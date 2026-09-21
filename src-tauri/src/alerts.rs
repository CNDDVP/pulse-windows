//! Notification decisions, mirroring upstream Pulse: one notice per limit per step,
//! a reset only for windows that were warned on the way up, one notice per outage,
//! and one low-balance notice per money line. Pure: `now` is passed in.
use crate::types::{AppSettings,ProviderUsage};
use serde::{Deserialize,Serialize};
use std::collections::BTreeMap;

#[derive(Default,Clone,Debug,PartialEq,Serialize,Deserialize)]
pub struct WindowMemory{ pub step:Option<u8>, pub spent:bool, pub resets_at:Option<String>, pub share:Option<f64> }
#[derive(Default,Clone,Debug,PartialEq,Serialize,Deserialize)]
pub struct AccountMemory{
    pub windows:BTreeMap<String,WindowMemory>,
    pub failures:u32, pub outage_reported:bool,
    pub low_balance_line:Option<f64>, pub low_balance_reported:bool,
}
#[derive(Default,Clone,Debug,PartialEq,Serialize,Deserialize)]
pub struct Memory{ pub accounts:BTreeMap<String,AccountMemory> }

#[derive(Debug,Clone,PartialEq,Serialize)]
pub struct Notice{ pub account_id:String, pub kind:&'static str, pub title:String, pub body:String }

const OUTAGE_AFTER:u32=3;
/// Transport-level codes count towards an outage; setup problems and auth changes are neutral.
const FAILURE_CODES:&[&str]=&["network","timeout","server","rate_limited","internal"];

fn ts(s:&Option<String>)->Option<i64>{s.as_deref().and_then(|s|chrono::DateTime::parse_from_rfc3339(s).ok()).map(|d|d.timestamp())}
fn reset_text(at:&Option<String>,now:i64)->String{match ts(at){Some(t) if t>now=>{let s=t-now;if s>=86400{format!("{} 天后重置",s/86400)}else if s>=3600{format!("{} 小时后重置",s/3600)}else{format!("{} 分钟后重置",(s/60).max(1))}},_=>"等待重置".into()}}

/// `fresh` holds this cycle's raw fetch results only; cached/stale replacements never reach
/// here, so an outage is judged on real fetches and unfetched accounts keep their memory.
pub fn evaluate(fresh:&[ProviderUsage],settings:&AppSettings,mut memory:Memory,now:i64)->(Vec<Notice>,Memory){
    let mut notices=vec![];
    let n=&settings.notifications;
    for r in fresh{
        let Some(cfg)=settings.providers.get(&r.account_id) else{continue};
        if !cfg.enabled{continue}
        let mem=memory.accounts.entry(r.account_id.clone()).or_default();
        let name=if cfg.label.is_empty(){r.display_name.clone()}else{cfg.label.clone()};
        match r.state.as_str(){
            "live"=>{
                mem.failures=0;mem.outage_reported=false;
                // A live snapshot older than a day is not evidence of anything.
                if ts(&r.checked_at).is_some_and(|t|now-t>86400){continue}
                for w in &r.windows{
                    let wm=mem.windows.entry(w.id.clone()).or_default();
                    let share=w.used_percent;
                    let reset_moved=match (ts(&wm.resets_at),ts(&w.resets_at)){(Some(old),Some(new))=>new>old+60,_=>false};
                    let share_dropped=wm.share.is_some_and(|old|old-share>=40.0);
                    if reset_moved||share_dropped{
                        if wm.step.is_some()&&n.on_reset&&n.threshold.is_some(){
                            notices.push(Notice{account_id:r.account_id.clone(),kind:"reset",title:format!("{name} 额度已重置"),body:format!("{} 现在 {share:.0}% 已用",w.name)});
                        }
                        wm.step=None;wm.spent=false;
                    }
                    if let Some(t)=n.threshold{
                        if share>=t as f64&&wm.step!=Some(t)&&!wm.spent{
                            notices.push(Notice{account_id:r.account_id.clone(),kind:"approaching",title:format!("{name} 接近额度上限"),body:format!("{} {share:.0}% 已用",w.name)});
                            wm.step=Some(t);
                        }
                    }
                    if n.on_spent&&(w.exhausted||share>=99.5)&&!wm.spent{
                        notices.push(Notice{account_id:r.account_id.clone(),kind:"spent",title:format!("{name} 额度已用尽"),body:format!("{}：{}",w.name,reset_text(&w.resets_at,now))});
                        wm.spent=true;
                    }
                    wm.resets_at=w.resets_at.clone();wm.share=Some(share);
                }
                if let (Some(line),Some(cur))=(cfg.low_balance,cfg.low_balance_currency.as_deref()){
                    if let Some(b)=r.balances.iter().find(|b|b.currency.eq_ignore_ascii_case(cur)){
                        if b.amount<line{
                            if !(mem.low_balance_reported&&mem.low_balance_line==Some(line)){
                                notices.push(Notice{account_id:r.account_id.clone(),kind:"low_balance",title:format!("{name} 余额不足"),body:format!("剩余 {:.2} {cur}，低于 {line:.2}",b.amount)});
                                mem.low_balance_reported=true;mem.low_balance_line=Some(line);
                            }
                        }else{mem.low_balance_reported=false;}
                    }
                }
            }
            "unavailable"|"error" if r.error_code.as_deref().is_some_and(|c|FAILURE_CODES.contains(&c))=>{
                mem.failures=mem.failures.saturating_add(1);
                if mem.failures>=OUTAGE_AFTER&&!mem.outage_reported&&n.on_failure{
                    notices.push(Notice{account_id:r.account_id.clone(),kind:"unreadable",title:format!("{name} 连续读取失败"),body:r.error_message.clone().unwrap_or_else(||"连续多次未能读取额度".into())});
                    mem.outage_reported=true;
                }
            }
            _=>{} // stale readings and setup problems are neutral
        }
    }
    (notices,memory)
}

pub fn load(path:&std::path::Path)->Memory{std::fs::read(path).ok().and_then(|b|serde_json::from_slice(&b).ok()).unwrap_or_default()}
pub fn save(path:&std::path::Path,memory:&Memory)->Result<(),String>{crate::config::atomic_write(path,&serde_json::to_vec(memory).map_err(|_|"通知记忆序列化失败")?)}

#[cfg(test)]mod tests{
    use super::*;use crate::types::{ProviderConfig,UsageWindow,NotificationSettings,Balance};
    fn settings(th:Option<u8>)->AppSettings{let mut s=AppSettings::default();s.providers.clear();s.providers.insert("a".into(),ProviderConfig{provider_id:"codex".into(),label:"工作".into(),enabled:true,..Default::default()});s.notifications=NotificationSettings{threshold:th,on_spent:true,on_reset:true,on_failure:true};s}
    fn reading(share:f64,reset:&str,exhausted:bool)->ProviderUsage{let mut r=ProviderUsage::reading("codex",vec![UsageWindow{id:"w".into(),name:"每周限额".into(),used_fraction:share/100.0,used_percent:share,resets_at:Some(reset.into()),window_seconds:Some(604800),exhausted}]);r.account_id="a".into();r.checked_at=Some(chrono::DateTime::from_timestamp(1_789_000_000,0).unwrap().to_rfc3339());r}
    const NOW:i64=1_789_000_000;
    #[test]fn threshold_fires_once_and_survives_small_dips(){
        let s=settings(Some(90));let (n1,m)=evaluate(&[reading(92.0,"2026-09-22T00:00:00Z",false)],&s,Memory::default(),NOW);assert_eq!(n1.len(),1);assert_eq!(n1[0].kind,"approaching");
        let (n2,m)=evaluate(&[reading(87.0,"2026-09-22T00:00:00Z",false)],&s,m,NOW);assert!(n2.is_empty(),"a 5-point dip must not re-announce");
        let (n3,_)=evaluate(&[reading(95.0,"2026-09-22T00:00:00Z",false)],&s,m,NOW);assert!(n3.is_empty(),"same step is never repeated");
    }
    #[test]fn reset_only_after_warning_and_with_evidence(){
        let s=settings(Some(90));let (_,m)=evaluate(&[reading(92.0,"2026-09-22T00:00:00Z",false)],&s,Memory::default(),NOW);
        let (n,m)=evaluate(&[reading(3.0,"2026-09-29T00:00:00Z",false)],&s,m,NOW);assert_eq!(n.iter().map(|x|x.kind).collect::<Vec<_>>(),["reset"]);
        let (n2,_)=evaluate(&[reading(92.0,"2026-09-29T00:00:00Z",false)],&s,m,NOW);assert_eq!(n2[0].kind,"approaching","re-armed after the reset");
        let (n3,_)=evaluate(&[reading(3.0,"2026-09-29T00:00:00Z",false)],&s,Memory::default(),NOW);assert!(n3.is_empty(),"never warned, so nothing to reset");
    }
    #[test]fn spent_once_then_failures_once_per_outage(){
        let s=settings(None);let (n,m)=evaluate(&[reading(100.0,"2026-09-22T00:00:00Z",true)],&s,Memory::default(),NOW);assert_eq!(n[0].kind,"spent");
        let (n2,m)=evaluate(&[reading(100.0,"2026-09-22T00:00:00Z",true)],&s,m,NOW);assert!(n2.is_empty());
        let mut fail=ProviderUsage::problem("codex","network","x");fail.account_id="a".into();
        let (a,m)=evaluate(&[fail.clone()],&s,m,NOW);let (b,m)=evaluate(&[fail.clone()],&s,m,NOW);let (c,m)=evaluate(&[fail.clone()],&s,m,NOW);let (d,m)=evaluate(&[fail.clone()],&s,m,NOW);
        assert!(a.is_empty()&&b.is_empty());assert_eq!(c[0].kind,"unreadable");assert!(d.is_empty(),"one notice per outage");
        let (_,m)=evaluate(&[reading(10.0,"2026-09-22T00:00:00Z",false)],&s,m,NOW);assert_eq!(m.accounts["a"].failures,0,"a working reading clears the streak");
        let mut auth=ProviderUsage::problem("codex","auth","x");auth.account_id="a".into();let (e,m2)=evaluate(&[auth],&s,m,NOW);assert!(e.is_empty());assert_eq!(m2.accounts["a"].failures,0,"auth problems are neutral");
    }
    #[test]fn low_balance_once_per_line_and_rearms(){
        let mut s=settings(None);let c=s.providers.get_mut("a").unwrap();c.low_balance=Some(5.0);c.low_balance_currency=Some("CNY".into());
        let mut r=ProviderUsage::reading("deepseek",vec![]);r.state="live".into();r.account_id="a".into();r.checked_at=Some(chrono::DateTime::from_timestamp(NOW,0).unwrap().to_rfc3339());r.balances=vec![Balance::new("CNY",3.0),Balance::new("USD",1.0)];
        let (n,m)=evaluate(&[r.clone()],&s,Memory::default(),NOW);assert_eq!(n.len(),1,"only the configured currency is compared");assert_eq!(n[0].kind,"low_balance");
        let (n2,m)=evaluate(&[r.clone()],&s,m,NOW);assert!(n2.is_empty());
        r.balances[0].amount=20.0;let (_,m)=evaluate(&[r.clone()],&s,m,NOW);r.balances[0].amount=2.0;let (n3,_)=evaluate(&[r],&s,m,NOW);assert_eq!(n3.len(),1,"climbing back over the line re-arms");
    }
}
