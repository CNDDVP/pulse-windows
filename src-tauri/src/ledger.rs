//! Read-only local token ledger. No transcript text, prompts or paths leave Rust.
use std::{collections::BTreeMap,fs::{self,File},io::{BufRead,BufReader,Read,Seek,SeekFrom},path::{Path,PathBuf}};
use serde::{Serialize,Deserialize};use serde_json::Value;use sha2::{Digest,Sha256};
use rusqlite::{Connection,params};
#[derive(Default,Clone,Serialize,Deserialize)]struct State{model:String,totals:[u64;4]}
#[derive(Clone,Serialize)]pub struct Row{pub source:String,pub model:String,pub day:String,pub hour:String,pub input:u64,pub output:u64,pub cache_read:u64,pub cache_write:u64,pub partial:bool}
#[derive(Serialize)]pub struct Summary{pub rows:Vec<Row>,pub scanned_files:usize,pub skipped_files:usize,pub changed_files:usize,pub days:u32,pub partial:bool,pub cost_estimate:Option<f64>,pub notes:Vec<String>}
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
        let delta=std::array::from_fn::<_,4,_>(|i|totals[i].saturating_sub(state.totals[i]));
        let reset=totals.iter().zip(state.totals).any(|(a,b)|*a<b);
        for (i,n) in totals.iter().enumerate(){state.totals[i]=state.totals[i].max(*n)}
        let counts=[delta[0].saturating_sub(delta[2]),delta[1],delta[2],0];
        if counts.iter().sum::<u64>()==0{return None}
        return Some(Event{id:format!("{ts}-{:x}",Sha256::digest(serde_json::to_vec(&totals).ok()?)),ts,model:if state.model.is_empty(){"unknown".into()}else{state.model.clone()},counts,partial:reset||delta[2]>delta[0]||state.model.is_empty()});
    }
    if source=="claude"{
        if v["type"]!="assistant"{return None}let m=&v["message"];let u=m.get("usage")?;
        let ts=timestamp(&v["timestamp"])?;
        let id=m["id"].as_str().map(str::to_string).unwrap_or_else(||format!("offset-{offset}"));
        return Some(Event{id,ts,model:m["model"].as_str().unwrap_or("unknown").into(),counts:[count(&u["input_tokens"]),count(&u["output_tokens"]),count(&u["cache_read_input_tokens"]),count(&u["cache_creation_input_tokens"])],partial:m["id"].is_null()||u["input_tokens"].is_null()||u["output_tokens"].is_null()});
    }
    if ["cline","roocode","kilocode"].contains(&source){
        if v["say"]!="api_req_started"{return None}let text:Value=serde_json::from_str(v["text"].as_str()?).ok()?;
        let ts=timestamp(&v["ts"])?;if text["tokensIn"].is_null()&&text["tokensOut"].is_null(){return None}
        return Some(Event{id:format!("{ts}-{offset}"),ts,model:text["model"].as_str().unwrap_or("unknown").into(),counts:[count(&text["tokensIn"]),count(&text["tokensOut"]),count(&text["cacheReads"]),count(&text["cacheWrites"])],partial:true});
    }
    if source=="gemini"{
        if v["type"]!="gemini"{return None}let u=v.get("tokens")?;let input=count(&u["input"]);let cache=count(&u["cached"]);
        return Some(Event{id:v["id"].as_str().map(str::to_string).unwrap_or_else(||format!("offset-{offset}")),ts:timestamp(&v["timestamp"])?,model:v["model"].as_str().unwrap_or("unknown").into(),counts:[input.saturating_sub(cache)+count(&u["tool"]),count(&u["output"]),cache,0],partial:true});
    }
    if source=="openclaw"{
        let m=&v["message"];if m["role"]!="assistant"{return None}let u=m.get("usage")?;
        return Some(Event{id:v["id"].as_str().map(str::to_string).unwrap_or_else(||format!("offset-{offset}")),ts:timestamp(&v["timestamp"])?,model:m["model"].as_str().unwrap_or("unknown").into(),counts:[count(&u["input"]),count(&u["output"]),count(&u["cacheRead"]),count(&u["cacheWrite"])],partial:true});
    }
    None
}
fn discover(root:&Path,source:&str,out:&mut Vec<(String,PathBuf)>,depth:usize){
    if depth>18||out.len()>=20000{return}
    let Ok(entries)=fs::read_dir(root)else{return};
    for entry in entries.flatten(){let Ok(kind)=entry.file_type()else{continue};if kind.is_symlink(){continue}let path=entry.path();
        if kind.is_dir(){discover(&path,source,out,depth+1)}else if path.extension().is_some_and(|e|e=="jsonl"||e=="json"){
            let name=path.file_name().and_then(|s|s.to_str()).unwrap_or("");
            if ["cline","roocode","kilocode"].contains(&source) && name!="ui_messages.json"{continue}
            if source=="gemini" && !name.starts_with("session-"){continue}
            if ["claude","codex","openclaw"].contains(&source)&&path.extension().is_none_or(|e|e!="jsonl"){continue}
            out.push((source.into(),path));
        }
    }
}
fn sources()->Vec<(String,PathBuf)>{
    let mut out=vec![];
    if let Some(root)=crate::providers::credentials::home_path("CLAUDE_CONFIG_DIR",".claude"){discover(&root.join("projects"),"claude",&mut out,0)}
    if let Some(root)=crate::providers::credentials::home_path("CODEX_HOME",".codex"){discover(&root.join("sessions"),"codex",&mut out,0);discover(&root.join("archived_sessions"),"codex",&mut out,0)}
    if let Some(root)=crate::providers::credentials::home_path("GEMINI_CLI_HOME",".gemini"){discover(&root.join("tmp"),"gemini",&mut out,0)}
    if let Some(home)=dirs::home_dir(){discover(&home.join(".openclaw/agents"),"openclaw",&mut out,0)}
    if let Some(app)=dirs::config_dir(){for editor in ["Code","Code - Insiders","VSCodium"]{for (source,ext) in [("cline","saoudrizwan.claude-dev"),("roocode","rooveterinaryinc.roo-cline"),("kilocode","kilocode.kilo-code")]{discover(&app.join(editor).join("User/globalStorage").join(ext).join("tasks"),source,&mut out,0)}}}
    out
}
fn database(path:&Path)->Result<Connection,String>{
    let db=Connection::open(path).map_err(|_|"无法打开统计缓存")?;
    db.busy_timeout(std::time::Duration::from_secs(2)).map_err(|_|"统计缓存锁定")?;
    db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY,source TEXT,size INTEGER,mtime INTEGER,prefix TEXT,offset INTEGER,state TEXT); CREATE TABLE IF NOT EXISTS events(path TEXT,source TEXT,event_id TEXT,ts INTEGER,model TEXT,input INTEGER,output INTEGER,cache_read INTEGER,cache_write INTEGER,partial INTEGER,PRIMARY KEY(path,event_id));").map_err(|_|"无法初始化统计缓存")?;Ok(db)
}
pub fn scan(days:u32)->Result<Summary,String>{
    if ![7,30,90].contains(&days){return Err("统计区间无效".into())}
    let root=crate::config::get_config_dir();fs::create_dir_all(&root).map_err(|_|"无法创建统计缓存")?;
    scan_paths(days,&root.join("ledger-v1.sqlite"),sources())
}
fn scan_paths(days:u32,db_path:&Path,paths:Vec<(String,PathBuf)>)->Result<Summary,String>{
    let mut db=database(db_path)?;let mut changed=0;let mut skipped=0;let scanned=paths.len();
    let live:Vec<String>=paths.iter().map(|(_,p)|format!("{:x}",Sha256::digest(p.to_string_lossy().as_bytes()))).collect();
    for (source,path) in paths{
        let result=(||->Result<(),String>{
            let metadata=fs::metadata(&path).map_err(|_|"metadata")?;
            if metadata.len()>256*1024*1024{return Err("large".into())}
            let mtime=metadata.modified().ok().and_then(|t|t.duration_since(std::time::UNIX_EPOCH).ok()).map(|t|t.as_nanos().min(i64::MAX as u128) as i64).unwrap_or(0);
            let path_key=format!("{:x}",Sha256::digest(path.to_string_lossy().as_bytes()));
            let mut file=File::open(&path).map_err(|_|"read")?;let mut start=vec![0;metadata.len().min(1024) as usize];file.read_exact(&mut start).map_err(|_|"read")?;
            let prefix=format!("{:x}",Sha256::digest(&start));
            let old:Option<(u64,i64,String,u64,String)>=db.query_row("SELECT size,mtime,prefix,offset,state FROM files WHERE path=?",[&path_key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).ok();
            if old.as_ref().is_some_and(|(size,time,_,_,_)|*size==metadata.len()&&*time==mtime){return Ok(())}
            let jsonl=path.extension().is_some_and(|e|e=="jsonl");
            let append=jsonl&&old.as_ref().is_some_and(|(size,_,p,_,_)|metadata.len()>*size&&*size>=1024&&p==&prefix);
            let (mut offset,mut state)=match if append{old.as_ref()}else{None}{Some((_,_,_,o,s))=>(*o,serde_json::from_str::<State>(s).unwrap_or_default()),_=>(0,State::default())};
            let tx=db.transaction().map_err(|_|"lock")?;
            if !append{tx.execute("DELETE FROM events WHERE path=?",[&path_key]).map_err(|_|"db")?;}
            let insert=|v:&Value,offset:u64,state:&mut State|->Result<(),String>{
                if let Some(event)=parse(&source,v,state,offset){
                    // Codex ids are timestamp+content hashes and survive a move into
                    // archived_sessions; only offset-derived ids need the path namespace.
                    let id=if event.id.starts_with("offset-")||["cline","roocode","kilocode"].contains(&source.as_str()){format!("{path_key}/{}",event.id)}else{event.id};
                    tx.execute("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(path,event_id) DO UPDATE SET input=MAX(input,excluded.input),output=MAX(output,excluded.output),cache_read=MAX(cache_read,excluded.cache_read),cache_write=MAX(cache_write,excluded.cache_write),partial=MAX(partial,excluded.partial)",params![path_key,source,id,event.ts,event.model,event.counts[0],event.counts[1],event.counts[2],event.counts[3],event.partial as u8]).map_err(|_|"record")?;
                }Ok(())
            };
            file.seek(SeekFrom::Start(offset)).map_err(|_|"seek")?;
            if jsonl {
                let mut reader=BufReader::new(file);loop{
                    let mut line=vec![];let read=reader.by_ref().take(2*1024*1024+1).read_until(b'\n',&mut line).map_err(|_|"line")?;
                    if read==0{break}if read>2*1024*1024{return Err("oversized line".into())}
                    if !line.ends_with(b"\n"){break} // incomplete trailing record retried after append
                    match serde_json::from_slice::<Value>(&line){Ok(v)=>insert(&v,offset,&mut state)?,Err(_)=>{skipped+=1;}}
                    offset+=read as u64;
                }
            }else{
                if metadata.len()>16*1024*1024{return Err("large json".into())}
                let v:Value=serde_json::from_reader(file).map_err(|_|"json")?;
                let array=v.as_array().or_else(||v["messages"].as_array()).ok_or("format")?;
                for (i,line) in array.iter().enumerate(){insert(line,i as u64,&mut state)?;}offset=metadata.len();
            }
            tx.execute("INSERT OR REPLACE INTO files VALUES(?,?,?,?,?,?,?)",params![path_key,source,metadata.len(),mtime,prefix,offset,serde_json::to_string(&state).map_err(|_|"state")?]).map_err(|_|"checkpoint")?;
            tx.commit().map_err(|_|"commit")?;changed+=1;Ok(())
        })();if result.is_err(){skipped+=1;}
    }
    // Rows for files that were moved or deleted would otherwise be summed forever.
    {
        let tx=db.transaction().map_err(|_|"lock")?;
        tx.execute_batch("CREATE TEMP TABLE IF NOT EXISTS live(path TEXT PRIMARY KEY); DELETE FROM live;").map_err(|_|"db")?;
        for key in &live{tx.execute("INSERT OR IGNORE INTO live VALUES(?)",[key]).map_err(|_|"db")?;}
        tx.execute("DELETE FROM events WHERE path NOT IN (SELECT path FROM live)",[]).map_err(|_|"db")?;
        tx.execute("DELETE FROM files WHERE path NOT IN (SELECT path FROM live)",[]).map_err(|_|"db")?;
        tx.commit().map_err(|_|"commit")?;
    }
    let today=chrono::Local::now().date_naive();let first=today-chrono::Duration::days(days as i64-1);
    let mut stmt=db.prepare("SELECT source,model,ts,MAX(input),MAX(output),MAX(cache_read),MAX(cache_write),MAX(partial) FROM events GROUP BY source,event_id").map_err(|_|"统计查询失败")?;
    let result=stmt.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?,[r.get::<_,u64>(3)?,r.get::<_,u64>(4)?,r.get::<_,u64>(5)?,r.get::<_,u64>(6)?],r.get::<_,bool>(7)?))).map_err(|_|"统计读取失败")?;
    let mut buckets:BTreeMap<(String,String,String,String),Row>=BTreeMap::new();
    for (source,model,ts,c,partial) in result.flatten(){let Some(date)=chrono::DateTime::from_timestamp(ts,0).map(|d|d.with_timezone(&chrono::Local))else{continue};
        if date.date_naive()<first||date.date_naive()>today{continue}let day=date.format("%Y-%m-%d").to_string();let hour=date.format("%H:00").to_string();
        let row=buckets.entry((source.clone(),model.clone(),day.clone(),hour.clone())).or_insert(Row{source,model,day,hour,input:0,output:0,cache_read:0,cache_write:0,partial:false});
        row.input+=c[0];row.output+=c[1];row.cache_read+=c[2];row.cache_write+=c[3];row.partial|=partial;
    }
    let rows:Vec<_>=buckets.into_values().collect();let partial=skipped>0||rows.iter().any(|r|r.partial);
    Ok(Summary{rows,scanned_files:scanned,skipped_files:skipped,changed_files:changed,days,partial,cost_estimate:None,notes:vec!["仅读取本机记录；缺失文件不代表零消耗。".into(),"费用暂不可用；不把未知模型价格当作零。".into(),"Gemini/OpenClaw/编辑器记录为部分格式覆盖；Copilot、导出来源及其他目录尚未支持。".into()]})
}
#[cfg(test)]mod tests{
    use super::*;use serde_json::json;
    #[test]fn codex_cumulative_counts_cache_once(){let mut s=State{model:"model".into(),..Default::default()};let v=json!({"type":"event_msg","timestamp":"2026-09-17T00:00:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":30,"output_tokens":20}}}});assert_eq!(parse("codex",&v,&mut s,0).unwrap().counts,[70,20,30,0]);assert!(parse("codex",&v,&mut s,1).is_none());}
    #[test]fn incremental_roundtrip_no_double_count(){let d=tempfile::tempdir().unwrap();let file=d.path().join("session.jsonl");let db=d.path().join("cache.db");let v=json!({"type":"assistant","timestamp":chrono::Utc::now().to_rfc3339(),"message":{"id":"m1","model":"x","usage":{"input_tokens":10,"output_tokens":5}}});fs::write(&file,format!("{v}\n{v}\n")).unwrap();let paths=vec![("claude".into(),file)];let a=scan_paths(7,&db,paths.clone()).unwrap();let b=scan_paths(7,&db,paths).unwrap();assert_eq!(a.rows[0].input,10);assert_eq!(b.rows[0].input,10);assert_eq!(b.changed_files,0);}
    #[test]fn malformed_lines_are_partial(){let d=tempfile::tempdir().unwrap();let file=d.path().join("x.jsonl");fs::write(&file,"{bad}\n").unwrap();assert!(scan_paths(7,&d.path().join("db"),vec![("claude".into(),file)]).unwrap().partial);}
    #[test]fn archived_codex_session_is_not_double_counted(){
        let d=tempfile::tempdir().unwrap();let db=d.path().join("cache.db");
        let live=d.path().join("sessions");let archive=d.path().join("archived_sessions");fs::create_dir_all(&live).unwrap();fs::create_dir_all(&archive).unwrap();
        let ctx=json!({"type":"turn_context","payload":{"model":"gpt"}});
        let ev=json!({"type":"event_msg","timestamp":chrono::Utc::now().to_rfc3339(),"payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":20}}}});
        let first=live.join("rollout.jsonl");fs::write(&first,format!("{ctx}\n{ev}\n")).unwrap();
        let before=scan_paths(7,&db,vec![("codex".into(),first.clone())]).unwrap();
        assert_eq!(before.rows.iter().map(|r|r.input).sum::<u64>(),100);
        let moved=archive.join("rollout.jsonl");fs::rename(&first,&moved).unwrap();
        let after=scan_paths(7,&db,vec![("codex".into(),moved)]).unwrap();
        assert_eq!(after.rows.iter().map(|r|r.input).sum::<u64>(),100,"a session moved to archived_sessions must be counted once");
        let gone=scan_paths(7,&db,vec![]).unwrap();
        assert!(gone.rows.is_empty(),"events of deleted files must not linger");
    }
}
