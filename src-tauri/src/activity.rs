//! CLI activity detection (Claude Code, Codex): incremental JSONL reads classified into
//! working/idle events. Transcript content never leaves this module — only state flags.
use serde_json::Value;
use std::{collections::HashMap,fs,io::{Read,Seek,SeekFrom},path::PathBuf};

#[derive(Debug,Clone,Copy,PartialEq,Eq)]
pub enum Event{Working,Idle}

/// Conservative, allow-listed event classification per source.
pub fn classify_line(source:&str,v:&Value)->Option<Event>{
    match source{
        "claude"=>match v["type"].as_str()?{
            "user"=>Some(Event::Working),
            "assistant"=>{
                let sr=v.pointer("/message/stop_reason").and_then(|x|x.as_str());
                match sr{
                    Some("tool_use")=>Some(Event::Working),
                    Some("end_turn")|Some("max_tokens")=>Some(Event::Idle),
                    _=>{
                        let has_tool=v.pointer("/message/content").and_then(|c|c.as_array())
                            .is_some_and(|a|a.iter().any(|b|b["type"]=="tool_use"));
                        if has_tool{Some(Event::Working)}else{None}
                    }
                }
            }
            _=>None,
        },
        "codex"=>{
            if v["type"].as_str()?!="event_msg"{return None}
            let pt=v.pointer("/payload/type").and_then(|x|x.as_str())?;
            match pt{
                "token_count"|"task_started"|"agent_reasoning"|"exec_command_begin"|"turn_started"=>Some(Event::Working),
                "task_complete"|"turn_aborted"|"task_interrupted"|"shutdown_complete"=>Some(Event::Idle),
                _=>None,
            }
        }
        _=>None,
    }
}

fn roots()->Vec<(&'static str,PathBuf)>{
    let mut out=vec![];
    if let Some(p)=crate::providers::credentials::home_path("CLAUDE_CONFIG_DIR",".claude"){out.push(("claude",p.join("projects")))}
    if let Some(p)=crate::providers::credentials::home_path("CODEX_HOME",".codex"){out.push(("codex",p.join("sessions")))}
    out
}

fn discover(root:&PathBuf,out:&mut Vec<PathBuf>,depth:usize){
    if depth>6||out.len()>=5000{return}
    let Ok(entries)=fs::read_dir(root)else{return};
    for e in entries.flatten(){
        let Ok(kind)=e.file_type()else{continue};
        if kind.is_symlink(){continue}
        let p=e.path();
        if kind.is_dir(){discover(&p,out,depth+1)}
        else if p.extension().is_some_and(|x|x=="jsonl"){out.push(p)}
    }
}

/// Last classified event from the bytes appended after `offset`; returns the offset of the
/// last complete line so a torn tail is retried after the next append.
fn scan_appended(path:&PathBuf,offset:u64,source:&str)->Option<(Option<Event>,u64)>{
    let mut f=fs::File::open(path).ok()?;
    let len=f.metadata().ok()?.len();
    if len<=offset{return None}
    f.seek(SeekFrom::Start(offset)).ok()?;
    let mut buf=Vec::new();
    f.read_to_end(&mut buf).ok()?;
    let complete_end=match buf.iter().rposition(|&b|b==b'\n'){Some(i)=>i+1,None=>return None};
    let mut last=None;
    for line in buf[..complete_end].split(|&b|b==b'\n'){
        if line.is_empty(){continue}
        if let Ok(v)=serde_json::from_slice::<Value>(line){
            if let Some(ev)=classify_line(source,&v){last=Some(ev)}
        }
    }
    Some((last,offset+complete_end as u64))
}

/// Incremental watcher: first sight of a file starts at its end (history is not activity);
/// truncation restarts from zero; a working verdict decays after 3 quiet minutes.
#[derive(Default)]
pub struct Watcher{
    roots:Vec<(&'static str,PathBuf)>,
    files:HashMap<PathBuf,u64>,
    last_working:HashMap<&'static str,i64>,
    states:HashMap<&'static str,bool>,
}
impl Watcher{
    /// Real CLI log locations (Claude projects, Codex sessions).
    pub fn system_roots()->Vec<(&'static str,PathBuf)>{
        let mut out=vec![];
        if let Some(p)=crate::providers::credentials::home_path("CLAUDE_CONFIG_DIR",".claude"){out.push(("claude",p.join("projects")))}
        if let Some(p)=crate::providers::credentials::home_path("CODEX_HOME",".codex"){out.push(("codex",p.join("sessions")))}
        out
    }
    pub fn new(roots:Vec<(&'static str,PathBuf)>)->Self{Self{roots,..Default::default()}}
    pub fn poll(&mut self,now:i64)->HashMap<&'static str,bool>{
        for (source,root) in self.roots.clone(){
            let mut files=vec![];discover(&root,&mut files,0);
            for path in files{
                let len=fs::metadata(&path).map(|m|m.len()).unwrap_or(0);
                let offset=match self.files.get(&path){
                    Some(&o)=>if o<=len{o}else{self.files.insert(path.clone(),0);0},
                    None=>{self.files.insert(path.clone(),len);continue}
                };
                if len==offset{continue}
                if let Some((ev,new_off))=scan_appended(&path,offset,source){
                    self.files.insert(path,new_off);
                    match ev{
                        Some(Event::Working)=>{self.last_working.insert(source,now);self.states.insert(source,true);}
                        Some(Event::Idle)=>{self.states.insert(source,false);}
                        None=>{}
                    }
                }
            }
        }
        for (source,last) in &self.last_working{
            if now-*last>180{self.states.insert(source,false);}
        }
        self.states.clone()
    }
}

#[cfg(test)]
mod tests{
    use super::*;use serde_json::json;
    #[test]fn claude_events(){
        assert_eq!(classify_line("claude",&json!({"type":"user"})),Some(Event::Working));
        assert_eq!(classify_line("claude",&json!({"type":"assistant","message":{"stop_reason":"tool_use"}})),Some(Event::Working));
        assert_eq!(classify_line("claude",&json!({"type":"assistant","message":{"stop_reason":"end_turn"}})),Some(Event::Idle));
        assert_eq!(classify_line("claude",&json!({"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash"}]}})),Some(Event::Working));
        assert_eq!(classify_line("claude",&json!({"type":"summary"})),None);
    }
    #[test]fn codex_events(){
        assert_eq!(classify_line("codex",&json!({"type":"event_msg","payload":{"type":"token_count"}})),Some(Event::Working));
        assert_eq!(classify_line("codex",&json!({"type":"event_msg","payload":{"type":"task_complete"}})),Some(Event::Idle));
        assert_eq!(classify_line("codex",&json!({"type":"event_msg","payload":{"type":"unknown_thing"}})),None);
        assert_eq!(classify_line("codex",&json!({"type":"turn_context"})),None);
    }
    #[test]fn first_sight_skips_history_and_appends_count(){
        let d=tempfile::tempdir().unwrap();let p=d.path().join("s.jsonl");
        fs::write(&p,format!("{}\n",json!({"type":"user"}))).unwrap();
        let mut w=Watcher::new(vec![("claude",d.path().to_path_buf())]);
        let states=w.poll(1_000);
        assert_eq!(states.get("claude"),None,"historical lines must not mark activity");
        let first_off=*w.files.get(&p).unwrap();
        assert_eq!(first_off as usize,format!("{}\n",json!({"type":"user"})).len(),"first sight starts at file end");
        fs::write(&p,format!("{}\n{}\n",json!({"type":"user"}),json!({"type":"user"}))).unwrap();
        let total=fs::metadata(&p).unwrap().len();
        let states=w.poll(2_000);
        assert_eq!(states.get("claude"),Some(&true),"appended user event means working");
        assert_eq!(*w.files.get(&p).unwrap(),total,"offset advances past consumed lines");
    }
}
