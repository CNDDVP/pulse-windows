//! Semantic adapters against Pulse 442a9c5 (Apache-2.0); numeric absence is not zero.
use crate::types::{Balance,ProviderUsage,UsageWindow};
use chrono::{DateTime,Utc};
use serde_json::Value;
pub fn number(v:&Value)->Option<f64>{v.as_f64().or_else(||v.as_str()?.trim().parse().ok()).filter(|n|n.is_finite())}
pub fn date(v:&Value)->Option<String>{
    if let Some(s)=v.as_str(){
        if let Ok(d)=DateTime::parse_from_rfc3339(s){return Some(d.with_timezone(&Utc).to_rfc3339())}
        if let Ok(d)=chrono::NaiveDate::parse_from_str(s,"%Y-%m-%d"){return Some(d.and_hms_opt(0,0,0)?.and_utc().to_rfc3339())}
    }
    let n=number(v)?; let a=n.abs();
    let sec=if a>1e17{n/1e9}else if a>1e14{n/1e6}else if a>1e11{n/1e3}else{n};
    DateTime::from_timestamp(sec as i64,0).map(|d|d.to_rfc3339())
}
pub fn window(id:&str,name:&str,pct:f64,reset:&Value,seconds:Option<i64>)->Option<UsageWindow>{
    if !pct.is_finite() || pct<0.0{return None}
    Some(UsageWindow{id:id.into(),name:name.into(),used_fraction:pct/100.0,used_percent:pct,
        resets_at:date(reset),window_seconds:seconds.filter(|s|*s>0),exhausted:pct>=100.0})
}
fn add(w:&mut Vec<UsageWindow>,v:Option<UsageWindow>){if let Some(v)=v{w.push(v)}}
pub fn parse(id:&str,v:&Value,now:i64)->ProviderUsage{
    let mut w=vec![];
    match id {
        "claude"=>{
            if let Some(limits)=v["limits"].as_array(){for (i,l) in limits.iter().enumerate(){
                let (label,seconds)=match l["kind"].as_str(){Some("session")=>("5小时限额",18000),Some("weekly_all"|"weekly_scoped")=>("每周限额",604800),_=>continue};
                if let Some(p)=number(&l["percent"]){let name=format!("{} {}",label,l.pointer("/scope/model/display_name").and_then(Value::as_str).unwrap_or(""));
                    let mut win=window(&format!("claude-{i}"),&name,p,&l["resets_at"],Some(seconds));
                    if let Some(ref mut a)=win {a.exhausted=l["severity"].as_str()==Some("exhausted") || p>=100.0;} add(&mut w,win);
                }
            }}
            if w.is_empty(){for (key,seconds) in [("five_hour",18000),("seven_day",604800)]{if let Some(p)=number(&v[key]["utilization"]){add(&mut w,window(key,key,p,&v[key]["resets_at"],Some(seconds)));}}}
        }
        "codex"=>{
            let mut groups=vec![("account".to_string(),&v["rate_limit"])];
            if let Some(extra)=v["additional_rate_limits"].as_array(){for (i,g) in extra.iter().enumerate(){groups.push((format!("{}-{i}",g["limit_name"].as_str().unwrap_or("model")),&g["rate_limit"]));}}
            for (label,g) in groups {let start=w.len();for slot in ["primary_window","secondary_window"]{
                let l=&g[slot];if let Some(p)=number(&l["used_percent"]){
                    let secs=number(&l["limit_window_seconds"]).map(|s|s as i64);
                    // A reset further than a century away is a broken payload, not a window.
                    let reset=if !l["reset_at"].is_null(){l["reset_at"].clone()}else if let Some(s)=number(&l["reset_after_seconds"]).filter(|s|(0.0..=3.2e9).contains(s)){serde_json::json!(now.saturating_add(s as i64))}else{Value::Null};
                    let title=match secs {Some(18000)=>"5小时限额".into(),Some(604800)=>"每周限额".into(),Some(s)=>format!("{}分钟限额",s/60),None=>"额度窗口".into()};
                    let win_name = if label == "account" { title } else { format!("{label} · {title}") };
                    add(&mut w,window(&format!("{label}-{slot}"),&win_name,p,&reset,secs));
                }
            }
            if (g["limit_reached"]==true || g["allowed"]==false || (label=="account" && (v.pointer("/spend_control/reached")==Some(&Value::Bool(true)) || !v["rate_limit_reached_type"].is_null()))) && w.len()>start {
                if let Some(a)=w[start..].iter_mut().max_by(|a,b|a.used_percent.total_cmp(&b.used_percent)){a.exhausted=true;}
            }}
        }
        "cursor"=>{
            let plan=v.pointer("/individualUsage/plan").or_else(||v.pointer("/teamUsage/pooled")).unwrap_or(&Value::Null);
            for (key,label) in [("autoPercentUsed","Cursor 专属模型"),("apiPercentUsed","其他模型")]{if let Some(p)=number(&plan[key]){add(&mut w,window(key,label,p,&v["billingCycleEnd"],None));}}
            if w.is_empty(){if let (Some(used),Some(limit))=(number(&plan["used"]),number(&plan["limit"])){if limit>0.0{add(&mut w,window("plan","套餐额度",used/limit*100.0,&v["billingCycleEnd"],None));}}}
            let extra=v.pointer("/individualUsage/onDemand").or_else(||v.pointer("/teamUsage/onDemand")).unwrap_or(&Value::Null);
            if extra["enabled"]!=false{if let (Some(used),Some(limit))=(number(&extra["used"]),number(&extra["limit"])){if limit>0.0{add(&mut w,window("on-demand","额外消费",used/limit*100.0,&v["billingCycleEnd"],None));}}}
        }
        "copilot"=>{
            for key in ["premium_interactions","chat","completions"]{let l=&v["quota_snapshots"][key];
                if l["has_quota"]==false || l["unlimited"]==true{continue}
                let Some(left)=number(&l["percent_remaining"]) else {continue};
                if l["has_quota"].is_null() && number(&l["entitlement"]).unwrap_or(0.0)<=0.0 && number(&l["remaining"]).unwrap_or(0.0)<=0.0 && left>=100.0 {continue}
                let reset=v.get("quota_reset_date_utc").or_else(||v.get("quota_reset_date")).unwrap_or(&Value::Null);
                let label = match key {
                    "premium_interactions" => "高级交互",
                    "chat" => "聊天问答",
                    "completions" => "代码补全",
                    _ => key,
                };
                let mut win=window(key,label,(100.0-left).max(0.0),reset,None);
                if let Some(ref mut a)=win{a.exhausted=left<=0.0 && l["overage_permitted"]!=true;} add(&mut w,win);
            }
        }
        "kimi"=>{
            if let Some(limits)=v["limits"].as_array(){for (i,l) in limits.iter().enumerate(){
                let multiplier=match l["window"]["timeUnit"].as_str(){Some("TIME_UNIT_SECOND")=>1,Some("TIME_UNIT_MINUTE")=>60,Some("TIME_UNIT_HOUR")=>3600,Some("TIME_UNIT_DAY")=>86400,_=>continue};
                let seconds=number(&l["window"]["duration"]).filter(|n|*n>0.0).map(|n|n as i64).and_then(|n|n.checked_mul(multiplier));
                let label=match seconds{Some(18000)=>"5小时限额",Some(86400)=>"每日限额",Some(604800)=>"每周限额",_=>"定时限额"};
                if seconds.is_some(){add(&mut w,count_window(&format!("limit-{i}"),label,&l["detail"],seconds));}
            }}
            if let Some(usages)=v.get("usages"){
                if let Some(l5)=usages.get("limit_5h"){if let Some(r)=number(&l5["used_ratio"]){if !w.iter().any(|win|win.id.contains("5h")||win.window_seconds==Some(18000)){add(&mut w,window("limit-5h","5小时限额",(r*100.0).min(100.0),&l5["reset_time"],Some(18000)));}}}
                if let Some(l7)=usages.get("limit_7d"){if let Some(r)=number(&l7["used_ratio"]){if !w.iter().any(|win|win.id=="weekly"||win.window_seconds==Some(604800)){add(&mut w,window("weekly","每周限额",(r*100.0).min(100.0),&l7["reset_time"],Some(604800)));}}}
            }
            if !w.iter().any(|win|win.id=="weekly"||win.window_seconds==Some(604800)){add(&mut w,count_window("weekly","每周限额",&v["usage"],None));}
        }
        "opencode"=>{
            for (key,label,seconds) in [("rolling","5小时限额",Some(18000)),("weekly","每周限额",Some(604800)),("monthly","每月限额",None)]{
                let l=&v["usage"][key];
                if let Some(p)=number(&l["percent"]){
                    let mut win=window(key,label,p,&l["resetsAt"],seconds);
                    if let Some(ref mut a)=win{if l["status"].as_str().is_some_and(|s|s!="ok"){a.exhausted=true;}}
                    add(&mut w,win);
                }
            }
        }
        "volcengine"=>{
            if let Some(items)=v["items"].as_array(){for item in items{if item["subscribed"]!=false{
                let prod=item["product"].as_str().unwrap_or("Plan");
                if let Some(periods)=item["periods"].as_array(){for (i,p) in periods.iter().enumerate(){
                    let label=p["label"].as_str().unwrap_or("限额");
                    if let Some(pct)=number(&p["percent"]){
                        let secs=match label.to_lowercase().as_str(){"5h"=>Some(18000),"weekly"=>Some(604800),"monthly"=>Some(2592000),_=>None};
                        let name=match label.to_lowercase().as_str(){"5h"=>"5小时限额".into(),"weekly"=>"每周限额".into(),"monthly"=>"每月限额".into(),_=>format!("{prod} {label}")};
                        add(&mut w,window(&format!("ark-{prod}-{i}"),&name,pct,&p["reset_at"],secs));
                    }
                }}
            }}}
            let coding=v.get("coding").unwrap_or(v);
            let quota_usage=coding.pointer("/Result/QuotaUsage").or_else(||coding.get("QuotaUsage"));
            if let Some(quotas)=quota_usage.and_then(Value::as_array){for (i,q) in quotas.iter().enumerate(){
                let level=q["Level"].as_str().unwrap_or("quota");
                if let Some(pct)=number(&q["Percent"]){
                    let (name,secs)=match level.to_lowercase().as_str(){"5h"=>("5小时限额",Some(18000)),"weekly"=>("每周限额",Some(604800)),"fortnightly"=>("两周限额",Some(1209600)),_=>("Coding Plan",None)};
                    add(&mut w,window(&format!("coding-{level}-{i}"),name,pct,&q["ResetTimestamp"],secs));
                }
            }}
            let afp=v.get("afp").unwrap_or(v);
            let result=afp.get("Result").unwrap_or(afp);
            for (key,label,secs) in [("AFPFiveHour","Agent 5小时限额",Some(18000)),("AFPDaily","Agent 每日限额",Some(86400)),("AFPWeekly","Agent 每周限额",Some(604800)),("AFPMonthly","Agent 每月限额",Some(2592000))]{
                let item=&result[key];
                if let (Some(q),Some(u))=(number(&item["Quota"]),number(&item["Used"])){if q>0.0{
                    add(&mut w,window(key,label,(u/q*100.0).max(0.0),&item["ResetTime"],secs));
                }}
            }
        }
        "command-code"=>{
            let credits=v.get("credits").unwrap_or(v);
            let limits=&credits["windowLimits"];
            for (key,label,secs) in [("fiveHour","5小时限额",18000),("weekly","每周限额",604800)]{
                let item=&limits[key];
                if let (Some(used),Some(cap))=(number(&item["used"]),number(&item["cap"])){if cap>0.0{
                    let pct=(used/cap*100.0).max(0.0);
                    let mut win=window(key,label,pct,&item["resetAt"],Some(secs));
                    if let Some(ref mut a)=win{a.exhausted=used>=cap;}
                    add(&mut w,win);
                }}
            }
            let mut reading=ProviderUsage::reading(id,w);
            let c_obj=&credits["credits"];
            let mut balance=0.0;
            let mut has_balance=false;
            for k in ["monthlyCredits","purchasedCredits","freeCredits"]{
                if let Some(amt)=number(&c_obj[k]){balance+=amt;has_balance=true;}
            }
            if has_balance{reading.balances.push(Balance{currency:"USD".into(),amount:balance});}
            reading.plan_name=c_obj["planId"].as_str().or_else(||v.pointer("/subscription/plan/id").and_then(Value::as_str)).map(normalize_plan_name);
            return reading;
        }
        "devin"=>{
            if let Some(p)=number(&v["daily_percentage"]){add(&mut w,window("daily","每日限额",p,&v["daily_reset_at"],Some(86400)));}
            if let Some(p)=number(&v["weekly_percentage"]){add(&mut w,window("weekly","每周限额",p,&v["weekly_reset_at"],Some(604800)));}
            if w.is_empty(){
                if let Some(rem)=number(&v["dailyRemainingPercent"]){if v["hideDailyQuota"]!=true{add(&mut w,window("daily","每日限额",(100.0-rem).max(0.0),&v["dailyResetAtUnix"],Some(86400)));}}
                if let Some(rem)=number(&v["weeklyRemainingPercent"]){if v["hideWeeklyQuota"]!=true{add(&mut w,window("weekly","每周限额",(100.0-rem).max(0.0),&v["weeklyResetAtUnix"],Some(604800)));}}
            }
        }
        "ollama"=>{
            if let Some(p)=number(&v["session"]["percent"]){add(&mut w,window("session","5小时限额",p,&v["session"]["reset"],Some(18000)));}
            if let Some(p)=number(&v["weekly"]["percent"]){add(&mut w,window("weekly","每周限额",p,&v["weekly"]["reset"],Some(604800)));}
        }
        "grok-bot"=>{
            if v["usesPooledEnterpriseAllowance"]==true || v["includedLimitZero"]==true || v["hasNonZeroIncludedLimit"]==false {return ProviderUsage::problem(id,"not_included","当前套餐不含个人 Grok Bot 额度")}
            if v["hasNonZeroIncludedLimit"]==true{if let Some(p)=number(&v["usagePercent"]){add(&mut w,window("weekly","每周额度",p,&v["nextResetTimestampUtc"],None));}}
        }
        "grok"=>{
            let c=&v["config"];let start=date(c.pointer("/currentPeriod/start").unwrap_or(&c["billingPeriodStart"])).and_then(|s|DateTime::parse_from_rfc3339(&s).ok()).map(|d|d.timestamp());
            let end=date(c.pointer("/currentPeriod/end").unwrap_or(&c["billingPeriodEnd"])).and_then(|s|DateTime::parse_from_rfc3339(&s).ok()).map(|d|d.timestamp());
            if let (Some(start),Some(end))=(start,end){if start<=now && now<end{let p=number(&c["creditUsagePercent"]).or_else(||c["creditUsagePercent"].is_null().then_some(0.0));if let Some(p)=p{add(&mut w,window("pool","账户共享额度",p,&serde_json::json!(end),Some(end-start)));}}}
        }
        "zai"|"zhipu"=>{
            if v["success"]!=true && number(&v["code"])!=Some(200.0){return ProviderUsage::problem(id,"service_refused","服务拒绝查询；请核对区域、凭据与订阅")}
            if let Some(limits)=v["data"]["limits"].as_array(){for (i,l) in limits.iter().enumerate(){
                let Some(kind)=l["type"].as_str() else{continue};if !["TOKENS_LIMIT","CREDIT_LIMIT","TIME_LIMIT"].contains(&kind){continue}
                let unit=number(&l["unit"]).map(|n|n as i64);let multiplier=match unit{Some(1)=>86400,Some(3)=>3600,Some(5)=>60,Some(6)=>604800,_=>continue};
                let seconds=number(&l["number"]).filter(|n|*n>0.0).and_then(|n|(n as i64).checked_mul(multiplier));
                let used=number(&l["usage"]).filter(|n|*n>0.0).and_then(|total|{
                    let left=number(&l["remaining"]).map(|n|total-n);let current=number(&l["currentValue"]);
                    match (left,current){(Some(a),Some(b))=>Some(a.max(b)/total*100.0),(a,b)=>a.or(b).map(|n|n/total*100.0)}
                }).or_else(||number(&l["percentage"]));
                let label = match kind {
                    "TOKENS_LIMIT" => "Token 额度",
                    "CREDIT_LIMIT" => "积分额度",
                    "TIME_LIMIT" => "请求频次",
                    _ => kind,
                };
                if let Some(p)=used{
                    let duration=if kind=="TIME_LIMIT" && unit==Some(5) && number(&l["number"])==Some(1.0){None}else{seconds};
                    // Console naming (每5小时使用额度 / 每周使用额度 / MCP 每月额度). The MCP allowance is
                    // reported as a TIME_LIMIT whose unit is a per-minute count, so recognise it by a
                    // reset weeks away instead: a real per-minute rate limit resets within the minute.
                    let reset_in=date(&l["nextResetTime"]).and_then(|s|DateTime::parse_from_rfc3339(&s).ok()).map(|d|d.timestamp()-now);
                    let monthly_mcp=kind=="TIME_LIMIT" && (duration.is_some_and(|s|s>=28*86400) || reset_in.is_some_and(|r|r>2*86400));
                    let duration=if monthly_mcp{duration.filter(|s|*s>=28*86400).or(Some(2_592_000))}else{duration};
                    let name:String=match (kind,duration){
                        _ if monthly_mcp=>"MCP 每月额度".into(),
                        (_,Some(18000))=>"每5小时使用额度".into(),
                        (_,Some(604800))=>"每周使用额度".into(),
                        (_,Some(86400))=>"每日使用额度".into(),
                        _=>label.into(),
                    };
                    add(&mut w,window(&format!("{kind}-{i}"),&name,p.max(0.0),&l["nextResetTime"],duration));
                }
            }}
        }
        "minimax"|"minimax-cn"=>{
            if number(&v["base_resp"]["status_code"]).is_some_and(|c|c!=0.0){return ProviderUsage::problem(id,"service_refused","MiniMax 拒绝查询，请核对区域和凭据")}
            let data=v.get("data").unwrap_or(v);
            if let Some(models)=data["model_remains"].as_array(){for (i,m) in models.iter().enumerate(){for period in ["interval","weekly"]{
                let prefix=format!("current_{period}_");let total=number(&m[format!("{prefix}total_count")]);let left=number(&m[format!("{prefix}remaining_percent")]);
                if number(&m[format!("{prefix}status")])==Some(3.0) && total.unwrap_or(0.0)==0.0 && left.unwrap_or(0.0)>=100.0{continue}
                let p=left.map(|n|100.0-n).or_else(||{let total=total.filter(|n|*n>0.0)?;Some((total-number(&m[format!("{prefix}usage_count")])?)/total*100.0)});
                let (seconds,reset)=if period=="interval"{let start=number(&m["start_time"]);let end=number(&m["end_time"]);let secs=start.zip(end).and_then(|(a,b)|(b>a).then_some(((b-a)/1000.0) as i64));if secs.is_none(){continue}(secs,&m["end_time"])}else{(Some(604800),&m["weekly_end_time"])};
                if let Some(p)=p{add(&mut w,window(&format!("{i}-{period}"),&format!("{} {period}",m["model_name"].as_str().unwrap_or("额度")),p.max(0.0),reset,seconds));}
            }}}
        }
        "deepseek"=>{
            let mut reading=ProviderUsage::reading(id,vec![]);
            if let Some(infos)=v["balance_infos"].as_array(){for b in infos{if let (Some(currency),Some(amount))=(b["currency"].as_str(),number(&b["total_balance"])){reading.balances.push(Balance{currency:currency.into(),amount});}}}
            if !reading.balances.is_empty(){reading.state="live".into();reading.error_code=None;reading.error_message=None;}
            return reading;
        }
        _=>return ProviderUsage::problem(id,"unsupported","该数据路线尚未实现，不能报告额度"),
    }
    let mut reading=ProviderUsage::reading(id,w);
    reading.plan_name=match id {
        "codex"=>v["plan_type"].as_str(),
        "cursor"=>v["membershipType"].as_str(),
        "copilot"=>v["copilot_plan"].as_str(),
        "kimi"=>v.pointer("/user/membership/level").and_then(Value::as_str),
        "zai"|"zhipu"=>v.pointer("/data/level").and_then(Value::as_str),
        "devin"=>v["planName"].as_str(),
        _=>None
    }.map(normalize_plan_name);
    reading
}
pub fn normalize_plan_name(s:&str)->String{
    match s.trim().to_lowercase().as_str(){
        "plus"=>"Plus".to_string(),
        "pro"=>"Pro".to_string(),
        "team"=>"Team".to_string(),
        "business"=>"Business".to_string(),
        "enterprise"=>"Enterprise".to_string(),
        "hobby"|"free"=>"Free".to_string(),
        _=>s.to_string(),
    }
}
fn count_window(id:&str,name:&str,v:&Value,seconds:Option<i64>)->Option<UsageWindow>{let limit=number(&v["limit"]).filter(|n|*n>0.0)?;let used=number(&v["used"]).or_else(||Some(limit-number(&v["remaining"])?))?;window(id,name,(used/limit*100.0).max(0.0),&v["resetTime"],seconds)}

#[cfg(test)] mod tests {
    use super::*;use serde_json::json;
    #[test]fn empty_is_not_zero(){for id in ["claude","codex","kimi","cursor","copilot","deepseek","grok-bot","zai","minimax","volcengine","command-code","devin","ollama"]{let r=parse(id,&json!({}),0);assert_ne!(r.state,"live","{id}");assert_eq!(r.primary_percent,None);}}
    #[test]fn claude_current_and_legacy(){let r=parse("claude",&json!({"limits":[{"kind":"weekly_scoped","percent":23.5,"scope":{"model":{"display_name":"Opus"}},"severity":"warning"}]}),0);assert_eq!(r.primary_percent,Some(23.5));assert!(!r.windows[0].exhausted);assert_eq!(parse("claude",&json!({"five_hour":{"utilization":12.5},"seven_day":{"utilization":75}}),0).primary_percent,Some(75.0));}
    #[test]fn cursor_percent_not_fraction(){let r=parse("cursor",&json!({"individualUsage":{"plan":{"autoPercentUsed":0.0267,"apiPercentUsed":20}}}),0);assert_eq!(r.windows[0].used_percent,0.0267);assert_eq!(r.primary_percent,Some(20.0));}
    #[test]fn kimi_string_counts_and_unknown_unit(){let r=parse("kimi",&json!({"usage":{"limit":"100","remaining":"30"},"limits":[{"window":{"duration":2,"timeUnit":"UNKNOWN"},"detail":{"limit":"10","used":"5"}}]}),0);assert_eq!(r.windows.len(),1);assert_eq!(r.primary_percent,Some(70.0));assert_eq!(r.windows[0].window_seconds,None);}
    #[test]fn kimi_weekly_limit_not_duplicated(){let r=parse("kimi",&json!({"usage":{"limit":"100","remaining":"30"},"limits":[{"window":{"duration":7,"timeUnit":"TIME_UNIT_DAY"},"detail":{"limit":"10","used":"5"}}]}),0);assert_eq!(r.windows.iter().filter(|w|w.id=="weekly"||w.window_seconds==Some(604800)).count(),1);}
    #[test]fn codex_huge_reset_does_not_overflow(){let r=parse("codex",&json!({"rate_limit":{"primary_window":{"used_percent":1.0,"reset_after_seconds":1e300}}}),i64::MAX-5);assert_eq!(r.windows.len(),1);assert_eq!(r.windows[0].resets_at,None);}
    #[test]fn copilot_exclusion_and_overage(){let r=parse("copilot",&json!({"quota_snapshots":{"chat":{"percent_remaining":0,"has_quota":false},"completions":{"percent_remaining":0,"has_quota":true,"overage_permitted":true},"premium_interactions":{"unlimited":true,"percent_remaining":100}}}),0);assert_eq!(r.windows.len(),1);assert!(!r.windows[0].exhausted);}
    #[test]fn codex_reset_and_extra(){let r=parse("codex",&json!({"rate_limit":{"primary_window":{"used_percent":1.5,"reset_after_seconds":60,"limit_window_seconds":3600}},"additional_rate_limits":[{"limit_name":"review","rate_limit":{"primary_window":{"used_percent":90,"reset_at":1800000000}}}]}),1700000000);assert_eq!(r.windows.len(),2);assert_eq!(r.primary_percent,Some(90.0));assert_eq!(date(&json!(1700000060)),r.windows[0].resets_at);}
    #[test]fn dates_ms_and_seconds(){assert_eq!(date(&json!(1800000000)),date(&json!(1800000000000u64)));assert_eq!(date(&json!(1800000000)),date(&json!(1800000000000000u64)));assert_eq!(date(&json!(1800000000)),date(&json!(1800000000000000000u64)));assert!(date(&json!("nonsense")).is_none());}
    #[test]fn money_not_percentage(){let r=parse("deepseek",&json!({"balance_infos":[{"currency":"CNY","total_balance":"10"},{"currency":"USD","total_balance":"2"}]}),0);assert_eq!(r.balances.len(),2);assert_eq!(r.primary_percent,None);assert_eq!(r.state,"live");}
    #[test]fn zero_limit_is_not_reading(){assert_ne!(parse("kimi",&json!({"usage":{"limit":"0","used":"0"}}),0).state,"live");}
    #[test]fn grok_implicit_zero_only_inside_period(){let v=json!({"config":{"currentPeriod":{"start":"2026-09-01T00:00:00Z","end":"2026-10-01T00:00:00Z"}}});assert_eq!(parse("grok",&v,1789600000).primary_percent,Some(0.0));assert_eq!(parse("grok",&v,0).primary_percent,None);}
    #[test]fn glm_finer_counts(){let r=parse("zhipu",&json!({"success":true,"data":{"limits":[{"type":"CREDIT_LIMIT","unit":3,"number":5,"usage":2000,"remaining":1000}]}}),0);assert_eq!(r.primary_percent,Some(50.0));}
    #[test]fn zhipu_windows_use_console_names(){
        let r=parse("zhipu",&json!({"success":true,"data":{"limits":[
            {"type":"TOKENS_LIMIT","unit":3,"number":5,"percentage":20},
            {"type":"TOKENS_LIMIT","unit":6,"number":1,"percentage":30},
            {"type":"TIME_LIMIT","unit":1,"number":30,"percentage":8},
            {"type":"TIME_LIMIT","unit":5,"number":1,"percentage":1}]}}),0);
        let names:Vec<_>=r.windows.iter().map(|w|w.name.as_str()).collect();
        assert_eq!(names,["每5小时使用额度","每周使用额度","MCP 每月额度","请求频次"]);
        assert_eq!(r.windows[2].window_seconds,Some(2592000));assert_eq!(r.windows[3].window_seconds,None);
        // The live API reports the MCP allowance with a per-minute unit but a reset weeks away.
        let now=1_789_000_000;
        let live=parse("zhipu",&json!({"success":true,"data":{"limits":[{"type":"TIME_LIMIT","unit":5,"number":1,"percentage":8.1,"nextResetTime":(now+19*86400)*1000}]}}),now);
        assert_eq!(live.windows[0].name,"MCP 每月额度");assert_eq!(live.windows[0].window_seconds,Some(2592000));
    }
    #[test]fn minimax_remaining_count(){let r=parse("minimax",&json!({"model_remains":[{"current_weekly_total_count":"100","current_weekly_usage_count":"96"}]}),0);assert_eq!(r.primary_percent,Some(4.0));}
    #[test]fn volcengine_coding_and_afp(){let r=parse("volcengine",&json!({"coding":{"Result":{"QuotaUsage":[{"Level":"5h","Percent":12.5,"ResetTimestamp":1788780000}]}},"afp":{"Result":{"AFPWeekly":{"Quota":1000,"Used":300,"ResetTime":1789085506}}}}),0);assert_eq!(r.windows.len(),2);assert_eq!(r.windows[0].used_percent,12.5);assert_eq!(r.windows[1].used_percent,30.0);assert_eq!(r.primary_percent,Some(30.0));}
    #[test]fn command_code_credits_and_limits(){let r=parse("command-code",&json!({"credits":{"credits":{"monthlyCredits":10,"purchasedCredits":5,"planId":"pro"},"windowLimits":{"fiveHour":{"used":2,"cap":10,"resetAt":1788780000000i64}}}}),0);assert_eq!(r.windows.len(),1);assert_eq!(r.windows[0].used_percent,20.0);assert_eq!(r.balances[0].amount,15.0);assert_eq!(r.plan_name,Some("Pro".into()));}
    #[test]fn devin_pro_and_endpoint(){assert_eq!(parse("devin",&json!({"daily_percentage":5,"weekly_percentage":10}),0).windows.len(),2);assert_eq!(parse("devin",&json!({"dailyRemainingPercent":95,"weeklyRemainingPercent":90,"planName":"Pro"}),0).windows[0].used_percent,5.0);}
    #[test]fn ollama_session_weekly(){let r=parse("ollama",&json!({"session":{"percent":15,"reset":"2026-09-17T12:00:00Z"},"weekly":{"percent":40}}),0);assert_eq!(r.windows.len(),2);assert_eq!(r.primary_percent,Some(40.0));}
}

