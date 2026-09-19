//! Command Code provider adapter (Apache-2.0 / Pulse 442a9c5).
use crate::types::ProviderUsage;
use serde_json::Value;

pub async fn fetch(key: &str, http: &reqwest::Client) -> Result<Value, ProviderUsage> {
    let base = "https://api.commandcode.ai";
    // 1. whoami
    let whoami_req = http.get(format!("{base}/alpha/whoami?limits=1")).bearer_auth(key);
    let whoami = crate::providers::response("command-code", whoami_req).await?;

    let org_id = whoami.pointer("/org/id").and_then(Value::as_str);
    let org_query = org_id.map(|id| format!("?org={id}")).unwrap_or_default();

    // 2. credits
    let credits_req = http.get(format!("{base}/alpha/billing/credits{org_query}")).bearer_auth(key);
    let credits = crate::providers::response("command-code", credits_req).await?;

    // 3. subscriptions (optional) — 6s cap: two required calls can already eat most of the
    // 25s outer budget; an optional decoration must not cause the main usage to be dropped.
    let sub_req = http.get(format!("{base}/alpha/billing/subscriptions{org_query}")).bearer_auth(key);
    let subscription = match tokio::time::timeout(std::time::Duration::from_secs(6), crate::providers::response("command-code", sub_req)).await {
        Ok(r) => r.ok(),
        Err(_) => None,
    };

    Ok(serde_json::json!({
        "whoami": whoami,
        "credits": credits,
        "subscription": subscription
    }))
}
