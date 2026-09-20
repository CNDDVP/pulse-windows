use crate::types::ProviderUsage;
use chrono::{DateTime,Utc};
pub fn apply_primary_window(reading:&mut ProviderUsage,pin:Option<&str>){
    if reading.state=="live"||reading.state=="stale"{
        if let Some(pin)=pin{
            if let Some(w)=reading.windows.iter().find(|w|w.id==pin){
                reading.primary_percent=Some(w.used_percent);
                return;
            }
        }
        reading.primary_percent=reading.windows.iter().map(|w|w.used_percent).reduce(f64::max);
    }
}
pub fn reconcile(fresh:ProviderUsage,previous:Option<&ProviderUsage>,now:i64)->ProviderUsage{
    reconcile_with_pin(fresh,previous,None,now)
}
pub fn reconcile_with_pin(mut fresh:ProviderUsage,previous:Option<&ProviderUsage>,pin:Option<&str>,now:i64)->ProviderUsage{
    if fresh.state=="live" {apply_primary_window(&mut fresh,pin);return fresh}
    // Never hide an authentication change or an unsupported route behind a cached account.
    let is_local_service = fresh.error_code.as_deref() == Some("local_service");
    if !matches!(fresh.error_code.as_deref(),Some("network"|"timeout"|"server"|"rate_limited"|"local_service")){return fresh}
    if let Some(old)=previous.filter(|o|o.account_id==fresh.account_id && o.provider_id==fresh.provider_id && (!o.scope.is_empty() && (o.scope==fresh.scope || is_local_service))){
        let age=old.last_success_at.as_deref().and_then(|s|DateTime::parse_from_rfc3339(s).ok()).map(|d|now-d.timestamp());
        if is_local_service || age.is_some_and(|age|(0..=600).contains(&age)){
            let windows:Vec<_>=old.windows.iter().filter(|w|w.resets_at.as_deref().and_then(|s|DateTime::parse_from_rfc3339(s).ok()).is_none_or(|d|d.timestamp()>now)).cloned().collect();
            if !windows.is_empty() || !old.balances.is_empty(){
                fresh.state="stale".into();fresh.source=old.source.clone();fresh.last_success_at=old.last_success_at.clone();
                fresh.windows=windows;fresh.balances=old.balances.clone();fresh.plan_name=old.plan_name.clone();
                fresh.scope=old.scope.clone();
                apply_primary_window(&mut fresh,pin);
            }
        }
    }
    fresh
}
pub fn expire(reading:ProviderUsage,now:i64)->ProviderUsage {
    expire_with_pin(reading,None,now)
}
pub fn expire_with_pin(mut reading:ProviderUsage,pin:Option<&str>,now:i64)->ProviderUsage {
    if reading.state!="live" && reading.state!="stale" {return reading}
    let timestamp=reading.last_success_at.as_deref().and_then(|s|DateTime::parse_from_rfc3339(s).ok()).map(|d|d.timestamp()).unwrap_or(0);
    let is_local_service = reading.error_code.as_deref() == Some("local_service");
    if !is_local_service && (now-timestamp>600 || timestamp>now) {
        reading.state="unavailable".into();reading.windows.clear();reading.balances.clear();reading.primary_percent=None;
        reading.error_code=Some("expired".into());reading.error_message=Some("上次读数已过期，等待刷新".into());
    }else{
        reading.windows.retain(|w|w.resets_at.as_deref().and_then(|s|DateTime::parse_from_rfc3339(s).ok()).is_none_or(|d|d.timestamp()>now));
        apply_primary_window(&mut reading,pin);
        if reading.windows.is_empty() && reading.balances.is_empty(){reading.state="unavailable".into();reading.error_code=Some("reset".into());reading.error_message=Some("额度窗口已重置，等待服务新读数".into());}
    }reading
}
pub fn now()->i64{Utc::now().timestamp()}
#[cfg(test)]mod tests{use super::*;use crate::types::UsageWindow;
    #[test]fn failures_are_marked_stale_but_auth_is_not(){let mut old=ProviderUsage::reading("codex",vec![UsageWindow{used_percent:60.0,..Default::default()}]);old.account_id="one".into();old.scope="fixture-scope".into();old.last_success_at=Some(Utc::now().to_rfc3339());let mut failure=ProviderUsage::problem("codex","network","network");failure.account_id="one".into();failure.scope="fixture-scope".into();assert_eq!(reconcile(failure.clone(),Some(&old),now()).state,"stale");failure.error_code=Some("auth".into());assert_eq!(reconcile(failure,Some(&old),now()).primary_percent,None);}
    #[test]fn scope_mismatch_never_reuses(){let mut old=ProviderUsage::reading("codex",vec![UsageWindow::default()]);old.account_id="one".into();old.scope="fixture-scope".into();old.last_success_at=Some(Utc::now().to_rfc3339());let mut failure=ProviderUsage::problem("codex","network","network");failure.account_id="two".into();assert_ne!(reconcile(failure,Some(&old),now()).state,"stale");}
    #[test]fn test_local_service_reconciliation_reuses_cache(){
        let mut old=ProviderUsage::reading("antigravity",vec![UsageWindow{used_percent:13.0,resets_at:Some(chrono::DateTime::from_timestamp(now()+3600,0).unwrap().to_rfc3339()),..Default::default()}]);
        old.account_id="antigravity-default".into();old.scope="antigravity-12345678".into();old.last_success_at=Some(Utc::now().to_rfc3339());
        let mut failure=ProviderUsage::problem("antigravity","local_service","未发现可读取额度的 Antigravity 本地服务");
        failure.account_id="antigravity-default".into();
        let reconciled=reconcile(failure,Some(&old),now());
        assert_eq!(reconciled.state,"stale");
        assert_eq!(reconciled.primary_percent,Some(13.0));
        assert_eq!(reconciled.windows.len(),1);
    }
    #[test]fn test_local_service_reset_expiry(){
        let mut old=ProviderUsage::reading("antigravity",vec![UsageWindow{used_percent:13.0,resets_at:Some(chrono::DateTime::from_timestamp(now()-100,0).unwrap().to_rfc3339()),..Default::default()}]);
        old.account_id="antigravity-default".into();old.scope="antigravity-12345678".into();old.last_success_at=Some(Utc::now().to_rfc3339());
        let mut failure=ProviderUsage::problem("antigravity","local_service","未发现可读取额度的 Antigravity 本地服务");
        failure.account_id="antigravity-default".into();
        let reconciled=reconcile(failure,Some(&old),now());
        // Since the window has already reset in the past, it should not be retained as stale quota
        assert_eq!(reconciled.state,"unavailable");
        assert_eq!(reconciled.primary_percent,None);
    }
}

