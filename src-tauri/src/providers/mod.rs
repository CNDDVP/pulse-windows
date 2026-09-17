pub mod antigravity;
pub mod claude;
pub mod codex;
pub mod copilot;
pub mod cursor;
pub mod deepseek;
pub mod kimi;

use crate::types::{AppSettings, ProviderUsage};

pub async fn fetch_all_usages(settings: &AppSettings) -> Vec<ProviderUsage> {
    let mut tasks = vec![];

    // Collect ordered enabled providers
    let mut ordered: Vec<(&String, &crate::types::ProviderConfig)> = settings
        .providers
        .iter()
        .filter(|(_, cfg)| cfg.enabled)
        .collect();
    ordered.sort_by_key(|(_, cfg)| cfg.order);

    for (id, cfg) in ordered {
        let id_str = id.clone();
        let api_key = cfg.api_key.clone();

        let task = tokio::spawn(async move {
            match id_str.as_str() {
                "antigravity" => antigravity::fetch_antigravity_usage().await,
                "cursor" => cursor::fetch_cursor_usage().await,
                "codex" => codex::fetch_codex_usage().await,
                "claude" => claude::fetch_claude_usage(api_key.as_deref()).await,
                "kimi" => kimi::fetch_kimi_usage(api_key.as_deref()).await,
                "deepseek" => deepseek::fetch_deepseek_usage(api_key.as_deref()).await,
                "copilot" => copilot::fetch_copilot_usage(api_key.as_deref()).await,
                other => ProviderUsage {
                    provider_id: other.to_string(),
                    display_name: capitalize_first(other),
                    icon: other.to_string(),
                    state: "unavailable".to_string(),
                    primary_percent: 0,
                    plan_name: None,
                    is_active: false,
                    windows: vec![],
                    error_message: Some(format!("{} 尚未配置", other)),
                },
            }
        });
        tasks.push(task);
    }

    let mut results = vec![];
    for task in tasks {
        if let Ok(usage) = task.await {
            results.push(usage);
        }
    }

    results
}

fn capitalize_first(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        None => String::new(),
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
    }
}
