//! StepFun (阶跃星辰) adapter: dual-mode support for API Key (cash/voucher balance)
//! and DevCenter Web Console Oasis-Token (Step Plan Credit rate limits).

use crate::providers::credentials;
use crate::types::ProviderUsage;
use serde_json::Value;

fn problem(code: &str, msg: &str) -> ProviderUsage {
    ProviderUsage::problem("stepfun", code, msg)
}

fn extract_device_id(token: &str) -> Option<String> {
    for part in token.rsplit("...") {
        if let Some(c) = credentials::claims(part) {
            if let Some(dev_id) = c.get("device_id").and_then(Value::as_str).filter(|s|!s.is_empty()) {
                return Some(dev_id.to_string());
            }
        }
    }
    None
}

async fn request(req: reqwest::RequestBuilder, label: &str, plan_rpc: bool) -> Result<Value, ProviderUsage> {
    let response = req.send().await.map_err(|e| problem(if e.is_timeout() {"timeout"} else {"network"}, &format!("{label}：连接失败或超时")))?;
    let status=response.status().as_u16();
    if !response.status().is_success() {
        let code=match status {401|403=>"auth",429=>"rate_limited",404=>"not_found",_=>"server"};
        let mut error=problem(code,&format!("{label}：HTTP {status}{}",if status==401||status==403 {"，请检查或更新该来源凭据"} else {""}));
        error.retry_after_seconds=response.headers().get("retry-after").and_then(|v|v.to_str().ok()).and_then(|v|v.parse().ok());
        error.web_auth_required=plan_rpc && (status==401||status==403);
        return Err(error);
    }
    let value=response.json::<Value>().await.map_err(|_|problem("schema",&format!("{label}：响应格式无效")))?;
    validate_response(value,label,plan_rpc)
}

// Dashboard RPC success is 1. The cash REST endpoint has no such status contract.
fn validate_response(value: Value, label: &str, plan_rpc: bool) -> Result<Value, ProviderUsage> {
    if !value.is_object() {
        return Err(problem("schema", &format!("{label}：响应格式无效")));
    }
    if plan_rpc {
        let is_ok = matches!(value.get("status"), Some(v) if v.as_i64() == Some(1) || v.as_str() == Some("1"));
        if !is_ok {
            let msg = value.get("message")
                .or_else(|| value.get("msg"))
                .or_else(|| value.get("error"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let msg_lower = msg.to_lowercase();
            let (code, custom_msg) = if msg_lower.contains("embezzled") {
                ("auth", "账号已在其他设备登录，当前 Token 已被踢出，请重新登录")
            } else if msg_lower.contains("token expired") || msg_lower.contains("expired token") {
                ("auth", "Token 已过期，请重新登录")
            } else if msg_lower.contains("invalid credentials") || msg_lower.contains("invalid token") || msg_lower.contains("unauthorized") || msg_lower.contains("unauthenticated") {
                ("auth", "登录凭据无效或未授权，请核对 Token")
            } else if !msg.is_empty() {
                ("server", "控制台业务请求失败")
            } else {
                ("server", "控制台业务状态未成功")
            };
            let mut e=problem(code, &format!("{label}：{custom_msg}"));e.web_auth_required=code=="auth";return Err(e);
        }
    }
    Ok(value)
}

fn merge(
    plan: Option<Result<Value, ProviderUsage>>,
    cash: Option<Result<Value, ProviderUsage>>,
    usages: Option<Result<Value, ProviderUsage>>,
) -> Result<Value, ProviderUsage> {
    let mut merged = serde_json::Map::new();
    let mut warnings = Vec::new();
    let mut failures = Vec::new();
    let mut successes = 0;
    let web_auth_required=plan.as_ref().is_some_and(|r|r.as_ref().is_err_and(|e|e.web_auth_required)) || usages.as_ref().is_some_and(|r|r.as_ref().is_err_and(|e|e.web_auth_required));
    for (label, result, keys) in [
        ("套餐", plan, vec!["plan_credit_rate_limit","five_hour_usage_left_rate","five_hour_usage_reset_time","weekly_usage_left_rate","weekly_usage_reset_time","plan_family","plan_name"]),
        ("API 余额", cash, vec!["balance"])
    ] {
        match result {
            None => warnings.push(format!("{label}：未配置对应凭据")),
            Some(Err(e)) => { warnings.push(e.error_message.clone().unwrap_or_else(|| format!("{label}：查询失败"))); failures.push(e); },
            Some(Ok(v)) => {
                let selected: serde_json::Map<String, Value> = keys.into_iter().filter_map(|k| v.get(k).map(|v| (k.to_string(), v.clone()))).collect();
                let parsed = super::parsers::parse("stepfun", &Value::Object(selected.clone()), 0);
                if parsed.state == "live" { merged.extend(selected); successes += 1; }
                else { let e = problem("no_data", &format!("{label}：未返回可识别读数")); warnings.push(e.error_message.clone().unwrap()); failures.push(e); }
            }
        }
    }
    merged.insert("web_auth_required".into(),Value::Bool(web_auth_required));
    if let Some(Err(e))=&usages{warnings.push(e.error_message.clone().unwrap_or_else(||"用量明细查询失败".into()));}
    if successes == 0 {
        let mut e=failures.into_iter().next().unwrap_or_else(|| problem("missing_credentials", "未配置 StepFun 凭据"));e.web_auth_required=web_auth_required;return Err(e);
    }
    if let Some(Ok(u)) = usages {
        let list = u.get("usages").or_else(|| u.get("items")).or_else(|| u.get("records")).unwrap_or(&u);
        if let Some(arr) = list.as_array() {
            // P3 #8：完整性只按 truncated 标记与 total 差值判断——
            // 分页已完整取回 300/300 条时不再因"单页大小 200"误报达到上限
            let total = u.get("total").and_then(Value::as_u64).unwrap_or(arr.len() as u64);
            let truncated = u.get("truncated").and_then(Value::as_bool).unwrap_or(false) || total > arr.len() as u64;
            if truncated {
                warnings.push(format!("用量明细不完整（已获取 {} / 共 {} 条），图表仅统计已返回记录", arr.len(), total));
            }
            // P2 #4：后续页失败的具体原因透出到警告，不静默吞掉
            if let Some(page_err) = u.get("usage_page_error").and_then(Value::as_str) {
                warnings.push(format!("明细分页中断：{page_err}"));
            }
            if u.get("usage_page_auth").and_then(Value::as_bool).unwrap_or(false) {
                warnings.push("明细后续页返回认证失败，可能需要重新网页登录".into());
            }
            // 合法空记录正常挂载，不产生任何不必要的警告
            merged.insert("hourly_usages".into(), list.clone());
        } else {
            warnings.push("用量明细响应结构异常（记录字段缺失或类型变化），24h 图表暂不可用".into());
        }
    }
    if !warnings.is_empty() {
        merged.insert("token_warning".into(), Value::String(warnings.join("；")));
    }
    Ok(Value::Object(merged))
}

// QueryStepPlanUsagesRequest uses start_time/to_time; from_time belongs to
// StepPlanUsageRecord (the response). Encode protobuf int64 values as strings.
// P2 #9: page 为可变参数，支持按 total 分页拉取
fn usage_request_body(now: i64, page: u32) -> Value {
    serde_json::json!({
        "startTime": now.saturating_sub(86400).to_string(),
        "toTime": now.to_string(),
        "granularHour": 1,
        "pageSize": 200,
        "page": page
    })
}

/// P2 #9：按 total 分页拉取用量明细，最多 3 页（600 条）。
/// 分页拉取用量明细（P2 #4/#5/#6/#8）：
/// - 独立总预算 10s（页间与页内都以剩余预算为限），保护外层 25s 账户预算——
///   明细拖慢不再连带丢弃已成功的套餐与现金结果
/// - 后续页失败不吞错：错误写入 usage_page_error，认证失败标记 web_auth_required
/// - 按 (fromTime, modelId) 小时粒度去重 + 重复页检测（服务重复返回同一页时停止）
/// - truncated 只按 total>已取 或 预算/错误中断 判定，不再用单页大小推断
async fn fetch_usages_paginated(
    http: &reqwest::Client,
    token: &str,
    device: &Option<String>,
    cookie: &str,
) -> Option<Result<Value, ProviderUsage>> {
    let now = chrono::Utc::now().timestamp();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let mut all_records: Vec<Value> = Vec::new();
    let mut seen_keys: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();
    let mut first_response: Option<Result<Value, ProviderUsage>> = None;
    let mut truncated = false;
    let mut pages_fetched = 0u32;
    let mut page_error: Option<String> = None;
    let mut page_auth_flag = false;
    // 记录每页首条记录键，检测服务端重复返回同一页
    let mut last_page_first_key: Option<(String, String)> = None;

    for page in 1..=3u32 {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            truncated = true;
            page_error = Some("明细分页预算耗尽".into());
            break;
        }
        let mut req = http.post("https://platform.stepfun.com/api/step.openapi.devcenter.Dashboard/QueryStepPlanUsages")
            .header("Connect-Protocol-Version","1").header("Oasis-Appid","10300")
            .header("Oasis-Platform","web").header("Oasis-Token",token)
            .header("Origin","https://platform.stepfun.com").header("Referer","https://platform.stepfun.com/");
        if let Some(device)=device{req=req.header("Oasis-Webid",device);}
        let body = usage_request_body(now, page);
        let result = tokio::time::timeout(remaining,
            request(req.header("Cookie", cookie).json(&body), "用量明细", true)).await;

        match result {
            Ok(Ok(v)) => {
                if first_response.is_none() {
                    first_response = Some(Ok(v.clone()));
                }
                let list = v.get("usages").or_else(|| v.get("items")).or_else(|| v.get("records"));
                if let Some(arr) = list.and_then(Value::as_array) {
                    // 重复页检测：整页首键与上页相同且长度相同 → 服务端分页失效，停止
                    let page_first_key = arr.first().map(record_key);
                    if page == 1 && arr.is_empty() {
                        break; // 合法空结果
                    }
                    if let (Some(k), Some(pk)) = (&page_first_key, &last_page_first_key) {
                        if k == pk && arr.len() == seen_keys.len() && page > 1 {
                            truncated = true;
                            page_error = Some("服务端重复返回同一页".into());
                            break;
                        }
                    }
                    last_page_first_key = page_first_key;
                    // 小时粒度去重：同一 (fromTime, model) 只保留一条
                    for rec in arr.iter() {
                        let key = record_key(rec);
                        if seen_keys.insert(key) {
                            all_records.push(rec.clone());
                        }
                    }
                    pages_fetched = page;
                    let total = v.get("total").and_then(Value::as_u64).unwrap_or(0);
                    if (all_records.len() as u64) >= total || page >= 3 {
                        truncated = (all_records.len() as u64) < total;
                        break;
                    }
                } else {
                    break;
                }
            }
            Ok(Err(e)) => {
                if first_response.is_none() {
                    first_response = Some(Err(e));
                    break; // 首页失败：整体失败
                }
                // 后续页失败：保留已获取记录，记录错误与认证标记（P2 #4）
                page_error = Some(e.error_message.clone().unwrap_or_else(|| "后续页请求失败".into()));
                if e.web_auth_required { page_auth_flag = true; }
                truncated = true;
                break;
            }
            Err(_) => {
                if first_response.is_none() {
                    first_response = Some(Err(problem("timeout", "用量明细：请求超时")));
                    break;
                }
                page_error = Some("后续页请求超时".into());
                truncated = true;
                break;
            }
        }
    }

    // 合并与标记：按实际拉取页数合并（服务端可能缩小页大小，不能用固定阈值）
    if let Some(Ok(v)) = &mut first_response {
        if let Some(obj) = v.as_object_mut() {
            if pages_fetched > 1 {
                obj.insert("usages".to_string(), Value::Array(all_records));
            }
            if truncated {
                obj.insert("truncated".to_string(), Value::Bool(true));
            }
            if let Some(err) = page_error {
                obj.insert("usage_page_error".to_string(), Value::String(err));
            }
            if page_auth_flag {
                obj.insert("usage_page_auth".to_string(), Value::Bool(true));
            }
        }
    }

    first_response
}

/// 明细记录的稳定键：小时粒度（granularHour=1）下 (fromTime, modelId) 唯一。
fn record_key(rec: &Value) -> (String, String) {
    let ts = rec.get("fromTime").or_else(|| rec.get("from_time")).or_else(|| rec.get("timestamp"))
        .map(|v| match v {
            Value::String(s) => s.clone(),
            Value::Number(n) => n.to_string(),
            _ => String::new(),
        })
        .unwrap_or_default();
    let model = rec.get("modelId").or_else(|| rec.get("model_id"))
        .and_then(Value::as_str).unwrap_or("").to_string();
    (ts, model)
}

pub async fn fetch(secret: &str, http: &reqwest::Client) -> Result<Value, ProviderUsage> {
    let creds = credentials::parse_stepfun_credentials(secret);
    let plan = async {
        let token = creds.oasis_token.as_ref()?;
        let device = extract_device_id(token);
        let mut req = http.post("https://platform.stepfun.com/api/step.openapi.devcenter.Dashboard/QueryStepPlanRateLimit")
            .header("Connect-Protocol-Version","1").header("Oasis-Appid","10300")
            .header("Oasis-Platform","web").header("Oasis-Token",token)
            .header("Origin","https://platform.stepfun.com").header("Referer","https://platform.stepfun.com/");
        if let Some(device)=&device{req=req.header("Oasis-Webid",device);}
        let cookie=credentials::stepfun_cookie(token,creds.cookie.as_deref(),device.as_deref());
        Some(request(req.header("Cookie", cookie).json(&serde_json::json!({})), "套餐", true).await)
    };
    let cash = async {
        let key = creds.api_key.as_ref()?;
        Some(request(http.get("https://api.stepfun.com/v1/accounts").bearer_auth(key).header("Accept","application/json"), "API 余额", false).await)
    };
    let usages = async {
        let token = creds.oasis_token.as_ref()?;
        let device = extract_device_id(token);
        let cookie=credentials::stepfun_cookie(token,creds.cookie.as_deref(),device.as_deref());
        fetch_usages_paginated(http, token, &device, &cookie).await
    };
    let (plan, cash, usages) = tokio::join!(plan, cash, usages);
    merge(plan, cash, usages)
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
    #[test] fn usage_query_matches_dashboard_request_schema() {
        let body = usage_request_body(1_790_000_000, 1);
        assert_eq!(body, json!({
            "startTime": "1789913600", "toTime": "1790000000",
            "granularHour": 1, "pageSize": 200, "page": 1
        }));
        assert!(body.get("fromTime").is_none());
    }
    #[test] fn usage_bad_request_preserves_plan_and_cash_without_token_renewal() {
        let v = merge(Some(Ok(plan())), Some(Ok(json!({"balance":15.0}))),
            Some(Err(problem("server", "用量明细：HTTP 400")))).unwrap();
        assert_eq!(v["balance"], 15.0);
        assert!(v.get("plan_credit_rate_limit").is_some());
        assert_eq!(v["web_auth_required"], false);
        assert!(v["token_warning"].as_str().unwrap().contains("HTTP 400"));
    }
    #[test] fn usage_schema_anomaly_warns_and_keeps_data() {
        // S7：records 类型异常时不再静默丢图——warnings 显式标注，其余成功数据保留
        let v = merge(Some(Ok(plan())), Some(Ok(json!({"balance":15.0}))),
            Some(Ok(json!({"status":1,"usages":{"unexpected":"shape"}})))).unwrap();
        assert_eq!(v["balance"], 15.0);
        assert!(v["token_warning"].as_str().unwrap().contains("结构异常"));
        assert!(v.get("hourly_usages").is_none());
    }
    #[test] fn usage_truncated_flag_warns() {
        let records: Vec<_> = (0..50).map(|i| json!({"usage_time": i, "credit": 1.0})).collect();
        let v = merge(Some(Ok(plan())), None,
            Some(Ok(json!({"status":1,"usages":records,"total":100})))).unwrap();
        assert!(v["token_warning"].as_str().unwrap().contains("用量明细不完整"));
    }
    #[test] fn empty_records_does_not_warn() {
        // 问题 8：合法空记录不产生 warning
        let v = merge(Some(Ok(plan())), Some(Ok(json!({"balance":15.0}))),
            Some(Ok(json!({"status":1,"usages":[]}))));
        assert!(v.is_ok());
        let res = v.unwrap();
        assert!(res.get("token_warning").is_none());
    }
    #[test] fn rpc_success_is_one_not_zero() {
        for status in [json!(1),json!("1")] {
            let mut value=plan();value["status"]=status;
            let accepted=validate_response(value,"test",true).unwrap();
            let merged=merge(Some(Ok(accepted)),None,None).unwrap();
            assert_eq!(super::super::parsers::parse("stepfun",&merged,0).state,"live");
        }
        for status in [json!(0),json!("0"),json!(2),Value::Null,json!(false)] {
            let mut value=plan();value["status"]=status;
            assert!(validate_response(value,"test",true).is_err());
        }
        assert!(validate_response(json!({"balance":15}),"test",false).is_ok());
        assert!(validate_response(json!({"balance":15}),"test",true).is_err());
    }
    #[test] fn rpc_semantic_error_matching() {
        let embezzled = json!({"status": 0, "message": "user session embezzled by another client"});
        let err = validate_response(embezzled, "套餐", true).unwrap_err();
        assert_eq!(err.error_code.as_deref(), Some("auth"));
        assert!(err.error_message.unwrap().contains("账号已在其他设备登录"));

        let expired = json!({"status": 0, "msg": "token expired"});
        let err = validate_response(expired, "套餐", true).unwrap_err();
        assert_eq!(err.error_code.as_deref(), Some("auth"));
        assert!(err.error_message.unwrap().contains("Token 已过期"));
    }
    #[test] fn refresh_device_claim_takes_precedence() {
        use base64::{Engine,engine::general_purpose::URL_SAFE_NO_PAD};
        let jwt=|id:&str| format!("e30.{}.test",URL_SAFE_NO_PAD.encode(json!({"device_id":id}).to_string()));
        assert_eq!(extract_device_id(&format!("{}...{}",jwt("access"),jwt("refresh"))).as_deref(),Some("refresh"));
        assert_eq!(extract_device_id(&jwt("single")).as_deref(),Some("single"));
    }
    fn plan()->Value {json!({"plan_family":2,"plan_credit_rate_limit":{"subscription_credit_left_rate":0.9925,"subscription_credit_reset_time":"1792465684","credit_buckets":[{"type":1,"credit_residual":1588018947.0},{"type":2,"credit_residual":500000.0,"expire_at":"2026-10-01T00:00:00Z"}]}})}
    #[test] fn dual_results_keep_money_and_credit_and_topup() {
        let v=merge(Some(Ok(plan())),Some(Ok(json!({"balance":15.0}))),None).unwrap();
        let r=super::super::parsers::parse("stepfun",&v,0);
        assert_eq!(r.balances.len(),3);assert!(r.error_message.is_none());
        assert!(r.balances.iter().any(|b|b.currency=="CNY"&&b.amount==15.0));
        assert!(r.balances.iter().any(|b|b.currency=="Credit"&&b.amount==1588018947.0));
        assert!(r.balances.iter().any(|b|b.currency=="Credit-Topup"&&b.amount==500000.0&&b.expires_at.as_deref()==Some("2026-10-01T00:00:00+00:00")));
        assert_eq!(r.windows[0].used_percent,0.75);assert!(r.windows[0].resets_at.is_some());
        assert_eq!(r.windows[0].window_seconds,None);
    }
    #[test] fn partial_failure_keeps_other_source_and_actual_error() {
        let v=merge(Some(Err(problem("network","套餐：网络失败"))),Some(Ok(json!({"balance":15.0}))),None).unwrap();
        assert_eq!(v["balance"],15.0);assert!(v["token_warning"].as_str().unwrap().contains("网络失败"));
        let v=merge(Some(Ok(plan())),Some(Err(problem("auth","API 余额：凭据无效"))),None).unwrap();
        assert!(v.get("plan_credit_rate_limit").is_some());assert!(v["token_warning"].as_str().unwrap().contains("API 余额"));
    }
    #[test] fn zero_credit_and_missing_cash_are_distinct() {
        let mut p=plan();p["plan_credit_rate_limit"]["credit_buckets"][0]["credit_residual"]=json!(0);
        p["plan_credit_rate_limit"]["credit_buckets"][1]["credit_residual"]=json!(0);
        let v=merge(Some(Ok(p)),Some(Ok(json!({"total_voucher_balance":26}))),None).unwrap();
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

#[cfg(test)]mod renewal_regressions{
 use super::*;use serde_json::json;
 #[tokio::test]async fn http_401_remains_visible_with_successful_cash(){
  use tokio::io::{AsyncReadExt,AsyncWriteExt};
  let server=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let url=format!("http://{}",server.local_addr().unwrap());
  let task=tokio::spawn(async move{let(mut socket,_)=server.accept().await.unwrap();let mut b=[0;4096];socket.read(&mut b).await.unwrap();socket.write_all(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();});
  let error=request(reqwest::Client::builder().no_proxy().build().unwrap().get(url),"套餐",true).await.unwrap_err();task.await.unwrap();assert!(error.web_auth_required);
  let value=merge(Some(Err(error)),Some(Ok(json!({"balance":15}))),None).unwrap();let r=super::super::parsers::parse("stepfun",&value,0);
  assert_eq!(r.state,"live");assert!(r.web_auth_required);assert!(r.error_message.unwrap().contains("401"));assert_eq!(r.balances[0].amount,15.0);
 }
 #[test]fn cash_auth_error_does_not_trigger_web_renewal(){let v=merge(Some(Ok(json!({"plan_credit_rate_limit":{"subscription_credit_left_rate":0.9}}))),Some(Err(problem("auth","API 余额：HTTP 401"))),None).unwrap();assert_eq!(v["web_auth_required"],false);}
 #[test]fn detail_failure_is_not_silently_discarded(){let mut e=problem("auth","用量明细：HTTP 401");e.web_auth_required=true;let v=merge(None,Some(Ok(json!({"balance":15}))),Some(Err(e))).unwrap();assert_eq!(v["web_auth_required"],true);assert!(v["token_warning"].as_str().unwrap().contains("用量明细"));}
 #[test]fn topup_expiry_and_unknown_buckets(){let r=super::super::parsers::parse("stepfun",&json!({"plan_credit_rate_limit":{"credit_buckets":[{"type":2,"credit_residual":10,"expire_at":"2026-12-01T00:00:00Z"},{"type":2,"credit_residual":20,"expire_at":"2026-10-01T00:00:00Z"},{"type":99,"credit_residual":999},{"type":1}]}}),0);assert_eq!(r.balances.len(),1);assert_eq!(r.balances[0].amount,30.0);assert_eq!(r.balances[0].expires_at.as_deref(),Some("2026-10-01T00:00:00+00:00"));}
}

#[cfg(test)]mod timestamp_regression{
 #[test]fn hourly_timestamps_accept_milliseconds_and_numeric_strings(){let r=super::super::parsers::parse("stepfun",&serde_json::json!({"balance":15,"hourly_usages":[{"fromTime":"1790000000000","creditConsumed":5},{"fromTime":1790000000,"creditConsumed":3}]}),0);let rows=r.hourly_usages.unwrap();assert_eq!(rows.len(),2);assert_eq!(rows[0].timestamp,1790000000);assert_eq!(rows[0].timestamp,rows[1].timestamp);}
}
