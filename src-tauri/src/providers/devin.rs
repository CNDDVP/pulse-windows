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
    // 新鲜度判定（A23）：超 7 天、elapsed 异常、或元数据都取不到——一律视为不可信，
    // 打上 _unverified 让上层按未验证展示，而不是把旧额度包装成实时读数。
    let is_stale = std::fs::metadata(path)
        .and_then(|m| m.modified())
        .map(|mtime| mtime.elapsed().map(|el| el.as_secs() > 7 * 86400).unwrap_or(true))
        .unwrap_or(true);

    let conn = rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| e.to_string())?;
    // While Windsurf is running its DB may be locked; wait briefly instead of
    // reporting the lock conflict as a missing credential.
    let _ = conn.busy_timeout(std::time::Duration::from_millis(500));
    
    let mut stmt = conn.prepare("SELECT value FROM ItemTable WHERE key LIKE 'windsurf%'").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;

    for row in rows.flatten() {
        if let Ok(mut v) = serde_json::from_str::<Value>(&row) {
            if v.get("dailyRemainingPercent").is_some() || v.get("weeklyRemainingPercent").is_some() || v.get("daily_percentage").is_some() {
                if is_stale {
                    v["_unverified"] = serde_json::json!(true);
                }
                return Ok(v);
            }
        }
    }
    Err("未在 state.vscdb 找到额度记录".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_read_state_vscdb_fresh() {
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join("state.vscdb");
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.execute("CREATE TABLE ItemTable (key TEXT, value TEXT)", []).unwrap();
        conn.execute("INSERT INTO ItemTable VALUES ('windsurf.quota', '{\"dailyRemainingPercent\": 80}')", []).unwrap();
        drop(conn);

        let val = read_state_vscdb(&db_path).unwrap();
        assert_eq!(val["dailyRemainingPercent"], 80);
        assert_ne!(val["_unverified"], true);
    }
}

