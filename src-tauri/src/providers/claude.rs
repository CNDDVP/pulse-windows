use crate::types::{ProviderUsage, UsageWindow};
use serde_json::Value;

pub async fn fetch_claude_usage(custom_token: Option<&str>) -> ProviderUsage {
    let home = dirs::home_dir();
    let file_token = home.and_then(|h| {
        let cred_file = h.join(".claude").join(".credentials.json");
        if cred_file.exists() {
            let content = std::fs::read_to_string(cred_file).ok()?;
            let val: Value = serde_json::from_str(&content).ok()?;
            val.get("accessToken")
                .or_else(|| val.get("token"))
                .and_then(|t| t.as_str())
                .map(|s| s.to_string())
        } else {
            None
        }
    });

    let token = custom_token.map(|s| s.to_string()).or(file_token);

    let token = match token {
        Some(t) if !t.trim().is_empty() => t,
        _ => {
            return ProviderUsage {
                provider_id: "claude".to_string(),
                display_name: "Claude Code".to_string(),
                icon: "claude".to_string(),
                state: "unavailable".to_string(),
                primary_percent: 0,
                plan_name: None,
                is_active: false,
                windows: vec![],
                error_message: Some("未检测到本地登录，可在设置中填入 Token".to_string()),
            };
        }
    };

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return ProviderUsage {
                provider_id: "claude".to_string(),
                display_name: "Claude Code".to_string(),
                icon: "claude".to_string(),
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
        .get("https://api.anthropic.com/api/oauth/usage")
        .header("Authorization", format!("Bearer {}", token))
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("User-Agent", "claude-cli (external, cli)")
        .header("Accept", "application/json")
        .send()
        .await;

    match resp {
        Ok(res) if res.status().is_success() => {
            if let Ok(data) = res.json::<Value>().await {
                let mut windows = vec![];
                let mut max_pct = 0;

                // Parse 5h session and weekly windows
                if let Some(session) = data.get("five_hour").or_else(|| data.get("session")) {
                    let used_pct = session.get("used_percent").and_then(|u| u.as_u64()).unwrap_or(0) as u32;
                    let reset_in = session.get("resets_in").and_then(|r| r.as_str()).map(|s| s.to_string());
                    if used_pct > max_pct { max_pct = used_pct; }

                    windows.push(UsageWindow {
                        id: "claude-session".to_string(),
                        name: "Current session".to_string(),
                        used_fraction: (used_pct as f64) / 100.0,
                        used_percent: used_pct,
                        resets_at: None,
                        resets_in: reset_in.or(Some("5小时窗口".to_string())),
                    });
                }

                if let Some(weekly) = data.get("weekly").or_else(|| data.get("all_models")) {
                    let used_pct = weekly.get("used_percent").and_then(|u| u.as_u64()).unwrap_or(0) as u32;
                    let reset_in = weekly.get("resets_in").and_then(|r| r.as_str()).map(|s| s.to_string());

                    windows.push(UsageWindow {
                        id: "claude-weekly".to_string(),
                        name: "All models".to_string(),
                        used_fraction: (used_pct as f64) / 100.0,
                        used_percent: used_pct,
                        resets_at: None,
                        resets_in: reset_in.or(Some("每周刷新".to_string())),
                    });
                }

                ProviderUsage {
                    provider_id: "claude".to_string(),
                    display_name: "Claude Code".to_string(),
                    icon: "claude".to_string(),
                    state: "live".to_string(),
                    primary_percent: max_pct,
                    plan_name: data.get("plan").and_then(|p| p.as_str()).map(|s| s.to_string()),
                    is_active: false,
                    windows,
                    error_message: None,
                }
            } else {
                ProviderUsage {
                    provider_id: "claude".to_string(),
                    display_name: "Claude Code".to_string(),
                    icon: "claude".to_string(),
                    state: "error".to_string(),
                    primary_percent: 0,
                    plan_name: None,
                    is_active: false,
                    windows: vec![],
                    error_message: Some("解析 Claude 用量失败".to_string()),
                }
            }
        }
        Ok(res) => ProviderUsage {
            provider_id: "claude".to_string(),
            display_name: "Claude Code".to_string(),
            icon: "claude".to_string(),
            state: "unavailable".to_string(),
            primary_percent: 0,
            plan_name: None,
            is_active: false,
            windows: vec![],
            error_message: Some(format!("认证或接口错误: {}", res.status())),
        },
        Err(e) => ProviderUsage {
            provider_id: "claude".to_string(),
            display_name: "Claude Code".to_string(),
            icon: "claude".to_string(),
            state: "error".to_string(),
            primary_percent: 0,
            plan_name: None,
            is_active: false,
            windows: vec![],
            error_message: Some(e.to_string()),
        },
    }
}
