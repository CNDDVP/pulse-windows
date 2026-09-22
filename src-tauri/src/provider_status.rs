//! Round5B 项目三：供应商服务状态（Statuspage 系公开端点）。
//!
//! 数据源为官方公开状态页 `…/api/v2/status.json`（Anthropic、OpenAI 同为 Statuspage 系），
//! 走应用既有代理设置（共享 `AppState.http` 客户端，代理变更时会整体重建）。
//! 并发拉取、每家独立 10 秒预算：单家超时/非 200/畸形 JSON 只把该家标为
//! `unavailable`（indicator=unknown 灰灯），绝不阻塞也不编造其他供应商的状态。
//! StepFun / 智谱无公开状态 API → 本模块不含，由前端界面诚实注明。
use serde::Serialize;
use std::time::Duration;

/// 每家供应商的拉取预算（秒）；并发执行，总耗时不超过单家预算。
pub const STATUS_BUDGET_SECS: u64 = 10;
/// 响应体上限：status.json 只有几 KB，超限视为异常响应（防呆，与 usage 侧同思路）。
const MAX_BODY_BYTES: usize = 1024 * 1024;

/// (provider 标识, 展示名, Statuspage status.json 端点)。只收录有公开端点的供应商。
/// 端点经真实数据只读探查核验（2026-09-23）：
/// - OpenAI `status.openai.com/api/v2/status.json` → 200，字段为 status.indicator /
///   status.description / page.updated_at（ISO-8601）。
/// - 旧址 `status.anthropic.com/api/v2/status.json` 现已 301 永久重定向到
///   `status.claude.com`；共享客户端显式禁止跟随重定向（安全边界），故直接收录规范址。
pub const STATUS_ENDPOINTS: &[(&str, &str, &str)] = &[
    ("anthropic", "Anthropic", "https://status.claude.com/api/v2/status.json"),
    ("openai", "OpenAI", "https://status.openai.com/api/v2/status.json"),
];

#[derive(Debug, Clone, Serialize)]
pub struct ProviderStatus {
    pub provider: String,
    pub display_name: String,
    /// 四色归一后的指示灯：operational(绿) / degraded(黄) / outage(红) / unknown(灰)。
    pub indicator: String,
    /// state=ok 时为状态页原文描述；state=unavailable 时为失败原因（诚实降级）。
    pub description: String,
    /// 状态页自身的更新时间（page.updated_at）；拉取失败时为 null。
    pub updated_at: Option<String>,
    /// "ok" = 成功解析；"unavailable" = 拉取/解析失败。
    pub state: String,
}

/// Statuspage indicator → 四色归一。maintenance（维护中）无独立颜色档，
/// 归入黄灯（服务处于非正常态），原文语义保留在 description。
pub fn map_indicator(raw: &str) -> &'static str {
    match raw {
        "none" => "operational",
        "minor" | "maintenance" => "degraded",
        "major" | "critical" => "outage",
        _ => "unknown",
    }
}

/// 非 2xx 的降级原因；2xx 返回 None（重定向被共享客户端策略阻止，同样按非成功处理）。
pub fn http_status_reason(code: u16) -> Option<String> {
    if (200..300).contains(&code) { None } else { Some(format!("状态页返回 HTTP {code}")) }
}

fn unavailable(id: &str, name: &str, reason: &str) -> ProviderStatus {
    ProviderStatus {
        provider: id.into(),
        display_name: name.into(),
        indicator: "unknown".into(),
        description: reason.into(),
        updated_at: None,
        state: "unavailable".into(),
    }
}

/// 解析 Statuspage `/api/v2/status.json` 响应体 → (indicator, description, updated_at)。
/// 畸形 JSON 或缺少 `status.indicator` 字段 → Err（调用方降级 unavailable，不猜状态）；
/// 未知 indicator 取值原样映射 unknown（灰灯，诚实）。description / updated_at 缺失按空/无处理。
pub fn parse_status_json(body: &str) -> Result<(String, String, Option<String>), String> {
    let v: serde_json::Value = serde_json::from_str(body).map_err(|_| "状态页响应不是有效 JSON".to_string())?;
    let indicator_raw = v
        .get("status")
        .and_then(|s| s.get("indicator"))
        .and_then(|i| i.as_str())
        .ok_or_else(|| "状态页响应缺少 status.indicator 字段".to_string())?;
    let description = v
        .get("status")
        .and_then(|s| s.get("description"))
        .and_then(|d| d.as_str())
        .unwrap_or("")
        .to_string();
    let updated_at = v.get("page").and_then(|p| p.get("updated_at")).and_then(|u| u.as_str()).map(str::to_string);
    Ok((map_indicator(indicator_raw).into(), description, updated_at))
}

async fn fetch_inner(http: &reqwest::Client, url: &str) -> Result<(String, String, Option<String>), String> {
    let mut resp = http.get(url).send().await.map_err(|e| {
        if e.is_timeout() { "连接超时，请检查网络延迟或代理响应".to_string() }
        else if e.is_connect() { "无法建立连接，请检查网络环境或代理配置".to_string() }
        else { format!("请求失败：{e}") }
    })?;
    if let Some(reason) = http_status_reason(resp.status().as_u16()) { return Err(reason); }
    let mut body = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|_| "读取状态页响应失败".to_string())? {
        if body.len() + chunk.len() > MAX_BODY_BYTES { return Err("状态页响应超过大小限制".into()); }
        body.extend_from_slice(&chunk);
    }
    let text = String::from_utf8(body).map_err(|_| "状态页响应不是 UTF-8 文本".to_string())?;
    parse_status_json(&text)
}

/// 拉取单家：10 秒预算独立生效，超时/失败降级为 unavailable，不向上传播错误。
async fn fetch_one(http: &reqwest::Client, id: &str, name: &str, url: &str) -> ProviderStatus {
    match tokio::time::timeout(Duration::from_secs(STATUS_BUDGET_SECS), fetch_inner(http, url)).await {
        Err(_) => unavailable(id, name, &format!("请求超时（预算 {STATUS_BUDGET_SECS} 秒）")),
        Ok(Err(reason)) => unavailable(id, name, &reason),
        Ok(Ok((indicator, description, updated_at))) => ProviderStatus {
            provider: id.into(),
            display_name: name.into(),
            indicator,
            description,
            updated_at,
            state: "ok".into(),
        },
    }
}

/// 并发拉取全部有公开端点的供应商；结果按 STATUS_ENDPOINTS 顺序返回。
/// 每家独立预算，任一家失败/超时只影响自己。
pub async fn fetch_all(http: &reqwest::Client) -> Vec<ProviderStatus> {
    let mut set = tokio::task::JoinSet::new();
    for (id, name, url) in STATUS_ENDPOINTS {
        let http = http.clone();
        let (id, name) = (id.to_string(), name.to_string());
        set.spawn(async move { fetch_one(&http, &id, name.as_str(), url).await });
    }
    let mut out = Vec::new();
    while let Some(joined) = set.join_next().await {
        if let Ok(status) = joined { out.push(status); }
    }
    out.sort_by_key(|s| STATUS_ENDPOINTS.iter().position(|(id, _, _)| *id == s.provider).unwrap_or(usize::MAX));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // 依真实响应结构建模的 fixture（status.claude.com 2026-09-23 探查：page.name="Claude"，
    // status.indicator/description、page.updated_at 为 ISO-8601）。
    const OPERATIONAL_FIXTURE: &str = r#"{
        "page": {"id":"g13x0v2qtlpv","name":"Claude","url":"https://status.claude.com",
                 "time_zone_id":"America/Los_Angeles","updated_at":"2026-09-23T05:42:11.123Z"},
        "status": {"indicator":"none","description":"All Systems Operational"}
    }"#;

    #[test]
    fn endpoints_cover_exactly_the_providers_with_public_status_apis() {
        assert_eq!(STATUS_ENDPOINTS.len(), 2);
        let urls: Vec<_> = STATUS_ENDPOINTS.iter().map(|(_, _, u)| *u).collect();
        // 规范址（真实数据探查：status.anthropic.com 已 301 → status.claude.com）。
        assert_eq!(urls, vec![
            "https://status.claude.com/api/v2/status.json",
            "https://status.openai.com/api/v2/status.json",
        ]);
    }

    #[test]
    fn indicator_mapping_covers_statuspage_values_and_maps_unknowns_to_gray() {
        assert_eq!(map_indicator("none"), "operational");
        assert_eq!(map_indicator("minor"), "degraded");
        assert_eq!(map_indicator("maintenance"), "degraded");
        assert_eq!(map_indicator("major"), "outage");
        assert_eq!(map_indicator("critical"), "outage");
        // 未知取值（含畸形内容）一律灰灯，不猜。
        assert_eq!(map_indicator("banana"), "unknown");
        assert_eq!(map_indicator(""), "unknown");
    }

    #[test]
    fn parses_operational_fixture_with_description_and_updated_at() {
        let (indicator, description, updated_at) = parse_status_json(OPERATIONAL_FIXTURE).unwrap();
        assert_eq!(indicator, "operational");
        assert_eq!(description, "All Systems Operational");
        assert_eq!(updated_at.as_deref(), Some("2026-09-23T05:42:11.123Z"));
    }

    #[test]
    fn parses_degraded_and_outage_fixtures() {
        let degraded = r#"{"page":{"updated_at":"2026-09-23T04:00:00.000Z"},"status":{"indicator":"minor","description":"Degraded performance for Claude API"}}"#;
        assert_eq!(parse_status_json(degraded).unwrap().0, "degraded");
        let outage = r#"{"status":{"indicator":"major","description":"Partial System Outage"}}"#;
        let (ind, desc, ts) = parse_status_json(outage).unwrap();
        assert_eq!(ind, "outage");
        assert_eq!(desc, "Partial System Outage");
        assert_eq!(ts, None);
        let critical = r#"{"status":{"indicator":"critical","description":"Major Service Outage"}}"#;
        assert_eq!(parse_status_json(critical).unwrap().0, "outage");
    }

    #[test]
    fn malformed_json_degrades_to_error() {
        assert!(parse_status_json("<html>502 Bad Gateway</html>").unwrap_err().contains("JSON"));
        assert!(parse_status_json("").unwrap_err().contains("JSON"));
        assert!(parse_status_json("{\"status\":{\"indicator\":").unwrap_err().contains("JSON"));
        // 顶层不是对象（如数组/字符串）同样不能编造成状态。
        assert!(parse_status_json(r#"["none"]"#).unwrap_err().contains("status.indicator"));
    }

    #[test]
    fn missing_indicator_or_non_string_degrades_to_error() {
        let no_status = r#"{"page":{"updated_at":"2026-09-23T05:42:11Z"}}"#;
        assert!(parse_status_json(no_status).unwrap_err().contains("status.indicator"));
        let null_indicator = r#"{"status":{"indicator":null,"description":"x"}}"#;
        assert!(parse_status_json(null_indicator).unwrap_err().contains("status.indicator"));
        // indicator 缺 description / updated_at 仍可解析（诚实留空，不编造）。
        let bare = r#"{"status":{"indicator":"none"}}"#;
        let (ind, desc, ts) = parse_status_json(bare).unwrap();
        assert_eq!((ind.as_str(), desc.as_str(), ts), ("operational", "", None));
    }

    #[test]
    fn non_2xx_yields_reason_and_success_yields_none() {
        assert_eq!(http_status_reason(200), None);
        assert_eq!(http_status_reason(204), None);
        assert_eq!(http_status_reason(503).as_deref(), Some("状态页返回 HTTP 503"));
        assert_eq!(http_status_reason(403).as_deref(), Some("状态页返回 HTTP 403"));
        // 共享客户端阻止重定向，3xx 也按降级处理。
        assert_eq!(http_status_reason(302).as_deref(), Some("状态页返回 HTTP 302"));
    }

    #[test]
    fn unavailable_entry_is_gray_with_reason_and_no_timestamp() {
        let e = unavailable("anthropic", "Anthropic", "状态页返回 HTTP 503");
        assert_eq!((e.provider.as_str(), e.display_name.as_str()), ("anthropic", "Anthropic"));
        assert_eq!(e.state, "unavailable");
        assert_eq!(e.indicator, "unknown");
        assert_eq!(e.description, "状态页返回 HTTP 503");
        assert_eq!(e.updated_at, None);
        // 序列化字段名与前端对齐（snake_case）。
        let v: serde_json::Value = serde_json::to_value(&e).unwrap();
        for key in ["provider", "display_name", "indicator", "description", "updated_at", "state"] {
            assert!(v.get(key).is_some(), "missing {key}");
        }
    }

    #[test]
    fn budget_constant_is_ten_seconds_per_provider() {
        assert_eq!(STATUS_BUDGET_SECS, 10);
    }
}
