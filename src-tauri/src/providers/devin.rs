//! Devin / Windsurf provider adapter (Apache-2.0 / Pulse 442a9c5).
use crate::types::ProviderUsage;
use serde_json::Value;
use std::path::PathBuf;

pub async fn fetch(token: Option<&str>, http: &reqwest::Client) -> Result<Value, ProviderUsage> {
    if let Some(token) = token {
        let trimmed = token.trim();
        if !trimmed.is_empty() {
            return fetch_endpoint(trimmed, http).await;
        }
    }
    fetch_local()
}

async fn fetch_endpoint(token: &str, http: &reqwest::Client) -> Result<Value, ProviderUsage> {
    let mut raw_token = token;
    if let Some(stripped) = token.strip_prefix("Bearer ") {
        raw_token = stripped.trim();
    }
    let parts: Vec<&str> = raw_token.split_whitespace().collect();
    let bearer = parts.first().unwrap_or(&raw_token);
    let org = parts.get(1).copied().unwrap_or("default");
    let org_path = if org.starts_with("org_") || org.starts_with("org-") {
        format!("organizations/{org}")
    } else if org.starts_with("org/") || org.starts_with("organizations/") {
        org.to_string()
    } else {
        format!("org/{org}")
    };

    let url = format!("https://app.devin.ai/api/{org_path}/billing/quota/usage");
    let req = http.get(&url).bearer_auth(bearer);
    crate::providers::response("devin", req).await
}

pub fn fetch_local() -> Result<Value, ProviderUsage> {
    let candidates = [
        dirs::config_dir().map(|p| p.join("Windsurf/User/globalStorage/state.vscdb")),
        dirs::data_local_dir().map(|p| p.join("Programs/Windsurf/User/globalStorage/state.vscdb")),
    ];

    for candidate in candidates.into_iter().flatten() {
        if candidate.exists() {
            if let Ok(val) = read_state_vscdb(&candidate) {
                return Ok(val);
            }
        }
    }

    Err(ProviderUsage::problem("devin", "missing_credentials", "未在本地检测到 Windsurf/Devin 本地状态库，请在账号中填入 API 凭据"))
}

fn read_state_vscdb(path: &PathBuf) -> Result<Value, String> {
    let conn = rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| e.to_string())?;
    // While Windsurf is running its DB may be locked; wait briefly instead of
    // reporting the lock conflict as a missing credential.
    let _ = conn.busy_timeout(std::time::Duration::from_millis(500));
    
    let mut stmt = conn.prepare("SELECT value FROM ItemTable WHERE key LIKE 'windsurf%'").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;

    for row in rows.flatten() {
        if let Ok(v) = serde_json::from_str::<Value>(&row) {
            if v.get("dailyRemainingPercent").is_some() || v.get("weeklyRemainingPercent").is_some() || v.get("daily_percentage").is_some() {
                return Ok(v);
            }
        }
    }
    Err("未在 state.vscdb 找到额度记录".into())
}
