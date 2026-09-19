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
                // token_count 是用量遥测，不是活动信号（Codex 会在 task_complete 同秒补发统计，
            // 字节边界切批时会被当成"最后一个事件"把刚熄的灯重新点亮）——任务执行期的
            // 点亮由 task_started/agent_reasoning/exec_command_begin/turn_started 覆盖。
            "task_started"|"agent_reasoning"|"exec_command_begin"|"turn_started"=>Some(Event::Working),
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
    // ZCode（zhipu 账号的 CLI）：只监控任务执行日志（cli/exec/*.log）——agent 跑命令
    // 时持续追加，语义=「正在执行任务」。不再监控 v2 的 tasks-index.sqlite-wal
    // （实测误亮：后台索引/checkpoint 写入与对话无关，会把空闲点亮成工作中）。
    // Antigravity：language server 日志按速率判定（空闲心跳 ~280B/5s，agent 任务时
    // 流式日志远超阈值）。
    if let Some(p)=crate::providers::credentials::home_path("ZCODE_HOME",".zcode"){
        out.push(("zhipu",p.join("cli").join("exec")));
    }
    #[cfg(windows)]
    {
        let appdata=std::env::var("APPDATA").ok().map(PathBuf::from);
        if let Some(p)=appdata.map(|d|d.join("Antigravity").join("logs")){out.push(("antigravity",p))}
    }
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
        else if p.extension().is_some_and(|x|x=="jsonl"||x=="log"||x=="sqlite-wal"){out.push(p)}
    }
}

/// Last classified event from the bytes appended after `offset`; returns the offset of the
/// last complete line so a torn tail is retried after the next append.
fn scan_appended(path:&PathBuf,offset:u64,budget:u64,source:&str)->Option<(Option<Event>,u64)>{
    let mut f=fs::File::open(path).ok()?;
    let len=f.metadata().ok()?.len();
    if len<=offset{return None}
    f.seek(SeekFrom::Start(offset)).ok()?;
    let take=((len-offset) as u64).min(budget) as usize;
    let mut buf=vec![0u8;take];
    f.read_exact(&mut buf).ok()?;
    // 预算内没有换行分两种（B07）：读满文件预算仍无换行=真正的超长行，丢弃推进防卡死；
    // 否则是正常 torn tail（事件分两次写入/全局预算截断），保留偏移等待补全，不丢事件。
    let complete_end=match buf.iter().rposition(|&b|b==b'\n'){
        Some(i)=>i+1,
        None=>{
            if take==READ_BUDGET_BYTES as usize && (len-offset)>READ_BUDGET_BYTES{
                return Some((None,offset+take as u64));
            }
            return None;
        }
    };
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
/// 每文件=一个会话；3 分钟无事件衰减；每轮/每文件读取预算防大积压阻塞。
const SESSION_DECAY_SECS:i64=180;
const READ_BUDGET_BYTES:u64=1024*1024;
const POLL_TOTAL_BUDGET_BYTES:u64=8*1024*1024;
/// Antigravity 的 language server 空闲时也匀速写日志（实测 ~280B/5s 心跳），
/// agent 任务则是流式日志（每轮几十 KB）。按每轮增长量区分，低于阈值不算工作。
const AGENT_RATE_BYTES:u64=2048;
#[derive(Default)]
pub struct Watcher{
    roots:Vec<(&'static str,PathBuf)>,
    files:HashMap<PathBuf,u64>,
    sessions:HashMap<PathBuf,(bool,i64)>,
}
impl Watcher{
    fn source_of(&self,path:&PathBuf)->Option<&'static str>{
        self.roots.iter().find(|(_,root)|path.starts_with(root)).map(|(s,_)|*s)
    }
    /// Real CLI log locations (Claude projects, Codex sessions, ZCode, Antigravity).
    pub fn system_roots()->Vec<(&'static str,PathBuf)>{
        roots()
    }
    pub fn new(roots:Vec<(&'static str,PathBuf)>)->Self{Self{roots,..Default::default()}}
    pub fn poll(&mut self,now:i64)->HashMap<&'static str,bool>{
        // 每轮总读取预算：超大积压分多轮消化，不阻塞扫描。
        let mut budget=POLL_TOTAL_BUDGET_BYTES;
        let mut seen:std::collections::HashSet<PathBuf>=std::collections::HashSet::new();
        for (source,root) in self.roots.clone(){
            let mut files=vec![];discover(&root,&mut files,0);
            for path in files{
                seen.insert(path.clone());
                let len=fs::metadata(&path).map(|m|m.len()).unwrap_or(0);
                let offset=match self.files.get(&path){
                    Some(&o)=>if o<=len{o}else{self.files.insert(path.clone(),0);0},
                    None=>{self.files.insert(path.clone(),len);continue}
                };
                if len==offset{continue}
                let take=((len-offset) as u64).min(READ_BUDGET_BYTES).min(budget);
                if take==0{continue}
                budget-=take;
                // 字节级源（会话存储 / agent 日志）：不做 JSON 解析，按增长量判定。
                let (ev,new_off)=match source{
                    "zhipu"=>(Some(Event::Working),offset+take),
                    "antigravity"=>(if take>=AGENT_RATE_BYTES{Some(Event::Working)}else{None},offset+take),
                    _=>match scan_appended(&path,offset,take,source){Some((e,o))=>(e,o),None=>continue},
                };
                self.files.insert(path.clone(),new_off);
                match ev{
                    Some(Event::Working)=>{self.sessions.insert(path.clone(),(true,now));}
                    Some(Event::Idle)=>{self.sessions.insert(path.clone(),(false,now));}
                    None=>{}
                }
            }
        }
        // 回收已消失/轮转走的文件（日志清理、重命名），防长期运行内存缓涨。
        self.files.retain(|k,_|seen.contains(k));
        self.sessions.retain(|k,_|seen.contains(k));
        // 会话级衰减：每个文件独立 3 分钟无事件即转空闲；任一会话工作即源工作。
        self.sessions.retain(|_,(_,last)|now-*last<=SESSION_DECAY_SECS);
        // 对称报告：每个受监控源都必须出现——空闲源显式报 false，让 poll_activity
        // 能把 is_active 复位。只报 true 会让熄灯路径失联（v0.3.6 回归：灯亮后
        // 永不复位，除非重启）。
        let mut states:HashMap<&'static str,bool>=HashMap::new();
        for (source,_) in &self.roots{states.insert(source,false);}
        for path in self.files.keys(){
            if self.sessions.get(path).is_some_and(|(w,_)|*w){
                if let Some(src)=self.source_of(path){states.insert(src,true);}
            }
        }
        states
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
        assert_eq!(classify_line("codex",&json!({"type":"event_msg","payload":{"type":"token_count"}})),None,"用量遥测不点亮（结束后统计不得重新点亮）");
        assert_eq!(classify_line("codex",&json!({"type":"event_msg","payload":{"type":"task_complete"}})),Some(Event::Idle));
        assert_eq!(classify_line("codex",&json!({"type":"event_msg","payload":{"type":"unknown_thing"}})),None);
        assert_eq!(classify_line("codex",&json!({"type":"turn_context"})),None);
    }
    #[test]fn two_sessions_any_working_keeps_source_active(){
        let d=tempfile::tempdir().unwrap();
        let a=d.path().join("a.jsonl");let b=d.path().join("b.jsonl");
        fs::write(&a,format!("{}
",json!({"type":"user"}))).unwrap();
        fs::write(&b,format!("{}
",json!({"type":"user"}))).unwrap();
        let mut w=Watcher::new(vec![("claude",d.path().to_path_buf())]);
        w.poll(1_000); // 首见跳过
        fs::write(&a,format!("{}
{}
",json!({"type":"user"}),json!({"type":"user"}))).unwrap();
        fs::write(&b,format!("{}
{}
",json!({"type":"assistant","message":{"stop_reason":"end_turn"}}),json!({"type":"assistant","message":{"stop_reason":"end_turn"}}))).unwrap();
        let states=w.poll(2_000);
        assert_eq!(states.get("claude"),Some(&true),"B 会话空闲不应清掉 A 会话的工作状态");
    }
    #[test]fn first_sight_skips_history_and_appends_count(){
        let d=tempfile::tempdir().unwrap();let p=d.path().join("s.jsonl");
        fs::write(&p,format!("{}\n",json!({"type":"user"}))).unwrap();
        let mut w=Watcher::new(vec![("claude",d.path().to_path_buf())]);
        let states=w.poll(1_000);
        assert_eq!(states.get("claude"),Some(&false),"historical lines must not mark activity");
        let first_off=*w.files.get(&p).unwrap();
        assert_eq!(first_off as usize,format!("{}\n",json!({"type":"user"})).len(),"first sight starts at file end");
        fs::write(&p,format!("{}\n{}\n",json!({"type":"user"}),json!({"type":"user"}))).unwrap();
        let total=fs::metadata(&p).unwrap().len();
        let states=w.poll(2_000);
        assert_eq!(states.get("claude"),Some(&true),"appended user event means working");
        assert_eq!(*w.files.get(&p).unwrap(),total,"offset advances past consumed lines");
    }
    #[test]fn idle_source_reports_false_after_completion(){
        // v0.3.6 回归测试：工作结束后 poll 必须显式报 false（否则 poll_activity
        // 收不到复位信号，is_active 永久 true，卫星灯不熄灭）。
        let d=tempfile::tempdir().unwrap();let p=d.path().join("s.jsonl");
        let mut f=std::fs::OpenOptions::new().create(true).append(true).open(&p).unwrap();
        let line=|v:serde_json::Value|format!("{}\n",v);
        use std::io::Write;
        f.write_all(line(json!({"type":"event_msg","payload":{"type":"task_started"}})).as_bytes()).unwrap();drop(f);
        let mut w=Watcher::new(vec![("codex",d.path().to_path_buf())]);
        w.poll(1_000); // 首见跳过
        let mut f=std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        f.write_all(line(json!({"type":"event_msg","payload":{"type":"agent_reasoning"}})).as_bytes()).unwrap();drop(f);
        assert_eq!(w.poll(2_000).get("codex"),Some(&true),"工作中");
        let mut f=std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        f.write_all(line(json!({"type":"event_msg","payload":{"type":"task_complete"}})).as_bytes()).unwrap();drop(f);
        assert_eq!(w.poll(3_000).get("codex"),Some(&false),"任务完成后必须显式报 false 熄灯");
        assert_eq!(w.poll(3_000+200).get("codex"),Some(&false),"衰减期内保持 false 且不丢 key");
    }
    #[test]fn torn_tail_survives_and_completes(){
        // B07 回归：事件分两次追加写入。torn tail 阶段偏移必须停在完整行末尾
        // （=半行开头），补全后从那里重读，事件不丢。
        let d=tempfile::tempdir().unwrap();let p=d.path().join("s.jsonl");
        fs::write(&p,"").unwrap();
        let mut w=Watcher::new(vec![("claude",d.path().to_path_buf())]);
        assert_eq!(w.poll(1_000).get("claude"),Some(&false),"空文件不点亮");
        let mut f=std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        f.write_all(b"{\"type\":\"user\",\"x\":0}\n").unwrap();drop(f);
        assert_eq!(w.poll(1_100).get("claude"),Some(&true),"首条完整事件点亮");        let done_len=*w.files.get(&p).unwrap();
        // 追加半行（无换行）：torn tail——偏移不推进。
        let mut f=std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        use std::io::Write;f.write_all(b"{\"type\":\"user\",").unwrap();drop(f);
        assert_eq!(w.poll(1_200).get("claude"),Some(&true),"半行期间保持此前状态");
        assert_eq!(*w.files.get(&p).unwrap(),done_len,"torn tail 不推进偏移");
        // 补齐后半段：从半行开头重读，完整事件可解析。
        let mut f=std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        f.write_all(b"\"y\":2}\n").unwrap();drop(f);
        assert_eq!(w.poll(1_300).get("claude"),Some(&true),"补全后事件不丢");
    }
    #[test]fn oversize_line_is_dropped_not_stuck(){
        let d=tempfile::tempdir().unwrap();let p=d.path().join("big.jsonl");
        fs::write(&p,"seed\n").unwrap();
        let mut w=Watcher::new(vec![("claude",d.path().to_path_buf())]);
        w.poll(1_000); // 首见跳历史
        fs::write(&p,vec![b'x';(READ_BUDGET_BYTES+4096) as usize]).unwrap();
        w.poll(2_000);
        // 超长行读满预算仍无换行：偏移推进预算长度（不卡死），不产生事件。
        assert_eq!(*w.files.get(&p).unwrap(),"seed
".len() as u64+READ_BUDGET_BYTES);
        // 追加正常事件后可继续解析（未被超长行卡死）。
        let mut f=std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        use std::io::Write;f.write_all(format!("\n{}\n",json!({"type":"user"})).as_bytes()).unwrap();drop(f);
        assert_eq!(w.poll(3_000).get("claude"),Some(&true));
    }
    #[test]fn zhipu_any_append_is_working(){
        // 实测误亮后 zhipu 只监控 exec 任务日志；追加即工作中。
        let d=tempfile::tempdir().unwrap();let p=d.path().join("call_test-stdout.log");
        fs::write(&p,vec![0u8;512]).unwrap();
        let mut w=Watcher::new(vec![("zhipu",d.path().to_path_buf())]);
        assert_eq!(w.poll(1_000).get("zhipu"),Some(&false),"首见跳历史");
        // 二进制追加（任务日志写命令输出）——不做 JSON 解析，任何增长即工作。
        use std::io::Write;let mut f=std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        f.write_all(&[1,2,3,4]).unwrap();drop(f);
        assert_eq!(w.poll(2_000).get("zhipu"),Some(&true),"会话存储被写入 = 工作中");
        // 3 分钟无写入 → 衰减熄灭。
        assert_eq!(w.poll(2_000+181).get("zhipu"),Some(&false),"衰减后熄灭");
    }
    #[test]fn antigravity_rate_gate(){
        let d=tempfile::tempdir().unwrap();let p=d.path().join("language_server.log");
        fs::write(&p,"seed\n").unwrap();
        let mut w=Watcher::new(vec![("antigravity",d.path().to_path_buf())]);
        w.poll(1_000);
        use std::io::Write;
        // 心跳（<2KB/轮）：不点亮。
        let mut f=std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        f.write_all(&[b'x';400]).unwrap();drop(f);
        assert_eq!(w.poll(2_000).get("antigravity"),Some(&false),"空闲心跳不应点亮");
        // 任务流式日志（≥2KB/轮）：点亮。
        let mut f=std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        f.write_all(&[b'x';AGENT_RATE_BYTES as usize]).unwrap();drop(f);
        assert_eq!(w.poll(3_000).get("antigravity"),Some(&true),"高速日志 = agent 任务");
    }
}
