use crate::types::{ProviderUsage, UsageWindow};
use serde_json::Value;

pub async fn fetch_deepseek_usage(api_key: Option<&str>) -> ProviderUsage {
    let key = match api_key {
        Some(k) if !k.trim().is_empty() => k,
        _ => {
            return ProviderUsage {
                provider_id: "deepseek".to_string(),
                display_name: "DeepSeek".to_string(),
                icon: "deepseek".to_string(),
                state: "unavailable".to_string(),
                primary_percent: 0,
                plan_name: None,
                is_active: false,
                windows: vec![],
                error_message: Some("请在设置中配置 DeepSeek API Key".to_string()),
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
                provider_id: "deepseek".to_string(),
                display_name: "DeepSeek".to_string(),
                icon: "deepseek".to_string(),
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
        .get("https://api.deepseek.com/user/balance")
        .header("Authorization", format!("Bearer {}", key))
        .send()
        .await;

    match resp {
        Ok(res) if res.status().is_success() => {
            if let Ok(data) = res.json::<Value>().await {
                let is_avail = data.get("is_available").and_then(|a| a.as_bool()).unwrap_or(true);
                let balance_infos = data.get("balance_infos").and_then(|b| b.as_array());

                let mut total_balance = 0.0;
                let mut currency = "CNY";

                if let Some(infos) = balance_infos {
                    for info in infos {
                        let cur = info.get("currency").and_then(|c| c.as_str()).unwrap_or("CNY");
                        let total = info.get("total_balance").and_then(|t| t.as_str()).and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
                        total_balance += total;
                        currency = cur;
                    }
                }

                let symbol = if currency == "CNY" { "¥" } else { "$" };

                ProviderUsage {
                    provider_id: "deepseek".to_string(),
                    display_name: "DeepSeek".to_string(),
                    icon: "deepseek".to_string(),
                    state: if is_avail { "live".to_string() } else { "unavailable".to_string() },
                    primary_percent: 0,
                    plan_name: Some(format!("{}{:.2}", symbol, total_balance)),
                    is_active: false,
                    windows: vec![
                        UsageWindow {
                            id: "deepseek-balance".to_string(),
                            name: "账户总余额".to_string(),
                            used_fraction: 0.0,
                            used_percent: 0,
                            resets_at: None,
                            resets_in: Some(format!("{}{:.2}", symbol, total_balance)),
                        }
                    ],
                    error_message: None,
                }
            } else {
                ProviderUsage {
                    provider_id: "deepseek".to_string(),
                    display_name: "DeepSeek".to_string(),
                    icon: "deepseek".to_string(),
                    state: "error".to_string(),
                    primary_percent: 0,
                    plan_name: None,
                    is_active: false,
                    windows: vec![],
                    error_message: Some("解析响应失败".to_string()),
                }
            }
        }
        Ok(res) => ProviderUsage {
            provider_id: "deepseek".to_string(),
            display_name: "DeepSeek".to_string(),
            icon: "deepseek".to_string(),
            state: "unavailable".to_string(),
            primary_percent: 0,
            plan_name: None,
            is_active: false,
            windows: vec![],
            error_message: Some(format!("错误: {}", res.status())),
        },
        Err(e) => ProviderUsage {
            provider_id: "deepseek".to_string(),
            display_name: "DeepSeek".to_string(),
            icon: "deepseek".to_string(),
            state: "error".to_string(),
            primary_percent: 0,
            plan_name: None,
            is_active: false,
            windows: vec![],
            error_message: Some(e.to_string()),
        },
    }
}
