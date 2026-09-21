//! StepFun (阶跃星辰) adapter: dual-mode support for API Key (cash/voucher balance)
//! and DevCenter Web Console Oasis-Token (Step Plan Credit rate limits).

use crate::providers::credentials;
use crate::types::ProviderUsage;
use serde_json::Value;

fn problem(code: &str, msg: &str) -> ProviderUsage {
    ProviderUsage::problem("stepfun", code, msg)
}

fn extract_device_id(token: &str) -> Option<String> {
    for part in token.split("...") {
        if let Some(c) = credentials::claims(part) {
            if let Some(dev_id) = c.get("device_id").and_then(Value::as_str) {
                return Some(dev_id.to_string());
            }
        }
    }
    None
}

async fn request(req: reqwest::RequestBuilder, label: &str) -> Result<Value, ProviderUsage> {
    let response = req.send().await.map_err(|e| problem(if e.is_timeout() {"timeout"} else {"network"}, &format!("{label}：连接失败或超时")))?;
    let status=response.status().as_u16();
    if !response.status().is_success() {
        let code=match status {401|403=>"auth",429=>"rate_limited",404=>"not_found",_=>"server"};
        let mut error=problem(code,&format!("{label}：HTTP {status}{}",if status==401||status==403 {"，请检查或更新该来源凭据"} else {""}));
        error.retry_after_seconds=response.headers().get("retry-after").and_then(|v|v.to_str().ok()).and_then(|v|v.parse().ok());
        return Err(error);
    }
    let value=response.json::<Value>().await.map_err(|_|problem("schema",&format!("{label}：响应格式无效")))?;
    if !value.is_object() || value.get("status").is_some_and(|s| s.as_i64()!=Some(0) && s.as_str()!=Some("0")) {
        return Err(problem("schema",&format!("{label}：服务未返回成功数据")));
    }
    Ok(value)
}

fn merge(plan: Option<Result<Value,ProviderUsage>>, cash: Option<Result<Value,ProviderUsage>>) -> Result<Value,ProviderUsage> {
    let mut merged=serde_json::Map::new();
    let mut warnings=Vec::new();
    let mut failures=Vec::new();
    let mut successes=0;
    for (label,result,keys) in [
        ("套餐",plan,vec!["plan_credit_rate_limit","five_hour_usage_left_rate","five_hour_usage_reset_time","weekly_usage_left_rate","weekly_usage_reset_time","plan_family","plan_name"]),
        ("API 余额",cash,vec!["balance"])
    ] {
        match result {
            None=>warnings.push(format!("{label}：未配置对应凭据")),
            Some(Err(e))=>{warnings.push(e.error_message.clone().unwrap_or_else(||format!("{label}：查询失败")));failures.push(e);},
            Some(Ok(v))=>{
                let selected:serde_json::Map<String,Value>=keys.into_iter().filter_map(|k|v.get(k).map(|v|(k.to_string(),v.clone()))).collect();
                let parsed=super::parsers::parse("stepfun",&Value::Object(selected.clone()),0);
                if parsed.state=="live" {merged.extend(selected);successes+=1;}
                else {let e=problem("no_data",&format!("{label}：未返回可识别读数"));warnings.push(e.error_message.clone().unwrap());failures.push(e);}
            }
        }
    }
    if successes==0 {return Err(failures.into_iter().next().unwrap_or_else(||problem("missing_credentials","未配置 StepFun 凭据")));}
    if !warnings.is_empty(){merged.insert("token_warning".into(),Value::String(warnings.join("；")));}
    Ok(Value::Object(merged))
}

pub async fn fetch(secret: &str, http: &reqwest::Client) -> Result<Value, ProviderUsage> {
    let creds=credentials::parse_stepfun_credentials(secret);
    let plan=async {
        let token=creds.oasis_token.as_ref()?;
        let device=extract_device_id(token);
        let mut req=http.post("https://platform.stepfun.com/api/step.openapi.devcenter.Dashboard/QueryStepPlanRateLimit")
            .header("Connect-Protocol-Version","1").header("Oasis-Appid","10300")
            .header("Oasis-Platform","web").header("Oasis-Token",token)
            .header("Origin","https://platform.stepfun.com").header("Referer","https://platform.stepfun.com/");
        let cookie=if let Some(device)=device {req=req.header("Oasis-Webid",&device);format!("Oasis-Token={token}; Oasis-Webid={device}")} else {format!("Oasis-Token={token}")};
        Some(request(req.header("Cookie",cookie).json(&serde_json::json!({})),"套餐").await)
    };
    let cash=async {
        let key=creds.api_key.as_ref()?;
        Some(request(http.get("https://api.stepfun.com/v1/accounts").bearer_auth(key).header("Accept","application/json"),"API 余额").await)
    };
    let (plan,cash)=tokio::join!(plan,cash);
    merge(plan,cash)
}

pub fn source_label(secret: &str) -> &'static str {
    let creds = credentials::parse_stepfun_credentials(secret);
    match (creds.api_key.is_some(), creds.oasis_token.is_some()) {
        (true, true) => "已保存凭据（API Key + 网页 Token） → 服务接口",
        (true, false) => "已保存凭据（API Key） → 服务接口",
        (false, true) => "已保存凭据（网页 Token） → 控制台接口",
        (false, false) => "已保存凭据 → 服务接口",
    }
}

#[cfg(test)] mod tests {
    use super::*;
    use serde_json::json;
    fn plan()->Value {json!({"plan_family":2,"plan_credit_rate_limit":{"subscription_credit_left_rate":0.9925,"subscription_credit_reset_time":"1792465684","credit_buckets":[{"credit_residual":1588018947.0}]}})}
    #[test] fn dual_results_keep_money_and_credit() {
        let v=merge(Some(Ok(plan())),Some(Ok(json!({"balance":15.0})))).unwrap();
        let r=super::super::parsers::parse("stepfun",&v,0);
        assert_eq!(r.balances.len(),2);assert!(r.error_message.is_none());
        assert!(r.balances.iter().any(|b|b.currency=="CNY"&&b.amount==15.0));
        assert_eq!(r.windows[0].used_percent,0.75);assert!(r.windows[0].resets_at.is_some());
        assert_eq!(r.windows[0].window_seconds,None);
    }
    #[test] fn partial_failure_keeps_other_source_and_actual_error() {
        let v=merge(Some(Err(problem("network","套餐：网络失败"))),Some(Ok(json!({"balance":15.0})))).unwrap();
        assert_eq!(v["balance"],15.0);assert!(v["token_warning"].as_str().unwrap().contains("网络失败"));
        let v=merge(Some(Ok(plan())),Some(Err(problem("auth","API 余额：凭据无效")))).unwrap();
        assert!(v.get("plan_credit_rate_limit").is_some());assert!(v["token_warning"].as_str().unwrap().contains("API 余额"));
    }
    #[test] fn zero_credit_and_missing_cash_are_distinct() {
        let mut p=plan();p["plan_credit_rate_limit"]["credit_buckets"][0]["credit_residual"]=json!(0);
        let v=merge(Some(Ok(p)),Some(Ok(json!({"total_voucher_balance":26})))).unwrap();
        let r=super::super::parsers::parse("stepfun",&v,0);
        assert_eq!(r.balances.len(),1);assert_eq!(r.balances[0].amount,0.0);
        assert!(r.error_message.unwrap().contains("API 余额"));
    }
    #[test] fn credential_updates_preserve_other_field() {
        let first=credentials::merge_stepfun_credentials("synthetic-key",r#"{"oasis_token":"synthetic-token"}"#);
        let c=credentials::parse_stepfun_credentials(&first);
        assert_eq!(c.api_key.as_deref(),Some("synthetic-key"));assert_eq!(c.oasis_token.as_deref(),Some("synthetic-token"));
        let second=credentials::merge_stepfun_credentials(&first,r#"{"api_key":"replacement"}"#);
        let c=credentials::parse_stepfun_credentials(&second);
        assert_eq!(c.api_key.as_deref(),Some("replacement"));assert_eq!(c.oasis_token.as_deref(),Some("synthetic-token"));
    }
}
