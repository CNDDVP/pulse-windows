export interface UsageWindow {
  id: string;
  name: string;
  used_fraction: number;
  used_percent: number;
  resets_at?: string;
  resets_in?: string;
}

export interface ProviderUsage {
  provider_id: string;
  display_name: string;
  icon: string;
  state: "live" | "loading" | "unavailable" | "error";
  primary_percent: number;
  plan_name?: string;
  is_active: boolean;
  windows: UsageWindow[];
  error_message?: string;
}

export interface ProviderConfig {
  enabled: boolean;
  order: number;
  api_key?: string;
  custom_endpoint?: string;
}

export interface AppSettings {
  dock_side: "right" | "left";
  auto_collapse_seconds: number;
  theme: "obsidian" | "translucent";
  refresh_interval_seconds: number;
  providers: Record<string, ProviderConfig>;
}
