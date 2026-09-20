export interface UsageWindow {
  id: string; name: string; used_fraction: number; used_percent: number;
  resets_at: string | null; window_seconds: number | null; exhausted: boolean;
}
export interface ProviderUsage {
  account_id: string; provider_id: string; display_name: string;
  state: "live" | "stale" | "loading" | "unavailable" | "error";
  primary_percent: number | null; plan_name: string | null; is_active: boolean;
  windows: UsageWindow[]; balances: {currency: string; amount: number}[];
  error_code: string | null; error_message: string | null; source: string;
  checked_at: string | null; last_success_at: string | null; retry_after_seconds: number | null;
  duration_ms: number | null;
}
export interface ProviderConfig {
  provider_id: string; label: string; enabled: boolean; order: number; use_local: boolean;
  credential_configured: boolean; primary_window: string | null;
  /** Window the outer elapsed-time ring tracks; null = soonest reset. */
  elapsed_window: string | null;
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
export interface MonitorOption { name: string; label: string }
export interface NetworkProxySettings {
  mode: "auto" | "manual_http" | "manual_socks5";
  host: string;
  port: number;
}
export interface AppSettings {
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
  notifications: NotificationSettings; hotkeys: HotkeySettings;
  providers: Record<string, ProviderConfig>;
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

