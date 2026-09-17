use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
pub const PROVIDERS: &[(&str, &str)] = &[
    ("claude", "Claude Code"), ("codex", "Codex"), ("antigravity", "Antigravity"),
    ("cursor", "Cursor"), ("copilot", "GitHub Copilot"), ("grok", "Grok"),
    ("grok-bot", "Grok Bot"), ("opencode", "OpenCode Go"), ("kimi", "Kimi Code"),
    ("ollama", "Ollama Cloud"), ("zai", "z.ai"), ("zhipu", "Zhipu"),
    ("minimax", "MiniMax"), ("minimax-cn", "MiniMax CN"), ("volcengine", "Volcengine"),
    ("command-code", "Command Code"), ("deepseek", "DeepSeek"), ("devin", "Devin"),
];
pub fn name(id: &str) -> String { PROVIDERS.iter().find(|p| p.0 == id).map(|p| p.1).unwrap_or(id).into() }
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UsageWindow {
    pub id: String, pub name: String, pub used_fraction: f64, pub used_percent: f64,
    pub resets_at: Option<String>, pub window_seconds: Option<i64>, pub exhausted: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Balance { pub currency: String, pub amount: f64 }
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProviderUsage {
    #[serde(skip)] pub scope: String,
    pub account_id: String, pub provider_id: String, pub display_name: String, pub state: String,
    pub primary_percent: Option<f64>, pub plan_name: Option<String>, pub is_active: bool,
    pub windows: Vec<UsageWindow>, pub balances: Vec<Balance>, pub error_code: Option<String>,
    pub error_message: Option<String>, pub source: String, pub checked_at: Option<String>,
    pub last_success_at: Option<String>, pub retry_after_seconds: Option<u64>,
}
impl ProviderUsage {
    pub fn problem(provider: &str, code: &str, message: &str) -> Self {
        Self { provider_id: provider.into(), display_name: name(provider), state: "unavailable".into(),
            error_code: Some(code.into()), error_message: Some(message.into()), ..Self::default() }
    }
    pub fn reading(provider: &str, windows: Vec<UsageWindow>) -> Self {
        if windows.is_empty() { return Self::problem(provider, "no_data", "服务未报告可识别的额度数据"); }
        let primary_percent=windows.iter().map(|w| w.used_percent).reduce(f64::max);
        Self {provider_id:provider.into(), display_name:name(provider), state:"live".into(), primary_percent, windows, ..Self::default()}
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub struct ProviderConfig {
    pub provider_id: String, pub label: String, pub enabled: bool, pub order: u32,
    pub use_local: bool, pub credential_configured: bool, pub primary_window: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct AppSettings {
    pub schema_version: u32, pub dock_side: String, pub auto_collapse_seconds: u64,
    pub theme: String, pub refresh_interval_seconds: u64, pub display_mode: String,
    pub forecast: bool, pub show_elapsed: bool, pub follow_active_display: bool,
    pub hide_fullscreen: bool, pub monitor_name: Option<String>, pub free_x: f64, pub free_y: f64,
    pub providers: BTreeMap<String, ProviderConfig>,
}
impl Default for AppSettings {
    fn default() -> Self {
        let providers=PROVIDERS.iter().enumerate().map(|(i,(id,_))| (format!("{id}-default"),ProviderConfig {
            provider_id:(*id).into(), label:name(id), enabled:false, order:i as u32, use_local:true, ..ProviderConfig::default()
        })).collect();
        Self { schema_version:2, dock_side:"right".into(), auto_collapse_seconds:0, theme:"obsidian".into(),
            refresh_interval_seconds:120, display_mode:"used".into(), forecast:false, show_elapsed:false,
            follow_active_display:false, hide_fullscreen:false, monitor_name:None, free_x:0.5, free_y:0.5, providers }
    }
}
impl AppSettings {
    pub fn validate(&self) -> Result<(),String> {
        if self.schema_version!=2 || !["left","right","top","free"].contains(&self.dock_side.as_str())
            || !["obsidian","translucent"].contains(&self.theme.as_str())
            || !["used","remaining"].contains(&self.display_mode.as_str())
            || !(30..=3600).contains(&self.refresh_interval_seconds) || self.auto_collapse_seconds>300
            || !self.free_x.is_finite() || !self.free_y.is_finite() || !(0.0..=1.0).contains(&self.free_x) || !(0.0..=1.0).contains(&self.free_y)
            || self.providers.len()>64 { return Err("设置版本或参数无效".into()); }
        for (id,cfg) in &self.providers {
            if !valid_id(id) || !PROVIDERS.iter().any(|p|p.0==cfg.provider_id) || cfg.label.len()>160 { return Err("账号配置无效".into()); }
        }
        Ok(())
    }
}
pub fn valid_id(id:&str)->bool { !id.is_empty() && id.len()<=100 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b==b'-' || b==b'_') }
