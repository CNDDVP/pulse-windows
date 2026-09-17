use crate::types::{ProviderUsage, UsageWindow};
use base64::prelude::*;
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;

pub async fn fetch_cursor_usage() -> ProviderUsage {
    let app_data = match std::env::var("APPDATA") {
        Ok(v) => v,
        Err(_) => {
            return ProviderUsage {
                provider_id: "cursor".to_string(),
                display_name: "Cursor".to_string(),
                icon: "cursor".to_string(),
                state: "unavailable".to_string(),
                primary_percent: 0,
                plan_name: None,
                is_active: false,
                windows: vec![],
                error_message: Some("无法获取 APPDATA 路径".to_string()),
            };
        }
    };

    let db_path = std::path::Path::new(&app_data)
        .join("Cursor")
        .join("User")
        .join("globalStorage")
        .join("state.vscdb");

    if !db_path.exists() {
        return ProviderUsage {
            provider_id: "cursor".to_string(),
            display_name: "Cursor".to_string(),
            icon: "cursor".to_string(),
            state: "unavailable".to_string(),
            primary_percent: 0,
            plan_name: None,
            is_active: false,
            windows: vec![],
            error_message: Some("未安装 Cursor 或未登录".to_string()),
        };
    }

    let raw_token = match extract_token_from_db(&db_path) {
        Some(t) => t,
        None => {
            return ProviderUsage {
                provider_id: "cursor".to_string(),
                display_name: "Cursor".to_string(),
                icon: "cursor".to_string(),
                state: "unavailable".to_string(),
                primary_percent: 0,
                plan_name: None,
                is_active: false,
                windows: vec![],
                error_message: Some("未在本地找到登录 Token".to_string()),
            };
        }
    };

    let account_id = match extract_account_id_from_jwt(&raw_token) {
        Some(acc) => acc,
        None => {
            return ProviderUsage {
                provider_id: "cursor".to_string(),
                display_name: "Cursor".to_string(),
                icon: "cursor".to_string(),
                state: "error".to_string(),
                primary_percent: 0,
                plan_name: None,
                is_active: false,
                windows: vec![],
                error_message: Some("Token 解析失败".to_string()),
            };
        }
    };

    let cookie = format!("WorkosCursorSessionToken={}%3A%3A{}", account_id, raw_token);

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(6))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return ProviderUsage {
                provider_id: "cursor".to_string(),
                display_name: "Cursor".to_string(),
                icon: "cursor".to_string(),
                state: "error".to_string(),
                primary_percent: 0,
                plan_name: None,
                is_active: false,
                windows: vec![],
                error_message: Some(e.to_string()),
            };
        }
    };

    let resp = client
        .get("https://cursor.com/api/usage-summary")
        .header("Cookie", cookie)
        .header("Accept", "application/json")
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
        .send()
        .await;

    match resp {
        Ok(res) if res.status().is_success() => {
            if let Ok(data) = res.json::<Value>().await {
                let plan = data
                    .get("membershipType")
                    .and_then(|m| m.as_str())
                    .unwrap_or("free");

                let auto_msg = data
                    .get("autoModelSelectedDisplayMessage")
                    .and_then(|m| m.as_str())
                    .unwrap_or("");
                let named_msg = data
                    .get("namedModelSelectedDisplayMessage")
                    .and_then(|m| m.as_str())
                    .unwrap_or("");

                let auto_pct = parse_percent_from_msg(auto_msg).unwrap_or(0);
                let named_pct = parse_percent_from_msg(named_msg).unwrap_or(0);

                let cycle_end = data
                    .get("billingCycleEnd")
                    .and_then(|e| e.as_str())
                    .map(|s| s.to_string());

                let reset_in = cycle_end.as_ref().map(|s| {
                    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
                        let now = chrono::Utc::now();
                        let diff = dt.signed_duration_since(now);
                        if diff.num_days() > 0 {
                            format!("{}天后重置", diff.num_days())
                        } else {
                            "今日重置".to_string()
                        }
                    } else {
                        "次月重置".to_string()
                    }
                });

                let mut windows = vec![];
                windows.push(UsageWindow {
                    id: "cursor-auto".to_string(),
                    name: "Included Total Usage".to_string(),
                    used_fraction: (auto_pct as f64) / 100.0,
                    used_percent: auto_pct,
                    resets_at: cycle_end.clone(),
                    resets_in: reset_in.clone(),
                });

                windows.push(UsageWindow {
                    id: "cursor-named".to_string(),
                    name: "Named Model Usage".to_string(),
                    used_fraction: (named_pct as f64) / 100.0,
                    used_percent: named_pct,
                    resets_at: cycle_end,
                    resets_in: reset_in,
                });

                let primary = auto_pct.max(named_pct);

                ProviderUsage {
                    provider_id: "cursor".to_string(),
                    display_name: "Cursor".to_string(),
                    icon: "cursor".to_string(),
                    state: "live".to_string(),
                    primary_percent: primary,
                    plan_name: Some(plan.to_uppercase()),
                    is_active: false,
                    windows,
                    error_message: None,
                }
            } else {
                ProviderUsage {
                    provider_id: "cursor".to_string(),
                    display_name: "Cursor".to_string(),
                    icon: "cursor".to_string(),
                    state: "error".to_string(),
                    primary_percent: 0,
                    plan_name: None,
                    is_active: false,
                    windows: vec![],
                    error_message: Some("无法解析返回的 JSON".to_string()),
                }
            }
        }
        Ok(res) => {
            let status = res.status();
            let msg = if status == 401 || status == 403 {
                "登录已过期，请在 Cursor 软件中登录或使用".to_string()
            } else {
                format!("HTTP 状态码: {}", status)
            };
            ProviderUsage {
                provider_id: "cursor".to_string(),
                display_name: "Cursor".to_string(),
                icon: "cursor".to_string(),
                state: "unavailable".to_string(),
                primary_percent: 0,
                plan_name: None,
                is_active: false,
                windows: vec![],
                error_message: Some(msg),
            }
        },
        Err(e) => ProviderUsage {
            provider_id: "cursor".to_string(),
            display_name: "Cursor".to_string(),
            icon: "cursor".to_string(),
            state: "error".to_string(),
            primary_percent: 0,
            plan_name: None,
            is_active: false,
            windows: vec![],
            error_message: Some(e.to_string()),
        },
    }
}

fn extract_token_from_db(db_path: &std::path::Path) -> Option<String> {
    let conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    let mut stmt = conn
        .prepare("SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken' LIMIT 1")
        .ok()?;

    let mut rows = stmt.query([]).ok()?;
    if let Some(row) = rows.next().ok()? {
        let val: Result<String, _> = row.get(0);
        if let Ok(s) = val {
            return Some(s);
        }
        let blob: Result<Vec<u8>, _> = row.get(0);
        if let Ok(b) = blob {
            return String::from_utf8(b).ok();
        }
    }
    None
}

fn extract_account_id_from_jwt(token: &str) -> Option<String> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() < 2 {
        return None;
    }
    let mut payload = parts[1].to_string();
    while payload.len() % 4 != 0 {
        payload.push('=');
    }
    let decoded = BASE64_URL_SAFE.decode(payload.as_bytes()).ok()?;
    let claims: Value = serde_json::from_slice(&decoded).ok()?;
    let sub = claims.get("sub")?.as_str()?;
    if let Some(acc) = sub.split('|').last() {
        Some(acc.to_string())
    } else {
        Some(sub.to_string())
    }
}

fn parse_percent_from_msg(msg: &str) -> Option<u32> {
    // "You've used 15% of your..."
    if let Some(pos) = msg.find('%') {
        let before = &msg[..pos];
        let num_str = before.split_whitespace().last()?;
        num_str.parse::<u32>().ok()
    } else {
        None
    }
}
