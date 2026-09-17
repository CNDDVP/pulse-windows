use crate::types::{ProviderUsage, UsageWindow};
use serde_json::Value;

pub async fn fetch_kimi_usage(api_key: Option<&str>) -> ProviderUsage {
    let key = match api_key {
        Some(k) if !k.trim().is_empty() => k,
        _ => {
            return ProviderUsage {
                provider_id: "kimi".to_string(),
                display_name: "Kimi Code".to_string(),
                icon: "kimi".to_string(),
                state: "unavailable".to_string(),
                primary_percent: 0,
                plan_name: None,
                is_active: false,
                windows: vec![],
                error_message: Some("请在设置中配置 Kimi API Key".to_string()),
            };
        }
    };

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(6))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return ProviderUsage {
                provider_id: "kimi".to_string(),
                display_name: "Kimi Code".to_string(),
                icon: "kimi".to_string(),
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
        .get("https://api.moonshot.cn/v1/users/me/balance")
        .header("Authorization", format!("Bearer {}", key))
        .send()
        .await;

    match resp {
        Ok(res) if res.status().is_success() => {
            if let Ok(data) = res.json::<Value>().await {
                let balance = data
                    .get("data")
                    .and_then(|d| d.get("available_balance"))
                    .and_then(|b| b.as_f64())
                    .unwrap_or(0.0);

                let voucher = data
                    .get("data")
                    .and_then(|d| d.get("voucher_balance"))
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.0);

                let total = balance + voucher;

                ProviderUsage {
                    provider_id: "kimi".to_string(),
                    display_name: "Kimi Code".to_string(),
                    icon: "kimi".to_string(),
                    state: "live".to_string(),
                    primary_percent: 0,
                    plan_name: Some(format!("¥{:.2}", total)),
                    is_active: false,
                    windows: vec![
                        UsageWindow {
                            id: "kimi-balance".to_string(),
                            name: "现金余额".to_string(),
                            used_fraction: 0.0,
                            used_percent: 0,
                            resets_at: None,
                            resets_in: Some(format!("¥{:.2}", balance)),
                        },
                        UsageWindow {
                            id: "kimi-voucher".to_string(),
                            name: "代金券".to_string(),
                            used_fraction: 0.0,
                            used_percent: 0,
                            resets_at: None,
                            resets_in: Some(format!("¥{:.2}", voucher)),
                        },
                    ],
                    error_message: None,
                }
            } else {
                ProviderUsage {
                    provider_id: "kimi".to_string(),
                    display_name: "Kimi Code".to_string(),
                    icon: "kimi".to_string(),
                    state: "error".to_string(),
                    primary_percent: 0,
                    plan_name: None,
                    is_active: false,
                    windows: vec![],
                    error_message: Some("解析 Kimi 余额失败".to_string()),
                }
            }
        }
        Ok(res) => ProviderUsage {
            provider_id: "kimi".to_string(),
            display_name: "Kimi Code".to_string(),
            icon: "kimi".to_string(),
            state: "unavailable".to_string(),
            primary_percent: 0,
            plan_name: None,
            is_active: false,
            windows: vec![],
            error_message: Some(format!("请求错误: {}", res.status())),
        },
        Err(e) => ProviderUsage {
            provider_id: "kimi".to_string(),
            display_name: "Kimi Code".to_string(),
            icon: "kimi".to_string(),
            state: "error".to_string(),
            primary_percent: 0,
            plan_name: None,
            is_active: false,
            windows: vec![],
            error_message: Some(e.to_string()),
        },
    }
}
