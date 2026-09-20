//! Read-only local token ledger. No transcript text, prompts or paths leave Rust.
use std::{collections::BTreeMap,fs::{self,File},io::{BufRead,BufReader,Read,Seek,SeekFrom},path::{Path,PathBuf}};
use serde::{Serialize,Deserialize};use serde_json::Value;use sha2::{Digest,Sha256};
use rusqlite::{Connection,params};
#[derive(Default,Clone,Serialize,Deserialize)]struct State{model:String,totals:[u64;4],bad_lines:u64}
#[derive(Debug,Clone,Serialize)]pub struct Row{pub source:String,pub model:String,pub day:String,pub hour:String,pub input:u64,pub output:u64,pub cache_read:u64,pub cache_write:u64,pub partial:bool}
#[derive(Debug,Serialize)]pub struct Summary{pub rows:Vec<Row>,pub scanned_files:usize,pub skipped_files:usize,pub changed_files:usize,pub days:u32,pub partial:bool,pub cost_estimate:Option<f64>,pub notes:Vec<String>,pub duration_ms:Option<u64>,pub coverage_gap:bool}
struct Event{id:String,ts:i64,model:String,counts:[u64;4],partial:bool}
fn count(v:&Value)->u64{v.as_u64().unwrap_or(0)}
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
        return Some(Event{id:format!("{ts}-{:x}",Sha256::digest(serde_json::to_vec(&totals).ok()?)),ts,model:if state.model.is_empty(){"unknown".into()}else{state.model.clone()},counts,partial:reset||delta[2]>delta[0]||state.model.is_empty()});
    }
    if source=="claude"{
        if v["type"]!="assistant"{return None}let m=&v["message"];let u=m.get("usage")?;
        let ts=timestamp(&v["timestamp"])?;
        let counts=[count(&u["input_tokens"]),count(&u["output_tokens"]),count(&u["cache_read_input_tokens"]),count(&u["cache_creation_input_tokens"])];
        // Claude Code writes "<synthetic>" assistant placeholders with an all-zero usage block.
        if counts.iter().all(|c|*c==0){return None}
        let id=m["id"].as_str().map(str::to_string).unwrap_or_else(||format!("offset-{offset}"));
        return Some(Event{id,ts,model:m["model"].as_str().unwrap_or("unknown").into(),counts,partial:m["id"].is_null()||u["input_tokens"].is_null()||u["output_tokens"].is_null()});
    }
    if ["cline","roocode","kilocode"].contains(&source){
        if v["say"]!="api_req_started"{return None}let text:Value=serde_json::from_str(v["text"].as_str()?).ok()?;
        let ts=timestamp(&v["ts"])?;if text["tokensIn"].is_null()&&text["tokensOut"].is_null(){return None}
        return Some(Event{id:format!("{ts}-{offset}"),ts,model:text["model"].as_str().unwrap_or("unknown").into(),counts:[count(&text["tokensIn"]),count(&text["tokensOut"]),count(&text["cacheReads"]),count(&text["cacheWrites"])],partial:true});
    }
    if source=="gemini"{
        let u = if v["type"] == "gemini" { v.get("tokens") } else { v.pointer("/payload/tokens").or_else(|| v.get("tokens")) }?;
        let input=count(&u["input"]);let cache=count(&u["cached"]);
        let model=v["model"].as_str().or_else(|| v.pointer("/payload/model").and_then(Value::as_str)).unwrap_or("unknown");
        let id=v["id"].as_str().or_else(|| v.pointer("/payload/id").and_then(Value::as_str)).map(str::to_string).unwrap_or_else(||format!("offset-{offset}"));
        let ts=v.get("timestamp").or_else(|| v.pointer("/payload/timestamp")).and_then(timestamp)?;
        return Some(Event{id,ts,model:model.into(),counts:[input.saturating_sub(cache)+count(&u["tool"]),count(&u["output"]),cache,0],partial:true});
    }
    if source=="openclaw"{
        let m=&v["message"];if m["role"]!="assistant"{return None}let u=m.get("usage")?;
        return Some(Event{id:v["id"].as_str().map(str::to_string).unwrap_or_else(||format!("offset-{offset}")),ts:timestamp(&v["timestamp"])?,model:m["model"].as_str().unwrap_or("unknown").into(),counts:[count(&u["input"]),count(&u["output"]),count(&u["cacheRead"]),count(&u["cacheWrite"])],partial:true});
    }
    None
}
fn discover<F>(root:&Path,source:&str,out:&mut Vec<(String,PathBuf)>,depth:usize,truncated:&mut bool,is_cancelled:&F)->Result<(),String>
where F: Fn() -> bool {
    if is_cancelled() { return Err("已取消".into()); }
    if depth>18||out.len()>=10000{ *truncated = true; return Ok(()); }
    // 目录不存在=该来源未安装（正常）；权限等其他错误才标扫描截断（A13）。
    let entries=match fs::read_dir(root){
        Ok(e)=>e,
        Err(e) if e.kind()==std::io::ErrorKind::NotFound=>return Ok(()),
        Err(_)=>{ *truncated = true; return Ok(()); }
    };
    for entry in entries.flatten(){
        if is_cancelled() { return Err("已取消".into()); }
        let Ok(kind)=entry.file_type()else{continue};if kind.is_symlink(){continue}let path=entry.path();
        if kind.is_dir(){discover(&path,source,out,depth+1,truncated,is_cancelled)?}else if path.extension().is_some_and(|e|e=="jsonl"||e=="json"){
            let name=path.file_name().and_then(|s|s.to_str()).unwrap_or("");
            if ["cline","roocode","kilocode"].contains(&source) && name!="ui_messages.json"{continue}
            if source=="gemini" && !name.starts_with("session-"){continue}
            if ["claude","codex","openclaw"].contains(&source)&&path.extension().is_none_or(|e|e!="jsonl"){continue}
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
fn sources_with_cancel<F>(is_cancelled:&F)->Result<(Vec<(String,PathBuf)>,bool),String>
where F: Fn() -> bool {
    let mut out=vec![];
    let mut truncated=false;
    if let Some(root)=crate::providers::credentials::home_path("CLAUDE_CONFIG_DIR",".claude"){collect(&root.join("projects"),"claude",&mut out,&mut truncated,is_cancelled)?;}
    if let Some(root)=crate::providers::credentials::home_path("CODEX_HOME",".codex"){collect(&root.join("sessions"),"codex",&mut out,&mut truncated,is_cancelled)?;collect(&root.join("archived_sessions"),"codex",&mut out,&mut truncated,is_cancelled)?;}
    if let Some(root)=crate::providers::credentials::home_path("GEMINI_CLI_HOME",".gemini"){collect(&root.join("tmp"),"gemini",&mut out,&mut truncated,is_cancelled)?;}
    if let Some(home)=dirs::home_dir(){collect(&home.join(".openclaw/agents"),"openclaw",&mut out,&mut truncated,is_cancelled)?;}
    if let Some(app)=dirs::config_dir(){for editor in ["Code","Code - Insiders","VSCodium"]{for (source,ext) in [("cline","saoudrizwan.claude-dev"),("roocode","rooveterinaryinc.roo-cline"),("kilocode","kilocode.kilo-code")]{collect(&app.join(editor).join("User/globalStorage").join(ext).join("tasks"),source,&mut out,&mut truncated,is_cancelled)?;}}}
    Ok((out,truncated))
}
fn database(path:&Path)->Result<Connection,String>{
    let db=Connection::open(path).map_err(|_|"无法打开统计缓存")?;
    db.busy_timeout(std::time::Duration::from_secs(2)).map_err(|_|"统计缓存锁定")?;
    db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY,source TEXT,size INTEGER,mtime INTEGER,prefix TEXT,offset INTEGER,state TEXT); CREATE TABLE IF NOT EXISTS events(path TEXT,source TEXT,event_id TEXT,ts INTEGER,model TEXT,input INTEGER,output INTEGER,cache_read INTEGER,cache_write INTEGER,partial INTEGER,PRIMARY KEY(path,event_id)); CREATE INDEX IF NOT EXISTS idx_events_source_ts ON events(source, ts);").map_err(|_|"无法初始化统计缓存")?;Ok(db)
}
pub fn scan(days:u32)->Result<Summary,String>{
    scan_with_cancel(days,&||false)
}
pub fn scan_with_cancel<F>(days:u32,is_cancelled:&F)->Result<Summary,String>
where F: Fn() -> bool + Send + Sync {
    if ![7,30,90].contains(&days){return Err("统计区间无效".into())}
    if is_cancelled() { return Err("已取消".into()); }
    let root=crate::config::get_config_dir();fs::create_dir_all(&root).map_err(|_|"无法创建统计缓存")?;
    let (paths, truncated) = sources_with_cancel(is_cancelled)?;
    scan_paths_with_cancel(days,&root.join("ledger-v1.sqlite"),paths,truncated,is_cancelled)
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
            if metadata.len()>256*1024*1024{return Err("large".into())}
            let mtime=metadata.modified().ok().and_then(|t|t.duration_since(std::time::UNIX_EPOCH).ok()).map(|t|t.as_nanos().min(i64::MAX as u128) as i64).unwrap_or(0);
            let path_key=format!("{:x}",Sha256::digest(path.to_string_lossy().as_bytes()));
            let old:Option<(u64,i64,String,u64,String)>=db.query_row("SELECT size,mtime,prefix,offset,state FROM files WHERE path=?",[&path_key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).ok();
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
                let array=v.as_array().or_else(||v["messages"].as_array()).ok_or("format")?;
                for (i,line) in array.iter().enumerate(){
                    if i % 100 == 0 && is_cancelled() { return Err("已取消".into()); }
                    insert(line,i as u64,&mut state)?;
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
    for row in &rows {
        if row.input+row.output+row.cache_read+row.cache_write==0{continue}
        if let Some(c) = estimate_model_cost(&row.model, &[row.input, row.output, row.cache_read, row.cache_write]) {
            total_cost += c; any_cost = true; priced += 1;
        } else { unpriced += 1; }
    }
    let cost_estimate = if any_cost { Some((total_cost * 100.0).round() / 100.0) } else { None };
    let coverage_gap=truncated;
    // B08：坏行状态持久化在 files.state——后续扫描跳过未变化文件时标记不丢。
    let persisted_bad:u64={
        let mut stmt=db.prepare("SELECT state FROM files WHERE state LIKE '%bad_lines%'").map_err(|_|"读取坏行状态失败")?;
        let total=stmt.query_map([],|r|r.get::<_,String>(0)).map_err(|_|"读取坏行状态失败")?
            .filter_map(|s|s.ok()).filter_map(|s|serde_json::from_str::<State>(&s).ok())
            .map(|st|st.bad_lines).sum();
        total
    };
    let partial=skipped>0||persisted_bad>0||rows.iter().any(|r|r.partial)||coverage_gap;
    let duration_ms=Some(scan_start.elapsed().as_millis() as u64);
    let mut notes=vec![
        "仅读取本机记录；缺失文件不代表零消耗。".into(),
        if cost_estimate.is_some() {
            "费用估算基于主流公有云 API 标价折算，仅供参考，不代表订阅内实际扣费。".into()
        } else {
            "费用暂不可用；不把未知模型价格当作零。".into()
        },
        "Gemini/OpenClaw/编辑器记录为部分格式覆盖；Copilot、导出来源及其他目录尚未支持。".into()
    ];
    if coverage_gap{
        notes.push("目录扫描达到上限或受限，已保留既有历史记录，统计可能存在缺口。".into());
    }
    if persisted_bad>0{
        notes.push(format!("历史扫描中曾有 {persisted_bad} 行无法解析（已跳过，不影响已解析事件）。"));
    }
    if unpriced>0{
        notes.push(format!("有 {unpriced} 组记录来自未知定价的模型，未计入费用估算（已计价 {priced} 组）。"));
    }
    Ok(Summary{rows,scanned_files:scanned,skipped_files:skipped,changed_files:changed,days,partial,cost_estimate,notes,duration_ms,coverage_gap})
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
}

