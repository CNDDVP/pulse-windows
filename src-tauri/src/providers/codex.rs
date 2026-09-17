use crate::types::{ProviderUsage, UsageWindow};
use serde_json::Value;

pub async fn fetch_codex_usage() -> ProviderUsage {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => {
            return ProviderUsage {
                provider_id: "codex".to_string(),
                display_name: "Codex".to_string(),
                icon: "codex".to_string(),
                state: "unavailable".to_string(),
                primary_percent: 0,
                plan_name: None,
                is_active: false,
                windows: vec![],
                error_message: Some("未找到用户主目录".to_string()),
            };
        }
    };

    let auth_path = home.join(".codex").join("auth.json");
    if !auth_path.exists() {
        return ProviderUsage {
            provider_id: "codex".to_string(),
            display_name: "Codex".to_string(),
            icon: "codex".to_string(),
            state: "unavailable".to_string(),
            primary_percent: 0,
            plan_name: None,
            is_active: false,
            windows: vec![],
            error_message: Some("~/.codex/auth.json 不存在".to_string()),
        };
    }

    let auth_str = match std::fs::read_to_string(&auth_path) {
        Ok(s) => s,
        Err(e) => {
            return ProviderUsage {
                provider_id: "codex".to_string(),
                display_name: "Codex".to_string(),
                icon: "codex".to_string(),
                state: "unavailable".to_string(),
                primary_percent: 0,
                plan_name: None,
                is_active: false,
                windows: vec![],
                error_message: Some(format!("读取失败: {}", e)),
            };
        }
    };

    let auth_json: Value = match serde_json::from_str(&auth_str) {
        Ok(v) => v,
        Err(_) => {
            return ProviderUsage {
                provider_id: "codex".to_string(),
                display_name: "Codex".to_string(),
                icon: "codex".to_string(),
                state: "unavailable".to_string(),
                primary_percent: 0,
                plan_name: None,
                is_active: false,
                windows: vec![],
                error_message: Some("无法解析 auth.json".to_string()),
            };
        }
    };

    let token = auth_json
        .get("tokens")
        .and_then(|t| t.get("access_token"))
        .or_else(|| auth_json.get("access_token"))
        .and_then(|t| t.as_str());

    let token = match token {
        Some(t) => t,
        None => {
            return ProviderUsage {
                provider_id: "codex".to_string(),
                display_name: "Codex".to_string(),
                icon: "codex".to_string(),
                state: "unavailable".to_string(),
                primary_percent: 0,
                plan_name: None,
                is_active: false,
                windows: vec![],
                error_message: Some("未找到 Access Token，请先登录 Codex".to_string()),
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
                provider_id: "codex".to_string(),
                display_name: "Codex".to_string(),
                icon: "codex".to_string(),
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
        .get("https://chatgpt.com/backend-api/wham/usage")
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/json")
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
        .send()
        .await;

    match resp {
        Ok(res) if res.status().is_success() => {
            if let Ok(data) = res.json::<Value>().await {
                let plan = data
                    .get("plan_type")
                    .and_then(|p| p.as_str())
                    .map(|s| s.to_string());

                let mut windows = vec![];
                let mut primary_pct = 0;

                if let Some(rate_limit) = data.get("rate_limit") {
                    if let Some(pw) = rate_limit.get("primary_window") {
                        let used_pct = pw.get("used_percent").and_then(|u| u.as_u64()).unwrap_or(0) as u32;
                        let reset_after = pw.get("reset_after_seconds").and_then(|s| s.as_i64()).unwrap_or(0);
                        let window_secs = pw.get("limit_window_seconds").and_then(|s| s.as_i64()).unwrap_or(18000);
                        primary_pct = used_pct;

                        let window_name = if window_secs <= 18000 {
                            "5小时限额".to_string()
                        } else {
                            "每周限额".to_string()
                        };

                        let reset_desc = if reset_after > 3600 {
                            format!("{}小时{}分后重置", reset_after / 3600, (reset_after % 3600) / 60)
                        } else if reset_after > 60 {
                            format!("{}分钟后重置", reset_after / 60)
                        } else {
                            "即将重置".to_string()
                        };

                        windows.push(UsageWindow {
                            id: "codex-primary".to_string(),
                            name: window_name,
                            used_fraction: (used_pct as f64) / 100.0,
                            used_percent: used_pct,
                            resets_at: None,
                            resets_in: Some(reset_desc),
                        });
                    }

                    if let Some(sw) = rate_limit.get("secondary_window") {
                        let used_pct = sw.get("used_percent").and_then(|u| u.as_u64()).unwrap_or(0) as u32;
                        let reset_after = sw.get("reset_after_seconds").and_then(|s| s.as_i64()).unwrap_or(0);
                        
                        let reset_desc = if reset_after > 86400 {
                            format!("{}天后重置", reset_after / 86400)
                        } else if reset_after > 3600 {
                            format!("{}小时后重置", reset_after / 3600)
                        } else {
                            "即将重置".to_string()
                        };

                        windows.push(UsageWindow {
                            id: "codex-secondary".to_string(),
                            name: "每周限额".to_string(),
                            used_fraction: (used_pct as f64) / 100.0,
                            used_percent: used_pct,
                            resets_at: None,
                            resets_in: Some(reset_desc),
                        });
                    }

                    // Per-model limits if present
                    if let Some(models) = rate_limit.get("model_limits").and_then(|m| m.as_array()) {
                        for m in models {
                            let name = m.get("model_name").and_then(|n| n.as_str()).unwrap_or("Model");
                            let used_pct = m.get("used_percent").and_then(|u| u.as_u64()).unwrap_or(0) as u32;
                            windows.push(UsageWindow {
                                id: format!("codex-{}", name),
                                name: format!("限额 · {}", name),
                                used_fraction: (used_pct as f64) / 100.0,
                                used_percent: used_pct,
                                resets_at: None,
                                resets_in: None,
                            });
                        }
                    }
                }

                ProviderUsage {
                    provider_id: "codex".to_string(),
                    display_name: "Codex".to_string(),
                    icon: "codex".to_string(),
                    state: "live".to_string(),
                    primary_percent: primary_pct,
                    plan_name: plan.map(|p| p.to_uppercase()),
                    is_active: false,
                    windows,
                    error_message: None,
                }
            } else {
                ProviderUsage {
                    provider_id: "codex".to_string(),
                    display_name: "Codex".to_string(),
                    icon: "codex".to_string(),
                    state: "error".to_string(),
                    primary_percent: 0,
                    plan_name: None,
                    is_active: false,
                    windows: vec![],
                    error_message: Some("解析用量响应失败".to_string()),
                }
            }
        }
        Ok(res) => {
            let status = res.status();
            let msg = if status == 401 || status == 403 {
                "Token 已过期，请在 Codex 终端重新登录".to_string()
            } else {
                format!("请求错误: {}", status)
            };
            ProviderUsage {
                provider_id: "codex".to_string(),
                display_name: "Codex".to_string(),
                icon: "codex".to_string(),
                state: "unavailable".to_string(),
                primary_percent: 0,
                plan_name: None,
                is_active: false,
                windows: vec![],
                error_message: Some(msg),
            }
        }
        Err(e) => ProviderUsage {
            provider_id: "codex".to_string(),
            display_name: "Codex".to_string(),
            icon: "codex".to_string(),
            state: "error".to_string(),
            primary_percent: 0,
            plan_name: None,
            is_active: false,
            windows: vec![],
            error_message: Some(e.to_string()),
        },
    }
}
