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
}
export interface ProviderConfig {
  provider_id: string; label: string; enabled: boolean; order: number; use_local: boolean;
  credential_configured: boolean; primary_window: string | null;
}
export interface AppSettings {
  schema_version: number; dock_side: "right" | "left" | "top" | "free";
  auto_collapse_seconds: number; theme: "obsidian" | "translucent";
  refresh_interval_seconds: number; display_mode: "used" | "remaining";
  forecast: boolean; show_elapsed: boolean; follow_active_display: boolean; hide_fullscreen: boolean;
  monitor_name: string | null; free_x: number; free_y: number;
  providers: Record<string, ProviderConfig>;
}
