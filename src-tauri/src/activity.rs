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
        },
        // Kimi Code IDE：~/.kimi-code/server/events/session_*.jsonl，事件在 envelope.type。
        // turn.step.completed 不熄灯（一个 turn 含多步，step 间会闪烁）；turn.ended/prompt.completed 才熄。
        // 增加 turn.failed/turn.cancelled 等异常事件以及 event.session.work_changed(busy: false) 双重保底。
        "kimi"=>{
            let t=v["envelope"]["type"].as_str()?;
            match t{
                "turn.started"|"prompt.started"|"prompt.submitted"|"turn.step.started"|"tool.call.started"=>Some(Event::Working),
                "turn.ended"|"prompt.completed"|"turn.failed"|"turn.cancelled"|"turn.interrupted"|"prompt.failed"|"prompt.cancelled"=>Some(Event::Idle),
                "event.session.work_changed"=>match v.pointer("/payload/busy").and_then(|b|b.as_bool()){
                    Some(true)=>Some(Event::Working),
                    Some(false)=>Some(Event::Idle),
                    None=>None,
                },
                _=>None,
            }
        },
        "zhipu"=>{
            let ev=v["event"].as_str()?;
            match ev{
                "turn.started"|"model.request.started"|"tool.call.started"=>Some(Event::Working),
                "turn.completed"|"turn.failed"=>Some(Event::Idle),
                _=>None,
            }
        },
        _=>None,
    }
}

/// 旁路 usage 提取（Round4 项目一）：从单行日志取输出 token 计数，与活动灯判定完全解耦
/// （classify_line 不受影响，token 永不作为工作信号）。返回 (message id, 输出 token 数)：
/// - Claude：message.usage.output_tokens，按 message.id 键控（流式块同 id 累计）；
/// - Codex：token_count 的 info.total_token_usage.output_tokens（会话内累计；info 可为 null）；
/// - 其余渠道返回 None —— 日志无 usage 字段就不产速率数据，上游显示「—」，绝不编造。
pub fn usage_out(source:&str,v:&Value)->Option<(Option<String>,u64)>{
    match source{
        "claude"=>Some((Some(v.pointer("/message/id").and_then(|x|x.as_str())?.to_string()),
            v.pointer("/message/usage/output_tokens").and_then(|x|x.as_u64())?)),
        "codex"=>if v.pointer("/payload/type").and_then(|x|x.as_str())==Some("token_count"){
            Some((None,v.pointer("/payload/info/total_token_usage/output_tokens").and_then(|x|x.as_u64())?))
        }else{None},
        _=>None,
    }
}

/// 活动灯不消费 token；这里是纯旁路簿记：每会话文件一个 60 秒滑动窗口的输出 token 增量。
/// - 增量：同 message id 的后续块按累计差计；新 message id 的首块计数即增量（流式已写出部分）；
///   无键累计序列（Codex token_count）首个观测是基线、产 0，其后按累计差计。
/// - 回退：累计值变小（会话重开/重试）按 0 计并重置基线，绝不产生负增量或虚增尖峰。
/// - 滑出：窗口外样本丢弃，速率随之衰减为 None（上游显示「—」）。
pub const RATE_WINDOW_SECS:i64=60;
#[derive(Default)]
pub struct RateWindow{samples:Vec<(i64,u64)>,last_key:Option<String>,last_total:Option<u64>}
impl RateWindow{
    /// 记录一次 usage 观测，返回计入窗口的增量（tok，>=0）。
    pub fn observe(&mut self,now:i64,key:Option<&str>,value:u64)->u64{
        let delta=match (key,self.last_key.as_deref()){
            (Some(k),Some(prev)) if k==prev=>value.saturating_sub(self.last_total.unwrap_or(0)),
            (Some(_),_)=>value,
            (None,_)=>match self.last_total{Some(prev)=>value.saturating_sub(prev),None=>0},
        };
        self.last_key=key.map(str::to_string);
        self.last_total=Some(value);
        if delta>0{self.samples.push((now,delta));}
        self.samples.retain(|(ts,_)|now-*ts<RATE_WINDOW_SECS);
        delta
    }
    /// 窗口速率 tok/min：窗口增量 / 窗口秒数 × 60；窗口内无增量返回 None。
    pub fn rate(&self,now:i64)->Option<f64>{
        let total:u64=self.samples.iter().filter(|(ts,_)|now-*ts<RATE_WINDOW_SECS).map(|(_,d)|*d).sum();
        if total==0{None}else{Some(total as f64*60.0/RATE_WINDOW_SECS as f64)}
    }
}

fn roots()->Vec<(&'static str,PathBuf)>{
    let mut out=vec![];
    if let Some(p)=crate::providers::credentials::home_path("CLAUDE_CONFIG_DIR",".claude"){out.push(("claude",p.join("projects")))}
    if let Some(p)=crate::providers::credentials::home_path("CODEX_HOME",".codex"){out.push(("codex",p.join("sessions")))}
    // ZCode（zhipu 账号的 CLI）：监控 cli/log 目录下的 zcode-*.jsonl
    // 包含 turn.started/model.request.started/tool.call.started 与 turn.completed/turn.failed 事件。
    if let Some(p)=crate::providers::credentials::home_path("ZCODE_HOME",".zcode"){
        out.push(("zhipu",p.join("cli").join("log")));
    }
    // Kimi Code IDE：server/events 的会话事件流（envelope.type 结构化事件）。
    if let Some(p)=crate::providers::credentials::home_path("KIMI_CODE_HOME",".kimi-code"){
        out.push(("kimi",p.join("server").join("events")));
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
/// last complete line so a torn tail is retried after the next append. Usage lines are fed
/// to `rw` sideband-only; both paths parse exactly the lines the offset advance covers, so
/// a retried torn tail never double-counts tokens.
fn scan_appended(path:&PathBuf,offset:u64,budget:u64,source:&str,now:i64,rw:&mut RateWindow)->Option<(Option<Event>,u64)>{
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
            if let Some((key,out))=usage_out(source,&v){rw.observe(now,key.as_deref(),out);}
        }
    }
    Some((last,offset+complete_end as u64))
}

/// Incremental watcher: first sight of a file starts at its end (history is not activity);
/// truncation restarts from zero; a working verdict decays after 30 quiet minutes.
/// 每文件=一个会话；30 分钟无事件兜底衰减（长思考模型如 K2.8 High 思考单步可达 5~15 分钟）；
/// 正常结束由 turn.ended/prompt.completed/task_complete/end_turn 0 延迟即时熄灯；每轮/每文件读取预算防大积压阻塞。
const SESSION_DECAY_SECS:i64=1800;
const READ_BUDGET_BYTES:u64=1024*1024;
const POLL_TOTAL_BUDGET_BYTES:u64=8*1024*1024;
#[derive(Default)]
pub struct Watcher{
    roots:Vec<(&'static str,PathBuf)>,
    files:HashMap<PathBuf,u64>,
    sessions:HashMap<PathBuf,(bool,i64)>,
    /// 每会话文件的旁路速率窗口（Round4 项目一；与活动灯状态互不影响）。
    rates:HashMap<PathBuf,RateWindow>,
    /// 最近一次 poll 的按源速率快照：Some=f64 tok/min；None=该渠道日志无 usage 字段，
    /// 或 60 秒窗口内无增量（速率衰减为 None）；<1 tok/min 另由 poll_activity 归一为
    /// None（语义同 types.rs ProviderUsage::tok_per_min，前端显示「—」）。
    rate_snapshot:HashMap<&'static str,Option<f64>>,
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
                    Some(&o)=>if o<=len{o}else{self.files.insert(path.clone(),0);self.rates.remove(&path);0},
                    None=>{self.files.insert(path.clone(),len);continue}
                };
                if len==offset{continue}
                let take=((len-offset) as u64).min(READ_BUDGET_BYTES).min(budget);
                if take==0{continue}
                budget-=take;
                // 字节级源（语言服务器日志等非 JSONL 格式）：按特定标志或增量判定。
                let (ev,new_off)=match source{
                    "antigravity"=>{
                        let mut f=fs::File::open(&path).ok();
                        let is_working=if let Some(ref mut file)=f{
                            use std::io::{Seek,SeekFrom,Read};
                            let mut buf=vec![0u8;take as usize];
                            if file.seek(SeekFrom::Start(offset)).is_ok() && file.read_exact(&mut buf).is_ok(){
                                buf.windows(b"streamGenerateContent".len()).any(|w|w==b"streamGenerateContent")
                            }else{false}
                        }else{false};
                        (if is_working{Some(Event::Working)}else{None},offset+take)
                    },
                    _=>{
                        let rw=self.rates.entry(path.clone()).or_default();
                        match scan_appended(&path,offset,take,source,now,rw){Some((e,o))=>(e,o),None=>continue}
                    },
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
        self.rates.retain(|k,_|seen.contains(k));
        // 按源聚合各会话窗口速率；无 usage 字段的渠道、或窗口内无增量的时刻，保持 None
        // （诚实降级，前端显示 —；<1 由 lib.rs 归一为 None）。
        let mut agg:HashMap<&'static str,f64>=HashMap::new();
        for (path,rw) in &self.rates{
            if let Some(src)=self.source_of(path){
                if let Some(r)=rw.rate(now){*agg.entry(src).or_default()+=r;}
            }
        }
        self.rate_snapshot=self.roots.iter().map(|(s,_)|(*s,agg.get(s).copied())).collect();
        // 会话级衰减：antigravity 无明确结束事件，20s 无请求即转空闲；其余 3 分钟衰减。
        let roots=&self.roots;
        self.sessions.retain(|p,(_,last)|{
            let is_antigravity=roots.iter().find(|(_,root)|p.starts_with(root)).map(|(s,_)|*s)==Some("antigravity");
            let limit=if is_antigravity{20}else{SESSION_DECAY_SECS};
            now-*last<=limit
        });
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
    /// 最近一次 poll 的按源 tok/min 快照（配合 `poll` 使用）；None=渠道日志无 usage
    /// 字段或 60 秒窗口内无增量（速率不足 1 由 lib.rs 归一为 None，前端显示「—」）。
    pub fn rates(&self)->HashMap<&'static str,Option<f64>>{self.rate_snapshot.clone()}
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
    #[test]fn zhipu_events(){
        assert_eq!(classify_line("zhipu",&json!({"event":"turn.started"})),Some(Event::Working));
        assert_eq!(classify_line("zhipu",&json!({"event":"model.request.started"})),Some(Event::Working));
        assert_eq!(classify_line("zhipu",&json!({"event":"tool.call.started"})),Some(Event::Working));
        assert_eq!(classify_line("zhipu",&json!({"event":"turn.completed"})),Some(Event::Idle));
        assert_eq!(classify_line("zhipu",&json!({"event":"turn.failed"})),Some(Event::Idle));
        assert_eq!(classify_line("zhipu",&json!({"event":"zcode_protocol.process.memory_sample"})),None);
    }
    #[test]fn kimi_events(){
        let ev=|t:&str|json!({"kind":"event","envelope":{"type":t}});
        assert_eq!(classify_line("kimi",&ev("turn.started")),Some(Event::Working));
        assert_eq!(classify_line("kimi",&ev("turn.step.started")),Some(Event::Working));
        assert_eq!(classify_line("kimi",&ev("tool.call.started")),Some(Event::Working));
        assert_eq!(classify_line("kimi",&ev("turn.ended")),Some(Event::Idle));
        assert_eq!(classify_line("kimi",&ev("prompt.completed")),Some(Event::Idle));
        assert_eq!(classify_line("kimi",&ev("turn.failed")),Some(Event::Idle));
        assert_eq!(classify_line("kimi",&ev("turn.cancelled")),Some(Event::Idle));
        assert_eq!(classify_line("kimi",&json!({"kind":"event","envelope":{"type":"event.session.work_changed"},"payload":{"busy":false}})),Some(Event::Idle));
        assert_eq!(classify_line("kimi",&json!({"kind":"event","envelope":{"type":"event.session.work_changed"},"payload":{"busy":true}})),Some(Event::Working));
        assert_eq!(classify_line("kimi",&ev("context.spliced")),None,"元事件不点亮");
        assert_eq!(classify_line("kimi",&json!({"kind":"journal_header"})),None);
    }
    #[test]fn zhipu_turn_lifecycle(){
        let d=tempfile::tempdir().unwrap();let p=d.path().join("zcode-2026-09-19.jsonl");
        fs::write(&p,format!("{}\n",json!({"event":"turn.started"}))).unwrap();
        let mut w=Watcher::new(vec![("zhipu",d.path().to_path_buf())]);
        assert_eq!(w.poll(1_000).get("zhipu"),Some(&false),"首见跳历史");
        use std::io::Write;
        let mut f=std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        f.write_all(format!("{}\n",json!({"event":"turn.started"})).as_bytes()).unwrap();drop(f);
        assert_eq!(w.poll(2_000).get("zhipu"),Some(&true),"turn.started = 工作中");
        let mut f=std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        f.write_all(format!("{}\n",json!({"event":"turn.completed"})).as_bytes()).unwrap();drop(f);
        assert_eq!(w.poll(3_000).get("zhipu"),Some(&false),"turn.completed = 空闲");
    }
    #[test]fn antigravity_rate_gate(){
        let d=tempfile::tempdir().unwrap();let p=d.path().join("language_server.log");
        fs::write(&p,"seed\n").unwrap();
        let mut w=Watcher::new(vec![("antigravity",d.path().to_path_buf())]);
        assert_eq!(w.poll(1_000).get("antigravity"),Some(&false),"首见跳历史");
        use std::io::Write;
        // 空闲心跳（loadCodeAssist / fetchAvailableModels）：不点亮。
        let mut f=std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        f.write_all(b"URL: https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist\n").unwrap();drop(f);
        assert_eq!(w.poll(2_000).get("antigravity"),Some(&false),"空闲心跳不应点亮");
        // 任务流式请求（streamGenerateContent）：点亮。
        let mut f=std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        f.write_all(b"URL: https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse\n").unwrap();drop(f);
        assert_eq!(w.poll(3_000).get("antigravity"),Some(&true),"streamGenerateContent = 工作中");
        // 20 秒无请求 → 衰减熄灭。
        assert_eq!(w.poll(3_000+21).get("antigravity"),Some(&false),"20s 无请求自动熄灯");
    }
    #[test]fn rate_window_increment(){
        // 增量：基线不计数；无键累计序列按差计；同 message id 流式块按累计差计；
        // 新 message id 的首块计数即增量。速率 = 窗口增量/窗口秒数×60。
        let mut w=RateWindow::default();
        assert_eq!(w.observe(1_000,None,1_000),0,"首个累计观测是基线，不产增量");
        assert_eq!(w.observe(1_005,None,1_400),400);
        assert_eq!(w.observe(1_010,None,1_900),500);
        assert_eq!(w.rate(1_010),Some(900.0));
        assert_eq!(w.observe(1_012,Some("m1"),30),30,"新 message id 首块即增量");
        assert_eq!(w.observe(1_015,Some("m1"),80),50,"同 id 累计差");
        assert_eq!(w.rate(1_015),Some(980.0));
    }
    #[test]fn rate_window_rollback(){
        // 回退：累计值变小（会话重开/重试）按 0 计并重置基线；同 id 计数倒退钳为 0。
        let mut w=RateWindow::default();
        w.observe(1_000,None,5_000);
        assert_eq!(w.observe(1_005,None,4_900),0,"累计回退不产增量");
        assert_eq!(w.observe(1_010,None,5_050),150,"回退后按新基线继续");
        assert_eq!(w.observe(1_020,Some("m1"),120),120);
        assert_eq!(w.observe(1_030,Some("m1"),40),0,"同 id 计数倒退钳为 0");
        assert_eq!(w.observe(1_040,Some("m2"),60),60);
        assert_eq!(w.rate(1_040),Some(330.0),"窗口内只有真实增量 150+120+60");
    }
    #[test]fn rate_window_slide_out(){
        // 滑出：60 秒窗口外的样本丢弃；窗口清空后速率归 None（上游显示 —）。
        let mut w=RateWindow::default();
        w.observe(1_000,None,100);w.observe(1_005,None,700);
        assert_eq!(w.rate(1_010),Some(600.0));
        assert_eq!(w.rate(1_005+59),Some(600.0),"窗口边缘内保持");
        assert_eq!(w.rate(1_005+60),None,"60 秒滑出后无数据");
        // 滑出后基线仍在，后续增量继续按差计。
        assert_eq!(w.observe(1_070,None,900),200);
        assert_eq!(w.rate(1_070),Some(200.0));
    }
    #[test]fn usage_extraction_claude_and_codex(){
        let claude=json!({"type":"assistant","message":{"id":"msg_1","usage":{"input_tokens":4,"output_tokens":42}}});
        assert_eq!(usage_out("claude",&claude),Some((Some("msg_1".into()),42)));
        assert_eq!(usage_out("claude",&json!({"type":"user","message":{}})),None,"无 usage 字段不产速率");
        assert_eq!(usage_out("claude",&json!({"type":"summary","summary":"x"})),None);
        let codex=json!({"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"output_tokens":1234},"last_token_usage":{"output_tokens":12}}}});
        assert_eq!(usage_out("codex",&codex),Some((None,1234)));
        assert_eq!(usage_out("codex",&json!({"type":"event_msg","payload":{"type":"token_count","info":null}})),None,"info 为 null 不产速率");
        assert_eq!(usage_out("codex",&json!({"type":"event_msg","payload":{"type":"agent_reasoning"}})),None);
        // 无 usage 概念的渠道一律 None（前端显示 —）。
        assert_eq!(usage_out("zhipu",&json!({"event":"turn.started"})),None);
        assert_eq!(usage_out("kimi",&json!({"envelope":{"type":"turn.started"}})),None);
        assert_eq!(usage_out("antigravity",&json!({})),None);
    }
    #[test]fn usage_sideband_feeds_rate_without_changing_light(){
        // 旁路语义：usage 行同时携带 end_turn（熄灯事件）——灯必须熄，速率照常采集。
        let d=tempfile::tempdir().unwrap();let p=d.path().join("s.jsonl");
        fs::write(&p,format!("{}\n",json!({"type":"user"}))).unwrap();
        let mut w=Watcher::new(vec![("claude",d.path().to_path_buf())]);
        w.poll(9_000); // 首见跳历史
        use std::io::Write;
        let mut f=std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        f.write_all(format!("{}\n",json!({"type":"assistant","message":{"id":"msg_a","stop_reason":"end_turn","usage":{"output_tokens":42}}})).as_bytes()).unwrap();drop(f);
        assert_eq!(w.poll(9_005).get("claude"),Some(&false),"end_turn 照常熄灯：token 不作为工作信号");
        assert_eq!(w.rates().get("claude"),Some(&Some(42.0)),"usage 仍被旁路采集");
        w.poll(9_005+60);
        assert_eq!(w.rates().get("claude"),Some(&None),"60 秒滑出后速率归 None");
    }
    #[test]fn codex_token_count_feeds_rate_not_light(){
        // token_count 是用量遥测：不点亮（沿用既有分类），但总量差进入速率窗口。
        let d=tempfile::tempdir().unwrap();let p=d.path().join("rollout.jsonl");
        let line=|v:serde_json::Value|format!("{}\n",v);
        let mut f=std::fs::OpenOptions::new().create(true).append(true).open(&p).unwrap();
        f.write_all(line(json!({"type":"event_msg","payload":{"type":"task_started"}})).as_bytes()).unwrap();drop(f);
        let mut w=Watcher::new(vec![("codex",d.path().to_path_buf())]);
        w.poll(1_000); // 首见跳历史
        use std::io::Write;
        let mut f=std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        f.write_all(line(json!({"type":"event_msg","payload":{"type":"agent_reasoning"}})).as_bytes()).unwrap();drop(f);
        assert_eq!(w.poll(2_000).get("codex"),Some(&true));
        assert_eq!(w.rates().get("codex"),Some(&None),"基线观测不产速率");
        let mut f=std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        f.write_all(line(json!({"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"output_tokens":2_000}}}})).as_bytes()).unwrap();drop(f);
        assert_eq!(w.poll(3_000).get("codex"),Some(&true),"token_count 不改变活动灯");
        assert_eq!(w.rates().get("codex"),Some(&None),"首个 token_count 是基线（起步前的不计）");
        let mut f=std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        f.write_all(line(json!({"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"output_tokens":2_600}}}})).as_bytes()).unwrap();drop(f);
        w.poll(4_000);
        assert_eq!(w.rates().get("codex"),Some(&Some(600.0)),"总量差 600 进入窗口");
    }
    #[test]fn truncated_file_resets_rate_baseline(){
        // 文件被截断重写（日志清理/会话重建）：旧累计基线必须丢弃，
        // 否则新会话总量一旦超过旧基线会编造出一次虚假增量尖峰。
        let d=tempfile::tempdir().unwrap();let p=d.path().join("rollout.jsonl");
        let line=|v:serde_json::Value|format!("{}\n",v);
        fs::write(&p,line(json!({"type":"event_msg","payload":{"type":"task_started"}}))).unwrap();
        let mut w=Watcher::new(vec![("codex",d.path().to_path_buf())]);
        w.poll(1_000); // 首见跳历史
        use std::io::Write;
        let mut f=std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        f.write_all(line(json!({"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"output_tokens":1_600}}}})).as_bytes()).unwrap();drop(f);
        let mut f=std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        f.write_all(line(json!({"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"output_tokens":2_200}}}})).as_bytes()).unwrap();drop(f);
        w.poll(2_000);
        assert_eq!(w.rates().get("codex"),Some(&Some(600.0)));
        fs::write(&p,line(json!({"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"output_tokens":2_000}}}}))).unwrap();
        w.poll(3_000);
        assert_eq!(w.rates().get("codex"),Some(&None),"截断后基线重置，不把新总量差当增量");
    }
    #[test]fn multi_session_rates_sum_per_source(){
        // 同源多会话并发：速率按源聚合（机器级吞吐），与活动灯"任一会话工作即亮"同源口径。
        let d=tempfile::tempdir().unwrap();
        let a=d.path().join("a.jsonl");let b=d.path().join("b.jsonl");
        fs::write(&a,format!("{}\n",json!({"type":"user"}))).unwrap();
        fs::write(&b,format!("{}\n",json!({"type":"user"}))).unwrap();
        let mut w=Watcher::new(vec![("claude",d.path().to_path_buf())]);
        w.poll(1_000); // 首见跳历史
        use std::io::Write;
        let mut f=std::fs::OpenOptions::new().append(true).open(&a).unwrap();
        f.write_all(format!("{}\n",json!({"type":"assistant","message":{"id":"m1","usage":{"output_tokens":100}}})).as_bytes()).unwrap();drop(f);
        let mut f=std::fs::OpenOptions::new().append(true).open(&b).unwrap();
        f.write_all(format!("{}\n",json!({"type":"assistant","message":{"id":"m2","usage":{"output_tokens":250}}})).as_bytes()).unwrap();drop(f);
        w.poll(2_000);
        assert_eq!(w.rates().get("claude"),Some(&Some(350.0)));
    }
}
