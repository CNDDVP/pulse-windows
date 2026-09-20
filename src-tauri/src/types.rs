use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
pub const PROVIDERS: &[(&str, &str)] = &[
    ("claude", "Claude Code"), ("codex", "Codex"), ("antigravity", "Antigravity"),
    ("cursor", "Cursor"), ("copilot", "GitHub Copilot"), ("grok", "Grok"),
    ("grok-bot", "Grok Bot"), ("opencode", "OpenCode Go"), ("kimi", "Kimi Code"),
    ("ollama", "Ollama Cloud"), ("zai", "z.ai"), ("zhipu", "Zhipu"),
    ("minimax", "MiniMax"), ("minimax-cn", "MiniMax CN"), ("volcengine", "Volcengine"),
    ("command-code", "Command Code"), ("deepseek", "DeepSeek"), ("devin", "Devin"),
    ("xiaomi", "小米 Coding Plan"),
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
    /// Wall time of the fetch that produced this reading; feeds the per-account diagnostics.
    pub duration_ms: Option<u64>,
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
    /// Window the outer elapsed-time ring tracks; `None` picks the soonest reset.
    pub elapsed_window: Option<String>,
    /// `#rrggbb` override for the ring; `None` keeps the pressure colour.
    pub ring_color: Option<String>,
    /// `icon` (default) or `bot` — animated mark instead of the provider badge.
    pub mark_mode: Option<String>,
    pub bot_persona: Option<String>, pub bot_shape: Option<String>, pub bot_color: Option<String>,
    /// Optional second quota drawn as an inner ring; `None` keeps a single ring.
    pub secondary_window: Option<String>,
    /// Antigravity only: split Gemini / Claude-GPT into separate rail slots.
    pub split_model_groups: bool,
    /// Per-account money line for the low-balance notice, in `low_balance_currency` only.
    pub low_balance: Option<f64>, pub low_balance_currency: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct NotificationSettings {
    /// Used-share step (75/80/90/95) that raises the "approaching" notice; `None` = off.
    pub threshold: Option<u8>,
    pub on_spent: bool, pub on_reset: bool, pub on_failure: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct HotkeySettings { pub open_settings: Option<String>, pub toggle_rail: Option<String> }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct NetworkProxySettings {
    pub mode: String, // "auto" | "manual_http" | "manual_socks5"
    pub host: String,
    pub port: u16,
}
impl Default for NetworkProxySettings {
    fn default() -> Self {
        Self {
            mode: "auto".into(),
            host: String::new(),
            port: 0,
        }
    }
}

pub const SCHEMA_VERSION: u32 = 4;
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct RailWarnings {
    pub scope: String,
    pub account_ids: Vec<String>,
    pub custom_thresholds: bool,
    pub yellow: f64,
    pub red: f64,
    pub accounts: BTreeMap<String, RailAccountRule>,
}
impl Default for RailWarnings {
    fn default()->Self { Self { scope:"all".into(),account_ids:vec![],custom_thresholds:false,yellow:75.0,red:90.0,accounts:BTreeMap::new() } }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct RailAccountRule {
    pub mode: String,
    pub window_id: Option<String>,
    pub balances: BTreeMap<String, RailBalanceRule>,
}
impl Default for RailAccountRule {
    fn default()->Self { Self { mode:"primary".into(),window_id:None,balances:BTreeMap::new() } }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RailBalanceRule { pub yellow:f64, pub red:f64 }
impl RailWarnings {
    pub fn validate(&self)->Result<(),String> {
        if !["all","selected"].contains(&self.scope.as_str()) || self.account_ids.len()>64 || self.accounts.len()>128
            || !self.yellow.is_finite() || !self.red.is_finite() || !(0.0<self.yellow && self.yellow<self.red && self.red<=100.0)
            || self.account_ids.iter().any(|id|!valid_id(id)) { return Err("收纳条预警范围或百分比阈值无效".into()); }
        for (id,rule) in &self.accounts {
            if !valid_id(id) || !["primary","all","window"].contains(&rule.mode.as_str())
                || (rule.mode=="window" && rule.window_id.as_deref().is_none_or(|w|w.is_empty()||w.len()>256)) || rule.balances.len()>16 {return Err("收纳条额度选择无效".into());}
            for (currency, threshold) in &rule.balances {
                if currency.len()!=3 || !currency.bytes().all(|b|b.is_ascii_uppercase())
                    || !threshold.yellow.is_finite() || !threshold.red.is_finite() || threshold.red<0.0 || threshold.red>=threshold.yellow {
                    return Err("余额阈值需满足 0 ≤ 红色 < 黄色，币种为三位大写代码".into());
                }
            }
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct AppSettings {
    pub schema_version: u32, pub generation: u64, pub dock_side: String, pub auto_collapse_seconds: u64,
    pub theme: String, pub refresh_interval_seconds: u64, pub display_mode: String,
    pub forecast: bool, pub show_elapsed: bool, pub follow_active_display: bool,
    pub hide_fullscreen: bool, pub monitor_name: Option<String>, pub free_x: f64, pub free_y: f64,
    /// Used share at which rings turn red (60..=95); amber starts 15 points earlier.
    pub warning_threshold: u8,
    pub show_rail: bool,
    /// Honour prefers-reduced-motion and skip continuous animations (bot mark).
    pub reduce_motion: bool,
    /// What to show right after launch: "rail" | "settings" | "tray".
    pub start_behavior: String,
    pub monitoring_setup_completed: bool,
    pub token_spend_enabled: bool,
    pub authorized_providers: Vec<String>,
    pub network_proxy: NetworkProxySettings,
    pub collapsed_bar_color_mode: String,
    pub collapsed_bar_color: Option<String>,
    pub rail_warnings: RailWarnings,
    pub notifications: NotificationSettings,
    pub hotkeys: HotkeySettings,
    pub providers: BTreeMap<String, ProviderConfig>,
}
impl Default for AppSettings {
    fn default() -> Self {
        let providers=PROVIDERS.iter().enumerate().map(|(i,(id,_))| (format!("{id}-default"),ProviderConfig {
            provider_id:(*id).into(), label:name(id), enabled:false, order:i as u32, use_local:true, ..ProviderConfig::default()
        })).collect();
        Self { schema_version:SCHEMA_VERSION, generation:0, dock_side:"right".into(), auto_collapse_seconds:0, theme:"obsidian".into(),
            refresh_interval_seconds:120, display_mode:"used".into(), forecast:false, show_elapsed:false,
            follow_active_display:false, hide_fullscreen:false, monitor_name:None, free_x:0.5, free_y:0.5,
            warning_threshold:90, show_rail:true, reduce_motion:false, start_behavior:"rail".into(),
            monitoring_setup_completed:false, token_spend_enabled:false, authorized_providers:vec![],
            network_proxy:NetworkProxySettings::default(),
            collapsed_bar_color_mode:"auto".into(), collapsed_bar_color:None,
            rail_warnings:RailWarnings::default(),
            notifications:NotificationSettings::default(), hotkeys:HotkeySettings::default(), providers }
    }
}
impl AppSettings {
    pub fn validate(&self) -> Result<(),String> {
        self.rail_warnings.validate()?;
        if !(2..=SCHEMA_VERSION).contains(&self.schema_version) || !["left","right","top","free"].contains(&self.dock_side.as_str())
            || !["obsidian","translucent"].contains(&self.theme.as_str())
            || !["used","remaining"].contains(&self.display_mode.as_str())
            || !["rail","settings","tray"].contains(&self.start_behavior.as_str())
            || !(30..=3600).contains(&self.refresh_interval_seconds) || self.auto_collapse_seconds>300
            || !(60..=95).contains(&self.warning_threshold)
            || self.notifications.threshold.is_some_and(|t|![75,80,90,95].contains(&t))
            || [&self.hotkeys.open_settings,&self.hotkeys.toggle_rail].iter().any(|h|h.as_deref().is_some_and(|s|s.is_empty()||s.len()>64))
            || !self.free_x.is_finite() || !self.free_y.is_finite() || !(0.0..=1.0).contains(&self.free_x) || !(0.0..=1.0).contains(&self.free_y)
            || self.providers.len()>64 { return Err("设置版本或参数无效".into()); }
        for p in &self.authorized_providers {
            if !PROVIDERS.iter().any(|(id, _)| id == p) {
                return Err(format!("未知的已授权服务商: {p}"));
            }
        }
        if !["auto", "manual_http", "manual_socks5"].contains(&self.network_proxy.mode.as_str()) {
            return Err("代理模式无效".into());
        }
        if !["auto", "rainbow", "custom"].contains(&self.collapsed_bar_color_mode.as_str()) {
            return Err("折叠条颜色模式无效".into());
        }
        if let Some(ref c) = self.collapsed_bar_color {
            if !c.is_empty() && (!c.starts_with('#') || c.len() != 7) {
                return Err("折叠条自定义颜色格式无效，需为 #RRGGBB".into());
            }
        }
        if self.network_proxy.mode != "auto" {
            if self.network_proxy.host.is_empty() || self.network_proxy.host.len() > 255 || self.network_proxy.port == 0 {
                return Err("代理服务器地址或端口无效".into());
            }
        }
        for (id,cfg) in &self.providers {
            if !valid_id(id) || !PROVIDERS.iter().any(|p|p.0==cfg.provider_id) || cfg.label.len()>160 { return Err("账号配置无效".into()); }
            if cfg.ring_color.as_deref().is_some_and(|c|!(c.len()==7 && c.starts_with('#') && c[1..].bytes().all(|b|b.is_ascii_hexdigit()))) { return Err("圆环颜色无效".into()); }
            if cfg.low_balance.is_some_and(|v|!v.is_finite()||v<0.0) || cfg.low_balance_currency.as_deref().is_some_and(|c|c.is_empty()||c.len()>8) { return Err("余额阈值无效".into()); }
            if cfg.mark_mode.as_deref().is_some_and(|m|m!="icon"&&m!="bot") { return Err("标识模式无效".into()); }
            const PERSONAS:&[&str]=&["calm","eager","steady","curious","sleepy","playful","stoic","proud"];
            if cfg.bot_persona.as_deref().is_some_and(|p|!PERSONAS.contains(&p)) { return Err("机器人个性无效".into()); }
            const SHAPES:&[&str]=&["blob","pebble","bean","egg","squircle","tablet","capsule","cylinder","hex","gem","crystal","wedge","shield","dome","arch","cloud","teardrop","leaf"];
            if cfg.bot_shape.as_deref().is_some_and(|p|!SHAPES.contains(&p)) { return Err("机器人形状无效".into()); }
            if cfg.bot_color.as_deref().is_some_and(|c|!(c.len()==7 && c.starts_with('#') && c[1..].bytes().all(|b|b.is_ascii_hexdigit()))) { return Err("机器人颜色无效".into()); }
        }
        Ok(())
    }
}
pub fn valid_id(id:&str)->bool { !id.is_empty() && id.len()<=100 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b==b'-' || b==b'_') }
