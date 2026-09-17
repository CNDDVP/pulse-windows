use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageWindow {
    pub id: String,
    pub name: String,
    pub used_fraction: f64,
    pub used_percent: u32,
    pub resets_at: Option<String>,
    pub resets_in: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderUsage {
    pub provider_id: String,
    pub display_name: String,
    pub icon: String,
    pub state: String, // "live", "loading", "unavailable", "error"
    pub primary_percent: u32,
    pub plan_name: Option<String>,
    pub is_active: bool,
    pub windows: Vec<UsageWindow>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub enabled: bool,
    pub order: u32,
    pub api_key: Option<String>,
    pub custom_endpoint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    pub dock_side: String, // "right" or "left"
    pub auto_collapse_seconds: u64,
    pub theme: String, // "obsidian" or "translucent"
    pub refresh_interval_seconds: u64,
    pub providers: HashMap<String, ProviderConfig>,
}

impl Default for AppSettings {
    fn default() -> Self {
        let mut providers = HashMap::new();
        
        let defaults = [
            ("antigravity", true, 0),
            ("cursor", true, 1),
            ("codex", true, 2),
            ("claude", true, 3),
            ("kimi", true, 4),
            ("copilot", true, 5),
            ("deepseek", false, 6),
            ("grok", false, 7),
            ("minimax", false, 8),
            ("devin", false, 9),
            ("opencode", false, 10),
        ];

        for (id, enabled, order) in defaults {
            providers.insert(
                id.to_string(),
                ProviderConfig {
                    enabled,
                    order,
                    api_key: None,
                    custom_endpoint: None,
                },
            );
        }

        Self {
            dock_side: "right".to_string(),
            auto_collapse_seconds: 3,
            theme: "obsidian".to_string(),
            refresh_interval_seconds: 120,
            providers,
        }
    }
}
