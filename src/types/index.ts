export interface UsageWindow {
  id: string; name: string; used_fraction: number; used_percent: number;
  resets_at: string | null; window_seconds: number | null; exhausted: boolean;
}
export interface Balance {
  currency: string;
  amount: number;
  expires_at?: string | null;
}
export interface HourlyUsage {
  timestamp: number;
  model_id: string;
  calls: number;
  credit_consumed: number;
}
export interface ProviderUsage {
  account_id: string; provider_id: string; display_name: string;
  state: "live" | "stale" | "loading" | "unavailable" | "error";
  primary_percent: number | null; plan_name: string | null; is_active: boolean;
  windows: UsageWindow[]; balances: Balance[];
  error_code: string | null; error_message: string | null; source: string;
  checked_at: string | null; last_success_at: string | null; retry_after_seconds: number | null;
  duration_ms: number | null;
  /** Round4 项目一：旁路实时输出速率（tok/min，后端已取整并把 <1 收敛为 None）。
   *  null/缺省 = 渠道日志无 usage 字段或速率不足 1，前端显示「—」，不编造。 */
  tok_per_min?: number | null;
  hourly_usages?: HourlyUsage[];
}
export interface ProviderConfig {
  provider_id: string; label: string; enabled: boolean; order: number; use_local: boolean;
  credential_configured: boolean; primary_window: string | null;
  /** Window the outer elapsed-time ring tracks; null = soonest reset. */
  elapsed_window: string | null;
  elapsed_period_days?: number | null;
  /** #rrggbb override for the ring colour; null = pressure colour. */
  ring_color: string | null;
  /** Low-balance notice line, compared only against `low_balance_currency`. */
  low_balance: number | null; low_balance_currency: string | null;
  /** "icon" (default) or "bot" — animated mark instead of the provider badge. */
  mark_mode: string | null;
  bot_persona: string | null; bot_shape: string | null; bot_color: string | null;
  /** Optional second quota drawn as an inner ring; null = single ring. */
  secondary_window: string | null;
  /** Antigravity only: split Gemini / Claude-GPT into separate rail slots. */
  split_model_groups: boolean;
}
export interface NotificationSettings { threshold: number | null; on_spent: boolean; on_reset: boolean; on_failure: boolean }
export interface HotkeySettings { open_settings: string | null; toggle_rail: string | null }
/** 订阅记录（Round4 项目三）：按来源手动登记订阅价，字段与后端 SubscriptionRecord 对齐（snake_case 上链路）。 */
export interface SubscriptionRecord {
  price: number;
  /** 三位大写币种代码（如 USD/CNY）。 */
  currency: string;
  /** 订阅周期天数（1~366）。 */
  cycle_days: number;
  /** YYYY-MM-DD 或空串（未设置）。 */
  start_date: string;
  note: string;
}
export interface MonitorOption { name: string; label: string }
export interface NetworkProxySettings {
  mode: "auto" | "manual_http" | "manual_socks5";
  host: string;
  port: number;
}
export interface AppSettings {
  rail_warnings?: RailWarnings;
  schema_version: number; generation?: number; dock_side: "right" | "left" | "top" | "free";
  auto_collapse_seconds: number; theme: "obsidian" | "translucent";
  refresh_interval_seconds: number; display_mode: "used" | "remaining";
  forecast: boolean; show_elapsed: boolean; follow_active_display: boolean; hide_fullscreen: boolean;
  monitor_name: string | null; free_x: number; free_y: number;
  warning_threshold: number; show_rail: boolean; reduce_motion: boolean; start_behavior: string;
  monitoring_setup_completed: boolean; token_spend_enabled: boolean;
  authorized_providers: string[]; network_proxy: NetworkProxySettings;
  collapsed_bar_color_mode?: "auto" | "rainbow" | "custom";
  collapsed_bar_color?: string | null;
  /** Round4 项目二：成本显示币种与 USD→CNY 固定汇率（纯本地设置，不联网取汇）。换算只发生在展示层，估算与导出保持 USD 原值。 */
  display_currency?: "USD" | "CNY";
  usd_cny_rate?: number;
  /** Round4 项目三：订阅记录（来源标识 → 价格/币种/周期/开始日/备注），走既有设置持久化。 */
  subscriptions?: Record<string, SubscriptionRecord>;
  notifications: NotificationSettings; hotkeys: HotkeySettings;
  providers: Record<string, ProviderConfig>;
}

export interface RailAccountRule {
  mode: 'primary' | 'all' | 'window';
  window_id: string | null;
  balances: Record<string, {yellow:number;red:number}>;
}
export interface RailWarnings {
  scope:'all'|'selected'; account_ids:string[]; custom_thresholds:boolean;
  yellow:number; red:number; accounts:Record<string,RailAccountRule>;
}

/** 一次全量刷新的结果（A07）：读数快照 + 实际发起/被冷却跳过的账号数。 */
export interface RefreshSummary { readings: ProviderUsage[]; initiated: number; skipped: number; }

export interface ProxyDetection {
  mode: string;
  detected_type: string;
  address: string | null;
  detail: string;
}

export interface NetworkTestResult {
  ok: boolean;
  target: string;
  status: number | null;
  duration_ms: number;
  error: string | null;
}

export interface NotificationSendResult {
  success: boolean;
  stage: string;
  setting: string;
  test_id: string;
  error: string | null;
  hint: string | null;
}

export interface NotificationFullStatus {
  identity_status: "registered" | "moved" | "missing_shortcut" | "missing_aumid" | "unregistered";
  shortcut_path: string | null;
  shortcut_target: string | null;
  current_exe: string;
  windows_toasts_enabled: boolean | null;
  app_notification_setting: "enabled" | "disabled_for_app" | "disabled_for_user" | "disabled_by_policy" | "disabled_by_manifest" | "unknown";
  is_portable: boolean;
  plugin_permission: string;
  last_error: string | null;
}
