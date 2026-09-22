use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
/// Round5A 项目四：每个来源的自定义扫描路径上限（token_spend_extra_paths）。
pub const TOKEN_SPEND_EXTRA_PATHS_PER_SOURCE: usize = 20;
/// 校验 token_spend_extra_paths（AppSettings::validate 与保存命令共用同一份规则）：
/// 来源标识走 valid_id；每来源最多 20 条；每条必须是非空绝对路径。
/// 不校验存在性——目录可先配置后创建，缺失时扫描按“来源未安装”静默跳过。
pub fn validate_token_spend_extra_paths(map:&BTreeMap<String, Vec<String>>) -> Result<(), String> {
    if map.len()>64 { return Err("扫描路径来源过多".into()); }
    for (src,dirs) in map {
        if !valid_id(src) { return Err(format!("扫描路径来源标识无效: {src}")); }
        if dirs.len()>TOKEN_SPEND_EXTRA_PATHS_PER_SOURCE { return Err(format!("来源 {src} 的扫描路径超过 {} 条上限", TOKEN_SPEND_EXTRA_PATHS_PER_SOURCE)); }
        for p in dirs {
            if p.is_empty() || !std::path::Path::new(p).is_absolute() { return Err(format!("来源 {src} 的扫描路径必须是绝对路径: {p}")); }
            if p.len()>1024 { return Err(format!("来源 {src} 的扫描路径过长: {p}")); }
        }
    }
    Ok(())
}
pub const PROVIDERS: &[(&str, &str)] = &[
    ("claude", "Claude Code"), ("codex", "Codex"), ("antigravity", "Antigravity"),
    ("cursor", "Cursor"), ("copilot", "GitHub Copilot"), ("grok", "Grok"),
    ("grok-bot", "Grok Bot"), ("opencode", "OpenCode Go"), ("kimi", "Kimi Code"),
    ("ollama", "Ollama Cloud"), ("zai", "z.ai"), ("zhipu", "Zhipu"),
    ("minimax", "MiniMax"), ("minimax-cn", "MiniMax CN"), ("volcengine", "Volcengine"),
    ("command-code", "Command Code"), ("deepseek", "DeepSeek"), ("devin", "Devin"),
    ("xiaomi", "小米 Coding Plan"), ("stepfun", "StepFun"),
];
pub fn name(id: &str) -> String { PROVIDERS.iter().find(|p| p.0 == id).map(|p| p.1).unwrap_or(id).into() }
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UsageWindow {
    pub id: String, pub name: String, pub used_fraction: f64, pub used_percent: f64,
    pub resets_at: Option<String>, pub window_seconds: Option<i64>, pub exhausted: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Balance {
    pub currency: String,
    pub amount: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
}
impl Balance {
    pub fn new(currency: impl Into<String>, amount: f64) -> Self {
        Self { currency: currency.into(), amount, expires_at: None }
    }
    pub fn with_expiry(currency: impl Into<String>, amount: f64, expires_at: Option<String>) -> Self {
        Self { currency: currency.into(), amount, expires_at }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct HourlyUsage {
    pub timestamp: i64,
    pub model_id: String,
    pub calls: u64,
    pub credit_consumed: f64,
}
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hourly_usages: Option<Vec<HourlyUsage>>,
    /// Sideband live output rate from local CLI transcript tails (Claude message.usage /
    /// Codex token_count), tok/min rounded to an integer; None = 渠道日志无 usage 字段或
    /// 速率不足 1（前端显示「—」）。与活动灯无关的旁路值：不参与点灯，也不落盘
    /// （usage-cache 写出时清除，避免跨启动展示早已失效的速率）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tok_per_min: Option<f64>,
    #[serde(default)] pub web_auth_required: bool,
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
    /// None: automatic; custom elapsed-ring duration in days (not provider quota data).
    pub elapsed_period_days: Option<f64>,
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

/// 订阅记录（Round4 项目三）：按来源手动登记订阅价，用于「本月用量成本 ≈ 订阅价几倍」。
/// 跟随 AppSettings 走既有设置持久化通道；价格为本地估算口径（公开定价），仅供参考。
/// 来源键为本地审计的来源标识（如 claude/codex/zcode），API 额度类供应商不出现在前端入口。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct SubscriptionRecord {
    pub price: f64,
    pub currency: String,
    pub cycle_days: u32,
    /// YYYY-MM-DD 或留空（未设置）。
    pub start_date: String,
    pub note: String,
}
impl Default for SubscriptionRecord {
    fn default()->Self { Self { price:0.0, currency:"USD".into(), cycle_days:30, start_date:String::new(), note:String::new() } }
}
impl SubscriptionRecord {
    pub fn validate(&self)->Result<(),String> {
        if !self.price.is_finite() || !(0.0..=1_000_000.0).contains(&self.price) { return Err("订阅价需为 0~100 万的有限数值".into()); }
        if self.currency.len()!=3 || !self.currency.bytes().all(|b|b.is_ascii_uppercase()) { return Err("订阅币种需为三位大写代码（如 USD/CNY）".into()); }
        if !(1..=366).contains(&self.cycle_days) { return Err("订阅周期需为 1~366 天".into()); }
        if !self.start_date.is_empty() && chrono::NaiveDate::parse_from_str(&self.start_date,"%Y-%m-%d").is_err() { return Err("订阅开始日期需为 YYYY-MM-DD 或留空".into()); }
        if self.note.chars().count()>500 { return Err("订阅备注过长（≤500 字）".into()); }
        Ok(())
    }
}

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
    /// 订阅记录（Round4 项目三）：来源标识 → 订阅价/币种/周期/开始日/备注。
    pub subscriptions: BTreeMap<String, SubscriptionRecord>,
    /// 自定义扫描路径（Round5A 项目四）：来源标识 → 附加扫描目录（绝对路径，每来源上限 20）。
    /// 诚实口径：与默认扫描根只按文件路径去重——同一文件复制进多个目录（或目录嵌套在默认根内）
    /// 会以不同路径重复计数（README 与设置说明披露）。
    pub token_spend_extra_paths: BTreeMap<String, Vec<String>>,
    /// 成本显示币种（Round4 项目二）：仅 "USD" | "CNY"；换算只发生在前端展示层，
    /// 成本估算入库与导出始终保持 USD 原值。
    pub display_currency: String,
    /// USD→CNY 固定汇率（Round4 项目二）：纯本地设置，默认 7.2，可手改，不联网取汇；
    /// 前端所有经此折算的数字必须就近标注「按固定汇率 X.XX 估算」。
    pub usd_cny_rate: f64,
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
            notifications:NotificationSettings::default(), hotkeys:HotkeySettings::default(),
            subscriptions:BTreeMap::new(),
            token_spend_extra_paths:BTreeMap::new(),
            display_currency:"USD".into(), usd_cny_rate:7.2,
            providers }
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
            || !["USD","CNY"].contains(&self.display_currency.as_str())
            || !self.usd_cny_rate.is_finite() || !(0.01..=10000.0).contains(&self.usd_cny_rate)
            || self.subscriptions.len()>64 || self.providers.len()>64 { return Err("设置版本或参数无效".into()); }
        for (src,sub) in &self.subscriptions {
            if !valid_id(src) { return Err(format!("订阅来源标识无效: {src}")); }
            sub.validate().map_err(|e|format!("订阅记录 {src} 无效：{e}"))?;
        }
        validate_token_spend_extra_paths(&self.token_spend_extra_paths)?;
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
            if cfg.elapsed_period_days.is_some_and(|d|!d.is_finite()||d<1.0/24.0||d>366.0) {return Err("自定义周期应为 1 小时至 366 天".into());}
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

#[cfg(test)]
mod tests{
    use super::*;
    #[test]fn subscription_record_validation(){
        let ok=SubscriptionRecord{price:20.0,currency:"CNY".into(),cycle_days:30,start_date:"2026-09-01".into(),note:"月付".into()};
        assert!(ok.validate().is_ok());
        let mut s=ok.clone();s.price=-0.01;assert!(s.validate().is_err());
        s.price=f64::NAN;assert!(s.validate().is_err(),"非有限数值拒绝");
        s.price=1_000_001.0;assert!(s.validate().is_err());
        let mut s=ok.clone();s.currency="usd".into();assert!(s.validate().is_err(),"币种需三位大写");
        let mut s=ok.clone();s.cycle_days=0;assert!(s.validate().is_err());
        s.cycle_days=367;assert!(s.validate().is_err());
        let mut s=ok.clone();s.start_date="2026/09/01".into();assert!(s.validate().is_err());
        let mut s=ok.clone();s.start_date=String::new();assert!(s.validate().is_ok(),"开始日期可留空");
        let mut s=ok.clone();s.note="x".repeat(501);assert!(s.validate().is_err());
    }
    #[test]fn app_settings_validate_guards_subscriptions(){
        let mut s=AppSettings::default();
        s.subscriptions.insert("claude".into(),SubscriptionRecord{price:20.0,currency:"USD".into(),cycle_days:30,start_date:String::new(),note:String::new()});
        s.subscriptions.insert("zcode".into(),SubscriptionRecord::default());
        assert!(s.validate().is_ok());
        s.subscriptions.insert("bad source!".into(),SubscriptionRecord::default());
        assert!(s.validate().is_err(),"来源键走 valid_id 白名单字符");
        s.subscriptions.remove("bad source!");
        s.subscriptions.insert("codex".into(),SubscriptionRecord{cycle_days:0,..SubscriptionRecord::default()});
        assert!(s.validate().is_err());
    }
    #[test]fn settings_without_subscriptions_field_loads_with_defaults(){
        // 旧 settings.json 没有 subscriptions 字段：serde default 兜底，加载不失败。
        let mut root=serde_json::to_value(AppSettings::default()).unwrap();
        root.as_object_mut().unwrap().remove("subscriptions");
        let s:AppSettings=serde_json::from_value(root).unwrap();
        assert!(s.subscriptions.is_empty());
    }
    #[test]fn token_spend_extra_paths_validate(){
        // 合法：绝对路径、每来源 ≤20 条。
        let mut s=AppSettings::default();
        s.token_spend_extra_paths.insert("claude".into(),vec!["D:\\logs\\custom".into()]);
        assert!(s.validate().is_ok());
        // 相对路径与空串拒绝。
        s.token_spend_extra_paths.insert("claude".into(),vec!["relative/dir".into()]);
        assert!(s.validate().is_err(),"扫描路径必须绝对");
        s.token_spend_extra_paths.insert("claude".into(),vec![String::new()]);
        assert!(s.validate().is_err());
        // 来源键走 valid_id。
        s.token_spend_extra_paths.insert("claude".into(),vec!["D:\\logs".into()]);
        s.token_spend_extra_paths.insert("bad source!".into(),vec!["D:\\logs".into()]);
        assert!(s.validate().is_err());
        s.token_spend_extra_paths.remove("bad source!");
        // 每来源上限 20。
        s.token_spend_extra_paths.insert("claude".into(),(0..21).map(|i|format!("D:\\logs\\d{i}")).collect());
        assert!(s.validate().is_err(),"超过 20 条拒绝");
        s.token_spend_extra_paths.insert("claude".into(),(0..20).map(|i|format!("D:\\logs\\d{i}")).collect());
        assert!(s.validate().is_ok());
    }
    #[test]fn settings_without_extra_paths_field_loads_with_defaults(){
        // 旧 settings.json 没有 token_spend_extra_paths 字段：serde default 兜底。
        let mut root=serde_json::to_value(AppSettings::default()).unwrap();
        root.as_object_mut().unwrap().remove("token_spend_extra_paths");
        let s:AppSettings=serde_json::from_value(root).unwrap();
        assert!(s.token_spend_extra_paths.is_empty());
    }
    #[test]fn display_currency_and_rate_validate(){
        let mut s=AppSettings::default();
        assert!(s.validate().is_ok());
        assert_eq!(s.display_currency,"USD");
        assert!((s.usd_cny_rate-7.2).abs()<1e-9);
        s.display_currency="CNY".into();assert!(s.validate().is_ok());
        s.display_currency="JPY".into();assert!(s.validate().is_err(),"仅支持 USD/CNY");
        s.display_currency="cny".into();assert!(s.validate().is_err(),"币种代码区分大小写");
        s.display_currency="CNY".into();s.usd_cny_rate=0.0;assert!(s.validate().is_err());
        s.usd_cny_rate=-7.2;assert!(s.validate().is_err());
        s.usd_cny_rate=f64::NAN;assert!(s.validate().is_err(),"非有限汇率拒绝");
        s.usd_cny_rate=10001.0;assert!(s.validate().is_err());
        s.usd_cny_rate=0.01;assert!(s.validate().is_ok());
        s.usd_cny_rate=10000.0;assert!(s.validate().is_ok());
    }
    #[test]fn settings_without_currency_fields_load_with_defaults(){
        // 旧 settings.json 没有 display_currency/usd_cny_rate：serde default 兜底，加载不失败。
        let mut root=serde_json::to_value(AppSettings::default()).unwrap();
        let obj=root.as_object_mut().unwrap();
        obj.remove("display_currency");obj.remove("usd_cny_rate");
        let s:AppSettings=serde_json::from_value(root).unwrap();
        assert_eq!(s.display_currency,"USD");
        assert!((s.usd_cny_rate-7.2).abs()<1e-9);
    }
    #[test]fn settings_reject_unknown_top_level_field(){
        // deny_unknown_fields：前端不得私自上发未登记字段。
        let mut root=serde_json::to_value(AppSettings::default()).unwrap();
        root.as_object_mut().unwrap().insert("display_rate".into(),serde_json::json!(7.2));
        assert!(serde_json::from_value::<AppSettings>(root).is_err());
    }
    #[test]fn provider_usage_rate_field_is_optional_on_wire(){
        // tok_per_min 缺省/None 不上链路（skip_serializing_if），老缓存文件可正常反序列化。
        let u=ProviderUsage::default();
        assert!(u.tok_per_min.is_none());
        assert!(!serde_json::to_string(&u).unwrap().contains("tok_per_min"));
        let mut u2=u.clone();u2.tok_per_min=Some(42.0);
        let back:ProviderUsage=serde_json::from_str(&serde_json::to_string(&u2).unwrap()).unwrap();
        assert_eq!(back.tok_per_min,Some(42.0));
        // 老 usage-cache.json 没有该字段 → 反序列化为 None（显示 —），不报错。
        let mut v=serde_json::to_value(&u2).unwrap();
        v.as_object_mut().unwrap().remove("tok_per_min");
        let back2:ProviderUsage=serde_json::from_value(v).unwrap();
        assert_eq!(back2.tok_per_min,None);
    }
}
