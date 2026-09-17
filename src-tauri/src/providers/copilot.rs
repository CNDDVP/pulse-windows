use crate::types::{ProviderUsage, UsageWindow};

pub async fn fetch_copilot_usage(_api_key: Option<&str>) -> ProviderUsage {
    // Check hosts.json or token
    let home = dirs::home_dir();
    let hosts_path = home.map(|h| h.join(".config").join("github-copilot").join("hosts.json"));

    let token = if let Some(hp) = hosts_path {
        if hp.exists() {
            std::fs::read_to_string(hp).ok().and_then(|content| {
                let v: serde_json::Value = serde_json::from_str(&content).ok()?;
                v.get("github.com")
                    .and_then(|gh| gh.get("oauth_token"))
                    .and_then(|t| t.as_str())
                    .map(|s| s.to_string())
            })
        } else {
            None
        }
    } else {
        None
    };

    if let Some(t) = token {
        let client = reqwest::Client::new();
        if let Ok(res) = client
            .get("https://api.github.com/copilot_internal/v2/token")
            .header("Authorization", format!("Bearer {}", t))
            .header("User-Agent", "GitHubCopilotChat/0.22.4")
            .send()
            .await
        {
            if res.status().is_success() {
                return ProviderUsage {
                    provider_id: "copilot".to_string(),
                    display_name: "GitHub Copilot".to_string(),
                    icon: "copilot".to_string(),
                    state: "live".to_string(),
                    primary_percent: 0,
                    plan_name: Some("ACTIVE".to_string()),
                    is_active: false,
                    windows: vec![
                        UsageWindow {
                            id: "copilot-active".to_string(),
                            name: "订阅状态".to_string(),
                            used_fraction: 0.0,
                            used_percent: 0,
                            resets_at: None,
                            resets_in: Some("活跃无限量".to_string()),
                        }
                    ],
                    error_message: None,
                };
            }
        }
    }

    ProviderUsage {
        provider_id: "copilot".to_string(),
        display_name: "GitHub Copilot".to_string(),
        icon: "copilot".to_string(),
        state: "unavailable".to_string(),
        primary_percent: 0,
        plan_name: None,
        is_active: false,
        windows: vec![],
        error_message: Some("未检测到 Copilot 凭据".to_string()),
    }
}
