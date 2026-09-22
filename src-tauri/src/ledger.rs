//! Read-only local token ledger. No transcript text, prompts or paths leave Rust.
use std::{collections::{BTreeMap,BTreeSet},fs::{self,File},io::{BufRead,BufReader,Read,Seek,SeekFrom},path::{Path,PathBuf}};
use serde::{Serialize,Deserialize};use serde_json::Value;use sha2::{Digest,Sha256};
use rusqlite::{Connection,params};
// anomalies 记分项矛盾事件数，随 state 持久化跨扫描累计；#[serde(default)] 兼容
// 升级前旧 state（缺字段），否则反序列化失败会把 codex totals 清零导致整段重复计数。
#[derive(Default,Clone,Serialize,Deserialize)]#[serde(default)]struct State{model:String,totals:[u64;4],bad_lines:u64,anomalies:u64}
#[derive(Debug,Clone,Serialize,Deserialize)]pub struct Row{pub source:String,pub model:String,pub day:String,pub hour:String,pub input:u64,pub output:u64,pub cache_read:u64,pub cache_write:u64,pub partial:bool}
#[derive(Debug,Serialize)]pub struct ArchivedDay{pub day:String,pub source:String,pub model:String,pub input:u64,pub output:u64,pub cache_read:u64,pub cache_write:u64}
#[derive(Debug,Serialize)]pub struct Summary{pub rows:Vec<Row>,pub scanned_files:usize,pub skipped_files:usize,pub changed_files:usize,pub days:u32,pub partial:bool,pub anomalies:u64,pub cost_estimate:Option<f64>,
    /// 按来源的本月估算成本，USD 原值（Round4 项目三订阅倍数的数据源）。
    /// 口径 = 本月 ∩ 扫描窗口：扫描窗口只有 7/30/90 天，窗口起点晚于本月 1 日时
    /// （如月初刚过选 7 天）本月 1 日至窗口起点之间的成本不计入，订阅倍数随之系统性
    /// 低报；该场景 Summary.notes 会追加提示。只含已计价模型；空 map=本窗口内没有任何
    /// 可计价记录，前端一律显示「—」，不得当 0。
    pub month_cost_by_source:BTreeMap<String,f64>,
    pub notes:Vec<String>,pub duration_ms:Option<u64>,pub coverage_gap:bool}
struct Event{id:String,ts:i64,model:String,counts:[u64;4],partial:bool}
fn count(v:&Value)->u64{v.as_u64().unwrap_or(0)}
fn negative(v:&Value)->bool{v.as_f64().is_some_and(|n|n<0.0)}
fn timestamp(v:&Value)->Option<i64>{
    if let Some(s)=v.as_str(){chrono::DateTime::parse_from_rfc3339(s).ok().map(|d|d.timestamp())}
    else{v.as_i64().map(|n|if n>100_000_000_000{n/1000}else{n})}
}
fn parse(source:&str,v:&Value,state:&mut State,offset:u64)->Option<Event>{
    if source=="codex"{
        if v["type"]=="turn_context"{if let Some(m)=v["payload"]["model"].as_str(){state.model=m.into()}return None}
        if v["type"]!="event_msg" || v["payload"]["type"]!="token_count"{return None}
        let u=v.pointer("/payload/info/total_token_usage")?;
        let ts=timestamp(&v["timestamp"])?;
        let totals=[count(&u["input_tokens"]),count(&u["output_tokens"]),count(&u["cached_input_tokens"]),0];
        let reset=totals.iter().zip(&state.totals).any(|(a,b)|a<b);
        let delta=if reset {
            state.totals = totals;
            totals
        } else {
            let d = std::array::from_fn::<_,4,_>(|i|totals[i].saturating_sub(state.totals[i]));
            state.totals = totals;
            d
        };
        let counts=[delta[0].saturating_sub(delta[2]),delta[1],delta[2],0];
        if counts.iter().sum::<u64>()==0{return None}
        // 分项守卫：totals 回退（reset）或缓存增量 > 输入增量（cached ⊆ input 语义被破坏）→ 计入异常；model 缺失只标 partial。
        let anomaly=reset||delta[2]>delta[0];
        if anomaly{state.anomalies+=1}
        return Some(Event{id:format!("{ts}-{:x}",Sha256::digest(serde_json::to_vec(&totals).ok()?)),ts,model:if state.model.is_empty(){"unknown".into()}else{state.model.clone()},counts,partial:anomaly||state.model.is_empty()});
    }
    // ZCode CLI 的会话转录与 Claude Code 同构（assistant 消息带 message.usage），复用同一解析分支。
    // Qwen CLI（Round5A 项目三）同为 Claude Code 同构布局（~/.qwen/projects/**/*.jsonl，QWEN_CONFIG_DIR
    // 可覆盖），同样复用本分支；本机无 ~/.qwen 目录，格式按同构假设实现——【未经真实数据验证】。
    if ["claude","zcode","qwen"].contains(&source){
        if v["type"]!="assistant"{return None}let m=&v["message"];let u=m.get("usage")?;
        let ts=timestamp(&v["timestamp"])?;
        let counts=[count(&u["input_tokens"]),count(&u["output_tokens"]),count(&u["cache_read_input_tokens"]),count(&u["cache_creation_input_tokens"])];
        // Claude Code writes "<synthetic>" assistant placeholders with an all-zero usage block.
        if counts.iter().all(|c|*c==0){return None}
        let id=m["id"].as_str().map(str::to_string).unwrap_or_else(||format!("offset-{offset}"));
        // 分项守卫：id/分项缺失（现有语义，保持并纳入计数）+ 四分项负值（count() 会静默归零，属格式漂移）。
        let anomaly=m["id"].is_null()||u["input_tokens"].is_null()||u["output_tokens"].is_null()||["input_tokens","output_tokens","cache_read_input_tokens","cache_creation_input_tokens"].iter().any(|k|negative(&u[k]));
        if anomaly{state.anomalies+=1}
        return Some(Event{id,ts,model:m["model"].as_str().unwrap_or("unknown").into(),counts,partial:anomaly});
    }
    if ["cline","roocode","kilocode"].contains(&source){
        if v["say"]!="api_req_started"{return None}let text:Value=serde_json::from_str(v["text"].as_str()?).ok()?;
        let ts=timestamp(&v["ts"])?;if text["tokensIn"].is_null()&&text["tokensOut"].is_null(){return None}
        // 分项守卫：任一分项为负（count() 静默归零）→ 计入异常；本来源即部分格式覆盖，partial 恒真。
        if ["tokensIn","tokensOut","cacheReads","cacheWrites"].iter().any(|k|negative(&text[k])){state.anomalies+=1}
        return Some(Event{id:format!("{ts}-{offset}"),ts,model:text["model"].as_str().unwrap_or("unknown").into(),counts:[count(&text["tokensIn"]),count(&text["tokensOut"]),count(&text["cacheReads"]),count(&text["cacheWrites"])],partial:true});
    }
    if source=="gemini"{
        let u = if v["type"] == "gemini" { v.get("tokens") } else { v.pointer("/payload/tokens").or_else(|| v.get("tokens")) }?;
        let input=count(&u["input"]);let cache=count(&u["cached"]);
        let model=v["model"].as_str().or_else(|| v.pointer("/payload/model").and_then(Value::as_str)).unwrap_or("unknown");
        let id=v["id"].as_str().or_else(|| v.pointer("/payload/id").and_then(Value::as_str)).map(str::to_string).unwrap_or_else(||format!("offset-{offset}"));
        let ts=v.get("timestamp").or_else(|| v.pointer("/payload/timestamp")).and_then(timestamp)?;
        // 分项守卫：分项负值，或 cached > input（Gemini 口径中 cached ⊆ input，saturating_sub 会静默掩盖该矛盾）。
        if ["input","output","cached","tool"].iter().any(|k|negative(&u[k]))||cache>input{state.anomalies+=1}
        return Some(Event{id,ts,model:model.into(),counts:[input.saturating_sub(cache)+count(&u["tool"]),count(&u["output"]),cache,0],partial:true});
    }
    if source=="openclaw"{
        let m=&v["message"];if m["role"]!="assistant"{return None}let u=m.get("usage")?;
        // 分项守卫：任一分项为负（count() 静默归零）→ 计入异常。
        if ["input","output","cacheRead","cacheWrite"].iter().any(|k|negative(&u[k])){state.anomalies+=1}
        return Some(Event{id:v["id"].as_str().map(str::to_string).unwrap_or_else(||format!("offset-{offset}")),ts:timestamp(&v["timestamp"])?,model:m["model"].as_str().unwrap_or("unknown").into(),counts:[count(&u["input"]),count(&u["output"]),count(&u["cacheRead"]),count(&u["cacheWrite"])],partial:true});
    }
    // Round5A 项目二：OpenCode storage/message 的助手消息（<messageID>.json 或 .jsonl 行，单对象形状）。
    // 本机无 ~/.local/share/opencode 目录，schema 按上游 sst/opencode v1.0.0 源码（message-v2.ts：
    // role/tokens{input,output,reasoning,cache{read,write}}/time{created,completed}/modelID）实现
    // ——【未经真实数据验证】。input 是否已含 cache 因上游 provider 而异（AI SDK 各家口径不统一），
    // 无法本地核实，故不去重、四分项直接并列，恒标 partial（与 gemini/openclaw 同等诚实度）。
    if source=="opencode"{
        if v["role"]!="assistant"{return None}let u=v.get("tokens")?;
        if u["input"].is_null()&&u["output"].is_null(){return None}
        let ts=timestamp(&v["time"]["completed"]).or_else(||timestamp(&v["time"]["created"]))?;
        // 分项守卫：任一分项为负（count() 静默归零）→ 计入异常。
        if negative(&u["input"])||negative(&u["output"])||negative(&u["cache"]["read"])||negative(&u["cache"]["write"]){state.anomalies+=1}
        let counts=[count(&u["input"]),count(&u["output"]),count(&u["cache"]["read"]),count(&u["cache"]["write"])];
        if counts.iter().all(|c|*c==0){return None}
        return Some(Event{id:v["id"].as_str().map(str::to_string).unwrap_or_else(||format!("offset-{offset}")),ts,model:v["modelID"].as_str().unwrap_or("unknown").into(),counts,partial:true});
    }
    None
}
fn discover<F>(root:&Path,source:&str,out:&mut Vec<(String,PathBuf)>,depth:usize,truncated:&mut bool,is_cancelled:&F)->Result<(),String>
where F: Fn() -> bool {
    if is_cancelled() { return Err("已取消".into()); }
    if depth>18||out.len()>=10000{ *truncated = true; return Ok(()); }
    // 目录不存在=该来源未安装（正常）；路径指向文件（误配为目录，read_dir 返回 NotADirectory，
    // Windows os error 267）同样静默跳过——若误标 truncated，Summary 会永久出现 coverage_gap，
    // 与「仅一条路径无效」的实际不符；权限等其他错误才标扫描截断（A13）。
    let entries=match fs::read_dir(root){
        Ok(e)=>e,
        Err(e) if e.kind()==std::io::ErrorKind::NotFound||e.kind()==std::io::ErrorKind::NotADirectory=>return Ok(()),
        Err(_)=>{ *truncated = true; return Ok(()); }
    };
    for entry in entries.flatten(){
        if is_cancelled() { return Err("已取消".into()); }
        let Ok(kind)=entry.file_type()else{continue};if kind.is_symlink(){continue}let path=entry.path();
        if kind.is_dir(){discover(&path,source,out,depth+1,truncated,is_cancelled)?}else if path.extension().is_some_and(|e|e=="jsonl"||e=="json"){
            let name=path.file_name().and_then(|s|s.to_str()).unwrap_or("");
            if ["cline","roocode","kilocode"].contains(&source) && name!="ui_messages.json"{continue}
            if source=="gemini" && !name.starts_with("session-"){continue}
            if ["claude","codex","openclaw","zcode","qwen"].contains(&source)&&path.extension().is_none_or(|e|e!="jsonl"){continue}
            out.push((source.into(),path));
        }
    }
    Ok(())
}
/// Each source gets its own discovery budget: a pathological directory (gemini
/// tmp can hold tens of thousands of transcripts) must not starve the sources
/// that are discovered after it.
fn collect<F>(root:&Path,source:&str,out:&mut Vec<(String,PathBuf)>,truncated:&mut bool,is_cancelled:&F)->Result<(),String>
where F: Fn() -> bool {
    let mut part=vec![];discover(root,source,&mut part,0,truncated,is_cancelled)?;out.extend(part);
    Ok(())
}
/// Round5A 项目四：设置 token_spend_extra_paths（来源 → 附加扫描目录）并入来源发现，
/// 复用与默认根相同的 discover/collect 预算机制。排在默认根之后，异常目录不挤占默认根的发现预算。
/// 防御式过滤（保存命令已校验，此处兜底不崩）：空串、非绝对路径与「不是目录的路径」静默忽略；
/// 每来源最多取前 TOKEN_SPEND_EXTRA_PATHS_PER_SOURCE 条。诚实口径（与 README/面板披露一致）：
/// 与默认根只按文件路径（path_key）去重——嵌套（同一文件被两个根各发现一次）路径相同、不会重复；
/// 跨目录复制件对事件 id 稳定的来源（claude/zcode/qwen/codex/gemini/openclaw/opencode 的真实消息 id）
/// 在统计 GROUP BY (source,event_id) 时折叠、也不双计，但会重复解析并使 scanned_files 翻倍；
/// cline/roocode/kilocode（id 恒带 path_key 命名空间）与缺 id 的 offset- 兜底事件，复制件按路径重复计数。
fn extra_scan_paths<F>(extra:&BTreeMap<String,Vec<String>>,out:&mut Vec<(String,PathBuf)>,truncated:&mut bool,is_cancelled:&F)->Result<(),String>
where F: Fn() -> bool {
    for (source,dirs) in extra{
        for dir in dirs.iter().take(crate::types::TOKEN_SPEND_EXTRA_PATHS_PER_SOURCE){
            if dir.is_empty(){continue}
            let p=PathBuf::from(dir);
            if !p.is_absolute(){continue}
            collect(&p,source,out,truncated,is_cancelled)?;
        }
    }
    Ok(())
}
fn sources_with_cancel<F>(is_cancelled:&F,extra:&BTreeMap<String,Vec<String>>)->Result<(Vec<(String,PathBuf)>,bool),String>
where F: Fn() -> bool {
    let mut out=vec![];
    let mut truncated=false;
    if let Some(root)=crate::providers::credentials::home_path("CLAUDE_CONFIG_DIR",".claude"){collect(&root.join("projects"),"claude",&mut out,&mut truncated,is_cancelled)?;}
    // ZCode：v2 claude 同构转录两根（~/.zcode/projects 与 v2/agent-config/claude）继续收集——它们与
    // CLI 信封（cli/db/db.sqlite）分属不同会话空间（裸 UUID vs sess_*；本机实测时 projects 根不存在，
    // 区间 2026-06-26..07-31 全部来自在场的 v2/agent-config/claude，与 db model_usage 的
    // 2026-08-23..09-22 不相交），db 里的 claude-import-* 会话只导入消息历史、model_usage 为 0 行：
    // 两根并存不双计（证据见 zcode_cli_db_events 注释）。
    // CLI 信封的权威根是 cli/db/db.sqlite（Round5A 项目一）：cli/agents/**/transcript.jsonl（子代理转录）
    // 与 cli/rollout/model-io-*.jsonl（主会话原始 IO）与 db model_usage 是同一批请求的重复记录，且单文件
    // 实测可达 20GB/单行 16MB（超出 256MB/2MB 行扫描预算）——jsonl 信封根一律不收集，防双计。
    if let Some(root)=crate::providers::credentials::home_path("ZCODE_HOME",".zcode"){
        collect(&root.join("projects"),"zcode",&mut out,&mut truncated,is_cancelled)?;collect(&root.join("v2").join("agent-config").join("claude"),"zcode",&mut out,&mut truncated,is_cancelled)?;
        let cli_db=root.join("cli").join("db").join("db.sqlite");
        if cli_db.is_file(){out.push(("zcode".into(),cli_db));}
    }
    // Qwen CLI（Round5A 项目三）：Claude Code 同构布局 ~/.qwen/projects（QWEN_CONFIG_DIR 可覆盖），
    // 复用 claude 解析分支；本机无该目录，格式未经真实数据验证（见 parse 注释）。
    if let Some(root)=crate::providers::credentials::home_path("QWEN_CONFIG_DIR",".qwen"){collect(&root.join("projects"),"qwen",&mut out,&mut truncated,is_cancelled)?;}
    // OpenCode（Round5A 项目二）：XDG_DATA_HOME 可覆盖 ~/.local/share；storage/message（现行文档布局）
    // 与 storage/session/message（上游 v1.0.0 迁移代码证实存在的旧布局）两个形状都收，缺失目录静默跳过。
    // 本机无 opencode 数据目录，schema 未经真实数据验证（见 parse 注释）。
    if let Some(xdg)=crate::providers::credentials::home_path("XDG_DATA_HOME",".local/share"){
        collect(&xdg.join("opencode").join("storage").join("message"),"opencode",&mut out,&mut truncated,is_cancelled)?;
        collect(&xdg.join("opencode").join("storage").join("session").join("message"),"opencode",&mut out,&mut truncated,is_cancelled)?;
    }
    if let Some(root)=crate::providers::credentials::home_path("CODEX_HOME",".codex"){collect(&root.join("sessions"),"codex",&mut out,&mut truncated,is_cancelled)?;collect(&root.join("archived_sessions"),"codex",&mut out,&mut truncated,is_cancelled)?;}
    if let Some(root)=crate::providers::credentials::home_path("GEMINI_CLI_HOME",".gemini"){collect(&root.join("tmp"),"gemini",&mut out,&mut truncated,is_cancelled)?;}
    if let Some(home)=dirs::home_dir(){collect(&home.join(".openclaw/agents"),"openclaw",&mut out,&mut truncated,is_cancelled)?;}
    if let Some(app)=dirs::config_dir(){for editor in ["Code","Code - Insiders","VSCodium"]{for (source,ext) in [("cline","saoudrizwan.claude-dev"),("roocode","rooveterinaryinc.roo-cline"),("kilocode","kilocode.kilo-code")]{collect(&app.join(editor).join("User/globalStorage").join(ext).join("tasks"),source,&mut out,&mut truncated,is_cancelled)?;}}}
    extra_scan_paths(extra,&mut out,&mut truncated,is_cancelled)?;
    Ok((out,truncated))
}
fn database(path:&Path)->Result<Connection,String>{
    let db=Connection::open(path).map_err(|_|"无法打开统计缓存")?;
    db.busy_timeout(std::time::Duration::from_secs(2)).map_err(|_|"统计缓存锁定")?;
    db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY,source TEXT,size INTEGER,mtime INTEGER,prefix TEXT,offset INTEGER,state TEXT); CREATE TABLE IF NOT EXISTS events(path TEXT,source TEXT,event_id TEXT,ts INTEGER,model TEXT,input INTEGER,output INTEGER,cache_read INTEGER,cache_write INTEGER,partial INTEGER,PRIMARY KEY(path,event_id)); CREATE INDEX IF NOT EXISTS idx_events_source_ts ON events(source, ts); CREATE TABLE IF NOT EXISTS daily_archive(day TEXT,source TEXT,model TEXT,input INTEGER,output INTEGER,cache_read INTEGER,cache_write INTEGER,PRIMARY KEY(day,source,model)); CREATE TABLE IF NOT EXISTS daily_active(day TEXT PRIMARY KEY,seconds INTEGER); CREATE TABLE IF NOT EXISTS session_titles(path TEXT PRIMARY KEY,title TEXT NOT NULL); CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value INTEGER);").map_err(|_|"无法初始化统计缓存")?;Ok(db)
}
pub fn scan(days:u32)->Result<Summary,String>{
    scan_with_cancel(days,&||false,BTreeMap::new(),false)
}
/// `extra` 为设置 token_spend_extra_paths（来源 → 附加扫描目录，已按绝对路径/上限校验）；
/// `wsl_enabled` 为设置 token_spend_wsl（Round5B 项目二，opt-in 默认关）。
/// 两者均由调用方（token_spend 命令）从内存设置快照传入，扫描期快照不变。
pub fn scan_with_cancel<F>(days:u32,is_cancelled:&F,extra:BTreeMap<String,Vec<String>>,wsl_enabled:bool)->Result<Summary,String>
where F: Fn() -> bool + Send + Sync {
    let runner:WslRunner<'_>=&|args:&[String],timeout_ms:u64|wsl_process_runner(args,timeout_ms);
    if ![7,30,90].contains(&days){return Err("统计区间无效".into())}
    if is_cancelled() { return Err("已取消".into()); }
    let root=crate::config::get_config_dir();fs::create_dir_all(&root).map_err(|_|"无法创建统计缓存")?;
    let (paths, truncated) = sources_with_cancel(is_cancelled,&extra)?;
    scan_paths_with_wsl(days,&ledger_db_path(),paths,truncated,wsl_enabled,runner,is_cancelled)
}
pub fn scan_paths(days:u32,db_path:&Path,paths:Vec<(String,PathBuf)>,truncated:bool)->Result<Summary,String>{
    scan_paths_with_cancel(days,db_path,paths,truncated,&||false)
}
pub fn scan_paths_with_cancel<F>(days:u32,db_path:&Path,paths:Vec<(String,PathBuf)>,truncated:bool,is_cancelled:&F)->Result<Summary,String>
where F: Fn() -> bool + Send + Sync {
    let scan_start=std::time::Instant::now();
    let mut db=database(db_path)?;let mut changed=0;let mut skipped=0;let scanned=paths.len();
    let today=chrono::Local::now().date_naive();let first=today-chrono::Duration::days(days as i64-1);
    let window_start_dt=first.and_hms_opt(0,0,0).and_then(|t|t.and_local_timezone(chrono::Local).single());
    let window_start_sec=window_start_dt.map(|t|t.timestamp()).unwrap_or(0);
    let window_start_ns=window_start_dt.and_then(|t|t.timestamp_nanos_opt()).unwrap_or(0);
    let live:Vec<String>=paths.iter().map(|(_,p)|format!("{:x}",Sha256::digest(p.to_string_lossy().as_bytes()))).collect();
    for (source,path) in paths{
        if is_cancelled() { return Err("已取消".into()); }
        let result=(||->Result<(),String>{
            let metadata=fs::metadata(&path).map_err(|_|"metadata")?;
            let is_zdb=source=="zcode"&&path.file_name().and_then(|s|s.to_str())==Some("db.sqlite");
            // WAL 副本可能比主库文件新（运行中的写入先落 -wal，主库要等 checkpoint 才变大），
            // ZCode CLI 库的「是否有新数据」判定取主库与 -wal 的最大 mtime，避免漏读未 checkpoint 的增量。
            // 刻意不计入 -shm：SQLite 连接（包括这里的只读投影连接）每次打开都会更新 -shm 的
            // 读标记，其 mtime 必变——计入会让下方 size+mtime 短路在 ZCode 运行期间永远失效，
            // 每轮扫描都触发 ~万行全量重投影。
            let mtime=if is_zdb{sqlite_effective_mtime(&path)}else{metadata.modified().ok().and_then(|t|t.duration_since(std::time::UNIX_EPOCH).ok()).map(|t|t.as_nanos().min(i64::MAX as u128) as i64).unwrap_or(0)};
            let path_key=format!("{:x}",Sha256::digest(path.to_string_lossy().as_bytes()));
            // Round5B 项目一：会话标题（文件名尾段）随扫描写入，未变化文件同样走到此处（REPLACE 幂等），
            // 升级后旧库缺标题行也能在下次扫描补齐。失败不影响统计（标题属最佳努力元数据）。
            // 全路径不出 Rust：对外只暴露该尾段与不可逆 path_key。
            let _=db.execute("INSERT OR REPLACE INTO session_titles VALUES(?,?)",params![path_key,path.file_name().and_then(|s|s.to_str()).unwrap_or("未知文件")]);
            let old:Option<(u64,i64,String,u64,String)>=db.query_row("SELECT size,mtime,prefix,offset,state FROM files WHERE path=?",[&path_key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).ok();
            // Round5A 项目一：ZCode CLI 信封权威根——不作为 jsonl 解析，改走 model_usage 投影（注释见该函数）。
            if is_zdb{
                if old.as_ref().is_some_and(|(size,time,_,_,_)|*size==metadata.len()&&*time==mtime){return Ok(())}
                if old.is_none()&&mtime>0&&mtime<window_start_ns{return Ok(())}
                let tx=db.transaction().map_err(|_|"lock")?;
                // 事件按 session 键写入复合路径（`{path_key}#{session}`），重建时按父键全删。
                tx.execute("DELETE FROM events WHERE substr(path,1,64)=?",[&path_key]).map_err(|_|"db")?;
                tx.execute("DELETE FROM session_titles WHERE substr(path,1,64)=?",[&path_key]).map_err(|_|"db")?;
                let mut st=State::default();
                let n=zcode_cli_db_events(&path,&tx,&path_key,&mut st)?;
                tx.execute("INSERT OR REPLACE INTO files VALUES(?,?,?,?,?,?,?)",params![path_key,source,metadata.len(),mtime,"",0i64,serde_json::to_string(&st).map_err(|_|"state")?]).map_err(|_|"checkpoint")?;
                tx.commit().map_err(|_|"commit")?;
                if n>0{changed+=1;}
                return Ok(());
            }
            if metadata.len()>256*1024*1024{return Err("large".into())}
            if old.as_ref().is_some_and(|(size,time,_,_,_)|*size==metadata.len()&&*time==mtime){return Ok(())}
            if old.is_none() && mtime>0 && mtime<window_start_ns {return Ok(())}
            let mut file=File::open(&path).map_err(|_|"read")?;let mut start=vec![0;metadata.len().min(1024) as usize];file.read_exact(&mut start).map_err(|_|"read")?;
            let prefix=format!("{:x}",Sha256::digest(&start));
            let jsonl=path.extension().is_some_and(|e|e=="jsonl");
            let append=jsonl&&old.as_ref().is_some_and(|(size,_,p,_,_)|metadata.len()>*size&&*size>=1024&&p==&prefix);
            let (mut offset,mut state)=match if append{old.as_ref()}else{None}{Some((_,_,_,o,s))=>(*o,serde_json::from_str::<State>(s).unwrap_or_default()),_=>(0,State::default())};
            let tx=db.transaction().map_err(|_|"lock")?;
            if !append{tx.execute("DELETE FROM events WHERE path=?",[&path_key]).map_err(|_|"db")?;}
            let mut file_events_count=0;
            let mut insert=|v:&Value,offset:u64,state:&mut State|->Result<(),String>{
                if let Some(event)=parse(&source,v,state,offset){
                    file_events_count+=1;
                    // Codex ids are timestamp+content hashes and survive a move into
                    // archived_sessions; only offset-derived ids need the path namespace.
                    let id=if event.id.starts_with("offset-")||["cline","roocode","kilocode"].contains(&source.as_str()){format!("{path_key}/{}",event.id)}else{event.id};
                    tx.execute("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(path,event_id) DO UPDATE SET input=MAX(input,excluded.input),output=MAX(output,excluded.output),cache_read=MAX(cache_read,excluded.cache_read),cache_write=MAX(cache_write,excluded.cache_write),partial=MAX(partial,excluded.partial)",params![path_key,source,id,event.ts,event.model,event.counts[0],event.counts[1],event.counts[2],event.counts[3],event.partial as u8]).map_err(|_|"record")?;
                }Ok(())
            };
            file.seek(SeekFrom::Start(offset)).map_err(|_|"seek")?;
            if jsonl {
                let mut reader=BufReader::new(file);
                let mut line_counter = 0usize;
                loop{
                    line_counter += 1;
                    if line_counter % 100 == 0 && is_cancelled() { return Err("已取消".into()); }
                    let mut line=vec![];let read=reader.by_ref().take(2*1024*1024+1).read_until(b'\n',&mut line).map_err(|_|"line")?;
                    if read==0{break}if read>2*1024*1024{return Err("oversized line".into())}
                    if !line.ends_with(b"\n"){break} // incomplete trailing record retried after append
                    match serde_json::from_slice::<Value>(&line){Ok(v)=>insert(&v,offset,&mut state)?,Err(_)=>{skipped+=1;state.bad_lines+=1;}}
                    offset+=read as u64;
                }
            }else{
                if metadata.len()>16*1024*1024{return Err("large json".into())}
                let v:Value=serde_json::from_reader(file).map_err(|_|"json")?;
                // 单对象消息文件（OpenCode storage/message 的 <messageID>.json，Round5A 项目二）：
                // 带 role 的对象直接按单条记录解析，不再要求数组形状。
                let single=v.get("role").is_some();
                if single{insert(&v,0,&mut state)?;}
                let array=v.as_array().or_else(||v["messages"].as_array());
                match array{
                    Some(a)=>for (i,line) in a.iter().enumerate(){
                        if i % 100 == 0 && is_cancelled() { return Err("已取消".into()); }
                        insert(line,i as u64,&mut state)?;
                    },
                    None=>if !single{return Err("format".into())},
                }
                offset=metadata.len();
            }
            tx.execute("INSERT OR REPLACE INTO files VALUES(?,?,?,?,?,?,?)",params![path_key,source,metadata.len(),mtime,prefix,offset,serde_json::to_string(&state).map_err(|_|"state")?]).map_err(|_|"checkpoint")?;
            tx.commit().map_err(|_|"commit")?;
            if file_events_count>0{changed+=1;}
            Ok(())
        })();
        if let Err(e) = &result {
            if e == "已取消" { return Err("已取消".into()); }
            skipped+=1;
        }
    }
    if is_cancelled() { return Err("已取消".into()); }
    // Only clean up deleted/moved files when discovery was complete and no files errored out.
    // If discovery was truncated, deleting files outside `live` would falsely wipe unvisited records.
    // 会话路径（Round5B 项目一）：ZCode CLI 库投影按 session 键写入 `{path_key}#{session}` 复合
    // 路径；path_key 恒为 64 位小写十六进制（不含 '#'），故 `substr(path,1,64)` 对普通路径是
    // 自身、对复合路径是其父文件——清理时父文件已删除/移动的复合事件与标题随之清亡，
    // 父文件在场的（含本轮未变化而未重投影的库）全部保留。
    if !truncated && skipped==0 {
        let tx=db.transaction().map_err(|_|"lock")?;
        tx.execute_batch("CREATE TEMP TABLE IF NOT EXISTS live(path TEXT PRIMARY KEY); DELETE FROM live;").map_err(|_|"db")?;
        {
            let mut insert=tx.prepare("INSERT OR IGNORE INTO live VALUES(?)").map_err(|_|"db")?;
            for key in &live{insert.execute([key]).map_err(|_|"db")?;}
        }
        // Round5B 项目二：WSL 条目（files.source='wsl' 标记）不参与 Windows live 清理——
        // 其保留/删除由 WSL 阶段按「本轮发现集 + 开关状态」自行管理（wsl.exe 暂时不可用 ≠ 文件已删除）。
        tx.execute("DELETE FROM events WHERE substr(path,1,64) NOT IN (SELECT path FROM live) AND substr(path,1,64) NOT IN (SELECT path FROM files WHERE source='wsl')",[]).map_err(|_|"db")?;
        tx.execute("DELETE FROM session_titles WHERE substr(path,1,64) NOT IN (SELECT path FROM live) AND substr(path,1,64) NOT IN (SELECT path FROM files WHERE source='wsl')",[]).map_err(|_|"db")?;
        tx.execute("DELETE FROM files WHERE path NOT IN (SELECT path FROM live) AND source<>'wsl'",[]).map_err(|_|"db")?;
        tx.commit().map_err(|_|"commit")?;
    }
    // 已删除会话用量保留：events 随源日志清理而消失（Claude Code 默认 30 天）。
    // 按 day/source/model 归档"观测到的最大日聚合"——重算值变小不降低归档，
    // 既在源文件被清理后保留历史，也防止重扫双计。
    {
        let tx=db.transaction().map_err(|_|"lock")?;
        archive_daily(&tx)?;
        active_daily(&tx)?;
        tx.commit().map_err(|_|"commit")?;
    }
    let mut stmt=db.prepare("SELECT source,model,ts,MAX(input),MAX(output),MAX(cache_read),MAX(cache_write),MAX(partial) FROM events WHERE ts>=? GROUP BY source,event_id").map_err(|_|"统计查询失败")?;
    let result=stmt.query_map([window_start_sec],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?,[r.get::<_,u64>(3)?,r.get::<_,u64>(4)?,r.get::<_,u64>(5)?,r.get::<_,u64>(6)?],r.get::<_,bool>(7)?))).map_err(|_|"统计读取失败")?;
    let mut buckets:BTreeMap<(String,String,String,String),Row>=BTreeMap::new();
    for (source,model,ts,c,partial) in result.flatten(){let Some(date)=chrono::DateTime::from_timestamp(ts,0).map(|d|d.with_timezone(&chrono::Local))else{continue};
        if date.date_naive()<first||date.date_naive()>today{continue}let day=date.format("%Y-%m-%d").to_string();let hour=date.format("%H:00").to_string();
        let row=buckets.entry((source.clone(),model.clone(),day.clone(),hour.clone())).or_insert(Row{source,model,day,hour,input:0,output:0,cache_read:0,cache_write:0,partial:false});
        row.input+=c[0];row.output+=c[1];row.cache_read+=c[2];row.cache_write+=c[3];row.partial|=partial;
    }
    let rows:Vec<_>=buckets.into_values().collect();
    let mut total_cost = 0.0;
    let mut any_cost = false;
    // A14：计价覆盖率——有 token 但落在未知定价表的模型明确告知"未计入"。
    let mut priced=0usize;let mut unpriced=0usize;
    // Round4 项目三：按来源累计本月成本，与 total_cost 同一处计价，口径一致。
    // 实际口径是「本月 ∩ 扫描窗口」（rows 被限制在 [first,today]）；窗口起点晚于
    // 本月 1 日时由 month_window_note 在 Summary.notes 披露截断，防订阅倍数被静默低报。
    let month_prefix=chrono::Local::now().format("%Y-%m").to_string();
    let mut month_cost:BTreeMap<String,f64>=BTreeMap::new();
    let mut month_any=false;
    for row in &rows {
        if row.input+row.output+row.cache_read+row.cache_write==0{continue}
        if let Some(c) = estimate_model_cost(&row.model, &[row.input, row.output, row.cache_read, row.cache_write]) {
            total_cost += c; any_cost = true; priced += 1;
            if row.day.starts_with(&month_prefix){*month_cost.entry(row.source.clone()).or_default()+=c;month_any=true;}
        } else { unpriced += 1; }
    }
    let cost_estimate = if any_cost { Some((total_cost * 100.0).round() / 100.0) } else { None };
    let month_cost_by_source=if month_any{month_cost.into_iter().map(|(k,v)|(k,(v*100.0).round()/100.0)).collect()}else{BTreeMap::new()};
    let coverage_gap=truncated;
    // B08：坏行状态持久化在 files.state——后续扫描跳过未变化文件时标记不丢。
    // 分项矛盾计数 anomalies 同存于 state：跨扫描累计，随全量重解析（前缀变更）重置重算。
    let (persisted_bad,anomalies):(u64,u64)={
        let mut stmt=db.prepare("SELECT state FROM files").map_err(|_|"读取坏行状态失败")?;
        let mut acc=(0u64,0u64);
        for st in stmt.query_map([],|r|r.get::<_,String>(0)).map_err(|_|"读取坏行状态失败")?.flatten().filter_map(|s|serde_json::from_str::<State>(&s).ok()){acc.0+=st.bad_lines;acc.1+=st.anomalies;}
        acc
    };
    let partial=skipped>0||persisted_bad>0||rows.iter().any(|r|r.partial)||coverage_gap||anomalies>0;
    let duration_ms=Some(scan_start.elapsed().as_millis() as u64);
    let mut notes=vec![
        "仅读取本机记录；缺失文件不代表零消耗。".into(),
        if cost_estimate.is_some() {
            "费用估算基于主流公有云 API 标价折算，仅供参考，不代表订阅内实际扣费。".into()
        } else {
            "费用暂不可用；不把未知模型价格当作零。".into()
        },
        "Gemini/OpenClaw/编辑器记录为部分格式覆盖；OpenCode、Qwen 本机无真实数据目录，解析未经真实数据验证；Copilot、导出来源及其他目录尚未支持。".into()
    ];
    if coverage_gap{
        notes.push("目录扫描达到上限或受限，已保留既有历史记录，统计可能存在缺口。".into());
    }
    if let Some(note)=month_window_note(first,today){
        notes.push(note);
    }
    if persisted_bad>0{
        notes.push(format!("历史扫描中曾有 {persisted_bad} 行无法解析（已跳过，不影响已解析事件）。"));
    }
    if unpriced>0{
        notes.push(format!("有 {unpriced} 组记录来自未知定价的模型，未计入费用估算（已计价 {priced} 组）。"));
    }
    if anomalies>0{
        notes.push(format!("发现 {anomalies} 条分项矛盾事件（分项为负或缓存增量大于输入增量等），已标记 partial，计数时请留意。"));
    }
    Ok(Summary{rows,scanned_files:scanned,skipped_files:skipped,changed_files:changed,days,partial,anomalies,cost_estimate,month_cost_by_source,notes,duration_ms,coverage_gap})
}

/// SQLite 库文件的「有效 mtime」= 主库与 -wal 副本 mtime 的最大值（缺哪个跳哪个）。
/// ZCode CLI 运行中写入先落 WAL，主库文件要等 checkpoint 才变化，只看主库会漏读增量。
/// 刻意不计入 -shm：任何（含只读）连接每次打开库都会更新 -shm 的读标记使其 mtime 变化，
/// 计入会让「size+mtime 未变则跳过」的短路在库被频繁打开期间永远失效。
fn sqlite_effective_mtime(path:&Path)->i64{
    let mut best=0i64;
    let mut candidates=vec![path.to_path_buf()];
    for suffix in ["-wal"]{let mut s=path.as_os_str().to_os_string();s.push(suffix);candidates.push(PathBuf::from(s));}
    for p in candidates{if let Ok(m)=fs::metadata(&p){if let Ok(t)=m.modified(){if let Ok(d)=t.duration_since(std::time::UNIX_EPOCH){best=best.max(d.as_nanos().min(i64::MAX as u128) as i64);}}}}
    best
}
/// Round5A 项目一：把 ZCode CLI 权威根 `~/.zcode/cli/db/db.sqlite` 的 `model_usage` 表投影成账本事件
/// （每条模型请求一行，id 即该表主键，天然幂等去重）。ZCODE_HOME 覆盖根目录。
///
/// 防双计与语义探查结论（2026-09-23 只读实测本机 ZCode 3.10.1 数据，样本即真实文件，未复制内容）：
/// 1) **cli/rollout/model-io-*.jsonl 与 cli/agents/**/transcript.jsonl 是同一批请求的重复记录，不收集**。
///    对 sess_443e472a 逐请求比对：rollout 48 个 model_io 事件与 db 行按时间序一一对应，
///    (input,output,cache_read) 逐值相等（合计 5,888,252 vs 5,888,218，尾差 34≈0.0006%，来自
///    status='error' 的重试行只在 db 留痕）；agents 目录 31 个转录全是 sess_subagent_* 子代理会话，
///    其请求同样出现在 model_usage（query_source='subagent'，867 行），15/23 个 agents 会话目录与
///    rollout 文件同名重叠。db 是权威超集（161 个会话有 usage，query_source 覆盖 main_turn/subagent/
///    workflow_child/compact/session_title 等），收集 jsonl 根必然双计；且 rollout 实测单文件最大 20GB、
///    单行 16MB，超出 256MB/2MB 行扫描预算，jsonl 路线不可行。
/// 2) **v2 claude 格式转录与 CLI 信封并存不双计**：v2 根会话 id 为裸 UUID（2026-06-26..07-31），
///    CLI 信封为 sess_*（db model_usage 时间区间 2026-08-23..09-22），区间与 id 空间均不相交；
///    db 中 claude-import-* 会话（7 个）model_usage 为 0 行（只导入消息历史）。
/// 3) **usage 是逐请求增量，不是会话累计**：同会话相邻 model_complete 的 outputTokens 非单调
///    （实测 119→323→214→219→179…），故无需 codex 式 totals-delta，逐行直接计数。
/// 4) **cached ⊆ input**（OpenAI 风格含缓存输入）：实测全部 9,433 行 cache_read≤input 且
///    computed_total=input+output → 与 codex/gemini 同口径：非缓存输入 = input − cache_read。
///    cache_creation_input_tokens 列在全部真实行中为 0（列存在但当前无提供方写入），按独立分项
///    计入 cache_write 桶、不从 input 里扣——该并列口径未经真实数据验证，若未来出现非零值需复核。
/// 5) 历史取舍：rollout jsonl 早至 2026-08-03、db usage 自 2026-08-23 起——db 更短但 jsonl 不可读
///    （预算超限）且与 db 重叠，取 db 是唯一不双计的选择；更早消耗如实缺失（与"缺失文件不代表
///    零消耗"同口径，不伪造）。
/// 6) Round5B 项目一会话维度：model_usage 实测含 `session_id` 列（9,878 行 176 个不同值、0 个
///    NULL），投影含 session 维度——每行事件写入复合路径 `{path_key}#{session_id}`，会话列表与
///    逐会话明细即按其切分。未来 schema 漂移（列消失）时降级为单会话 `#{whole-library}` 整体聚合，
///    由 SessionRow.note 诚实标注「无会话拆分」，不跳过该库（真实消耗不能因维度缺失而丢失）。
///    session_id 为 NULL 的个别行（实测不存在）同样并入整体聚合行。session 键是 CLI 元数据，
///    非转录正文，投影不读取任何消息内容。
pub const ZCODE_WHOLE_LIBRARY_SESSION:&str="whole-library";
fn zcode_cli_db_events(path:&Path,tx:&rusqlite::Transaction,path_key:&str,state:&mut State)->Result<usize,String>{
    let src=rusqlite::Connection::open_with_flags(path,rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|_|"zcode cli 库打不开")?;
    src.busy_timeout(std::time::Duration::from_secs(2)).map_err(|_|"zcode cli 库锁定")?;
    // session 维度存在性按列探测：缺列（schema 漂移）→ 整体聚合降级，不致命。
    let has_session:bool=src.query_row("SELECT COUNT(*) FROM pragma_table_info('model_usage') WHERE name='session_id'",[],|r|r.get::<_,i64>(0)).map_err(|_|"zcode cli 库查询失败")?!=0;
    let sql=if has_session{
        "SELECT id,model_id,status,started_at,input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens,session_id FROM model_usage"
    }else{
        "SELECT id,model_id,status,started_at,input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens,NULL FROM model_usage"
    };
    let mut stmt=src.prepare(sql).map_err(|_|"zcode cli 库查询失败")?;
    let mut ins=tx.prepare("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?)").map_err(|_|"db")?;
    let mut ins_title=tx.prepare("INSERT OR REPLACE INTO session_titles VALUES(?,?)").map_err(|_|"db")?;
    let whole_path=format!("{path_key}#{ZCODE_WHOLE_LIBRARY_SESSION}");
    let whole_title=path.file_name().and_then(|s|s.to_str()).unwrap_or("ZCode CLI 库").to_string();
    let rows=stmt.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,String>(2)?,r.get::<_,i64>(3)?,r.get::<_,i64>(4)?,r.get::<_,i64>(5)?,r.get::<_,i64>(6)?,r.get::<_,i64>(7)?,r.get::<_,Option<String>>(8)?))).map_err(|_|"zcode cli 库读取失败")?;
    let mut n=0usize;
    for (id,model,status,started_at,input,output,cache_read,cache_write,session) in rows.flatten(){
        // 分项守卫：列值负数（count 语义会静默归零）→ 计入异常并钳 0；全零行跳过。
        let raw=[input,output,cache_read,cache_write];
        if raw.iter().any(|c|*c<0){state.anomalies+=1}
        let c0=raw.map(|c|c.max(0) as u64);
        if c0.iter().all(|c|*c==0){continue}
        // cached ⊆ input 语义被破坏（cache_read>input）→ 分项矛盾，同 codex/gemini 守卫。
        let anomaly=c0[2]>c0[0];
        if anomaly{state.anomalies+=1}
        let counts=[c0[0].saturating_sub(c0[2]),c0[1],c0[2],c0[3]];
        // started_at 为毫秒时间戳；running 行可能随后增长，ON CONFLICT 无需——事件按 path 全删重建。
        let ts=(started_at/1000).max(0);
        let empty=model.as_deref().map(str::is_empty).unwrap_or(true);
        let unknown=empty||model.is_none();
        // 会话路径：有 session 维度且该行带 session_id → 复合路径；否则并入整体聚合行。
        let sess=session.filter(|s|!s.is_empty());
        let epath=match &sess{Some(s)=>format!("{path_key}#{s}"),None=>whole_path.clone()};
        ins.execute(params![&epath,"zcode",id,ts,if unknown{"unknown"}else{model.as_deref().unwrap_or_default()},counts[0],counts[1],counts[2],counts[3],(anomaly||status!="completed"||unknown) as u8]).map_err(|_|"record")?;
        // 会话标题：session 键本身（CLI 元数据）；整体聚合行用库文件名 + 诚实标注。
        let title=match &sess{Some(s)=>s.clone(),None=>whole_title.clone()};
        ins_title.execute(params![&epath,title]).map_err(|_|"record")?;
        n+=1;
    }
    Ok(n)
}

// ---------- Round5B 项目二：WSL 用量（opt-in，默认关） ----------
//
// 安全模型（命令注入防护，纵深三层）：
// 1) 发现与读取一律 `wsl.exe -e <argv>` 直接 exec，不经发行版 shell——WSL 路径永不进入
//    `sh -c` 命令串，引号/分号/$ 等元字符没有任何解释者；
// 2) 每个 WSL 路径在进入命令构造前过字符白名单（[A-Za-z0-9/._-]，并拒绝 ".."）：含空格/
//    引号/分号/$/反引号的恶意路径一律拒绝（跳过，绝不拼接）——即便某些 wsl.exe 版本对
//    argv 转发存在重新分词的怪癖，白名单字符也不携带任何元语义；
// 3) 家目录探测的命令串为常量（`echo $HOME`），展开结果同样过白名单后才用于拼接扫描根。
//
// 诚实降级：wsl.exe 缺失/超时/家目录异常/发行版无数据 → 静默跳过（不报错、不崩溃），
// Summary.notes 标注；既有 WSL 记录保留——files 表以 source='wsl' 标记的条目豁免 Windows
// live 清理（wsl.exe 暂时不可用 ≠ WSL 文件已删除），保留/删除由 WSL 阶段按「本轮发现集 +
// 开关状态」自行管理。同会话双计风险：WSL 与 Windows 若挂载同一目录会被两次收集，
// 事件 id 稳定来源按 (source,event_id) 折叠（Round 5a 已验证该机制）。SQLite 类来源
// （OpenCode 等）不做 WSL 读取（需 headless agent，复杂度不成比例；README 注明）。

/// WSL 来源独立文件数预算：发现超出预算的文件不读取，notes 标注可能缺口。
pub const WSL_FILE_BUDGET:usize=2000;
/// WSL 单文件读取上限（计划口径 256KB），超出沿用 large 跳过语义。
pub const WSL_FILE_MAX_BYTES:u64=256*1024;
/// 单条 wsl.exe 命令超时（家目录探测与逐文件读取同用）：挂起的 WSL 不阻塞整轮扫描。
pub const WSL_CMD_TIMEOUT_MS:u64=15_000;
/// 连续读取失败上限：达到即中止本轮 WSL 阶段，避免 wsl.exe 半途不可用时按超时串行拖死整轮扫描。
pub const WSL_MAX_CONSECUTIVE_FAILURES:usize=5;
/// files 表 WSL 条目的来源标记：仅用于清理豁免与开关联动删除的判定；events 行仍用真实来源
/// （claude/qwen，与 Windows 侧同来源聚合，同会话由 (source,event_id) 折叠）。
const WSL_FILES_MARKER:&str="wsl";
/// wsl.exe 不可用/超时/家目录异常时的静默降级标注（Summary.notes）。
pub const WSL_NOTE_UNAVAILABLE:&str="WSL：未检测到可用发行版或读取失败，本轮已跳过 WSL 来源；既有 WSL 记录保留。";
/// wsl.exe 家目录探测 argv：命令串为常量，无任何用户数据插值；`-e` 不走登录 shell（无 motd）。
pub fn wsl_home_argv()->Vec<String>{vec!["-e".into(),"sh".into(),"-c".into(),"echo $HOME".into()]}
/// WSL 单文件读取 argv：`wsl.exe -e cat -- <path>`。`-e` 直接 exec、不经 shell；路径作为单个
/// argv 元素传递，`--` 终结选项解析（纵深防御：合法路径以 / 开头本就不会被当选项）。
pub fn wsl_read_argv(path:&str)->Vec<String>{vec!["-e".into(),"cat".into(),"--".into(),path.into()]}
/// WSL 文件发现 argv：GNU find 直接 exec，输出 `路径\t大小\tmtime@` 供断点续扫比对
/// （-printf 为 GNU 扩展；BusyBox find 不支持 → 退出非零，按「该根无数据」处理，诚实降级）。
pub fn wsl_find_argv(root:&str)->Vec<String>{
    vec!["-e".into(),"find".into(),root.into(),"-type".into(),"f".into(),"-name".into(),"*.jsonl".into(),"-printf".into(),"%p\t%s\t%T@\n".into()]
}
/// WSL 允许的扫描根（$HOME 过白名单后拼接固定后缀）：claude 与 qwen 的 projects 目录。
pub fn wsl_roots(home:&str)->Vec<String>{vec![format!("{home}/.claude/projects"),format!("{home}/.qwen/projects")]}
/// 扫描根序号 → 解析来源（与 Windows 侧同名来源聚合；zcode/OpenCode 等 SQLite 类不做 WSL 读取）。
fn wsl_root_source(i:usize)->&'static str{if i==0{"claude"}else{"qwen"}}
/// wsl.exe 命令执行器注入点：args 为完整 argv（含 "-e" 前缀），超时到点必须返回 Err。
pub type WslRunner<'a>=&'a dyn Fn(&[String],u64)->Result<Vec<u8>,String>;
/// wsl.exe 执行器的错误文案（wsl_find_err_transient 按其前缀分类瞬时/良性失败，措辞勿改）。
const WSL_ERR_SPAWN:&str="wsl.exe 启动失败";
const WSL_ERR_TIMEOUT:&str="wsl.exe 超时";
const WSL_ERR_WAIT:&str="wsl.exe 等待失败";
const WSL_ERR_NONZERO:&str="wsl.exe 返回非零退出码";
/// wsl.exe 全路径（%SystemRoot%\System32\wsl.exe）：裸名会走「应用目录优先」的搜索顺序，
/// 安装/便携目录下的同名二进制可遮蔽真实 wsl.exe 并以应用身份运行任意代码——与更新器对
/// powershell 用 System32 全路径同口径。SystemRoot 缺失（非标准环境）回退裸名。
fn wsl_exe()->std::path::PathBuf{
    std::env::var_os("SystemRoot").map(|r|{let mut p=std::path::PathBuf::from(r);p.push("System32");p.push("wsl.exe");p})
        .unwrap_or_else(||std::path::PathBuf::from("wsl.exe"))
}
/// find 失败分类：wsl.exe 启动失败/超时/等待失败 = 暂时不可用（本轮发现集不完整，保留集清理
/// 必须跳过，防误删仍在 WSL 侧的文件条目）；find 退出非零（目录缺失/无数据/BusyBox 不支持
/// -printf）= 良性「该根为空」。其余错误串按良性处理（生产执行器只产生上述四类文案）。
fn wsl_find_err_transient(e:&str)->bool{
    e.starts_with(WSL_ERR_SPAWN)||e.starts_with(WSL_ERR_TIMEOUT)||e.starts_with(WSL_ERR_WAIT)
}
/// 生产执行器：spawn wsl.exe（CREATE_NO_WINDOW 防 GUI 弹控制台），后台线程持续排空 stdout
/// 防管道写端把子进程卡死，主线程轮询超时后 kill。退出非零视为该命令失败（调用方降级）。
fn wsl_process_runner(args:&[String],timeout_ms:u64)->Result<Vec<u8>,String>{
    use std::io::Read;use std::process::{Command,Stdio};
    let mut cmd=Command::new(wsl_exe());
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    {use std::os::windows::process::CommandExt;const CREATE_NO_WINDOW:u32=0x0800_0000;cmd.creation_flags(CREATE_NO_WINDOW);}
    let mut child=cmd.spawn().map_err(|e|format!("{WSL_ERR_SPAWN}：{e}"))?;
    let stdout=child.stdout.take().ok_or_else(||"wsl.exe 输出管道不可用".to_string())?;
    let reader=std::thread::spawn(move||{let mut r=stdout;let mut buf=Vec::new();let _=r.read_to_end(&mut buf);buf});
    let start=std::time::Instant::now();
    let status:Result<std::process::ExitStatus,String>=loop{
        match child.try_wait(){
            Ok(Some(st))=>break Ok(st),
            Ok(None)=>{},
            Err(e)=>break Err(format!("{WSL_ERR_WAIT}：{e}")),
        }
        if start.elapsed().as_millis() as u64>=timeout_ms{
            let _=child.kill();let _=child.wait();
            break Err(format!("{WSL_ERR_TIMEOUT}（>{timeout_ms}ms）"));
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    };
    let out=reader.join().unwrap_or_default();
    match status{Ok(st) if st.success()=>Ok(out),Ok(_)=>Err(WSL_ERR_NONZERO.into()),Err(e)=>Err(e)}
}
/// $HOME 白名单：绝对 POSIX 路径、仅 [A-Za-z0-9/._-]、拒绝 ".."、长度 ≤256。
/// 含空格等异常家目录 → 整个 WSL 阶段静默降级（不进入任何命令构造）。
pub fn valid_wsl_home(home:&str)->bool{
    !home.is_empty()&&home.len()<=256&&home.starts_with('/')&&!home.contains("..")
        &&home.bytes().all(|b|b.is_ascii_alphanumeric()||matches!(b,b'/'|b'.'|b'_'|b'-'))
}
/// WSL 转录路径白名单（安全关键，见模块头注释）：绝对路径、字符白名单、拒 ".."、以 .jsonl
/// 结尾、必须落在允许根内。未过校验的发现结果一律静默跳过，绝不进入命令构造。
pub fn valid_wsl_path(path:&str,roots:&[String])->bool{
    !path.is_empty()&&path.len()<=1024&&path.starts_with('/')&&!path.contains("..")
        &&path.ends_with(".jsonl")
        &&path.bytes().all(|b|b.is_ascii_alphanumeric()||matches!(b,b'/'|b'.'|b'_'|b'-'))
        &&roots.iter().any(|r|path.starts_with(&format!("{r}/")))
}
/// WSL 文件路径键：sha256("wsl:"+POSIX 路径)——与 Windows 侧 sha256(路径) 天然不同键，
/// 跨侧无需去重；同会话双计由 (source,event_id) 折叠兜底（模块头注释）。
pub fn wsl_path_key(path:&str)->String{format!("{:x}",Sha256::digest(format!("wsl:{path}").as_bytes()))}
/// 会话标题用文件名尾段（与 Windows 侧同口径，全路径不出 Rust）。
fn wsl_file_name(path:&str)->&str{path.rsplit('/').next().unwrap_or(path)}
/// find 输出行解析：`路径\t大小\tmtime@`（%T@ 为秒的小数形式 → 存纳秒）；畸形行跳过。
fn parse_wsl_find_output(out:&[u8])->Vec<(String,u64,i64)>{
    String::from_utf8_lossy(out).lines().filter_map(|line|{
        let mut it=line.rsplitn(3,'\t');
        let mtime=it.next()?;let size=it.next()?;let path=it.next()?;
        let size=size.parse::<u64>().ok()?;let secs=mtime.parse::<f64>().ok()?;
        Some((path.trim().to_string(),size,(secs*1e9) as i64))
    }).collect()
}
/// 开关关闭：显式清除全部 WSL 条目（events/标题/files 标记行），与 Windows live 清理互补
/// （关闭语义 = 不并入也不保留）。
fn purge_wsl_entries(db:&Connection)->Result<(),String>{
    db.execute("DELETE FROM events WHERE path IN (SELECT path FROM files WHERE source='wsl')",[]).map_err(|_|"db")?;
    db.execute("DELETE FROM session_titles WHERE path IN (SELECT path FROM files WHERE source='wsl')",[]).map_err(|_|"db")?;
    db.execute("DELETE FROM files WHERE source='wsl'",[]).map_err(|_|"db")?;
    Ok(())
}
/// 一轮 WSL 阶段的结果（供 notes 与 partial 标记组装；不做全局状态）。
#[derive(Default,Debug)]
pub struct WslOutcome{pub discovered:usize,pub read:usize,pub unchanged:usize,pub failed:usize,pub large:usize,pub bad_lines:u64,pub budget_truncated:bool,pub aborted:bool,pub find_failed:bool}
/// WSL 阶段：家目录探测 → 逐根发现 → 白名单校验 → 保留集维护 → 逐文件读取入库。
/// 任一环节失败都不致命：单根 find 退出非零（目录缺失/不支持 -printf）按「该根为空」处理；
/// wsl.exe 启动失败/超时则本轮发现集不可信——find_failed=true 使保留集清理整体跳过
/// （wsl.exe 暂时不可用 ≠ 文件已删除，误删对已滑出扫描窗口的文件是永久丢失）；单文件失败
/// 计数跳过，连续失败达上限中止，整体失败（wsl.exe 缺失/家目录无效）返回 Err 由调用方降级。
fn wsl_scan_phase<F>(runner:WslRunner<'_>,db:&mut Connection,window_start_ns:i64,is_cancelled:&F)->Result<WslOutcome,String>
where F:Fn()->bool{
    let mut o=WslOutcome::default();
    let raw_home=runner(&wsl_home_argv(),WSL_CMD_TIMEOUT_MS)?;
    let home=String::from_utf8_lossy(&raw_home).trim().to_string();
    if !valid_wsl_home(&home){return Err("WSL 家目录无效".into())}
    let roots=wsl_roots(&home);
    // 发现：逐根 find；退出非零（目录缺失/无数据/不支持 -printf）按「该根为空」处理，不算失败；
    // wsl.exe 启动失败/超时属暂时不可用 → find_failed=true，本轮保留集清理跳过（模块头注释）。
    let mut entries:Vec<(String,String,u64,i64)>=vec![];// (路径, 来源, 大小, mtime_ns)
    for (i,root) in roots.iter().enumerate(){
        let out=match runner(&wsl_find_argv(root),WSL_CMD_TIMEOUT_MS){
            Ok(v)=>v,
            Err(e)=>{if wsl_find_err_transient(&e){o.find_failed=true;}continue},
        };
        for (path,size,mtime_ns) in parse_wsl_find_output(&out){
            if !valid_wsl_path(&path,&roots){continue}// 恶意/越界路径：跳过，绝不进入命令构造
            o.discovered+=1;
            entries.push((path,wsl_root_source(i).to_string(),size,mtime_ns));
        }
    }
    entries.sort_by(|a,b|a.0.cmp(&b.0));entries.dedup_by(|a,b|a.0==b.0);
    o.budget_truncated=o.discovered>WSL_FILE_BUDGET;
    entries.truncate(WSL_FILE_BUDGET);
    // 保留集维护：本轮发现之外的既有 WSL 条目按「WSL 侧文件已删除」清理（开启态唯一删除路径）。
    // 发现集不完整时不得清理——任一根 find 瞬时失败 / 文件数超预算截断，都意味着「不在本轮
    // 发现集」≠「WSL 侧已删除」（与 Windows 侧 `!truncated && skipped==0` 守卫同口径）；
    // 误删的文件若 mtime 已滑出扫描窗口将永不重读，丢失是永久性的。
    if !o.find_failed&&!o.budget_truncated{
        let live:BTreeSet<String>=entries.iter().map(|(p,_,_,_)|wsl_path_key(p)).collect();
        let stale:Vec<String>={
            let mut stmt=db.prepare("SELECT path FROM files WHERE source='wsl'").map_err(|_|"db")?;
            let rows=stmt.query_map([],|r|r.get::<_,String>(0)).map_err(|_|"db")?;
            rows.flatten().filter(|k|!live.contains(k)).collect()
        };
        for key in &stale{
            db.execute("DELETE FROM events WHERE path=?",[key]).map_err(|_|"db")?;
            db.execute("DELETE FROM session_titles WHERE path=?",[key]).map_err(|_|"db")?;
            db.execute("DELETE FROM files WHERE path=? AND source='wsl'",[key]).map_err(|_|"db")?;
        }
    }
    // 读取：size+mtime 未变直接沿用既有事件（断点续扫）；变化的全量重读（先删后插，幂等）。
    // 新文件且 mtime 早于窗口 → 与 Windows 侧同口径不解析（其事件必在窗口外，懒解析）。
    let mut consecutive=0usize;
    for (path,source,size,mtime_ns) in entries{
        if is_cancelled(){return Err("已取消".into())}
        let key=wsl_path_key(&path);
        let ck:Option<(u64,i64)>=db.query_row("SELECT size,mtime FROM files WHERE path=? AND source='wsl'",[&key],|r|Ok((r.get(0)?,r.get(1)?))).ok();
        if ck.is_some_and(|(s,m)|s==size&&m==mtime_ns){o.unchanged+=1;continue}
        if ck.is_none()&&mtime_ns>0&&mtime_ns<window_start_ns{continue}
        // 读前预检：find 已回传文件大小，超大文件直接按 large 跳过——不再把整文件经 wsl.exe
        // 管道整体缓冲后才丢弃（与 Windows 侧读前预检同口径），也避免超大文件读满超时被误计
        // 为 failed 连锁中止本阶段。读取后的上限检查保留作兜底（find 与 cat 之间文件变大）。
        if size>WSL_FILE_MAX_BYTES{o.large+=1;continue}
        let out=match runner(&wsl_read_argv(&path),WSL_CMD_TIMEOUT_MS){
            Ok(v)=>v,
            Err(_)=>{o.failed+=1;consecutive+=1;
                if consecutive>=WSL_MAX_CONSECUTIVE_FAILURES{o.aborted=true;break}
                continue}
        };
        consecutive=0;
        if out.len() as u64>WSL_FILE_MAX_BYTES{o.large+=1;continue}
        let tx=db.transaction().map_err(|_|"lock")?;
        tx.execute("DELETE FROM events WHERE path=?",[&key]).map_err(|_|"db")?;
        tx.execute("DELETE FROM session_titles WHERE path=?",[&key]).map_err(|_|"db")?;
        let mut st=State::default();
        {
            let mut ins=tx.prepare("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(path,event_id) DO UPDATE SET input=MAX(input,excluded.input),output=MAX(output,excluded.output),cache_read=MAX(cache_read,excluded.cache_read),cache_write=MAX(cache_write,excluded.cache_write),partial=MAX(partial,excluded.partial)").map_err(|_|"db")?;
            let mut offset=0u64;
            for raw in out.split(|b|*b==b'\n'){
                let line_start=offset;offset+=raw.len() as u64+1;
                if raw.is_empty(){continue}
                match serde_json::from_slice::<Value>(raw){
                    Ok(v)=>if let Some(event)=parse(&source,&v,&mut st,line_start){
                        // offset 兜底 id 带路径命名空间（与 Windows 侧同规则）；真实消息 id 裸存，
                        // 跨 WSL/Windows 副本由 (source,event_id) 折叠。
                        let id=if event.id.starts_with("offset-"){format!("{key}/{}",event.id)}else{event.id};
                        ins.execute(params![key,source,id,event.ts,event.model,event.counts[0],event.counts[1],event.counts[2],event.counts[3],event.partial as u8]).map_err(|_|"record")?;
                    },
                    Err(_)=>{st.bad_lines+=1;o.bad_lines+=1;}
                }
            }
        }
        tx.execute("INSERT OR REPLACE INTO session_titles VALUES(?,?)",params![key,wsl_file_name(&path)]).map_err(|_|"db")?;
        tx.execute("INSERT OR REPLACE INTO files VALUES(?,?,?,?,?,?,?)",params![key,WSL_FILES_MARKER,size,mtime_ns,"",0i64,serde_json::to_string(&st).map_err(|_|"state")?]).map_err(|_|"db")?;
        tx.commit().map_err(|_|"commit")?;
        o.read+=1;
    }
    Ok(o)
}
/// 生产扫描 = Windows 来源发现 + WSL 阶段 + 主扫描（账本库走全局路径）。
pub fn scan_paths_with_wsl<F>(days:u32,db_path:&Path,paths:Vec<(String,PathBuf)>,truncated:bool,wsl_enabled:bool,runner:WslRunner<'_>,is_cancelled:&F)->Result<Summary,String>
where F: Fn() -> bool + Send + Sync {
    let (wsl_notes,wsl_bad_lines,wsl_partial)=run_wsl_phase(days,db_path,wsl_enabled,runner,is_cancelled)?;
    let mut summary=scan_paths_with_cancel(days,db_path,paths,truncated,is_cancelled)?;
    summary.notes.extend(wsl_notes);
    summary.skipped_files+=wsl_bad_lines as usize;
    summary.partial|=wsl_partial;
    Ok(summary)
}
/// WSL 阶段编排：开启 → 执行并组装 notes；关闭 → 清空既有 WSL 条目。
/// 任何失败都不致命（返回空 notes + 降级标注），只有取消向上传播。
fn run_wsl_phase<F>(days:u32,db_path:&Path,wsl_enabled:bool,runner:WslRunner<'_>,is_cancelled:&F)->Result<(Vec<String>,u64,bool),String>
where F:Fn()->bool{
    let mut wsl_notes:Vec<String>=vec![];let mut wsl_bad_lines=0u64;
    let mut db=database(db_path)?;
    if !wsl_enabled{
        purge_wsl_entries(&db)?;
        return Ok((wsl_notes,0,false));
    }
    let wsl_partial;
    // 窗口起点与 scan_paths_with_cancel 同式（本地时区当日 00:00 的纳秒），用于懒解析比对。
    let today=chrono::Local::now().date_naive();let first=today-chrono::Duration::days(days as i64-1);
    let window_start_ns=first.and_hms_opt(0,0,0).and_then(|t|t.and_local_timezone(chrono::Local).single()).and_then(|t|t.timestamp_nanos_opt()).unwrap_or(0);
    match wsl_scan_phase(runner,&mut db,window_start_ns,is_cancelled){
        Ok(o)=>{
            wsl_bad_lines=o.bad_lines;
            if o.discovered>0{
                wsl_notes.push(format!("WSL：默认发行版并入 {} 个转录文件（claude/qwen；本轮新读 {}、未变 {}）。",o.read+o.unchanged,o.read,o.unchanged));
            }else if !o.find_failed{
                // 发现瞬时失败时不冒充「未发现」结论（根本没看到），由下方发现失败说明承担。
                wsl_notes.push("WSL：默认发行版未发现 claude/qwen 转录文件。".into());
            }
            if o.find_failed{wsl_notes.push("WSL：部分扫描根发现失败（wsl.exe 启动失败/超时），本轮保留既有 WSL 记录、未做清理。".into());}
            if o.budget_truncated{wsl_notes.push(format!("WSL：发现的文件数达独立预算上限（{}），超出部分未读取，统计可能存在缺口；为防误删，本轮未清理既有 WSL 记录。",WSL_FILE_BUDGET));}
            if o.failed>0{wsl_notes.push(format!("WSL：{} 个文件读取失败已跳过。",o.failed));}
            if o.aborted{wsl_notes.push("WSL：读取连续失败，已提前中止本轮 WSL 来源；既有 WSL 记录保留。".into());}
            if o.large>0{wsl_notes.push(format!("WSL：{} 个文件超过 {}KB 上限未读取。",o.large,WSL_FILE_MAX_BYTES/1024));}
            wsl_partial=o.failed>0||o.large>0||o.budget_truncated||o.aborted||o.bad_lines>0||o.find_failed;
        },
        Err(e) if e=="已取消"=>return Err(e),
        Err(_)=>{wsl_notes.push(WSL_NOTE_UNAVAILABLE.into());wsl_partial=true;}
    }
    Ok((wsl_notes,wsl_bad_lines,wsl_partial))
}

/// Round4 项目三口径披露：month_cost_by_source 实际覆盖「本月 ∩ 扫描窗口」。
/// 扫描窗口起点（first）晚于本月 1 日时返回追加到 Summary.notes 的提示文案；
/// 窗口已覆盖整月（90 天恒覆盖，30 天几乎总覆盖）返回 None，不添加噪音。
fn month_window_note(first:chrono::NaiveDate,today:chrono::NaiveDate)->Option<String>{
    use chrono::Datelike;
    let month_first=chrono::NaiveDate::from_ymd_opt(today.year(),today.month(),1)?;
    (first>month_first).then(||format!("本月成本仅统计扫描窗口（自 {first} 起）内的记录，未覆盖本月月初，订阅倍数可能偏低。"))
}

/// 事件按 (本地时区 day,source,model) 聚合后 upsert 进 daily_archive。
/// 先按 (source,event_id) 取 MAX 去重（与 Summary 口径一致，跨文件移动的事件不双计），
/// day 与 Row.day 同为本地时区；upsert 用 max(旧,新) 保留历史峰值。
/// day 键的时区偏移在首次归档时冻结进 meta 表：归档只有 max-upsert、没有删除/回退路径，
/// 若每次扫描都按当前系统时区切天，时区变更会把同一批事件重切到新 day 键而旧行永不修正
/// （趋势按 day 求和即永久双计）；冻结偏移保证 day 键稳定，Summary 每次全量重算不受影响。
/// day 键统一使用 meta 冻结的归档时区偏移（缺省回退当前本地偏移）。
fn frozen_tz(db:&Connection)->chrono::FixedOffset{
    let secs:Option<i64>=db.query_row("SELECT value FROM meta WHERE key='archive_tz_offset_secs'",[],|r|r.get(0)).ok();
    secs.and_then(|s|i32::try_from(s).ok()).and_then(chrono::FixedOffset::east_opt).unwrap_or_else(||*chrono::Local::now().offset())
}
fn archive_daily(db:&Connection)->Result<(),String>{
    let now_off=chrono::Local::now().offset().local_minus_utc();
    db.execute("INSERT OR IGNORE INTO meta(key,value) VALUES('archive_tz_offset_secs',?)",[now_off]).map_err(|_|"归档写入失败")?;
    let tz=frozen_tz(db);
    let mut stmt=db.prepare("SELECT source,model,ts,MAX(input),MAX(output),MAX(cache_read),MAX(cache_write) FROM events GROUP BY source,event_id").map_err(|_|"归档查询失败")?;
    let rows=stmt.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?,[r.get::<_,u64>(3)?,r.get::<_,u64>(4)?,r.get::<_,u64>(5)?,r.get::<_,u64>(6)?]))).map_err(|_|"归档读取失败")?;
    let mut buckets:BTreeMap<(String,String,String),[u64;4]>=BTreeMap::new();
    for (source,model,ts,c) in rows.flatten(){let Some(day)=chrono::DateTime::from_timestamp(ts,0).map(|d|d.with_timezone(&tz).format("%Y-%m-%d").to_string())else{continue};let e=buckets.entry((day,source,model)).or_insert([0;4]);for i in 0..4{e[i]+=c[i];}}
    let mut up=db.prepare("INSERT INTO daily_archive(day,source,model,input,output,cache_read,cache_write) VALUES(?,?,?,?,?,?,?) ON CONFLICT(day,source,model) DO UPDATE SET input=MAX(input,excluded.input),output=MAX(output,excluded.output),cache_read=MAX(cache_read,excluded.cache_read),cache_write=MAX(cache_write,excluded.cache_write)").map_err(|_|"归档写入失败")?;
    for ((day,source,model),c) in &buckets{up.execute(params![day,source,model,c[0],c[1],c[2],c[3]]).map_err(|_|"归档写入失败")?;}
    Ok(())
}
/// 读取按天归档的历史用量（day 升序），供趋势与导出使用。
pub fn archived_daily(db_path:&Path)->Result<Vec<ArchivedDay>,String>{
    let db=database(db_path)?;
    let mut stmt=db.prepare("SELECT day,source,model,input,output,cache_read,cache_write FROM daily_archive ORDER BY day ASC,source ASC,model ASC").map_err(|_|"归档读取失败")?;
    let rows=stmt.query_map([],|r|Ok(ArchivedDay{day:r.get(0)?,source:r.get(1)?,model:r.get(2)?,input:r.get(3)?,output:r.get(4)?,cache_read:r.get(5)?,cache_write:r.get(6)?})).map_err(|_|"归档读取失败")?;
    Ok(rows.flatten().collect())
}

/// 趋势窗口默认 370 天（对标 token-monitor 的 370 天滚动窗）。
pub const TREND_CAP_DAYS:u32=370;
/// 单日趋势：tokens 为全口径 input+output+cache_read+cache_write（与归档列一致），
/// per_source 按来源拆分（窗口内出现过的来源逐一列出，当日缺失补 0）。
#[derive(Debug,Clone,Serialize,Deserialize)]pub struct DailyTrend{pub day:String,pub tokens:u64,pub per_source:BTreeMap<String,u64>}
/// 趋势指标汇总：trend_metrics 命令返回值与趋势导出 JSON 共用同一形状。
/// active_seconds 为窗口内（首日..=末日）活跃总秒数，由 trend_report 按 daily_active 填充
/// （compute_metrics 是不含库查询的纯函数，此处恒 0）；跨 source 不去重、并行累计。
#[derive(Debug,Clone,Serialize,Deserialize)]pub struct TrendMetrics{pub days:Vec<DailyTrend>,pub active_days:u64,pub current_streak:u64,pub longest_streak:u64,pub peak_day:Option<String>,pub peak_tokens:u64,pub active_seconds:u64}
/// 账本库统一路径（scan 与趋势读取同源，避免两处拼接漂移）。
pub fn ledger_db_path()->PathBuf{crate::config::get_config_dir().join("ledger-v1.sqlite")}
/// 每日趋势序列（day 升序、逐日连续、缺日补 0），以 daily_archive 为主数据源：
/// 归档是 max-upsert 快照，上次扫描后新增的消耗由 events 重算补齐——按 (day,source,model)
/// 与归档值取 max（与归档写入同语义，重算变小不回退），再按 (day,source) 汇总。
/// 切天与「今天」都按 frozen_tz 冻结时区的本地午夜（禁止 UTC，与归档口径一致），
/// 窗口为最近 cap_days 天；更早的归档日不输出。
pub fn daily_trends(db_path:&Path,cap_days:u32)->Result<Vec<DailyTrend>,String>{
    if cap_days==0{return Ok(vec![])}
    let db=database(db_path)?;
    let tz=frozen_tz(&db);
    let today=chrono::Utc::now().with_timezone(&tz).date_naive();
    let first=today-chrono::Duration::days(cap_days as i64-1);
    let mut merged:BTreeMap<(String,String,String),[u64;4]>=BTreeMap::new();
    {
        let mut stmt=db.prepare("SELECT day,source,model,input,output,cache_read,cache_write FROM daily_archive").map_err(|_|"趋势读取失败")?;
        let rows=stmt.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,[r.get::<_,u64>(3)?,r.get::<_,u64>(4)?,r.get::<_,u64>(5)?,r.get::<_,u64>(6)?]))).map_err(|_|"趋势读取失败")?;
        for (day,source,model,c) in rows.flatten(){*merged.entry((day,source,model)).or_insert([0;4])=c;}
    }
    // events 重算值更大则取重算值：与 archive_daily 同查询、同冻结时区切天。
    {
        let mut stmt=db.prepare("SELECT source,model,ts,MAX(input),MAX(output),MAX(cache_read),MAX(cache_write) FROM events GROUP BY source,event_id").map_err(|_|"趋势读取失败")?;
        let rows=stmt.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?,[r.get::<_,u64>(3)?,r.get::<_,u64>(4)?,r.get::<_,u64>(5)?,r.get::<_,u64>(6)?]))).map_err(|_|"趋势读取失败")?;
        for (source,model,ts,c) in rows.flatten(){
            let Some(day)=chrono::DateTime::from_timestamp(ts,0).map(|d|d.with_timezone(&tz).format("%Y-%m-%d").to_string())else{continue};
            let e=merged.entry((day,source,model)).or_insert([0;4]);
            for i in 0..4{e[i]=e[i].max(c[i]);}
        }
    }
    let mut per_day_source:BTreeMap<(String,String),u64>=BTreeMap::new();
    let mut sources=std::collections::BTreeSet::new();
    // per_source 契约（见 DailyTrend 注释）：只列「窗口内出现过的来源」——daily_archive 无删除路径，
    // 更早历史的归档日会永久留存，不得把这些来源以 0 值带进窗口内每一天的 per_source。
    // day 键恒为 "%Y-%m-%d"，字典序即日期序。
    let (first_key,today_key)=(first.format("%Y-%m-%d").to_string(),today.format("%Y-%m-%d").to_string());
    for ((day,source,_model),c) in &merged{
        *per_day_source.entry((day.clone(),source.clone())).or_insert(0)+=c[0]+c[1]+c[2]+c[3];
        if day.as_str()>=first_key.as_str()&&day.as_str()<=today_key.as_str(){sources.insert(source.clone());}
    }
    let mut out=Vec::with_capacity(cap_days as usize);
    let mut d=first;
    while d<=today{
        let day=d.format("%Y-%m-%d").to_string();
        let mut tokens=0u64;let mut per_source=BTreeMap::new();
        for s in &sources{let v=per_day_source.get(&(day.clone(),s.clone())).copied().unwrap_or(0);per_source.insert(s.clone(),v);tokens+=v;}
        out.push(DailyTrend{day,tokens,per_source});
        d+=chrono::Duration::days(1);
    }
    Ok(out)
}
/// 活跃天数：tokens>0 的天数。
pub fn active_days(days:&[DailyTrend])->u64{days.iter().filter(|d|d.tokens>0).count() as u64}
/// 当前连续天数：对齐 token-monitor computeStreaks，从序列末尾（冻结时区今天）回走，
/// 今天不活跃（tokens=0）即 0，遇断档停止。
pub fn current_streak(days:&[DailyTrend])->u64{days.iter().rev().take_while(|d|d.tokens>0).count() as u64}
/// 最长连续天数：排序扫连续段——按日历日相邻判定（跨月/跨年用日期运算，不按序号），
/// 中断（断档日或缺口）后重新起段。
pub fn longest_streak(days:&[DailyTrend])->u64{
    let mut best=0u64;let mut run=0u64;let mut prev:Option<chrono::NaiveDate>=None;
    for d in days{
        let Ok(date)=chrono::NaiveDate::parse_from_str(&d.day,"%Y-%m-%d")else{continue};
        run=if d.tokens>0{if prev.is_some_and(|p|date==p+chrono::Duration::days(1)){run+1}else{1}}else{0};
        best=best.max(run);prev=Some(date);
    }
    best
}
/// 峰值单日：tokens 最大的 day（并列取最早）；空数据返回 None。
pub fn peak_day(days:&[DailyTrend])->Option<(String,u64)>{
    days.iter().fold(None,|acc:Option<(String,u64)>,d|match acc{
        Some((_,max)) if max>=d.tokens=>acc,
        _=>Some((d.day.clone(),d.tokens)),
    })
}
/// 纯函数指标汇总（trend_metrics 命令与导出共用）；active_seconds 恒 0，由 trend_report 查库填充。
pub fn compute_metrics(days:&[DailyTrend])->TrendMetrics{
    let (peak_day,peak_tokens)=peak_day(days).map(|(d,t)|(Some(d),t)).unwrap_or((None,0));
    TrendMetrics{days:days.to_vec(),active_days:active_days(days),current_streak:current_streak(days),longest_streak:longest_streak(days),peak_day,peak_tokens,active_seconds:0}
}
/// 读取趋势并计算指标（trend_metrics 命令入口）。active_seconds 汇总 daily_active 中
/// 落在窗口（首日..=末日）内的天：跨 source 不去重、并行累计；窗口外的历史峰值不计入。
pub fn trend_report(db_path:&Path)->Result<TrendMetrics,String>{
    let days=daily_trends(db_path,TREND_CAP_DAYS)?;
    let mut m=compute_metrics(&days);
    if let (Some(first),Some(last))=(days.first(),days.last()){
        m.active_seconds=daily_active(db_path)?.into_iter().filter(|(d,_)|d.as_str()>=first.day.as_str()&&d.as_str()<=last.day.as_str()).map(|(_,s)|s).sum();
    }
    Ok(m)
}

/// 每日活跃秒数：同 source 内按 ts 升序，相邻事件间隔 ≤5 分钟（≤300s）视为同一活动段，
/// 段时长 = Σ min(间隔,300s)——段内间隔本就 ≤300s，>300s 即切段不计时（长会话跨小时不膨胀）；
/// 段计入起始日（较早事件的冻结时区 day 键，跨天段不拆分）。跨 source 不去重：
/// 同时开多个工具按并行累计。与 daily_archive 同语义 max-upsert：重算变小不回退，
/// 源日志清理后保留历史峰值。事件先按 (source,event_id) 去重（同 archive_daily，跨文件移动不双计）。
fn active_daily(db:&Connection)->Result<(),String>{
    let tz=frozen_tz(db);
    let mut stmt=db.prepare("SELECT source,MIN(ts) AS mts FROM events GROUP BY source,event_id ORDER BY source,mts").map_err(|_|"活跃时长读取失败")?;
    let rows=stmt.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?))).map_err(|_|"活跃时长读取失败")?;
    let mut active:BTreeMap<String,u64>=BTreeMap::new();
    let mut prev:Option<(String,i64)>=None;
    for (source,ts) in rows.flatten(){
        if let Some((ps,pts))=&prev{if *ps==source{let gap=ts-*pts;if gap>0&&gap<=300{if let Some(day)=chrono::DateTime::from_timestamp(*pts,0).map(|d|d.with_timezone(&tz).format("%Y-%m-%d").to_string()){*active.entry(day).or_insert(0)+=gap as u64;}}}}
        prev=Some((source,ts));
    }
    let mut up=db.prepare("INSERT INTO daily_active(day,seconds) VALUES(?,?) ON CONFLICT(day) DO UPDATE SET seconds=MAX(seconds,excluded.seconds)").map_err(|_|"活跃时长写入失败")?;
    for (day,seconds) in &active{up.execute(params![day,*seconds]).map_err(|_|"活跃时长写入失败")?;}
    Ok(())
}
/// 读取每日活跃秒数（day 升序），供「活跃时间」指标卡与导出使用。
pub fn daily_active(db_path:&Path)->Result<Vec<(String,u64)>,String>{
    let db=database(db_path)?;
    let mut stmt=db.prepare("SELECT day,seconds FROM daily_active ORDER BY day ASC").map_err(|_|"活跃时长读取失败")?;
    let rows=stmt.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,u64>(1)?))).map_err(|_|"活跃时长读取失败")?;
    Ok(rows.flatten().collect())
}

fn estimate_model_cost(model: &str, counts: &[u64; 4]) -> Option<f64> {
    let m = model.to_lowercase();
    let (in_p, out_p, cr_p, cw_p) = if m.contains("claude-3-5-sonnet") || m.contains("claude-3-7-sonnet") || m.contains("claude-sonnet") {
        (3.0, 15.0, 0.30, 3.75)
    } else if m.contains("claude-3-opus") || m.contains("claude-opus") {
        (15.0, 75.0, 1.50, 18.75)
    } else if m.contains("claude-3-5-haiku") || m.contains("claude-haiku") {
        (0.80, 4.0, 0.08, 1.00)
    } else if m.contains("gpt-4o-mini") {
        (0.15, 0.60, 0.075, 0.0)
    } else if m.contains("gpt-4o") {
        (2.50, 10.0, 1.25, 0.0)
    } else if m.contains("o1") {
        (15.0, 60.0, 7.50, 0.0)
    } else if m.contains("o3-mini") {
        (1.10, 4.40, 0.55, 0.0)
    } else if m.contains("deepseek") {
        (0.14, 0.28, 0.014, 0.0)
    } else if m.contains("gemini-1.5-flash") || m.contains("gemini-2.0-flash") || m.contains("gemini-2.5-flash") {
        (0.075, 0.30, 0.01875, 0.0)
    } else if m.contains("gemini-1.5-pro") || m.contains("gemini-2.5-pro") {
        (1.25, 5.00, 0.3125, 0.0)
    } else {
        // 未知模型不计价（A14）：裸 "flash"/"pro" 兜底会把其他厂商同名子串误套 gemini 价格。
        return None;
    };
    let cost = (counts[0] as f64 * in_p + counts[1] as f64 * out_p + counts[2] as f64 * cr_p + counts[3] as f64 * cw_p) / 1_000_000.0;
    Some(cost)
}

/// Round5B 项目一：会话分页大小（每页 50）与逐事件明细上限（500，超出标注截断）。
pub const SESSION_PAGE_SIZE:u32=50;
pub const SESSION_DETAIL_CAP:usize=500;
/// 单参数上限防御：分页大小超过该值按上限截取，避免一次性拖出全部会话。
pub const SESSION_PAGE_MAX:u32=200;
/// 会话与事件 key 的分隔符：path_key 恒为 64 位小写十六进制（不含 '#'），首现 '#' 即会话边界。
const SESSION_KEY_SEP:char='#';
/// 复合会话路径 = `{path_key}#{session}`；整体聚合降级行用固定合成键（真实 session_id 恒带
/// sess_ 前缀，不会撞名）。
fn split_session_path(path:&str)->Option<(&str,&str)>{path.split_once(SESSION_KEY_SEP)}
/// ZCode CLI 库降级行（无 session 维度）的诚实标注文案。
pub const ZCODE_WHOLE_LIBRARY_NOTE:&str="按 CLI 库整体聚合，无会话拆分";
/// 会话级行：一个转录文件（jsonl/session 文件）或 ZCode CLI 库的一个 session 键 = 一个会话。
/// `path` 是明细查询键（不可逆 path_key 或其复合路径），全路径不出 Rust；
/// `title` 只含文件名尾段或 CLI session 键，不含任何转录正文。
#[derive(Debug,Clone,Serialize)]
pub struct SessionRow{pub source:String,pub path:String,pub session:Option<String>,pub title:String,pub note:Option<String>,pub first_ts:i64,pub last_ts:i64,pub input:u64,pub output:u64,pub cache_read:u64,pub cache_write:u64,pub cost_estimate:Option<f64>,pub events:u64,pub models:u64}
/// 会话内单事件（逐次调用的 token 拆分）；ts 为 epoch 秒。
#[derive(Debug,Clone,Serialize)]
pub struct SessionEvent{pub ts:i64,pub model:String,pub input:u64,pub output:u64,pub cache_read:u64,pub cache_write:u64}
/// 会话明细：按 ts 升序的逐事件列表（上限 SESSION_DETAIL_CAP，超出 truncated=true）+ 总事件数。
#[derive(Debug,Clone,Serialize)]
pub struct SessionDetail{pub path:String,pub total:u64,pub truncated:bool,pub events:Vec<SessionEvent>}
/// 会话列表：按 events.path 聚合（ZCode CLI 库按其 session 键的复合路径），先按
/// (source,event_id) 去重（与 Summary 同口径，跨文件移动不双计），再按 (source,path,model)
/// 分桶取 SUM，Rust 侧按 (source,path) 折成会话行。多模型会话的各模型桶 MAX(ts) 不同，
/// SQL 桶序会被其他会话的桶隔开——折叠不能只看相邻桶（会把一会话拆成多行、数值均为部分值），
/// 必须按键全量聚合后再统一按「末次活动倒序 + 稳定次序键（source,path）」排序分页。
/// cost 口径与 Summary 一致：已知定价模型的分桶求和，全未知定价 → None（显示「—」，不当 0）。
pub fn sessions(db_path:&Path,source:Option<&str>,offset:u32,limit:u32)->Result<Vec<SessionRow>,String>{
    if limit==0{return Err("会话分页大小无效".into())}
    let limit=limit.min(SESSION_PAGE_MAX);
    let db=database(db_path)?;
    let mut stmt=db.prepare("SELECT d.source,d.path,d.model,SUM(d.input),SUM(d.output),SUM(d.cache_read),SUM(d.cache_write),COUNT(*),MIN(d.ts),MAX(d.ts) FROM (SELECT source,path,event_id,ts,model,MAX(input) AS input,MAX(output) AS output,MAX(cache_read) AS cache_read,MAX(cache_write) AS cache_write FROM events GROUP BY source,event_id) d WHERE (?1 IS NULL OR d.source=?1) GROUP BY d.source,d.path,d.model").map_err(|_|"会话查询失败")?;
    let rows=stmt.query_map(params![source],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,[r.get::<_,u64>(3)?,r.get::<_,u64>(4)?,r.get::<_,u64>(5)?,r.get::<_,u64>(6)?],r.get::<_,u64>(7)?,r.get::<_,i64>(8)?,r.get::<_,i64>(9)?))).map_err(|_|"会话读取失败")?;
    struct Acc{first:i64,last:i64,input:u64,output:u64,cache_read:u64,cache_write:u64,events:u64,cost:f64,any_cost:bool,models:BTreeSet<String>}
    // 键控聚合：同会话的模型桶无需相邻（见函数注释），按 (source,path) 折叠到同一行。
    let mut all:Vec<(SessionRow,Acc)>=vec![];
    let mut index:BTreeMap<(String,String),usize>=BTreeMap::new();
    for (bsource,bpath,model,c,count,first,last) in rows.flatten(){
        let i=*index.entry((bsource.clone(),bpath.clone())).or_insert_with(||{
            all.push((SessionRow{source:bsource.clone(),path:bpath.clone(),session:split_session_path(&bpath).map(|(_,s)|s.to_string()),title:String::new(),note:None,first_ts:first,last_ts:last,input:0,output:0,cache_read:0,cache_write:0,cost_estimate:None,events:0,models:0},Acc{first,last,input:0,output:0,cache_read:0,cache_write:0,events:0,cost:0.0,any_cost:false,models:BTreeSet::new()}));
            all.len()-1
        });
        let a=&mut all[i].1;
        a.first=a.first.min(first);a.last=a.last.max(last);
        a.input+=c[0];a.output+=c[1];a.cache_read+=c[2];a.cache_write+=c[3];a.events+=count;
        a.models.insert(model.clone());
        if let Some(cost)=estimate_model_cost(&model,&c){a.cost+=cost;a.any_cost=true;}
    }
    // 聚合完成后统一排序：末次活动倒序 + 稳定次序键（source,path），SQL 桶序不再参与。
    all.sort_by(|a,b|b.1.last.cmp(&a.1.last).then_with(||a.0.source.cmp(&b.0.source)).then_with(||a.0.path.cmp(&b.0.path)));
    let start=(offset as usize).min(all.len());
    let end=(start+limit as usize).min(all.len());
    let mut titles=db.prepare("SELECT title FROM session_titles WHERE path=?").map_err(|_|"会话标题读取失败")?;
    let mut out=Vec::with_capacity(end-start);
    for (mut row,a) in all.into_iter().skip(start).take(end-start){
        // 模型数在分页前已折算完毕（一会话多模型取并集），随行返回。
        row.first_ts=a.first;row.last_ts=a.last;row.input=a.input;row.output=a.output;row.cache_read=a.cache_read;row.cache_write=a.cache_write;row.events=a.events;row.models=a.models.len() as u64;
        row.cost_estimate=if a.any_cost{Some((a.cost*100.0).round()/100.0)}else{None};
        // 标题：优先扫描期写入的文件名尾段（ZCode 整体聚合行写的是库文件名）；
        // 缺失（旧库升级后未重扫）回退 session 键 / 短 key，不编造文件名。
        let sess=row.session.clone();
        row.title=titles.query_row(params![row.path],|r|r.get::<_,String>(0)).ok()
            .unwrap_or_else(||match sess.as_deref(){Some(s)=>s.to_string(),None=>format!("{}…",&row.path[..row.path.len().min(8)])});
        // ZCode CLI 库降级行（合成键 whole-library）诚实标注：无会话维度。
        if sess.as_deref()==Some(ZCODE_WHOLE_LIBRARY_SESSION){row.note=Some(ZCODE_WHOLE_LIBRARY_NOTE.into());}
        out.push(row);
    }
    Ok(out)
}
/// 会话明细：单会话（events.path 精确匹配）逐事件列表，ts 升序，最多 SESSION_DETAIL_CAP 条，
/// 超出 truncated=true 并回传 total（前端标注「共 N 条，仅显示前 500 条」）。
/// 只读统计字段，不触碰任何转录正文。
pub fn session_detail(db_path:&Path,path:&str)->Result<SessionDetail,String>{
    let db=database(db_path)?;
    let total:u64=db.query_row("SELECT COUNT(*) FROM events WHERE path=?",[path],|r|r.get(0)).map_err(|_|"会话明细读取失败")?;
    let mut stmt=db.prepare("SELECT ts,model,input,output,cache_read,cache_write FROM events WHERE path=? ORDER BY ts ASC,event_id ASC LIMIT ?").map_err(|_|"会话明细读取失败")?;
    let rows=stmt.query_map(params![path,SESSION_DETAIL_CAP as i64],|r|Ok(SessionEvent{ts:r.get(0)?,model:r.get(1)?,input:r.get(2)?,output:r.get(3)?,cache_read:r.get(4)?,cache_write:r.get(5)?})).map_err(|_|"会话明细读取失败")?;
    let events:Vec<SessionEvent>=rows.flatten().collect();
    let truncated=total as usize>events.len();
    Ok(SessionDetail{path:path.into(),total,truncated,events})
}
#[cfg(test)]mod tests{
    use super::*;use serde_json::json;
    #[test]fn month_cost_by_source_uses_priced_models_only(){
        // Round4 项目三：本月成本按来源拆分，与 total 同一处计价；未知定价模型不产生来源条目。
        let d=tempfile::tempdir().unwrap();let db=d.path().join("cache.db");
        let mk=|model:&str,input:u64|{let v=json!({"type":"assistant","timestamp":chrono::Utc::now().to_rfc3339(),"message":{"id":"m1","model":model,"usage":{"input_tokens":input,"output_tokens":100}}});format!("{v}\n")};
        let file=d.path().join("session.jsonl");
        fs::write(&file,mk("claude-sonnet-4",1_000_000)).unwrap();
        let s=scan_paths(7,&db,vec![("claude".into(),file.clone())],false).unwrap();
        assert_eq!(s.month_cost_by_source.get("claude").copied(),Some(3.0));
        assert_eq!(s.cost_estimate,Some(3.0),"本月口径与总窗口在本用例中重合");
        // 未知定价模型：不计价 → 空 map（前端显示 —，不当作 0）。
        fs::write(&file,mk("unknown-model-x",1_000_000)).unwrap();
        let s2=scan_paths(7,&db,vec![("claude".into(),file)],false).unwrap();
        assert!(s2.month_cost_by_source.is_empty());
        assert_eq!(s2.cost_estimate,None);
    }
    #[test]fn month_window_note_discloses_truncated_month(){
        // 窗口起点晚于本月 1 日（如 9/23 选 7 天=9/17 起）：本月成本=本月∩窗口，
        // 必须在 Summary.notes 披露截断，不得自称完整本月。
        let today=chrono::NaiveDate::from_ymd_opt(2026,9,23).unwrap();
        let note=month_window_note(chrono::NaiveDate::from_ymd_opt(2026,9,17).unwrap(),today).unwrap();
        assert!(note.contains("2026-09-17"),"{note}");
        assert!(note.contains("未覆盖本月月初"),"{note}");
        // 边界：窗口起点恰为本月 1 日（9/23 选 30 天）不提示；90 天恒覆盖整月不提示。
        assert_eq!(month_window_note(chrono::NaiveDate::from_ymd_opt(2026,9,1).unwrap(),today),None);
        assert_eq!(month_window_note(chrono::NaiveDate::from_ymd_opt(2026,6,26).unwrap(),today),None);
    }
    #[test]fn codex_cumulative_counts_cache_once(){let mut s=State{model:"model".into(),..Default::default()};let v=json!({"type":"event_msg","timestamp":"2026-09-17T00:00:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":30,"output_tokens":20}}}});assert_eq!(parse("codex",&v,&mut s,0).unwrap().counts,[70,20,30,0]);assert!(parse("codex",&v,&mut s,1).is_none());}
    #[test]fn incremental_roundtrip_no_double_count(){let d=tempfile::tempdir().unwrap();let file=d.path().join("session.jsonl");let db=d.path().join("cache.db");let v=json!({"type":"assistant","timestamp":chrono::Utc::now().to_rfc3339(),"message":{"id":"m1","model":"x","usage":{"input_tokens":10,"output_tokens":5}}});fs::write(&file,format!("{v}\n{v}\n")).unwrap();let paths=vec![("claude".into(),file)];let a=scan_paths(7,&db,paths.clone(),false).unwrap();let b=scan_paths(7,&db,paths,false).unwrap();assert_eq!(a.rows[0].input,10);assert_eq!(b.rows[0].input,10);assert_eq!(b.changed_files,0);}
    #[test]fn malformed_lines_are_partial(){let d=tempfile::tempdir().unwrap();let file=d.path().join("x.jsonl");fs::write(&file,"{bad}\n").unwrap();assert!(scan_paths(7,&d.path().join("db"),vec![("claude".into(),file)],false).unwrap().partial);}
    #[test]fn files_older_than_the_window_are_parsed_lazily(){
        let d=tempfile::tempdir().unwrap();let db=d.path().join("cache.db");let file=d.path().join("old.jsonl");
        let v=json!({"type":"assistant","timestamp":(chrono::Utc::now()-chrono::Duration::days(20)).to_rfc3339(),"message":{"id":"m1","model":"x","usage":{"input_tokens":10,"output_tokens":5}}});
        fs::write(&file,format!("{v}\n")).unwrap();
        File::options().write(true).open(&file).unwrap().set_modified(std::time::SystemTime::now()-std::time::Duration::from_secs(20*86400)).unwrap();
        let week=scan_paths(7,&db,vec![("claude".into(),file.clone())],false).unwrap();
        assert_eq!(week.changed_files,0,"a file untouched since before the window is not parsed for a 7-day query");
        let quarter=scan_paths(90,&db,vec![("claude".into(),file)],false).unwrap();
        assert_eq!(quarter.changed_files,1);assert_eq!(quarter.rows.iter().map(|r|r.input).sum::<u64>(),10);
    }
    #[test]fn gemini_transcripts_are_not_parsed(){
        let d=tempfile::tempdir().unwrap();let db=d.path().join("cache.db");let file=d.path().join("session-x.jsonl");
        fs::write(&file,"{\"sessionId\":\"a2a-server\",\"kind\":\"main\"}\n{\"$set\":{\"messages\":[]}}\n").unwrap();
        let s=scan_paths(7,&db,vec![("gemini".into(),file)],false).unwrap();
        assert_eq!(s.changed_files,0);assert!(s.rows.is_empty());assert_eq!(s.skipped_files,0);
    }
    #[test]fn gemini_session_with_long_prefix_is_parsed(){
        let d=tempfile::tempdir().unwrap();let db=d.path().join("cache.db");let file=d.path().join("session-valid.jsonl");
        let long_header=format!("{{\"sessionId\":\"gemini-long\",\"history\":\"{}\"}}\n", "a".repeat(3000));
        let ev=json!({"type":"gemini","timestamp":chrono::Utc::now().to_rfc3339(),"model":"gemini-2.5-pro","tokens":{"input":150,"output":50,"cached":20,"tool":10}});
        fs::write(&file,format!("{long_header}{ev}\n")).unwrap();
        let s=scan_paths(7,&db,vec![("gemini".into(),file)],false).unwrap();
        assert_eq!(s.changed_files,1);
        assert_eq!(s.rows.iter().map(|r|r.input).sum::<u64>(),140);
        assert_eq!(s.rows.iter().map(|r|r.output).sum::<u64>(),50);
    }
    #[test]fn codex_monotonic_reset_does_not_keep_stale_max(){
        let mut s=State{model:"gpt-4".into(),..Default::default()};
        let t1=json!({"type":"event_msg","timestamp":"2026-09-17T01:00:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":20}}}});
        let ev1=parse("codex",&t1,&mut s,0).unwrap();
        assert_eq!(ev1.counts,[100,20,0,0]);
        let t2=json!({"type":"event_msg","timestamp":"2026-09-17T01:05:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":40,"cached_input_tokens":0,"output_tokens":10}}}});
        let ev2=parse("codex",&t2,&mut s,1).unwrap();
        assert!(ev2.partial);
        assert_eq!(ev2.counts,[40,10,0,0]);
        let t3=json!({"type":"event_msg","timestamp":"2026-09-17T01:10:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":70,"cached_input_tokens":0,"output_tokens":25}}}});
        let ev3=parse("codex",&t3,&mut s,2).unwrap();
        assert_eq!(ev3.counts,[30,15,0,0]);
    }
    #[test]fn discovery_truncation_does_not_delete_events(){
        let d=tempfile::tempdir().unwrap();let db=d.path().join("cache.db");
        let file=d.path().join("first.jsonl");
        let v=json!({"type":"assistant","timestamp":chrono::Utc::now().to_rfc3339(),"message":{"id":"m1","model":"x","usage":{"input_tokens":10,"output_tokens":5}}});
        fs::write(&file,format!("{v}\n")).unwrap();
        let first_scan=scan_paths(7,&db,vec![("claude".into(),file.clone())],false).unwrap();
        assert_eq!(first_scan.rows[0].input,10);
        let truncated_scan=scan_paths(7,&db,vec![],true).unwrap();
        assert!(truncated_scan.coverage_gap);
        let verify_scan=scan_paths(7,&db,vec![("claude".into(),file)],false).unwrap();
        assert_eq!(verify_scan.rows[0].input,10);
    }
    #[test]fn claude_synthetic_placeholder_is_not_an_event(){
        let mut s=State::default();
        let v=json!({"type":"assistant","timestamp":"2026-09-17T00:00:00Z","message":{"id":"m","model":"<synthetic>","usage":{"input_tokens":0,"output_tokens":0}}});
        assert!(parse("claude",&v,&mut s,0).is_none());
    }
    #[test]fn archived_codex_session_is_not_double_counted(){
        let d=tempfile::tempdir().unwrap();let db=d.path().join("cache.db");
        let live=d.path().join("sessions");let archive=d.path().join("archived_sessions");fs::create_dir_all(&live).unwrap();fs::create_dir_all(&archive).unwrap();
        let ctx=json!({"type":"turn_context","payload":{"model":"gpt"}});
        let ev=json!({"type":"event_msg","timestamp":chrono::Utc::now().to_rfc3339(),"payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":20}}}});
        let first=live.join("rollout.jsonl");fs::write(&first,format!("{ctx}\n{ev}\n")).unwrap();
        let before=scan_paths(7,&db,vec![("codex".into(),first.clone())],false).unwrap();
        assert_eq!(before.rows.iter().map(|r|r.input).sum::<u64>(),100);
        let moved=archive.join("rollout.jsonl");fs::rename(&first,&moved).unwrap();
        let after=scan_paths(7,&db,vec![("codex".into(),moved)],false).unwrap();
        assert_eq!(after.rows.iter().map(|r|r.input).sum::<u64>(),100,"a session moved to archived_sessions must be counted once");
        let gone=scan_paths(7,&db,vec![],false).unwrap();
        assert!(gone.rows.is_empty(),"events of deleted files must not linger");
    }
    #[test]fn test_scan_cancellation_immediate(){
        let d=tempfile::tempdir().unwrap();let db=d.path().join("cache.db");
        let file=d.path().join("first.jsonl");
        let v=json!({"type":"assistant","timestamp":chrono::Utc::now().to_rfc3339(),"message":{"id":"m1","model":"x","usage":{"input_tokens":10,"output_tokens":5}}});
        fs::write(&file,format!("{v}\n")).unwrap();
        let res=scan_paths_with_cancel(7,&db,vec![("claude".into(),file)],false,&||true);
        assert!(res.is_err());
        assert_eq!(res.unwrap_err(),"已取消");
    }
    #[test]fn test_scan_cancellation_during_processing(){
        let d=tempfile::tempdir().unwrap();let db=d.path().join("cache.db");
        let file1=d.path().join("first.jsonl");let file2=d.path().join("second.jsonl");
        let v=json!({"type":"assistant","timestamp":chrono::Utc::now().to_rfc3339(),"message":{"id":"m1","model":"x","usage":{"input_tokens":10,"output_tokens":5}}});
        fs::write(&file1,format!("{v}\n")).unwrap();
        fs::write(&file2,format!("{v}\n")).unwrap();
        let counter=std::sync::atomic::AtomicUsize::new(0);
        let cancel_fn=move||{
            let count=counter.fetch_add(1,std::sync::atomic::Ordering::SeqCst);
            count >= 2
        };
        let res=scan_paths_with_cancel(7,&db,vec![("claude".into(),file1),("claude".into(),file2)],false,&cancel_fn);
        assert!(res.is_err());
        assert_eq!(res.unwrap_err(),"已取消");
    }
    #[test]fn daily_archive_keeps_max_observed_day_totals(){
        let d=tempfile::tempdir().unwrap();let db=d.path().join("cache.db");let file=d.path().join("a.jsonl");
        let ts="2020-01-15T12:00:00Z";let day=chrono::DateTime::from_timestamp(chrono::DateTime::parse_from_rfc3339(ts).unwrap().timestamp(),0).unwrap().with_timezone(&chrono::Local).format("%Y-%m-%d").to_string();
        let v=json!({"type":"assistant","timestamp":ts,"message":{"id":"m1","model":"x","usage":{"input_tokens":100,"output_tokens":20,"cache_read_input_tokens":7,"cache_creation_input_tokens":3}}});
        fs::write(&file,format!("{v}\n")).unwrap();
        scan_paths(7,&db,vec![("claude".into(),file.clone())],false).unwrap();
        let rows=archived_daily(&db).unwrap();
        assert_eq!(rows.len(),1);assert_eq!(rows[0].day,day);assert_eq!(rows[0].source,"claude");assert_eq!(rows[0].model,"x");
        assert_eq!((rows[0].input,rows[0].output,rows[0].cache_read,rows[0].cache_write),(100,20,7,3));
        // 源文件被重写为更小用量：重算变小不得降低归档。
        let small=json!({"type":"assistant","timestamp":ts,"message":{"id":"m1","model":"x","usage":{"input_tokens":30,"output_tokens":5}}});
        fs::write(&file,format!("{small}\n")).unwrap();
        scan_paths(7,&db,vec![("claude".into(),file)],false).unwrap();
        let kept=archived_daily(&db).unwrap();
        assert_eq!((kept[0].input,kept[0].output,kept[0].cache_read,kept[0].cache_write),(100,20,7,3),"a smaller recomputed day total must not lower the archive");
        // 源文件被清理（events 随 live 清理消失）：归档保留历史峰值。
        let gone=scan_paths(7,&db,vec![],false).unwrap();
        assert!(gone.rows.is_empty());
        assert_eq!(archived_daily(&db).unwrap()[0].input,100,"archived totals must survive source-side log cleanup");
    }
    #[test]fn daily_archive_keys_span_day_source_model(){
        let d=tempfile::tempdir().unwrap();let db=d.path().join("cache.db");
        let day_of=|ts:&str|chrono::DateTime::from_timestamp(chrono::DateTime::parse_from_rfc3339(ts).unwrap().timestamp(),0).unwrap().with_timezone(&chrono::Local).format("%Y-%m-%d").to_string();
        let (t1,t2)=("2020-01-15T12:00:00Z","2020-02-15T12:00:00Z");let (day1,day2)=(day_of(t1),day_of(t2));
        let ev=|ts:&str,id:&str,model:&str|json!({"type":"assistant","timestamp":ts,"message":{"id":id,"model":model,"usage":{"input_tokens":10,"output_tokens":2}}});
        let mut paths:Vec<(String,PathBuf)>=vec![];
        for (name,body) in [("d1",format!("{}\n",ev(t1,"a","x"))),("d2",format!("{}\n",ev(t2,"b","x"))),("d3",format!("{}\n{}\n",ev(t1,"c","y"),ev(t1,"d","y")))]{let f=d.path().join(format!("{name}.jsonl"));fs::write(&f,body).unwrap();paths.push(("claude".into(),f));}
        let ctx=json!({"type":"turn_context","payload":{"model":"gpt"}});
        let cev=json!({"type":"event_msg","timestamp":t1,"payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":40,"cached_input_tokens":0,"output_tokens":8}}}});
        let f4=d.path().join("rollout.jsonl");fs::write(&f4,format!("{ctx}\n{cev}\n")).unwrap();paths.push(("codex".into(),f4));
        scan_paths(90,&db,paths,false).unwrap();
        let rows=archived_daily(&db).unwrap();
        assert_eq!(rows.len(),4,"one archive row per (day,source,model)");
        let mut got:Vec<_>=rows.iter().map(|r|(r.day.clone(),r.source.clone(),r.model.clone(),r.input,r.output)).collect();got.sort();
        assert_eq!(got,vec![(day1.clone(),"claude".into(),"x".into(),10,2),(day1.clone(),"claude".into(),"y".into(),20,4),(day1,"codex".into(),"gpt".into(),40,8),(day2,"claude".into(),"x".into(),10,2)]);
        assert!(rows.windows(2).all(|w|w[0].day<=w[1].day),"archived days must come back in ascending order");
    }
    #[test]fn daily_archive_day_keys_are_frozen_against_timezone_changes(){
        let d=tempfile::tempdir().unwrap();let db_path=d.path().join("cache.db");
        // 模拟“建库后的系统时区变更”：预置冻结偏移 = 当前本地偏移 ∓7h（任一真实偏移下都合法）。
        let local_off=chrono::Local::now().offset().local_minus_utc();
        let shift=if local_off>=0{-25_200}else{25_200};
        let frozen=chrono::FixedOffset::east_opt(local_off+shift).unwrap();
        let db=database(&db_path).unwrap();
        db.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('archive_tz_offset_secs',?)",[frozen.local_minus_utc()]).unwrap();
        drop(db);
        // 事件选在冻结偏移与本地偏移落入不同日的时刻（本地午夜附近）。
        let base=chrono::Local::now().date_naive();
        let local_dt=if shift<0{base.and_hms_opt(0,1,0).unwrap()}else{(base-chrono::Duration::days(1)).and_hms_opt(23,59,0).unwrap()};
        let ts=local_dt.and_local_timezone(chrono::Local).earliest().unwrap().timestamp();
        let day_of=|tz:chrono::FixedOffset|chrono::DateTime::from_timestamp(ts,0).unwrap().with_timezone(&tz).format("%Y-%m-%d").to_string();
        let (frozen_day,local_day)=(day_of(frozen),day_of(*chrono::Local::now().offset()));
        assert_ne!(frozen_day,local_day,"test setup must place the event on different days under the two offsets");
        let v=json!({"type":"assistant","timestamp":chrono::DateTime::from_timestamp(ts,0).unwrap().to_rfc3339(),"message":{"id":"m1","model":"x","usage":{"input_tokens":10,"output_tokens":2}}});
        let v2=json!({"type":"assistant","timestamp":chrono::DateTime::from_timestamp(ts+60,0).unwrap().to_rfc3339(),"message":{"id":"m2","model":"x","usage":{"input_tokens":5,"output_tokens":1}}});
        let file=d.path().join("tz.jsonl");fs::write(&file,format!("{v}\n{v2}\n")).unwrap();
        scan_paths(90,&db_path,vec![("claude".into(),file)],false).unwrap();
        let rows=archived_daily(&db_path).unwrap();
        assert_eq!(rows.len(),1);
        assert_eq!(rows[0].day,frozen_day,"archive day keys must follow the offset frozen at first archive, not the current system timezone");
        // 活跃时长同用冻结偏移切天：60s 段计入 frozen_day。
        assert_eq!(daily_active(&db_path).unwrap(),vec![(frozen_day,60)],"active seconds must land on the frozen day key too");
    }
    #[test]fn zcode_transcripts_reuse_claude_parsing(){
        let mut s=State::default();
        let v=json!({"type":"assistant","timestamp":"2026-09-20T08:00:00Z","message":{"id":"z1","model":"glm-5","usage":{"input_tokens":11,"output_tokens":4,"cache_read_input_tokens":6,"cache_creation_input_tokens":2}}});
        let e=parse("zcode",&v,&mut s,0).unwrap();
        assert_eq!(e.counts,[11,4,6,2]);assert_eq!(e.model,"glm-5");assert_eq!(e.id,"z1");assert!(!e.partial);
        // 与 claude 相同：全零 usage 的 synthetic 占位记录不算事件；缺 id 降级为 partial+offset id。
        let zero=json!({"type":"assistant","timestamp":"2026-09-20T08:00:01Z","message":{"id":"z2","model":"<synthetic>","usage":{"input_tokens":0,"output_tokens":0}}});
        assert!(parse("zcode",&zero,&mut s,1).is_none());
        let noid=json!({"type":"assistant","timestamp":"2026-09-20T08:00:02Z","message":{"model":"glm-5","usage":{"input_tokens":3,"output_tokens":1}}});
        let e2=parse("zcode",&noid,&mut s,2).unwrap();
        assert_eq!(e2.id,"offset-2");assert!(e2.partial);
    }
    #[test]fn zcode_discovery_only_takes_jsonl(){
        let d=tempfile::tempdir().unwrap();
        let proj=d.path().join("v2").join("agent-config").join("claude").join("h1").join("projects").join("D--proj");
        fs::create_dir_all(&proj).unwrap();
        let v=json!({"type":"assistant","timestamp":chrono::Utc::now().to_rfc3339(),"message":{"id":"m1","model":"x","usage":{"input_tokens":10,"output_tokens":5}}});
        fs::write(proj.join("session-a.jsonl"),format!("{v}\n")).unwrap();
        fs::write(proj.join("notes.json"),"{\"x\":1}").unwrap();
        let root=d.path().join("v2").join("agent-config").join("claude");
        let mut truncated=false;let mut out=vec![];
        collect(&root,"zcode",&mut out,&mut truncated,&||false).unwrap();
        assert_eq!(out.len(),1,"only .jsonl transcripts are collected for zcode");
        assert_eq!(out[0].0,"zcode");assert!(out[0].1.ends_with("session-a.jsonl"));
    }
    #[test]fn zcode_sessions_are_counted_in_scan(){
        let d=tempfile::tempdir().unwrap();let db=d.path().join("cache.db");let file=d.path().join("transcript.jsonl");
        let v=json!({"type":"assistant","timestamp":chrono::Utc::now().to_rfc3339(),"message":{"id":"z1","model":"glm-5","usage":{"input_tokens":11,"output_tokens":4,"cache_read_input_tokens":6,"cache_creation_input_tokens":2}}});
        fs::write(&file,format!("{v}\n")).unwrap();
        let s=scan_paths(7,&db,vec![("zcode".into(),file)],false).unwrap();
        assert_eq!(s.changed_files,1);assert_eq!(s.rows.len(),1);
        assert_eq!(s.rows[0].source,"zcode");assert_eq!(s.rows[0].model,"glm-5");
        assert_eq!((s.rows[0].input,s.rows[0].output,s.rows[0].cache_read,s.rows[0].cache_write),(11,4,6,2));
    }
    /// 合成 ZCode CLI 库 fixture：建 model_usage 中被投影的列（与真实表同名列；真实表还有几十个
    /// 未引用列，SELECT 不受影响；session_id 为 Round5B 项目一新增投影列，真实表实测存在）。
    /// 值形态对齐真实探查：cached ⊆ input、started_at 毫秒、session_id 恒非空 sess_*。
    fn zcode_db_fixture()->(tempfile::TempDir,PathBuf){
        let d=tempfile::tempdir().unwrap();
        let path=d.path().join("db.sqlite");
        let c=rusqlite::Connection::open(&path).unwrap();
        c.execute_batch("CREATE TABLE model_usage(id TEXT PRIMARY KEY,model_id TEXT,status TEXT,started_at INTEGER,input_tokens INTEGER,output_tokens INTEGER,cache_read_input_tokens INTEGER,cache_creation_input_tokens INTEGER,session_id TEXT);").unwrap();
        let mut ins=c.prepare("INSERT INTO model_usage VALUES(?,?,?,?,?,?,?,?,?)").unwrap();
        // 376501 输入含 376384 缓存读（真实行形态）：非缓存输入=117。
        ins.execute(params!["u1","GLM-5.3","completed",1_787_509_531_012i64,376_501i64,44,376_384,0,"sess_a"]).unwrap();
        // 全零行必须跳过（synthetic 语义同 claude）。
        ins.execute(params!["u2","GLM-5.3","completed",1_787_509_531_013i64,0,0,0,0,"sess_a"]).unwrap();
        // 非完成状态：计真实消耗但降级 partial（模型取不同名，避免与前一行合并进同一 day/hour 桶）。
        ins.execute(params!["u3","GLM-5.3-Flash","error",1_787_509_531_014i64,1_000,50,0,0,"sess_b"]).unwrap();
        drop(ins);c.close().unwrap();
        (d,path)
    }
    #[test]
    fn zcode_cli_db_projects_model_usage_to_events(){
        let (d,dbf)=zcode_db_fixture();let db=d.path().join("cache.db");
        let s=scan_paths(90,&db,vec![("zcode".into(),dbf.clone())],false).unwrap();
        assert_eq!(s.changed_files,1);assert_eq!(s.skipped_files,0);
        let u1:Vec<&Row>=s.rows.iter().filter(|r|r.model=="GLM-5.3"&&!r.partial).collect();
        assert_eq!(u1.len(),1);
        assert_eq!((u1[0].input,u1[0].output,u1[0].cache_read,u1[0].cache_write),(117,44,376_384,0),"input is cached-inclusive: non-cached input = input - cache_read");
        // error 状态行计入但降级 partial（真实消耗不丢）。
        let err:Vec<&Row>=s.rows.iter().filter(|r|r.partial).collect();
        assert_eq!(err.len(),1);assert_eq!(err[0].input,1_000);assert_eq!(err[0].output,50);
        // 幂等重扫：库未变（size+有效 mtime 相同）→ 不重投影，行仍在。
        let b=scan_paths(90,&db,vec![("zcode".into(),dbf)],false).unwrap();
        assert_eq!(b.changed_files,0);
        assert_eq!(b.rows.iter().map(|r|r.input).sum::<u64>(),1_117);
    }
    #[test]
    fn zcode_cli_db_contradictions_and_unknown_models_are_flagged(){
        let d=tempfile::tempdir().unwrap();let dbf=d.path().join("db.sqlite");
        let c=rusqlite::Connection::open(&dbf).unwrap();
        c.execute_batch("CREATE TABLE model_usage(id TEXT PRIMARY KEY,model_id TEXT,status TEXT,started_at INTEGER,input_tokens INTEGER,output_tokens INTEGER,cache_read_input_tokens INTEGER,cache_creation_input_tokens INTEGER);").unwrap();
        let mut ins=c.prepare("INSERT INTO model_usage VALUES(?,?,?,?,?,?,?,?)").unwrap();
        // cache_read > input：cached ⊆ input 被破坏 → 异常 + partial，非缓存输入钳 0。
        ins.execute(params!["bad","GLM-5.3","completed",1_787_509_531_012i64,100,5,200,0]).unwrap();
        // 负数分项：钳 0 + 异常（count 语义不得静默归零掩盖）。
        ins.execute(params!["neg","GLM-5.3","completed",1_787_509_531_013i64,-8,4,0,0]).unwrap();
        // model_id 为 NULL：unknown + partial，不清零计数。
        ins.execute(params!["nomodel",Option::<String>::None,"completed",1_787_509_531_014i64,10,2,0,0]).unwrap();
        drop(ins);c.close().unwrap();
        let db=d.path().join("cache.db");
        let s=scan_paths(90,&db,vec![("zcode".into(),dbf)],false).unwrap();
        assert_eq!(s.anomalies,2,"cache>input and negative components must be counted as anomalies");
        let by:BTreeMap<&str,&Row>=s.rows.iter().map(|r|(r.model.as_str(),r)).collect();
        // bad（缓存钳 0）与 neg（负数钳 0）同模型同秒 → 合并进同一 day/hour 桶：output 5+4=9。
        assert_eq!((by["GLM-5.3"].input,by["GLM-5.3"].output,by["GLM-5.3"].cache_read),(0,9,200));
        assert!(by["GLM-5.3"].partial);
        let m=by.get("unknown").unwrap();
        assert_eq!((m.input,m.output),(10,2));assert!(m.partial);
    }
    #[test]
    fn zcode_cli_db_sidecar_wal_mtime_is_honored(){
        // -wal 副本比主库新（模拟运行中未 checkpoint 的写入）：有效 mtime 取最大值。
        let (d,dbf)=zcode_db_fixture();
        let main=fs::metadata(&dbf).unwrap().modified().unwrap().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos() as i64;
        std::thread::sleep(std::time::Duration::from_millis(10));
        fs::write(d.path().join("db.sqlite-wal"),b"x").unwrap();
        assert!(sqlite_effective_mtime(&dbf)>main,"wal sidecar must count toward the effective mtime");
        // -shm 不计入：只读连接每次打开库都会顶新 -shm 的 mtime（实测必变），
        // 计入会让 size+mtime 短路在 ZCode 运行期间永远失效 → 每轮全量重投影。
        let with_wal=sqlite_effective_mtime(&dbf);
        std::thread::sleep(std::time::Duration::from_millis(10));
        fs::write(d.path().join("db.sqlite-shm"),b"x").unwrap();
        assert_eq!(sqlite_effective_mtime(&dbf),with_wal,"a fresher -shm must NOT count toward the effective mtime");
        // 无副本时退化为文件自身 mtime。
        let plain=d.path().join("plain.bin");fs::write(&plain,b"z").unwrap();
        let pmt=fs::metadata(&plain).unwrap().modified().unwrap().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos() as i64;
        assert_eq!(sqlite_effective_mtime(&plain),pmt);
    }
    #[test]
    fn zcode_cli_db_schema_drift_is_skipped_not_fatal(){
        // 未来 ZCode 改表名/列名：prepare 失败 → skipped++（partial 披露），不得 panic 或误清历史。
        let d=tempfile::tempdir().unwrap();let dbf=d.path().join("db.sqlite");
        let c=rusqlite::Connection::open(&dbf).unwrap();
        c.execute_batch("CREATE TABLE other(x INTEGER);").unwrap();c.close().unwrap();
        let db=d.path().join("cache.db");
        let s=scan_paths(90,&db,vec![("zcode".into(),dbf)],false).unwrap();
        assert_eq!(s.skipped_files,1);assert!(s.partial);assert!(s.rows.is_empty());
    }
    #[test]
    fn opencode_message_json_parses(){
        let mut s=State::default();
        // 上游 v1.0.0 Assistant 形状（message-v2.ts）：tokens{input,output,reasoning,cache{read,write}}。
        let v=json!({"id":"msg_1","sessionID":"ses_1","role":"assistant","modelID":"claude-sonnet-4","providerID":"anthropic","time":{"created":1_787_509_531_012i64,"completed":1_787_509_540_000i64},"tokens":{"input":10,"output":4,"reasoning":0,"cache":{"read":6,"write":2}}});
        let e=parse("opencode",&v,&mut s,0).unwrap();
        assert_eq!(e.counts,[10,4,6,2]);assert_eq!(e.model,"claude-sonnet-4");assert_eq!(e.id,"msg_1");
        assert_eq!(e.ts,1_787_509_540,"completed (ms) wins as the event timestamp");
        // 部分格式覆盖：恒标 partial（input 是否含缓存无法本地核实）。
        assert!(e.partial);
        // 用户消息与缺 tokens 的行不算事件。
        assert!(parse("opencode",&json!({"role":"user","tokens":{"input":1,"output":1}}),&mut s,1).is_none());
        assert!(parse("opencode",&json!({"role":"assistant"}),&mut s,2).is_none());
        // 缺 completed 回退 created。
        let e2=parse("opencode",&json!({"id":"m2","role":"assistant","time":{"created":1_787_509_531_012i64},"tokens":{"input":1,"output":1}}),&mut s,3).unwrap();
        assert_eq!(e2.ts,1_787_509_531);
        // 负分项 → 异常 + 钳 0，不清零整行。
        let e3=parse("opencode",&json!({"id":"m3","role":"assistant","time":{"created":1_787_509_531_012i64},"tokens":{"input":-5,"output":3}}),&mut s,4).unwrap();
        assert_eq!(e3.counts,[0,3,0,0]);assert_eq!(s.anomalies,1);
    }
    #[test]
    fn opencode_message_files_are_counted_in_scan(){
        let d=tempfile::tempdir().unwrap();
        let msg=d.path().join("storage").join("message").join("ses_1");
        fs::create_dir_all(&msg).unwrap();
        let mk=|id:&str,role:&str,i:u64|json!({"id":id,"role":role,"modelID":"m","time":{"created":chrono::Utc::now().timestamp_millis()},"tokens":{"input":i,"output":2,"reasoning":0,"cache":{"read":0,"write":0}}}).to_string();
        let a=msg.join("msg_a.json");let b=msg.join("msg_b.json");
        fs::write(&a,mk("a","assistant",10)).unwrap();
        fs::write(&b,mk("b","user",99)).unwrap();
        let db=d.path().join("cache.db");
        let s=scan_paths(7,&db,vec![("opencode".into(),a),("opencode".into(),b)],false).unwrap();
        assert_eq!(s.changed_files,1,"single-object message .json must parse; the user message yields no event");
        assert_eq!(s.rows[0].source,"opencode");assert!(s.rows[0].partial);
        assert_eq!(s.rows[0].input,10);assert_eq!(s.rows[0].output,2);
        assert_eq!(s.skipped_files,0);
    }
    #[test]
    fn opencode_discovery_takes_both_layout_shapes(){
        let d=tempfile::tempdir().unwrap();
        let a=d.path().join("storage").join("message").join("s1").join("m.json");
        let b=d.path().join("storage").join("session").join("message").join("s2").join("m2.jsonl");
        fs::create_dir_all(a.parent().unwrap()).unwrap();fs::create_dir_all(b.parent().unwrap()).unwrap();
        fs::write(&a,"{}").unwrap();fs::write(&b,"").unwrap();
        for root in [d.path().join("storage").join("message"),d.path().join("storage").join("session").join("message")].iter(){
            let mut truncated=false;let mut out=vec![];
            collect(root,"opencode",&mut out,&mut truncated,&||false).unwrap();
            assert_eq!(out.len(),1);
        }
    }
    #[test]
    fn qwen_transcripts_reuse_claude_parsing(){
        let mut s=State::default();
        let v=json!({"type":"assistant","timestamp":"2026-09-20T08:00:00Z","message":{"id":"q1","model":"qwen3-max","usage":{"input_tokens":12,"output_tokens":5,"cache_read_input_tokens":3,"cache_creation_input_tokens":1}}});
        let e=parse("qwen",&v,&mut s,0).unwrap();
        assert_eq!(e.counts,[12,5,3,1]);assert_eq!(e.model,"qwen3-max");assert_eq!(e.id,"q1");assert!(!e.partial);
        // 同构守卫同样生效：全零 synthetic 占位不算事件。
        let zero=json!({"type":"assistant","timestamp":"2026-09-20T08:00:01Z","message":{"id":"q2","model":"<synthetic>","usage":{"input_tokens":0,"output_tokens":0}}});
        assert!(parse("qwen",&zero,&mut s,1).is_none());
    }
    #[test]
    fn qwen_sessions_are_counted_in_scan(){
        let d=tempfile::tempdir().unwrap();let db=d.path().join("cache.db");
        let proj=d.path().join("projects").join("D--proj");
        fs::create_dir_all(&proj).unwrap();
        let v=json!({"type":"assistant","timestamp":chrono::Utc::now().to_rfc3339(),"message":{"id":"q1","model":"qwen3-max","usage":{"input_tokens":12,"output_tokens":5}}});
        let sess=proj.join("sess.jsonl");
        fs::write(&sess,format!("{v}\n")).unwrap();
        fs::write(proj.join("meta.json"),"{\"x\":1}").unwrap();
        let s=scan_paths(7,&db,vec![("qwen".into(),sess)],false).unwrap();
        assert_eq!(s.changed_files,1);
        assert_eq!(s.rows[0].source,"qwen");assert_eq!(s.rows[0].model,"qwen3-max");
        assert_eq!((s.rows[0].input,s.rows[0].output),(12,5));
    }
    #[test]
    fn qwen_discovery_only_takes_jsonl(){
        // ~/.qwen/projects 同构布局：目录里混有非转录 .json（CLAUDE.md 缓存等），只收 .jsonl。
        let d=tempfile::tempdir().unwrap();
        let proj=d.path().join("projects").join("D--proj");
        fs::create_dir_all(&proj).unwrap();
        fs::write(proj.join("sess.jsonl"),"").unwrap();
        fs::write(proj.join("meta.json"),"{\"x\":1}").unwrap();
        let mut truncated=false;let mut out=vec![];
        collect(&d.path().join("projects"),"qwen",&mut out,&mut truncated,&||false).unwrap();
        assert_eq!(out.len(),1,"only .jsonl transcripts are collected for qwen");
        assert_eq!(out[0].0,"qwen");assert!(out[0].1.ends_with("sess.jsonl"));
    }
    #[test]
    fn extra_scan_paths_collect_and_count(){
        // Round5A 项目四：临时目录里的合成文件按对应 source 一并收集并计入统计。
        let d=tempfile::tempdir().unwrap();
        let sub=d.path().join("custom-logs");
        fs::create_dir_all(&sub).unwrap();
        let v=json!({"type":"assistant","timestamp":chrono::Utc::now().to_rfc3339(),"message":{"id":"x1","model":"glm-5","usage":{"input_tokens":10,"output_tokens":5}}});
        fs::write(sub.join("session.jsonl"),format!("{v}\n")).unwrap();
        let mut extra=BTreeMap::new();
        extra.insert("zcode".into(),vec![sub.to_string_lossy().to_string()]);
        let mut truncated=false;let mut out=vec![];
        extra_scan_paths(&extra,&mut out,&mut truncated,&||false).unwrap();
        assert_eq!(out.len(),1);assert_eq!(out[0].0,"zcode");assert!(out[0].1.ends_with("session.jsonl"));
        let db=d.path().join("cache.db");
        let s=scan_paths(7,&db,out,false).unwrap();
        assert_eq!(s.changed_files,1);assert_eq!(s.rows[0].source,"zcode");
        assert_eq!((s.rows[0].input,s.rows[0].output),(10,5));
    }
    #[test]
    fn extra_scan_paths_ignore_illegal_entries(){
        // 非法路径忽略不崩：相对路径与空串跳过；不存在的绝对路径按“目录缺失”静默跳过。
        let d=tempfile::tempdir().unwrap();
        let mut extra=BTreeMap::new();
        extra.insert("claude".into(),vec!["relative/dir".into(),String::new(),d.path().join("missing").to_string_lossy().to_string()]);
        let mut truncated=false;let mut out=vec![];
        extra_scan_paths(&extra,&mut out,&mut truncated,&||false).unwrap();
        assert!(out.is_empty(),"no entry may survive validation failures");
        // 取消请求照常传播。
        let mut out2=vec![];
        assert_eq!(extra_scan_paths(&extra,&mut out2,&mut truncated,&||true).unwrap_err(),"已取消");
    }
    #[test]
    fn extra_scan_paths_file_instead_of_dir_is_skipped_without_truncation(){
        // 误把文件路径配成扫描目录（绝对路径校验拦不住）：read_dir 返回 NotADirectory
        // （Windows os error 267），不得标 truncated——否则 Summary 永久出现 coverage_gap，
        // 与「仅一条路径无效」的实际不符；按无效路径静默跳过。
        let d=tempfile::tempdir().unwrap();
        let file=d.path().join("notes.jsonl");fs::write(&file,"{}\n").unwrap();
        let mut extra=BTreeMap::new();
        extra.insert("claude".into(),vec![file.to_string_lossy().to_string()]);
        let mut truncated=false;let mut out=vec![];
        extra_scan_paths(&extra,&mut out,&mut truncated,&||false).unwrap();
        assert!(out.is_empty());
        assert!(!truncated,"a file path misconfigured as a directory is a silent skip, not a coverage gap");
    }
    #[test]
    fn extra_scan_paths_cap_per_source(){
        // 防御式上限：保存命令会拒绝超量，这里兜底只取每来源前 20 条，不崩不越界。
        let d=tempfile::tempdir().unwrap();
        let mut dirs=vec![];
        for i in 0..25{let p=d.path().join(format!("d{i}"));fs::create_dir_all(&p).unwrap();fs::write(p.join("s.jsonl"),"").unwrap();dirs.push(p.to_string_lossy().to_string());}
        let mut extra=BTreeMap::new();
        extra.insert("claude".into(),dirs);
        let mut truncated=false;let mut out=vec![];
        extra_scan_paths(&extra,&mut out,&mut truncated,&||false).unwrap();
        assert_eq!(out.len(),20,"at most TOKEN_SPEND_EXTRA_PATHS_PER_SOURCE dirs per source");
        // 超出上限的第 21..25 个目录不得被收集。
        assert!(!out.iter().any(|(_,p)|p.to_string_lossy().contains("d20")));
    }
    #[test]fn claude_component_contradiction_is_flagged_and_counted(){
        let mut s=State::default();
        let mk=|id:&str,usage:Value|json!({"type":"assistant","timestamp":"2026-09-17T00:00:00Z","message":{"id":id,"model":"x","usage":usage}});
        let ok=mk("m1",json!({"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":3,"cache_creation_input_tokens":1}));
        let e=parse("claude",&ok,&mut s,0).unwrap();assert!(!e.partial);assert_eq!(e.counts,[10,5,3,1]);assert_eq!(s.anomalies,0);
        let bad=mk("m2",json!({"input_tokens":10,"output_tokens":-5,"cache_read_input_tokens":-3}));
        let e=parse("claude",&bad,&mut s,1).unwrap();assert!(e.partial);assert_eq!(e.counts,[10,0,0,0],"negative components must be flagged, not silently zeroed into trend numbers");assert_eq!(s.anomalies,1);
        let e=parse("claude",&mk("m3",json!({"input_tokens":7,"output_tokens":2})),&mut s,2).unwrap();
        assert!(!e.partial);assert_eq!(s.anomalies,1,"a following clean event must not be affected");
    }
    #[test]fn zcode_contradiction_fixtures_are_flagged_and_counted(){
        let mut s=State::default();
        let ok=json!({"type":"assistant","timestamp":"2026-09-20T08:00:00Z","message":{"id":"z1","model":"glm-5","usage":{"input_tokens":11,"output_tokens":4}}});
        assert!(!parse("zcode",&ok,&mut s,0).unwrap().partial);assert_eq!(s.anomalies,0);
        // 现有语义纳入计数：usage 对象存在但 input_tokens 缺失 → partial + 异常。
        let miss=json!({"type":"assistant","timestamp":"2026-09-20T08:00:01Z","message":{"id":"z2","model":"glm-5","usage":{"output_tokens":4}}});
        let e=parse("zcode",&miss,&mut s,1).unwrap();assert!(e.partial);assert_eq!(e.counts,[0,4,0,0]);assert_eq!(s.anomalies,1);
        // 分项负值 → partial + 异常。
        let neg=json!({"type":"assistant","timestamp":"2026-09-20T08:00:02Z","message":{"id":"z3","model":"glm-5","usage":{"input_tokens":-8,"output_tokens":4}}});
        let e=parse("zcode",&neg,&mut s,2).unwrap();assert!(e.partial);assert_eq!(e.counts,[0,4,0,0]);assert_eq!(s.anomalies,2);
    }
    #[test]fn codex_cached_delta_contradiction_is_flagged_and_counted(){
        let mut s=State{model:"gpt-4".into(),..Default::default()};
        let mk=|i:i64,c:i64,o:i64|json!({"type":"event_msg","timestamp":"2026-09-17T00:00:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":i,"cached_input_tokens":c,"output_tokens":o}}}});
        // 正常增量：cached 增量 ≤ input 增量，不受影响。
        let e=parse("codex",&mk(100,30,20),&mut s,0).unwrap();assert!(!e.partial);assert_eq!(e.counts,[70,20,30,0]);assert_eq!(s.anomalies,0);
        // delta 分量矛盾：缓存增量 60 > 输入增量 40（无 totals 回退），标 partial 并计数。
        let e=parse("codex",&mk(140,90,25),&mut s,1).unwrap();
        assert!(e.partial);assert_eq!(e.counts,[0,5,60,0]);assert_eq!(s.anomalies,1);
        // 回到正常增量：不再标矛盾。
        let e=parse("codex",&mk(160,100,30),&mut s,2).unwrap();assert!(!e.partial);assert_eq!(e.counts,[10,5,10,0]);assert_eq!(s.anomalies,1);
    }
    #[test]fn gemini_component_contradiction_is_flagged_and_counted(){
        let mut s=State::default();
        let mk=|i:i64,c:i64|json!({"type":"gemini","timestamp":"2026-09-17T00:00:00Z","model":"gemini-2.5-pro","tokens":{"input":i,"output":50,"cached":c,"tool":0}});
        let e=parse("gemini",&mk(100,30),&mut s,0).unwrap();assert_eq!(e.counts,[70,50,30,0]);assert_eq!(s.anomalies,0);
        // 来源内矛盾：cached > input（cached ⊆ input 口径），saturating_sub 不再静默掩盖。
        let e=parse("gemini",&mk(10,30),&mut s,1).unwrap();assert_eq!(e.counts,[0,50,30,0]);assert_eq!(s.anomalies,1);
        // 分项负值同样计数。
        let e=parse("gemini",&mk(-5,0),&mut s,2).unwrap();assert_eq!(e.counts,[0,50,0,0]);assert_eq!(s.anomalies,2);
    }
    #[test]fn editor_sources_component_contradiction_is_flagged_and_counted(){
        for source in ["cline","roocode","kilocode"]{
            let mut s=State::default();
            let mk=|tin:i64|json!({"say":"api_req_started","ts":"2026-09-17T00:00:00Z","text":json!({"tokensIn":tin,"tokensOut":5,"cacheReads":3,"cacheWrites":1,"model":"x"}).to_string()});
            let e=parse(source,&mk(10),&mut s,0).unwrap();assert_eq!(e.counts,[10,5,3,1]);assert_eq!(s.anomalies,0);
            let e=parse(source,&mk(-10),&mut s,1).unwrap();assert_eq!(e.counts,[0,5,3,1]);assert_eq!(s.anomalies,1);
        }
    }
    #[test]fn openclaw_component_contradiction_is_flagged_and_counted(){
        let mut s=State::default();
        let mk=|cr:i64|json!({"id":"o1","timestamp":"2026-09-17T00:00:00Z","message":{"role":"assistant","model":"x","usage":{"input":10,"output":5,"cacheRead":cr,"cacheWrite":1}}});
        let e=parse("openclaw",&mk(3),&mut s,0).unwrap();assert_eq!(e.counts,[10,5,3,1]);assert_eq!(s.anomalies,0);
        let e=parse("openclaw",&mk(-3),&mut s,1).unwrap();assert_eq!(e.counts,[10,5,0,1]);assert_eq!(s.anomalies,1);
    }
    #[test]fn legacy_state_without_anomalies_still_deserializes(){
        // 升级前持久化的 state 无 anomalies 字段；反序列化失败会清空 codex totals，导致升级后整段重复计数。
        let s:State=serde_json::from_str(r#"{"model":"gpt","totals":[100,20,30,0],"bad_lines":2}"#).unwrap();
        assert_eq!(s.totals,[100,20,30,0]);assert_eq!(s.bad_lines,2);assert_eq!(s.anomalies,0);
    }
    #[test]fn scan_surfaces_component_anomalies_in_summary(){
        let d=tempfile::tempdir().unwrap();let db=d.path().join("cache.db");let file=d.path().join("a.jsonl");
        let ok=json!({"type":"assistant","timestamp":chrono::Utc::now().to_rfc3339(),"message":{"id":"m1","model":"x","usage":{"input_tokens":10,"output_tokens":5}}});
        let bad=json!({"type":"assistant","timestamp":chrono::Utc::now().to_rfc3339(),"message":{"id":"m2","model":"x","usage":{"input_tokens":10,"output_tokens":-5}}});
        fs::write(&file,format!("{ok}\n{bad}\n")).unwrap();
        let s=scan_paths(7,&db,vec![("claude".into(),file)],false).unwrap();
        assert_eq!(s.anomalies,1);assert!(s.rows[0].partial);assert!(s.partial);
        assert!(s.notes.iter().any(|n|n.contains("1 条分项矛盾")),"anomaly count must surface in notes");
        // 正常数据：计数为 0、无对应 note。
        let d2=tempfile::tempdir().unwrap();let f2=d2.path().join("b.jsonl");fs::write(&f2,format!("{ok}\n")).unwrap();
        let clean=scan_paths(7,&d2.path().join("db2"),vec![("claude".into(),f2)],false).unwrap();
        assert_eq!(clean.anomalies,0);assert!(!clean.partial);assert!(!clean.notes.iter().any(|n|n.contains("分项矛盾")));
    }
    #[test]fn daily_active_dense_events_sum_gaps_within_segment(){
        let d=tempfile::tempdir().unwrap();let db=d.path().join("cache.db");let file=d.path().join("a.jsonl");
        let t0=chrono::Utc::now().timestamp();
        let mk=|id:&str,ts:i64|json!({"type":"assistant","timestamp":chrono::DateTime::from_timestamp(ts,0).unwrap().to_rfc3339(),"message":{"id":id,"model":"x","usage":{"input_tokens":1,"output_tokens":1}}});
        // 密集：60s 间隔的三事件同一活动段，段长=60+60=120s。
        fs::write(&file,format!("{}\n{}\n{}\n",mk("a",t0),mk("b",t0+60),mk("c",t0+120))).unwrap();
        scan_paths(7,&db,vec![("claude".into(),file.clone())],false).unwrap();
        assert_eq!(daily_active(&db).unwrap().iter().map(|(_,s)|*s).sum::<u64>(),120);
        // 重算变小（只剩单个事件，无相邻间隔）不得降低：与 daily_archive 同语义 max-upsert 防回退。
        fs::write(&file,format!("{}\n",mk("solo",t0+120))).unwrap();
        scan_paths(7,&db,vec![("claude".into(),file)],false).unwrap();
        assert_eq!(daily_active(&db).unwrap().iter().map(|(_,s)|*s).sum::<u64>(),120,"a smaller recomputed activity must not lower daily_active");
    }
    #[test]fn daily_active_sparse_gaps_break_segments(){
        let d=tempfile::tempdir().unwrap();let db=d.path().join("cache.db");
        let t0=chrono::Utc::now().timestamp();
        let mk=|id:&str,ts:i64|json!({"type":"assistant","timestamp":chrono::DateTime::from_timestamp(ts,0).unwrap().to_rfc3339(),"message":{"id":id,"model":"x","usage":{"input_tokens":1,"output_tokens":1}}});
        // 恰 300s（≤5min）计入，301s 切段不计，再 300s 计入：claude 合计 600s；zcode 全稀疏（700s 间隔）计 0。
        let f1=d.path().join("c.jsonl");fs::write(&f1,format!("{}\n{}\n{}\n{}\n",mk("a",t0),mk("b",t0+300),mk("c",t0+601),mk("d",t0+901))).unwrap();
        let f2=d.path().join("z.jsonl");fs::write(&f2,format!("{}\n{}\n",mk("e",t0),mk("f",t0+700))).unwrap();
        scan_paths(7,&db,vec![("claude".into(),f1),("zcode".into(),f2)],false).unwrap();
        assert_eq!(daily_active(&db).unwrap().iter().map(|(_,s)|*s).sum::<u64>(),600);
    }
    #[test]fn daily_active_cross_day_segment_counts_into_starting_day(){
        let d=tempfile::tempdir().unwrap();let db=d.path().join("cache.db");let file=d.path().join("a.jsonl");
        let base=chrono::Local::now().date_naive();
        let t1=base.and_hms_opt(23,59,0).unwrap().and_local_timezone(chrono::Local).earliest().unwrap();
        let t2=t1+chrono::Duration::minutes(2);
        let mk=|id:&str,ts:chrono::DateTime<chrono::Local>|json!({"type":"assistant","timestamp":ts.to_rfc3339(),"message":{"id":id,"model":"x","usage":{"input_tokens":1,"output_tokens":1}}});
        fs::write(&file,format!("{}\n{}\n",mk("a",t1),mk("b",t2))).unwrap();
        scan_paths(7,&db,vec![("claude".into(),file)],false).unwrap();
        assert_eq!(daily_active(&db).unwrap(),vec![(t1.format("%Y-%m-%d").to_string(),120)],"a segment crossing midnight must land entirely on the starting day");
    }
    #[test]fn daily_active_empty_when_no_events(){
        let d=tempfile::tempdir().unwrap();let db=d.path().join("cache.db");
        scan_paths(7,&db,vec![],false).unwrap();
        assert!(daily_active(&db).unwrap().is_empty());
    }
    #[test]fn daily_active_parallel_sources_are_summed_without_dedup(){
        let d=tempfile::tempdir().unwrap();let db=d.path().join("cache.db");
        let t0=chrono::Utc::now().timestamp();
        let mk=|id:&str,ts:i64|json!({"type":"assistant","timestamp":chrono::DateTime::from_timestamp(ts,0).unwrap().to_rfc3339(),"message":{"id":id,"model":"x","usage":{"input_tokens":1,"output_tokens":1}}});
        let f1=d.path().join("c.jsonl");fs::write(&f1,format!("{}\n{}\n",mk("a",t0),mk("b",t0+60))).unwrap();
        let f2=d.path().join("z.jsonl");fs::write(&f2,format!("{}\n{}\n",mk("a",t0),mk("b",t0+60))).unwrap();
        scan_paths(7,&db,vec![("claude".into(),f1),("zcode".into(),f2)],false).unwrap();
        assert_eq!(daily_active(&db).unwrap().iter().map(|(_,s)|*s).sum::<u64>(),120,"parallel sources must accumulate, not dedupe");
    }
    fn trend(day:&str,tokens:u64)->DailyTrend{DailyTrend{day:day.into(),tokens,per_source:BTreeMap::new()}}
    #[test]
    fn trend_metric_edge_cases(){
        // 空数据：全 0，峰值为 None。
        let empty:Vec<DailyTrend>=vec![];
        assert_eq!(active_days(&empty),0);assert_eq!(current_streak(&empty),0);assert_eq!(longest_streak(&empty),0);assert_eq!(peak_day(&empty),None);
        // 月界：01-30..01-31 与 02-02..02-03 各 2 天连续段，中间 02-01 断档；今天（末尾 02-04）不活跃。
        let days=vec![trend("2026-01-30",10),trend("2026-01-31",20),trend("2026-02-01",0),trend("2026-02-02",5),trend("2026-02-03",7),trend("2026-02-04",0)];
        assert_eq!(active_days(&days),4);
        assert_eq!(current_streak(&days),0,"an inactive today must zero the current streak even when yesterday was active");
        assert_eq!(longest_streak(&days),2);
        assert_eq!(peak_day(&days),Some(("2026-01-31".into(),20)));
        // 今天活跃：current 从末尾回走 2 天（02-05、02-06）。
        let mut tail=days.clone();tail.push(trend("2026-02-05",1));tail.push(trend("2026-02-06",2));
        assert_eq!(current_streak(&tail),2);assert_eq!(longest_streak(&tail),2);
        // 跨月连续：01-31 与 02-01 相邻即连续段，跨月不中断。
        let across=vec![trend("2026-01-29",0),trend("2026-01-30",1),trend("2026-01-31",1),trend("2026-02-01",1),trend("2026-02-02",1),trend("2026-02-03",0)];
        assert_eq!(longest_streak(&across),4);assert_eq!(current_streak(&across),0);
        // 跨年连续同理。
        let year=vec![trend("2025-12-30",1),trend("2025-12-31",1),trend("2026-01-01",1),trend("2026-01-02",1)];
        assert_eq!(longest_streak(&year),4);
        // 峰值并列取最早。
        let tie=vec![trend("2026-02-02",9),trend("2026-02-03",9)];
        assert_eq!(peak_day(&tie),Some(("2026-02-02".into(),9)));
        // compute_metrics 汇总一致。
        let m=compute_metrics(&tail);
        assert_eq!(m.active_days,6);assert_eq!(m.current_streak,2);assert_eq!(m.longest_streak,2);assert_eq!(m.peak_day.as_deref(),Some("2026-01-31"));assert_eq!(m.peak_tokens,20);assert_eq!(m.days.len(),8);
    }
    #[test]
    fn daily_trends_empty_db_is_zero_filled(){
        let d=tempfile::tempdir().unwrap();let db_path=d.path().join("cache.db");
        assert!(daily_trends(&db_path,0).unwrap().is_empty(),"cap_days=0 must yield an empty window");
        let trends=daily_trends(&db_path,7).unwrap();
        assert_eq!(trends.len(),7);
        assert!(trends.iter().all(|t|t.tokens==0&&t.per_source.is_empty()),"a fresh database must produce zero-filled days with no sources");
        // day 升序且逐日连续，末尾为今天。
        assert!(trends.windows(2).all(|w|chrono::NaiveDate::parse_from_str(&w[1].day,"%Y-%m-%d").unwrap()-chrono::NaiveDate::parse_from_str(&w[0].day,"%Y-%m-%d").unwrap()==chrono::Duration::days(1)));
        let today=chrono::Local::now().date_naive().format("%Y-%m-%d").to_string();
        assert_eq!(trends.last().unwrap().day,today);
    }
    #[test]
    fn daily_trends_merges_archive_with_event_recompute_by_max(){
        let d=tempfile::tempdir().unwrap();let db_path=d.path().join("cache.db");
        let db=database(&db_path).unwrap();
        // 冻结时区与测试进程本地偏移一致，day 断言才稳定（与现有 tz 冻结测试同法）。
        let off=chrono::Local::now().offset().local_minus_utc();
        db.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('archive_tz_offset_secs',?)",[off]).unwrap();
        let tz=chrono::FixedOffset::east_opt(off).unwrap();
        let today=chrono::Utc::now().with_timezone(&tz).date_naive();
        let day1=today-chrono::Duration::days(2);let day2=today-chrono::Duration::days(1);
        let ts_of=|date:chrono::NaiveDate|date.and_hms_opt(12,0,0).unwrap().and_utc().timestamp()-off as i64;
        let d1=day1.format("%Y-%m-%d").to_string();let d2=day2.format("%Y-%m-%d").to_string();let dnow=today.format("%Y-%m-%d").to_string();
        // 归档：d1 两个来源；today 一个来源（上次扫描时的较小值）。
        db.execute("INSERT INTO daily_archive VALUES(?,?,?,?,?,?,?)",params![d1,"claude","x",100,20,7,3]).unwrap();
        db.execute("INSERT INTO daily_archive VALUES(?,?,?,?,?,?,?)",params![d1,"zcode","glm-5",11,4,6,2]).unwrap();
        db.execute("INSERT INTO daily_archive VALUES(?,?,?,?,?,?,?)",params![dnow,"claude","x",5,1,0,0]).unwrap();
        // 窗口外的旧归档日不得输出。
        db.execute("INSERT INTO daily_archive VALUES(?,?,?,?,?,?,?)",params!["2000-01-01","claude","x",1,1,0,0]).unwrap();
        // events 重算：d1 更小（不得降低归档）；today 更大（取重算值，模拟上次扫描后的新增消耗）。
        db.execute("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?)",params!["p1","claude","e1",ts_of(day1),"x",30,5,0,0,0]).unwrap();
        db.execute("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?)",params!["p2","claude","e2",ts_of(today),"x",50,10,0,0,0]).unwrap();
        drop(db);
        let trends=daily_trends(&db_path,370).unwrap();
        assert_eq!(trends.len(),370);
        assert_eq!(trends[0].day,(today-chrono::Duration::days(369)).format("%Y-%m-%d").to_string());
        assert_ne!(trends.iter().any(|t|t.day=="2000-01-01"),true,"archive days older than the window must not be output");
        let by:BTreeMap<&str,&DailyTrend>=trends.iter().map(|t|(t.day.as_str(),t)).collect();
        // d1：归档 claude 130 + zcode 23 = 153；重算 35 更小不回退。缺失来源补 0。
        let t1=by[d1.as_str()];
        assert_eq!(t1.tokens,153);
        assert_eq!(t1.per_source.get("claude"),Some(&130));
        assert_eq!(t1.per_source.get("zcode"),Some(&23));
        // 中间空档日补 0：来源仍逐一列出、值为 0。
        let mid=by[d2.as_str()];
        assert_eq!(mid.tokens,0);
        assert_eq!(mid.per_source.get("claude"),Some(&0));
        // today：events 重算 60 大于归档 6 → 取重算值。
        let tnow=by[dnow.as_str()];
        assert_eq!(tnow.tokens,60,"a larger recomputed day total must replace the stale archive value");
        // 全窗口指标与 7 天小窗口并存。
        let m=compute_metrics(&trends);
        assert_eq!(m.peak_day.as_deref(),Some(d1.as_str()));assert_eq!(m.peak_tokens,153);assert_eq!(active_days(&trends),2);
        assert_eq!(daily_trends(&db_path,7).unwrap().len(),7);
        assert_eq!(daily_trends(&db_path,7).unwrap()[6].day,dnow);
    }
    #[test]
    fn daily_trends_per_source_lists_only_sources_seen_within_window(){
        let d=tempfile::tempdir().unwrap();let db_path=d.path().join("cache.db");
        let db=database(&db_path).unwrap();
        // 冻结时区与测试进程本地偏移一致，day 断言才稳定（与上方测试同法）。
        let off=chrono::Local::now().offset().local_minus_utc();
        db.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('archive_tz_offset_secs',?)",[off]).unwrap();
        let tz=chrono::FixedOffset::east_opt(off).unwrap();
        let today=chrono::Utc::now().with_timezone(&tz).date_naive();
        let d1=(today-chrono::Duration::days(1)).format("%Y-%m-%d").to_string();
        let dnow=today.format("%Y-%m-%d").to_string();
        // 窗口内 d1：claude。窗口外 400 天前：已停用的来源 retired——daily_archive 无删除路径，
        // 这行会永久留存，但不得把 retired 以 0 值带进窗口内每一天的 per_source。
        db.execute("INSERT INTO daily_archive VALUES(?,?,?,?,?,?,?)",params![d1,"claude","x",100,20,7,3]).unwrap();
        let old=(today-chrono::Duration::days(400)).format("%Y-%m-%d").to_string();
        db.execute("INSERT INTO daily_archive VALUES(?,?,?,?,?,?,?)",params![old,"retired","old-model",500,50,0,0]).unwrap();
        drop(db);
        let trends=daily_trends(&db_path,370).unwrap();
        assert_eq!(trends.len(),370);
        for t in &trends{
            assert!(t.per_source.get("retired").is_none(),"a source only seen before the window must not appear in per_source of {}",t.day);
        }
        let by:BTreeMap<&str,&DailyTrend>=trends.iter().map(|t|(t.day.as_str(),t)).collect();
        // d1 数值不受影响。
        assert_eq!(by[d1.as_str()].tokens,130);
        assert_eq!(by[d1.as_str()].per_source.get("claude"),Some(&130));
        // 窗口内出现过的来源仍逐一列出：today 无消耗也补 claude=0，且不带 retired。
        assert_eq!(by[dnow.as_str()].per_source.get("claude"),Some(&0));
        assert_eq!(by[dnow.as_str()].per_source.len(),1);
    }
    #[test]
    fn trend_report_active_seconds_sums_only_window_days(){
        let d=tempfile::tempdir().unwrap();let db_path=d.path().join("cache.db");
        let today=chrono::Local::now().date_naive();
        let db=database(&db_path).unwrap();
        // 窗口内今天 3600s + 窗口外 400 天前 7200s（max-upsert 留存的旧峰值）。
        db.execute("INSERT INTO daily_active(day,seconds) VALUES(?,?)",params![today.format("%Y-%m-%d").to_string(),3600]).unwrap();
        db.execute("INSERT INTO daily_active(day,seconds) VALUES(?,?)",params![(today-chrono::Duration::days(400)).format("%Y-%m-%d").to_string(),7200]).unwrap();
        drop(db);
        let m=trend_report(&db_path).unwrap();
        assert_eq!(m.active_seconds,3600,"active seconds outside the 370-day window must not be summed");
    }

    // ---------- Round5B 项目一：会话级明细（列表 / 分页 / 明细截断 / ZCode session 维度） ----------

    /// 两份 claude 转录 + 一份 codex 会话：按末次活动倒序、标题=文件名尾段、四分项求和、
    /// 事件数/模型数、成本（已知定价模型才计）、逐事件明细 ts 升序。
    #[test]
    fn sessions_aggregate_by_path_ordered_by_last_activity(){
        let d=tempfile::tempdir().unwrap();let db=d.path().join("cache.db");
        let t0=chrono::Utc::now().timestamp()-3_600;
        let claude=|id:&str,ts:i64,input:u64|json!({"type":"assistant","timestamp":chrono::DateTime::from_timestamp(ts,0).unwrap().to_rfc3339(),"message":{"id":id,"model":"claude-sonnet","usage":{"input_tokens":input,"output_tokens":10}}});
        let f1=d.path().join("alpha.jsonl");
        fs::write(&f1,format!("{}\n{}\n",claude("a1",t0,1_000_000),claude("a2",t0+100,500_000))).unwrap();
        let f2=d.path().join("beta.jsonl");
        fs::write(&f2,format!("{}\n",claude("b1",t0+50,10))).unwrap();
        let f3=d.path().join("rollout.jsonl");
        fs::write(&f3,format!("{}\n{}\n",json!({"type":"turn_context","payload":{"model":"gpt-4o"}}),json!({"type":"event_msg","timestamp":chrono::DateTime::from_timestamp(t0+200,0).unwrap().to_rfc3339(),"payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":20}}}}))).unwrap();
        scan_paths(7,&db,vec![("claude".into(),f1),("claude".into(),f2),("codex".into(),f3)],false).unwrap();
        let rows=sessions(&db,None,0,SESSION_PAGE_SIZE).unwrap();
        assert_eq!(rows.len(),3);
        // 末次活动倒序：rollout(t0+200) > alpha(t0+100) > beta(t0+50)。
        assert_eq!(rows.iter().map(|r|r.title.as_str()).collect::<Vec<_>>(),vec!["rollout.jsonl","alpha.jsonl","beta.jsonl"]);
        let alpha=&rows[1];
        assert_eq!(alpha.source,"claude");assert_eq!(alpha.events,2);assert_eq!(alpha.models,1);
        assert_eq!((alpha.input,alpha.output),(1_500_000,20));
        assert_eq!((alpha.first_ts,alpha.last_ts),(t0,t0+100));
        assert_eq!(alpha.session,None,"jsonl 会话不带复合 session 键");
        assert_eq!(alpha.note,None);
        // 成本：1.5M 非缓存输入 @3.0/M + 20 输出 @15/M ≈ 4.5003 → 两位小数 4.5。
        assert_eq!(alpha.cost_estimate,Some(4.5));
        // 明细：ts 升序、上限内不截断。
        let detail=session_detail(&db,&rows[1].path).unwrap();
        assert_eq!(detail.total,2);assert!(!detail.truncated);
        assert_eq!(detail.events.iter().map(|e|e.ts).collect::<Vec<_>>(),vec![t0,t0+100]);
        assert_eq!((detail.events[0].input,detail.events[0].output),(1_000_000,10));
        // 来源筛选：只保留该来源的会话。
        assert_eq!(sessions(&db,Some("claude"),0,SESSION_PAGE_SIZE).unwrap().len(),2);
        let codex=sessions(&db,Some("codex"),0,SESSION_PAGE_SIZE).unwrap();
        assert_eq!(codex.len(),1);assert_eq!(codex[0].title,"rollout.jsonl");
        assert_eq!(sessions(&db,Some("zcode"),0,SESSION_PAGE_SIZE).unwrap().len(),0);
    }

    #[test]
    fn sessions_multimodel_session_stays_one_row_when_buckets_interleave(){
        // 回归：会话中途切模型 → (source,path,model) 多桶、各桶 MAX(ts) 不同，其他会话的桶
        // 会按桶序隔开同会话的桶（sonnet@+100 → beta@+75 → haiku@+50）。相邻折叠会把 alpha
        // 拆成两行（tokens/事件数/模型数均为部分值，且多占一个分页席位）；必须按 (source,path)
        // 全量聚合为 2 行，alpha 四分项/事件数/模型数合并、成本分桶计价后求和。
        let d=tempfile::tempdir().unwrap();let db=d.path().join("cache.db");
        let t0=chrono::Utc::now().timestamp()-3_600;
        let ev=|id:&str,ts:i64,model:&str,input:u64|json!({"type":"assistant","timestamp":chrono::DateTime::from_timestamp(ts,0).unwrap().to_rfc3339(),"message":{"id":id,"model":model,"usage":{"input_tokens":input,"output_tokens":10}}});
        let f1=d.path().join("alpha.jsonl");
        fs::write(&f1,format!("{}\n{}\n",ev("a1",t0+100,"claude-sonnet",1_000_000),ev("a2",t0+50,"claude-haiku",500_000))).unwrap();
        let f2=d.path().join("beta.jsonl");
        fs::write(&f2,format!("{}\n",ev("b1",t0+75,"claude-sonnet",10))).unwrap();
        scan_paths(7,&db,vec![("claude".into(),f1),("claude".into(),f2)],false).unwrap();
        let rows=sessions(&db,None,0,SESSION_PAGE_SIZE).unwrap();
        assert_eq!(rows.len(),2,"a transcript with two models must not split into two rows");
        // 末次活动倒序：alpha(t0+100) > beta(t0+75)。
        assert_eq!(rows.iter().map(|r|r.title.as_str()).collect::<Vec<_>>(),vec!["alpha.jsonl","beta.jsonl"]);
        let alpha=&rows[0];
        assert_eq!((alpha.input,alpha.output),(1_500_000,20),"both model buckets must fold into the session row");
        assert_eq!(alpha.events,2);assert_eq!(alpha.models,2);
        assert_eq!((alpha.first_ts,alpha.last_ts),(t0+50,t0+100));
        // 成本：sonnet 1M@3.0+10@15 + haiku 0.5M@0.8+10@4 ≈ 3.40019 → 两位小数 3.4（分桶计价求和）。
        assert_eq!(alpha.cost_estimate,Some(3.4));
        // 明细仍覆盖整会话（两模型事件都在）。
        let detail=session_detail(&db,&alpha.path).unwrap();
        assert_eq!(detail.total,2);
        assert_eq!(detail.events.iter().map(|e|e.model.as_str()).collect::<Vec<_>>(),vec!["claude-haiku","claude-sonnet"]);
    }

    #[test]
    fn sessions_pagination_windows_and_zero_limit_are_rejected(){
        let d=tempfile::tempdir().unwrap();let db=d.path().join("cache.db");
        let t0=chrono::Utc::now().timestamp()-3_600;
        let mut paths=vec![];
        for (i,name) in ["a","b","c"].iter().enumerate(){
            let f=d.path().join(format!("{name}.jsonl"));
            let v=json!({"type":"assistant","timestamp":chrono::DateTime::from_timestamp(t0+300-(i as i64)*100,0).unwrap().to_rfc3339(),"message":{"id":format!("m{name}"),"model":"x","usage":{"input_tokens":1,"output_tokens":1}}});
            fs::write(&f,format!("{v}\n")).unwrap();
            paths.push(("claude".into(),f));
        }
        scan_paths(7,&db,paths,false).unwrap();
        fn titles(rs:&[SessionRow])->Vec<&str>{rs.iter().map(|r|r.title.as_str()).collect()}
        assert_eq!(titles(&sessions(&db,None,0,SESSION_PAGE_SIZE).unwrap()),vec!["a.jsonl","b.jsonl","c.jsonl"]);
        assert_eq!(titles(&sessions(&db,None,0,2).unwrap()),vec!["a.jsonl","b.jsonl"],"page size 2 keeps last-activity-desc order");
        assert_eq!(titles(&sessions(&db,None,2,2).unwrap()),vec!["c.jsonl"]);
        assert_eq!(titles(&sessions(&db,None,1,1).unwrap()),vec!["b.jsonl"],"offset windows into the ordered list");
        assert!(sessions(&db,None,10,2).unwrap().is_empty(),"offset beyond the end yields an empty page");
        assert!(sessions(&db,None,0,0).is_err(),"limit=0 must be rejected, not treated as unbounded");
    }

    #[test]
    fn session_detail_truncates_at_500_events(){
        let d=tempfile::tempdir().unwrap();let db=d.path().join("cache.db");
        let t0=chrono::Utc::now().timestamp()-4_000;
        let mut body=String::new();
        for i in 0..600{
            let v=json!({"type":"assistant","timestamp":chrono::DateTime::from_timestamp(t0+i,0).unwrap().to_rfc3339(),"message":{"id":format!("m{i}"),"model":"claude-sonnet","usage":{"input_tokens":i,"output_tokens":1}}});
            body.push_str(&format!("{v}\n"));
        }
        let f=d.path().join("big.jsonl");fs::write(&f,body).unwrap();
        scan_paths(7,&db,vec![("claude".into(),f)],false).unwrap();
        let rows=sessions(&db,None,0,SESSION_PAGE_SIZE).unwrap();
        assert_eq!(rows.len(),1);assert_eq!(rows[0].events,600);
        let detail=session_detail(&db,&rows[0].path).unwrap();
        assert_eq!(detail.total,600);
        assert_eq!(detail.events.len(),SESSION_DETAIL_CAP,"detail is hard-capped at 500 events");
        assert!(detail.truncated,"600 events must be flagged truncated");
        assert_eq!(detail.events[0].ts,t0);
        assert_eq!(detail.events[499].ts,t0+499,"detail is chronological from the earliest event");
        assert_eq!(detail.events[499].input,499);
    }

    #[test]
    fn zcode_cli_db_sessions_split_by_session_id(){
        let (d,dbf)=zcode_db_fixture();let db=d.path().join("cache.db");
        let s=scan_paths(90,&db,vec![("zcode".into(),dbf.clone())],false).unwrap();
        assert_eq!(s.changed_files,1);
        let rows=sessions(&db,None,0,SESSION_PAGE_SIZE).unwrap();
        assert_eq!(rows.len(),2,"sess_a(1 event) + sess_b(1 event)；全零行跳过");
        let a=rows.iter().find(|r|r.session.as_deref()==Some("sess_a")).unwrap();
        let b=rows.iter().find(|r|r.session.as_deref()==Some("sess_b")).unwrap();
        assert_eq!(a.title,"sess_a");assert_eq!(b.title,"sess_b");
        assert!(a.note.is_none()&&b.note.is_none());
        assert_eq!((a.input,a.output,a.cache_read),(117,44,376_384));
        assert_eq!((b.input,b.output),(1_000,50));
        // 逐会话明细只含本会话事件。
        let da=session_detail(&db,&a.path).unwrap();
        assert_eq!(da.total,1);
        assert_eq!((da.events[0].input,da.events[0].cache_read),(117,376_384));
        // Summary 口径不受复合路径影响。
        let sb:Vec<&Row>=s.rows.iter().filter(|r|r.model=="GLM-5.3").collect();
        assert_eq!(sb.len(),1);assert_eq!(sb[0].input,117);
        // 幂等重扫（库未变）后复合会话与标题仍在：live 清理按父键放行（substr 修正）。
        let b2=scan_paths(90,&db,vec![("zcode".into(),dbf)],false).unwrap();
        assert_eq!(b2.changed_files,0);
        let rows2=sessions(&db,None,0,SESSION_PAGE_SIZE).unwrap();
        assert_eq!(rows2.len(),2);
        assert_eq!(rows2.iter().map(|r|r.title.as_str()).collect::<Vec<_>>(),rows.iter().map(|r|r.title.as_str()).collect::<Vec<_>>());
    }

    #[test]
    fn zcode_cli_db_without_session_column_aggregates_whole_library(){
        // schema 漂移（session_id 列消失）：整库降级为单会话，诚实标注「无会话拆分」，消耗不丢。
        let d=tempfile::tempdir().unwrap();let dbf=d.path().join("db.sqlite");
        let c=rusqlite::Connection::open(&dbf).unwrap();
        c.execute_batch("CREATE TABLE model_usage(id TEXT PRIMARY KEY,model_id TEXT,status TEXT,started_at INTEGER,input_tokens INTEGER,output_tokens INTEGER,cache_read_input_tokens INTEGER,cache_creation_input_tokens INTEGER);").unwrap();
        c.execute("INSERT INTO model_usage VALUES('u1','GLM-5.3','completed',1_787_509_531_012,100,5,0,0)",[]).unwrap();
        drop(c);
        // 有 session 列但个别行 session_id 为 NULL：该行并入整体聚合行（实测不存在，防御分支）。
        // 投影只认字面名 db.sqlite（is_zdb 判定），故第二库放独立目录、同名。
        let d2=tempfile::tempdir().unwrap();let dbf2=d2.path().join("db.sqlite");
        let c2=rusqlite::Connection::open(&dbf2).unwrap();
        c2.execute_batch("CREATE TABLE model_usage(id TEXT PRIMARY KEY,model_id TEXT,status TEXT,started_at INTEGER,input_tokens INTEGER,output_tokens INTEGER,cache_read_input_tokens INTEGER,cache_creation_input_tokens INTEGER,session_id TEXT);").unwrap();
        c2.execute("INSERT INTO model_usage VALUES('x1','glm','completed',1_787_509_531_012,10,1,0,0,'sess_x')",[]).unwrap();
        c2.execute("INSERT INTO model_usage VALUES('x2','glm','completed',1_787_509_531_013,20,2,0,0,NULL)",[]).unwrap();
        drop(c2);
        let db=d.path().join("cache.db");
        // 同一轮扫描同时带上两个库：live 清理按本轮发现集生效，分轮扫描会清掉上一轮的事件。
        scan_paths(90,&db,vec![("zcode".into(),dbf),("zcode".into(),dbf2)],false).unwrap();
        let rows=sessions(&db,None,0,SESSION_PAGE_SIZE).unwrap();
        assert_eq!(rows.len(),3,"第一库整体聚合 + 第二库 sess_x + NULL 行整体聚合");
        let wholes:Vec<&SessionRow>=rows.iter().filter(|r|r.session.as_deref()==Some(ZCODE_WHOLE_LIBRARY_SESSION)).collect();
        assert_eq!(wholes.len(),2);
        assert!(wholes.iter().any(|r|(r.input,r.output)==(100,5)),"无 session 列的库按整体聚合保留全部消耗");
        let db2w=wholes.iter().find(|r|(r.input,r.output)==(20,2)).unwrap();
        assert_eq!(db2w.title,"db.sqlite");
        assert_eq!(db2w.note.as_deref(),Some(ZCODE_WHOLE_LIBRARY_NOTE));
        assert!(rows.iter().any(|r|r.session.as_deref()==Some("sess_x")&&(r.input,r.output)==(10,1)));
    }

    #[test]
    fn session_titles_survive_unchanged_rescans_and_die_with_their_file(){
        let d=tempfile::tempdir().unwrap();let db=d.path().join("cache.db");
        let f=d.path().join("keep.jsonl");
        let v=json!({"type":"assistant","timestamp":chrono::Utc::now().to_rfc3339(),"message":{"id":"k1","model":"x","usage":{"input_tokens":1,"output_tokens":1}}});
        fs::write(&f,format!("{v}\n")).unwrap();
        scan_paths(7,&db,vec![("claude".into(),f.clone())],false).unwrap();
        // 未变化重扫：清理照常执行，标题与事件都必须存活。
        let again=scan_paths(7,&db,vec![("claude".into(),f.clone())],false).unwrap();
        assert_eq!(again.changed_files,0);
        let rows=sessions(&db,None,0,SESSION_PAGE_SIZE).unwrap();
        assert_eq!(rows.len(),1);assert_eq!(rows[0].title,"keep.jsonl");
        // 文件删除后：事件、标题、会话一并消失。
        fs::remove_file(&f).unwrap();
        scan_paths(7,&db,vec![],false).unwrap();
        assert!(sessions(&db,None,0,SESSION_PAGE_SIZE).unwrap().is_empty());
    }

    // ---------- Round5B 项目二：WSL 用量（opt-in 默认关） ----------

    /// 测试用 argv 路由键（参数含空格/制表符，用不可见分隔符拼 key）。
    fn argv_key(args:&[String])->String{args.join("\u{1}")}
    /// find %T@ 输出形态的「现在」时刻（窗口内的 mtime，避免懒解析跳过干扰断言）。
    fn wsl_test_mtime()->String{
        let ns=chrono::Utc::now().timestamp_nanos_opt().unwrap();
        format!("{}.{:09}",ns.div_euclid(1_000_000_000),ns.rem_euclid(1_000_000_000))
    }

    #[test]
    fn wsl_path_whitelist_rejects_injection_vectors(){
        // 安全关键 fixture（计划明确要求）：含引号/分号/$ 等元字符、穿越、根外、非 jsonl 的
        // 路径必须被白名单拒绝，绝不进入命令构造。
        let roots=wsl_roots("/home/u");
        let bad=[
            "/home/u/.claude/projects/a;reboot.jsonl",            // 分号
            "/home/u/.claude/projects/$(curl evil).jsonl",        // 命令替换
            "/home/u/.claude/projects/`id`.jsonl",                // 反引号
            "/home/u/.claude/projects/\"quoted\".jsonl",          // 双引号
            "/home/u/.claude/projects/'sq'.jsonl",                // 单引号
            "/home/u/.claude/projects/a b.jsonl",                 // 空格（argv 转发歧义）
            "/home/u/.claude/projects/a\nb.jsonl",                // 换行（不得进入命令构造/拆散 find 输出行）
            "/home/u/.claude/projects/a|b.jsonl",                 // 管道
            "/home/u/.claude/projects/a&b.jsonl",                 // 后台执行
            "/home/u/.claude/projects/../../etc/cron.d/x.jsonl",  // 目录穿越
            "/etc/shadow.jsonl",                                  // 允许根之外
            "/home/other/.claude/projects/x.jsonl",               // 他人家目录（根前缀不匹配）
            "relative/path.jsonl",                                // 相对路径
            "/home/u/.claude/projects/x.txt",                     // 非 .jsonl
            "C:\\Users\\x\\.claude\\projects\\a.jsonl",           // Windows 路径形态
            "",                                                   // 空串
        ];
        for p in bad{assert!(!valid_wsl_path(p,&roots),"{p:?} must be rejected by the whitelist")}
        assert!(!valid_wsl_path("/home/u/.claude/projects/a\u{0}.jsonl",&roots),"NUL must be rejected");
        let good=["/home/u/.claude/projects/D--proj/8f0c-uuid.jsonl","/home/u/.qwen/projects/p2/sess-9.jsonl"];
        for p in good{assert!(valid_wsl_path(p,&roots),"{p} must pass the whitelist")}
        // 家目录白名单同样拒绝元字符/相对/穿越。
        assert!(valid_wsl_home("/home/u"));assert!(valid_wsl_home("/root"));
        for h in ["","relative","/home/u x","/home/u;id","/home/u$(x)","/home/u`id`","/home/../etc","/home/u\u{0}x","/home/u\"q\""]{
            assert!(!valid_wsl_home(h),"{h:?} home must be rejected");
        }
    }

    #[test]
    fn wsl_command_construction_never_interpolates_paths_into_a_shell(){
        // 防注入第二层证明：读取走 `wsl.exe -e cat -- <path>`，路径是单个 argv 元素、命令里没有
        // sh -c；家目录探测 argv 为常量串；发现直接 exec find。任何路径都不会被拼进 shell 命令文本。
        let p="/home/u/.claude/projects/D--proj/a.jsonl";
        assert_eq!(wsl_read_argv(p),vec!["-e","cat","--",p]);
        assert!(!wsl_read_argv(p).windows(2).any(|w|w[0]=="sh"&&w[1]=="-c"));
        assert_eq!(wsl_home_argv(),vec!["-e","sh","-c","echo $HOME"]);
        assert_eq!(wsl_find_argv("/home/u/.claude/projects")[1],"find","discovery execs find directly, not a shell");
    }

    #[test]
    fn wsl_files_are_discovered_read_counted_and_rechecked_unchanged(){
        let d=tempfile::tempdir().unwrap();let db=d.path().join("cache.db");
        let home="/home/u";
        let good="/home/u/.claude/projects/D--p/uuid1.jsonl";
        let evil="/home/u/.claude/projects/evil;id.jsonl";// 发现结果中的恶意路径：必须被白名单拦下，绝不读取
        let body=json!({"type":"assistant","timestamp":chrono::Utc::now().to_rfc3339(),"message":{"id":"w1","model":"claude-sonnet","usage":{"input_tokens":100,"output_tokens":5}}}).to_string();
        let mut routes:BTreeMap<String,Vec<u8>>=BTreeMap::new();
        routes.insert(argv_key(&wsl_home_argv()),b"/home/u\n".to_vec());
        routes.insert(argv_key(&wsl_find_argv(&format!("{home}/.claude/projects"))),format!("{good}\t{}\t{}\n{evil}\t9\t{}\n",body.len(),wsl_test_mtime(),wsl_test_mtime()).into_bytes());
        routes.insert(argv_key(&wsl_read_argv(good)),body.into_bytes());
        let cat_calls=std::rc::Rc::new(std::cell::RefCell::new(0usize));
        let cc=cat_calls.clone();let routes=std::rc::Rc::new(routes);let r2=routes.clone();
        let runner:WslRunner<'_>=&move|args:&[String],_:u64|{
            if args[1]=="cat"{*cc.borrow_mut()+=1;}
            r2.get(&argv_key(args)).cloned().ok_or_else(||"no route".to_string())
        };
        let s=scan_paths_with_wsl(7,&db,vec![],false,true,runner,&||false).unwrap();
        assert_eq!(s.rows.len(),1);
        assert_eq!(s.rows[0].source,"claude");assert_eq!(s.rows[0].input,100);assert_eq!(s.rows[0].output,5);
        assert_eq!(*cat_calls.borrow(),1,"恶意发现路径不得进入读取；无路由的 qwen 根按空处理");
        // 路径键 = sha256("wsl:"+POSIX 路径)；会话标题为文件名尾段。
        let key=wsl_path_key(good);
        let rows=sessions(&db,None,0,SESSION_PAGE_SIZE).unwrap();
        assert_eq!(rows.len(),1);assert_eq!(rows[0].path,key);assert_eq!(rows[0].title,"uuid1.jsonl");
        // files 表带 'wsl' 标记行（live 清理豁免的判定依据）。
        let dbc=database(&db).unwrap();
        let n:i64=dbc.query_row("SELECT COUNT(*) FROM files WHERE source='wsl' AND path=?",[&key],|r|r.get(0)).unwrap();
        assert_eq!(n,1);
        assert!(s.notes.iter().any(|n|n.contains("并入 1 个转录文件")),"{:?}",s.notes);
        assert!(!s.partial);
        // 重扫：size+mtime 未变 → 不再 cat；且 WSL 事件经历一轮 live 清理后仍存活（标记豁免）。
        let s2=scan_paths_with_wsl(7,&db,vec![],false,true,runner,&||false).unwrap();
        assert_eq!(*cat_calls.borrow(),1,"unchanged WSL files must not be re-read");
        assert!(s2.notes.iter().any(|n|n.contains("未变 1")),"{:?}",s2.notes);
        assert_eq!(s2.rows.len(),1,"WSL events must survive the Windows live cleanup");
        assert_eq!(s2.rows[0].input,100);
    }

    #[test]
    fn wsl_unavailable_degrades_silently_and_keeps_history(){
        let d=tempfile::tempdir().unwrap();let db=d.path().join("cache.db");
        // 预置一次成功扫描留下的 WSL 条目（events + files 标记行）。
        let key=wsl_path_key("/home/u/.claude/projects/p/old.jsonl");
        let ts=chrono::Utc::now().timestamp();
        {
            let dbc=database(&db).unwrap();
            dbc.execute("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?)",params![key,"claude","m1",ts,"x",100,5,0,0,0]).unwrap();
            dbc.execute("INSERT INTO files VALUES(?,?,?,?,?,?,?)",params![key,"wsl",10i64,1i64,"",0i64,"{}"]).unwrap();
        }
        let runner:WslRunner<'_>=&|_:&[String],_:u64|->Result<Vec<u8>,String>{Err("wsl.exe 缺失".into())};
        let s=scan_paths_with_wsl(7,&db,vec![],false,true,runner,&||false).unwrap();
        assert!(s.notes.iter().any(|n|n.contains("WSL：未检测到可用发行版")),"{:?}",s.notes);
        assert!(s.partial);
        assert_eq!(s.rows[0].input,100,"wsl.exe 不可用 ≠ 文件已删除：既有 WSL 记录必须保留");
        // 开关关闭：既有 WSL 条目显式清除（关闭语义 = 不并入也不保留）。
        let s2=scan_paths_with_wsl(7,&db,vec![],false,false,runner,&||false).unwrap();
        assert!(s2.rows.is_empty());
        let dbc=database(&db).unwrap();
        let n:i64=dbc.query_row("SELECT COUNT(*) FROM files WHERE source='wsl'",[],|r|r.get(0)).unwrap();
        assert_eq!(n,0,"关闭开关后 WSL 条目应被清除");
    }

    #[test]
    fn wsl_invalid_home_degrades_with_note(){
        let d=tempfile::tempdir().unwrap();let db=d.path().join("cache.db");
        for home in ["","relative/home","/home/u;id","/home/u x"]{
            let mut routes:BTreeMap<String,Vec<u8>>=BTreeMap::new();
            routes.insert(argv_key(&wsl_home_argv()),format!("{home}\n").into_bytes());
            let routes=std::rc::Rc::new(routes);let r2=routes.clone();
            let runner:WslRunner<'_>=&move|args:&[String],_:u64|r2.get(&argv_key(args)).cloned().ok_or_else(||"no route".to_string());
            let s=scan_paths_with_wsl(7,&db,vec![],false,true,runner,&||false).unwrap();
            assert!(s.notes.iter().any(|n|n.contains("WSL：未检测到可用发行版")),"home={home:?} notes={:?}",s.notes);
            assert!(s.partial);
            assert!(s.rows.is_empty());
        }
    }

    #[test]
    fn wsl_distro_without_transcripts_is_not_a_gap(){
        // 发行版可达但两个根都不存在（find 退出非零）：按空处理，不算部分覆盖。
        let d=tempfile::tempdir().unwrap();let db=d.path().join("cache.db");
        let runner:WslRunner<'_>=&|args:&[String],_:u64|{
            if args[1]=="sh"{return Ok(b"/home/u\n".to_vec())}
            Err("find: No such file or directory".into())
        };
        let s=scan_paths_with_wsl(7,&db,vec![],false,true,runner,&||false).unwrap();
        assert!(s.notes.iter().any(|n|n.contains("未发现 claude/qwen 转录文件")),"{:?}",s.notes);
        assert!(!s.partial,"no data in a reachable distro is not a coverage gap");
    }

    #[test]
    fn wsl_transient_find_failure_keeps_existing_entries_and_marks_partial(){
        // 回归：wsl.exe 启动失败/超时 ≠ 该根为空——本轮发现集不可信时保留集清理必须整体跳过，
        // 否则单根瞬时失败会把该根已入库条目当作「WSL 侧文件已删除」全部清除，且文件 mtime
        // 滑出扫描窗口后永不重读（丢失永久）。标注 partial + notes，与家目录探测失败路径同语义。
        let d=tempfile::tempdir().unwrap();let db=d.path().join("cache.db");
        let key=wsl_path_key("/home/u/.claude/projects/p/old.jsonl");
        let ts=chrono::Utc::now().timestamp();
        {
            let dbc=database(&db).unwrap();
            dbc.execute("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?)",params![key,"claude","m1",ts,"x",100,5,0,0,0]).unwrap();
            dbc.execute("INSERT INTO files VALUES(?,?,?,?,?,?,?)",params![key,"wsl",10i64,1i64,"",0i64,"{}"]).unwrap();
        }
        let runner:WslRunner<'_>=&|args:&[String],_:u64|{
            if args[1]=="sh"{return Ok(b"/home/u\n".to_vec())}
            // claude 根：瞬时失败（超时）；qwen 根：良性失败（find 退出非零 = 该根为空）。
            if args[1]=="find"&&args[2].starts_with("/home/u/.claude"){return Err(format!("{}（>15000ms）",WSL_ERR_TIMEOUT))}
            Err(WSL_ERR_NONZERO.into())
        };
        let s=scan_paths_with_wsl(7,&db,vec![],false,true,runner,&||false).unwrap();
        assert_eq!(s.rows.iter().find(|r|r.model=="x").map(|r|r.input),Some(100),"wsl.exe 暂时不可用 ≠ 文件已删除：既有条目不得被清理");
        let dbc=database(&db).unwrap();
        let n:i64=dbc.query_row("SELECT COUNT(*) FROM files WHERE source='wsl'",[],|r|r.get(0)).unwrap();
        assert_eq!(n,1);
        assert!(s.notes.iter().any(|note|note.contains("发现失败")&&note.contains("未做清理")),"{:?}",s.notes);
        // 发现瞬时失败时不得输出「未发现转录文件」的误导性结论（根本没看到）。
        assert!(!s.notes.iter().any(|note|note.contains("未发现 claude/qwen 转录文件")),"{:?}",s.notes);
        assert!(s.partial);
    }

    #[test]
    fn wsl_benign_find_failure_still_cleans_genuinely_deleted_roots(){
        // 对照：find 退出非零（目录确实没了/发行版无数据）= 良性「该根为空」，既有条目照常按
        // 「WSL 侧文件已删除」清理，空发行版不算降级缺口。
        let d=tempfile::tempdir().unwrap();let db=d.path().join("cache.db");
        let key=wsl_path_key("/home/u/.claude/projects/p/gone.jsonl");
        let ts=chrono::Utc::now().timestamp();
        {
            let dbc=database(&db).unwrap();
            dbc.execute("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?)",params![key,"claude","m1",ts,"x",100,5,0,0,0]).unwrap();
            dbc.execute("INSERT INTO files VALUES(?,?,?,?,?,?,?)",params![key,"wsl",10i64,1i64,"",0i64,"{}"]).unwrap();
        }
        let runner:WslRunner<'_>=&|args:&[String],_:u64|{
            if args[1]=="sh"{return Ok(b"/home/u\n".to_vec())}
            Err(WSL_ERR_NONZERO.into())
        };
        let s=scan_paths_with_wsl(7,&db,vec![],false,true,runner,&||false).unwrap();
        assert!(s.rows.is_empty(),"a root that genuinely reports empty must have its stale entries cleaned");
        let dbc=database(&db).unwrap();
        let n:i64=dbc.query_row("SELECT COUNT(*) FROM files WHERE source='wsl'",[],|r|r.get(0)).unwrap();
        assert_eq!(n,0);
        assert!(!s.partial);
    }

    #[test]
    fn wsl_files_older_than_the_window_are_skipped_lazily(){
        // 与 Windows 侧同口径：新文件且 mtime 早于窗口 → 不读取（其事件必在窗口外）。
        let d=tempfile::tempdir().unwrap();let db=d.path().join("cache.db");
        let cat_calls=std::rc::Rc::new(std::cell::RefCell::new(0usize));
        let cc=cat_calls.clone();
        let runner:WslRunner<'_>=&move|args:&[String],_:u64|{
            if args[1]=="sh"{return Ok(b"/home/u\n".to_vec())}
            if args[1]=="find"{return Ok(b"/home/u/.claude/projects/p/ancient.jsonl\t10\t1000000.0\n".to_vec())}
            *cc.borrow_mut()+=1;Ok(vec![])
        };
        let s=scan_paths_with_wsl(7,&db,vec![],false,true,runner,&||false).unwrap();
        assert_eq!(*cat_calls.borrow(),0,"a file untouched since before the window must not be read");
        assert!(s.rows.is_empty());
        assert!(!s.partial);
    }

    #[test]
    fn wsl_discovery_budget_caps_reads_at_2000(){
        let d=tempfile::tempdir().unwrap();let db=d.path().join("cache.db");
        let body=json!({"type":"assistant","timestamp":chrono::Utc::now().to_rfc3339(),"message":{"id":"w1","model":"m","usage":{"input_tokens":100,"output_tokens":5}}}).to_string();
        let mtime=wsl_test_mtime();
        let cat_calls=std::rc::Rc::new(std::cell::RefCell::new(0usize));
        let cc=cat_calls.clone();
        let runner:WslRunner<'_>=&move|args:&[String],_:u64|{
            if args[1]=="sh"{return Ok(b"/home/u\n".to_vec())}
            if args[1]=="find"{
                let mut s=String::new();
                for i in 0..WSL_FILE_BUDGET+50{s.push_str(&format!("/home/u/.claude/projects/p/f{i:05}.jsonl\t{}\t{mtime}\n",body.len()));}
                return Ok(s.into_bytes());
            }
            *cc.borrow_mut()+=1;
            Ok(body.clone().into_bytes())
        };
        let s=scan_paths_with_wsl(7,&db,vec![],false,true,runner,&||false).unwrap();
        assert_eq!(*cat_calls.borrow(),WSL_FILE_BUDGET,"reads stop at the independent WSL budget");
        assert!(s.notes.iter().any(|n|n.contains("预算上限（2000）")),"{:?}",s.notes);
        assert!(s.partial);
    }

    #[test]
    fn wsl_budget_truncation_keeps_entries_squeezed_out_of_the_budget(){
        // 回归：预算截断（entries.truncate）先于保留集维护时，字典序被挤出前 2000 的既有入库
        // 条目会被当作「WSL 侧已删除」清掉——截断轮必须整体跳过清理（与 Windows 侧
        // `!truncated` 守卫同口径），notes 披露「超出部分未读取 + 本轮未清理」。
        let d=tempfile::tempdir().unwrap();let db=d.path().join("cache.db");
        // "zzz…" 字典序排在下方 find 输出的 f00000..f02049 之后：截断后不在本轮发现集内，但文件仍在 WSL 侧。
        let key=wsl_path_key("/home/u/.claude/projects/p/zzz_preexisting.jsonl");
        let ts=chrono::Utc::now().timestamp();
        {
            let dbc=database(&db).unwrap();
            dbc.execute("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?)",params![key,"claude","m1",ts,"x",77,5,0,0,0]).unwrap();
            dbc.execute("INSERT INTO files VALUES(?,?,?,?,?,?,?)",params![key,"wsl",10i64,1i64,"",0i64,"{}"]).unwrap();
        }
        let body=json!({"type":"assistant","timestamp":chrono::Utc::now().to_rfc3339(),"message":{"id":"b1","model":"m","usage":{"input_tokens":100,"output_tokens":5}}}).to_string();
        let mtime=wsl_test_mtime();
        let runner:WslRunner<'_>=&move|args:&[String],_:u64|{
            if args[1]=="sh"{return Ok(b"/home/u\n".to_vec())}
            if args[1]=="find"{
                let mut s=String::new();
                for i in 0..WSL_FILE_BUDGET+50{s.push_str(&format!("/home/u/.claude/projects/p/f{i:05}.jsonl\t{}\t{mtime}\n",body.len()));}
                return Ok(s.into_bytes());
            }
            Ok(body.clone().into_bytes())
        };
        let s=scan_paths_with_wsl(7,&db,vec![],false,true,runner,&||false).unwrap();
        assert!(s.notes.iter().any(|n|n.contains("预算上限（2000）")&&n.contains("未清理")),"{:?}",s.notes);
        assert_eq!(s.rows.iter().find(|r|r.model=="x").map(|r|r.input),Some(77),"预算截断 ≠ 已删除：被挤出预算的既有条目必须保留");
    }

    #[test]
    fn wsl_oversized_files_are_skipped_as_large(){
        let d=tempfile::tempdir().unwrap();let db=d.path().join("cache.db");
        let p="/home/u/.claude/projects/p/big.jsonl";
        let mut routes:BTreeMap<String,Vec<u8>>=BTreeMap::new();
        routes.insert(argv_key(&wsl_home_argv()),b"/home/u\n".to_vec());
        routes.insert(argv_key(&wsl_find_argv("/home/u/.claude/projects")),format!("{p}\t999999\t{}\n",wsl_test_mtime()).into_bytes());
        routes.insert(argv_key(&wsl_read_argv(p)),vec![b'x';WSL_FILE_MAX_BYTES as usize+1]);
        let cat_calls=std::rc::Rc::new(std::cell::RefCell::new(0usize));
        let cc=cat_calls.clone();let routes=std::rc::Rc::new(routes);let r2=routes.clone();
        let runner:WslRunner<'_>=&move|args:&[String],_:u64|{
            if args[1]=="cat"{*cc.borrow_mut()+=1;}
            r2.get(&argv_key(args)).cloned().ok_or_else(||"no route".to_string())
        };
        let s=scan_paths_with_wsl(7,&db,vec![],false,true,runner,&||false).unwrap();
        assert!(s.rows.is_empty(),"oversized files must not yield events");
        // find 已回传大小：超限文件必须在读取前被跳过，不得经 wsl.exe 管道整体缓冲后才丢弃
        //（也避免超大文件读满超时被误计为 failed 连锁中止本阶段）。
        assert_eq!(*cat_calls.borrow(),0,"oversized files must be skipped before any wsl.exe read");
        assert!(s.notes.iter().any(|n|n.contains("超过 256KB 上限未读取")),"{:?}",s.notes);
        assert!(s.partial);
    }

    #[test]
    fn wsl_consecutive_failures_abort_the_phase(){
        // wsl.exe 半途不可用：连续失败达上限即中止，不得按超时串行拖完整预算。
        let d=tempfile::tempdir().unwrap();let db=d.path().join("cache.db");
        let cat_calls=std::rc::Rc::new(std::cell::RefCell::new(0usize));
        let cc=cat_calls.clone();
        let runner:WslRunner<'_>=&move|args:&[String],_:u64|{
            if args[1]=="sh"{return Ok(b"/home/u\n".to_vec())}
            if args[1]=="find"{
                let mut s=String::new();
                for i in 0..10{s.push_str(&format!("/home/u/.claude/projects/p/f{i}.jsonl\t10\t{}\n",wsl_test_mtime()));}
                return Ok(s.into_bytes());
            }
            *cc.borrow_mut()+=1;
            Err("读取失败".into())
        };
        let s=scan_paths_with_wsl(7,&db,vec![],false,true,runner,&||false).unwrap();
        assert_eq!(*cat_calls.borrow(),WSL_MAX_CONSECUTIVE_FAILURES,"phase aborts after consecutive failures");
        assert!(s.notes.iter().any(|n|n.contains("5 个文件读取失败")),"{:?}",s.notes);
        assert!(s.notes.iter().any(|n|n.contains("连续失败")),"{:?}",s.notes);
        assert!(s.partial);
    }

    #[test]
    fn wsl_and_windows_copies_of_one_session_fold_by_event_id(){
        // 同会话双计风险（计划注明）：同一目录被 Windows 与 WSL 各收集一次 → 稳定消息 id 在
        // (source,event_id) 折叠，Summary 只计一次；会话视图按不同 path_key 各自成行。
        let d=tempfile::tempdir().unwrap();let db=d.path().join("cache.db");
        let line=json!({"type":"assistant","timestamp":chrono::Utc::now().to_rfc3339(),"message":{"id":"same-1","model":"m","usage":{"input_tokens":100,"output_tokens":5}}}).to_string();
        let win=d.path().join("same.jsonl");fs::write(&win,format!("{line}\n")).unwrap();
        let wp="/home/u/.claude/projects/mounted/same.jsonl";
        let mut routes:BTreeMap<String,Vec<u8>>=BTreeMap::new();
        routes.insert(argv_key(&wsl_home_argv()),b"/home/u\n".to_vec());
        routes.insert(argv_key(&wsl_find_argv("/home/u/.claude/projects")),format!("{wp}\t{}\t{}\n",line.len(),wsl_test_mtime()).into_bytes());
        routes.insert(argv_key(&wsl_read_argv(wp)),line.into_bytes());
        let runner:WslRunner<'_>=&move|args:&[String],_:u64|routes.get(&argv_key(args)).cloned().ok_or_else(||"no route".to_string());
        let s=scan_paths_with_wsl(7,&db,vec![("claude".into(),win.clone())],false,true,runner,&||false).unwrap();
        assert_eq!(s.rows.len(),1);
        assert_eq!(s.rows[0].input,100,"a session collected from both sides must be counted once");
        // 会话视图与 Summary 同口径：先按 (source,event_id) 去重再按 path 聚合——
        // 双侧收集的同一会话折叠为一行（ Round5a 机制，计划注明）。
        let rows=sessions(&db,None,0,SESSION_PAGE_SIZE).unwrap();
        assert_eq!(rows.len(),1,"the doubly-collected session folds to one row by (source,event_id)");
        assert_eq!(rows[0].input,100);
        // 折叠后保留的 path 取组内任意行（SQLite 语义），两侧键之一均为合法结果。
        let win_key=format!("{:x}",Sha256::digest(win.to_string_lossy().as_bytes()));
        assert!(rows[0].path==wsl_path_key(wp)||rows[0].path==win_key,"{:?}",rows[0].path);
    }

    #[test]
    fn wsl_process_runner_times_out_hung_commands(){
        // 环境探测用 where 只查存在性不执行（wsl --status 在损坏安装上可能挂起）。
        let installed=std::process::Command::new("cmd").args(["/C","where","wsl.exe"]).output().map(|o|o.status.success()).unwrap_or(false);
        if !installed{
            // 无 wsl.exe 环境：spawn 失败本身就是降级路径（必须 Err 而非 panic/卡死）。
            assert!(wsl_process_runner(&wsl_home_argv(),1_000).is_err());
            return;
        }
        let t0=std::time::Instant::now();
        let r=wsl_process_runner(&["-e".into(),"sleep".into(),"30".into()],1_500);
        assert!(r.is_err(),"a hung command must surface as an error");
        assert!(t0.elapsed()<std::time::Duration::from_secs(10),"timeout must kill the command, not wait out its 30s");
        // 有可用发行版时顺带做一次只读家目录探测：真实 $HOME 必须过白名单。
        if let Ok(home)=wsl_process_runner(&wsl_home_argv(),WSL_CMD_TIMEOUT_MS){
            let h=String::from_utf8_lossy(&home).trim().to_string();
            if !h.is_empty(){assert!(valid_wsl_home(&h),"real HOME {h:?} must pass the whitelist")}
        }
    }
}

