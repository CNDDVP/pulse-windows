//! Read-only local token ledger. No transcript text, prompts or paths leave Rust.
use std::{collections::BTreeMap,fs::{self,File},io::{BufRead,BufReader,Read,Seek,SeekFrom},path::{Path,PathBuf}};
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
    db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY,source TEXT,size INTEGER,mtime INTEGER,prefix TEXT,offset INTEGER,state TEXT); CREATE TABLE IF NOT EXISTS events(path TEXT,source TEXT,event_id TEXT,ts INTEGER,model TEXT,input INTEGER,output INTEGER,cache_read INTEGER,cache_write INTEGER,partial INTEGER,PRIMARY KEY(path,event_id)); CREATE INDEX IF NOT EXISTS idx_events_source_ts ON events(source, ts); CREATE TABLE IF NOT EXISTS daily_archive(day TEXT,source TEXT,model TEXT,input INTEGER,output INTEGER,cache_read INTEGER,cache_write INTEGER,PRIMARY KEY(day,source,model)); CREATE TABLE IF NOT EXISTS daily_active(day TEXT PRIMARY KEY,seconds INTEGER); CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value INTEGER);").map_err(|_|"无法初始化统计缓存")?;Ok(db)
}
pub fn scan(days:u32)->Result<Summary,String>{
    scan_with_cancel(days,&||false,BTreeMap::new())
}
/// `extra` 为设置 token_spend_extra_paths（来源 → 附加扫描目录，已按绝对路径/上限校验）；
/// 调用方（token_spend 命令）从内存设置快照传入，扫描期快照不变。
pub fn scan_with_cancel<F>(days:u32,is_cancelled:&F,extra:BTreeMap<String,Vec<String>>)->Result<Summary,String>
where F: Fn() -> bool + Send + Sync {
    if ![7,30,90].contains(&days){return Err("统计区间无效".into())}
    if is_cancelled() { return Err("已取消".into()); }
    let root=crate::config::get_config_dir();fs::create_dir_all(&root).map_err(|_|"无法创建统计缓存")?;
    let (paths, truncated) = sources_with_cancel(is_cancelled,&extra)?;
    scan_paths_with_cancel(days,&ledger_db_path(),paths,truncated,is_cancelled)
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
            let old:Option<(u64,i64,String,u64,String)>=db.query_row("SELECT size,mtime,prefix,offset,state FROM files WHERE path=?",[&path_key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).ok();
            // Round5A 项目一：ZCode CLI 信封权威根——不作为 jsonl 解析，改走 model_usage 投影（注释见该函数）。
            if is_zdb{
                if old.as_ref().is_some_and(|(size,time,_,_,_)|*size==metadata.len()&&*time==mtime){return Ok(())}
                if old.is_none()&&mtime>0&&mtime<window_start_ns{return Ok(())}
                let tx=db.transaction().map_err(|_|"lock")?;
                tx.execute("DELETE FROM events WHERE path=?",[&path_key]).map_err(|_|"db")?;
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
    if !truncated && skipped==0 {
        let tx=db.transaction().map_err(|_|"lock")?;
        tx.execute_batch("CREATE TEMP TABLE IF NOT EXISTS live(path TEXT PRIMARY KEY); DELETE FROM live;").map_err(|_|"db")?;
        {
            let mut insert=tx.prepare("INSERT OR IGNORE INTO live VALUES(?)").map_err(|_|"db")?;
            for key in &live{insert.execute([key]).map_err(|_|"db")?;}
        }
        tx.execute("DELETE FROM events WHERE path NOT IN (SELECT path FROM live)",[]).map_err(|_|"db")?;
        tx.execute("DELETE FROM files WHERE path NOT IN (SELECT path FROM live)",[]).map_err(|_|"db")?;
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
fn zcode_cli_db_events(path:&Path,tx:&rusqlite::Transaction,path_key:&str,state:&mut State)->Result<usize,String>{
    let src=rusqlite::Connection::open_with_flags(path,rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|_|"zcode cli 库打不开")?;
    src.busy_timeout(std::time::Duration::from_secs(2)).map_err(|_|"zcode cli 库锁定")?;
    let mut stmt=src.prepare("SELECT id,model_id,status,started_at,input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens FROM model_usage").map_err(|_|"zcode cli 库查询失败")?;
    let mut ins=tx.prepare("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?)").map_err(|_|"db")?;
    let rows=stmt.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,String>(2)?,r.get::<_,i64>(3)?,r.get::<_,i64>(4)?,r.get::<_,i64>(5)?,r.get::<_,i64>(6)?,r.get::<_,i64>(7)?))).map_err(|_|"zcode cli 库读取失败")?;
    let mut n=0usize;
    for (id,model,status,started_at,input,output,cache_read,cache_write) in rows.flatten(){
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
        ins.execute(params![path_key,"zcode",id,ts,if unknown{"unknown"}else{model.as_deref().unwrap_or_default()},counts[0],counts[1],counts[2],counts[3],(anomaly||status!="completed"||unknown) as u8]).map_err(|_|"record")?;
        n+=1;
    }
    Ok(n)
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
    /// 合成 ZCode CLI 库 fixture：仅建 model_usage 中被投影的列（与真实表同名列；真实表还有几十个
    /// 未引用列，SELECT 不受影响）。值形态对齐真实探查：cached ⊆ input、started_at 毫秒。
    fn zcode_db_fixture()->(tempfile::TempDir,PathBuf){
        let d=tempfile::tempdir().unwrap();
        let path=d.path().join("db.sqlite");
        let c=rusqlite::Connection::open(&path).unwrap();
        c.execute_batch("CREATE TABLE model_usage(id TEXT PRIMARY KEY,model_id TEXT,status TEXT,started_at INTEGER,input_tokens INTEGER,output_tokens INTEGER,cache_read_input_tokens INTEGER,cache_creation_input_tokens INTEGER);").unwrap();
        let mut ins=c.prepare("INSERT INTO model_usage VALUES(?,?,?,?,?,?,?,?)").unwrap();
        // 376501 输入含 376384 缓存读（真实行形态）：非缓存输入=117。
        ins.execute(params!["u1","GLM-5.3","completed",1_787_509_531_012i64,376_501i64,44,376_384,0]).unwrap();
        // 全零行必须跳过（synthetic 语义同 claude）。
        ins.execute(params!["u2","GLM-5.3","completed",1_787_509_531_013i64,0,0,0,0]).unwrap();
        // 非完成状态：计真实消耗但降级 partial（模型取不同名，避免与前一行合并进同一 day/hour 桶）。
        ins.execute(params!["u3","GLM-5.3-Flash","error",1_787_509_531_014i64,1_000,50,0,0]).unwrap();
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
}

