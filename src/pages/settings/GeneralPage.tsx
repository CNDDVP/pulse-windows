import {RailWarningSettings} from "./RailWarningSettings";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppSettings, MonitorOption, ProviderUsage, ProxyDetection, NetworkTestResult } from "../../types";
import { normalizeLang, useLang } from "../../lib/i18n";
import { Section, Row, Field, Switch } from "./shared";
import { selectCls, btnGhost, timeText, PROVIDERS, providerName } from "./constants";

export function GeneralPage({ settings, update, screens, usages, busy, onRefreshAll, toast }: {
  settings: AppSettings; update: (patch: Partial<AppSettings>) => void; screens: MonitorOption[];
  usages: ProviderUsage[]; busy: boolean; onRefreshAll: () => Promise<void>;
  toast: (type: "success" | "info" | "error", text: string) => void;
}) {
  const { t } = useLang();
  const [startup, setStartup] = useState<boolean | null>(null);
  const [isPortable, setIsPortable] = useState(false);
  const [proxyInfo, setProxyInfo] = useState<ProxyDetection | null>(null);
  const [testingProxy, setTestingProxy] = useState(false);
  const [testResult, setTestResult] = useState<NetworkTestResult | null>(null);

  const fetchProxyInfo = () => {
    void invoke<ProxyDetection>("detect_network_proxy").then(setProxyInfo).catch(() => setProxyInfo(null));
  };
  useEffect(() => { fetchProxyInfo(); }, [settings.network_proxy]);

  const handleTestProxy = async () => {
    setTestingProxy(true);
    setTestResult(null);
    try {
      const res = await invoke<NetworkTestResult>("test_network_connection", { target: null });
      setTestResult(res);
      if (res.ok) {
        toast("success", t("settings.general.conn_ok", { ms: res.duration_ms }));
      } else {
        toast("error", t("settings.general.conn_test_fail", { err: res.error || t("settings.general.unknown_error") }));
      }
    } catch (e) {
      toast("error", t("settings.general.test_fail", { err: String(e) }));
    } finally {
      setTestingProxy(false);
    }
  };

  useEffect(() => { void invoke<boolean>("startup_enabled").then(setStartup).catch(() => setStartup(null)); }, []);
  useEffect(() => { void invoke<boolean>("is_portable").then(setIsPortable).catch(() => {}); }, []);
  const lastSuccess = usages.map(u => u.last_success_at).filter((s): s is string => !!s).sort().at(-1) ?? null;

  return (
    <div className="space-y-5 max-w-2xl">
      <Section title={t("settings.general.rail_section")} icon="🖥️" subtitle={t("settings.general.rail_section_sub")}>
        <Row title={t("settings.general.show_rail")} subtitle={t("settings.general.show_rail_sub")}>
          <Switch checked={settings.show_rail} onChange={v => update({ show_rail: v })} label={t("settings.general.show_rail")} />
        </Row>
        <Row title={t("settings.general.follow_display")} subtitle={t("settings.general.follow_display_sub")}>
          <Switch checked={settings.follow_active_display} onChange={v => update({ follow_active_display: v, ...(v ? { monitor_name: null } : {}) })} label={t("settings.general.follow_display")} />
        </Row>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label={t("settings.general.fixed_monitor")} hint={settings.follow_active_display ? t("settings.general.fixed_monitor_following") : undefined}>
            <select className={selectCls} disabled={settings.follow_active_display} value={settings.monitor_name || ""} onChange={e => update({ monitor_name: e.target.value || null })}>
              <option value="">{t("settings.general.monitor_auto")}</option>
              {screens.map(m => <option key={m.name} value={m.name}>{m.label}</option>)}
              {settings.monitor_name && !screens.some(m => m.name === settings.monitor_name) && <option value={settings.monitor_name}>{t("settings.general.monitor_offline", { name: settings.monitor_name })}</option>}
            </select>
          </Field>
          <Field label={t("settings.general.dock_side")}>
            <select className={selectCls} value={settings.dock_side} onChange={e => update({ dock_side: e.target.value as AppSettings["dock_side"] })}>
              <option value="right">{t("settings.general.dock_right")}</option><option value="left">{t("settings.general.dock_left")}</option><option value="top">{t("settings.general.dock_top")}</option><option value="free">{t("settings.general.dock_free")}</option>
            </select>
          </Field>
        </div>
        {settings.dock_side === "free" && (
          <div className="pt-2 border-t border-[var(--border)] grid grid-cols-2 gap-4">
            {(["free_x", "free_y"] as const).map(k => (
              <label key={k} className="block space-y-1">
                <div className="flex justify-between text-xs text-[var(--text-2)]"><span>{t(k === "free_x" ? "settings.general.pos_x" : "settings.general.pos_y")}</span><span className="font-mono">{Math.round(settings[k] * 100)}%</span></div>
                <input type="range" min={0} max={1} step={0.01} value={settings[k]} aria-label={t(k === "free_x" ? "settings.general.pos_x" : "settings.general.pos_y")} onChange={e => update({ [k]: Number(e.target.value) } as Partial<AppSettings>)} className="w-full accent-[var(--accent)]" />
              </label>
            ))}
          </div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2 border-t border-[var(--border)]">
          <Field label={t("settings.general.auto_collapse")} hint={settings.dock_side === "free" ? t("settings.general.auto_collapse_free") : t("settings.general.auto_collapse_hint")}>
            <select disabled={settings.dock_side === "free"} className={selectCls} value={settings.auto_collapse_seconds} onChange={e => update({ auto_collapse_seconds: Number(e.target.value) })}>
              <option value={0}>{t("settings.general.collapse_off")}</option><option value={1}>{t("settings.general.collapse_1s")}</option><option value={2}>{t("settings.general.collapse_2s")}</option><option value={3}>{t("settings.general.collapse_3s")}</option><option value={5}>{t("settings.general.collapse_5s")}</option><option value={10}>{t("settings.general.collapse_10s")}</option>
            </select>
          </Field>
          <Row title={t("settings.general.hide_fullscreen")} subtitle={t("settings.general.hide_fullscreen_sub")}>
            <Switch checked={settings.hide_fullscreen} onChange={v => update({ hide_fullscreen: v })} label={t("settings.general.hide_fullscreen")} />
          </Row>
        </div>
      </Section>

      <RailWarningSettings settings={settings} usages={usages} update={update} busy={busy} onRefreshAll={onRefreshAll}/>

      <Section title={t("settings.general.appearance_section")} icon="🎨">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Round5d 项目一：主题（深色/浅色）走既有设置通道（settings.theme 持久化，
              后端枚举 "obsidian" | "translucent" 不变）；保存后经 settings-updated 回流，
              App 把值同步到 documentElement data-theme，index.css 语义令牌随之切换——
              悬浮栏/详情卡/设置窗全部即时生效。托盘菜单为系统原生 UI，跟随系统主题。 */}
          <Field label={t("settings.general.theme")} hint={t("settings.general.theme_hint")}>
            <select className={selectCls} value={settings.theme} aria-label={t("settings.general.theme")} onChange={e => update({ theme: e.target.value as AppSettings["theme"] })}>
              <option value="obsidian">{t("settings.general.theme_obsidian")}</option><option value="translucent">{t("settings.general.theme_translucent")}</option>
            </select>
          </Field>
          {/* Round5c 项目一：界面语言（默认 zh）。走既有设置通道持久化（update_settings）；
              选项名固定用各自语言的本地写法，不随界面语言翻译。切换经 settings-updated
              事件回流到各窗口的 I18nProvider，立即生效。 */}
          <Field label={t("settings.general.language")}>
            <select
              className={selectCls}
              value={normalizeLang(settings.language)}
              aria-label={t("settings.general.language")}
              onChange={e => update({ language: normalizeLang(e.target.value) })}
            >
              <option value="zh">简体中文</option>
              <option value="en">English</option>
            </select>
          </Field>
          <Field label={t("settings.general.percent_meaning")}>
            <select className={selectCls} value={settings.display_mode} onChange={e => update({ display_mode: e.target.value as AppSettings["display_mode"] })}>
              <option value="used">{t("settings.general.percent_used")}</option><option value="remaining">{t("settings.general.percent_remaining")}</option>
            </select>
          </Field>
          <Field label={t("settings.general.red_threshold")} hint={t("settings.general.red_threshold_hint")}>
            <select className={selectCls} value={settings.warning_threshold} onChange={e => update({ warning_threshold: Number(e.target.value) })}>
              {[60, 70, 75, 80, 85, 90, 95].map(v => <option key={v} value={v}>{t("settings.general.red_at", { v })}</option>)}
            </select>
          </Field>
        </div>
        <div className="pt-2 border-t border-[var(--border)] space-y-3">
          <Row title={t("settings.general.show_elapsed")} subtitle={t("settings.general.show_elapsed_sub")}>
            <Switch checked={settings.show_elapsed} onChange={v => update({ show_elapsed: v })} label={t("settings.general.show_elapsed")} />
          </Row>
          <Row title={t("settings.general.forecast")} subtitle={t("settings.general.forecast_sub")}>
            <Switch checked={settings.forecast} onChange={v => update({ forecast: v })} label={t("settings.general.forecast")} />
          </Row>
          <Row title={t("settings.general.reduce_motion")} subtitle={t("settings.general.reduce_motion_sub")}>
            <Switch checked={settings.reduce_motion} onChange={v => update({ reduce_motion: v })} label={t("settings.general.reduce_motion")} />
          </Row>
        </div>
      </Section>

      <Section title={t("settings.general.cost_section")} icon="💱" subtitle={t("settings.general.cost_section_sub")}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label={t("settings.general.cost_currency")}>
            <select className={selectCls} value={settings.display_currency ?? "USD"} onChange={e => update({ display_currency: e.target.value === "CNY" ? "CNY" : "USD" })}>
              <option value="USD">{t("settings.general.currency_usd")}</option>
              <option value="CNY">{t("settings.general.currency_cny")}</option>
            </select>
          </Field>
          <Field
            label={t("settings.general.rate_label")}
            hint={(settings.display_currency ?? "USD") === "CNY" ? t("settings.general.rate_hint_cny") : t("settings.general.rate_hint_usd")}
          >
            <input
              type="number" min={0.01} max={10000} step={0.01}
              className={selectCls}
              disabled={(settings.display_currency ?? "USD") !== "CNY"}
              aria-label={t("settings.general.rate_aria")}
              value={settings.usd_cny_rate ?? 7.2}
              onChange={e => {
                // 钳制在后端校验界（0.01~10000）内，避免保存被整表拒绝。
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v > 0) update({ usd_cny_rate: Math.min(10000, Math.max(0.01, v)) });
              }}
            />
          </Field>
        </div>
        <p className="text-[11px] text-[var(--text-3)]">{t("settings.general.cost_note")}</p>
      </Section>

      <Section title={t("settings.general.refresh_section")} icon="⚡" aside={<button className={btnGhost} disabled={busy} onClick={() => void onRefreshAll().catch(e => toast("error", t("settings.general.refresh_fail", { err: String(e) })))}>{t("settings.general.refresh_now")}</button>}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label={t("settings.general.refresh_interval")} hint={t("settings.general.refresh_interval_hint")}>
            <select className={selectCls} value={settings.refresh_interval_seconds} onChange={e => update({ refresh_interval_seconds: Number(e.target.value) })}>
              {[[30, "settings.general.interval_30s"], [60, "settings.general.interval_1m"], [120, "settings.general.interval_2m"], [300, "settings.general.interval_5m"], [600, "settings.general.interval_10m"], [900, "settings.general.interval_15m"], [1800, "settings.general.interval_30m"]].map(([v, k]) => <option key={v} value={v}>{t(k as string)}</option>)}
              {![30, 60, 120, 300, 600, 900, 1800].includes(settings.refresh_interval_seconds) && <option value={settings.refresh_interval_seconds}>{t("settings.general.interval_secs", { n: settings.refresh_interval_seconds })}</option>}
            </select>
          </Field>
          <Field label={t("settings.general.last_refresh")}>
            <div className={`${selectCls} font-mono`}>{lastSuccess ? timeText(lastSuccess) : t("settings.general.no_refresh_yet")}</div>
          </Field>
        </div>
      </Section>

      <Section title={t("settings.general.privacy_section")} icon="🛡️" subtitle={t("settings.general.privacy_section_sub")}>
        <Row title={t("settings.general.token_spend")} subtitle={t("settings.general.token_spend_sub")}>
          <Switch checked={settings.token_spend_enabled} onChange={v => update({ token_spend_enabled: v })} label={t("settings.general.token_spend")} />
        </Row>
        <Row title={t("settings.general.wsl_usage")} subtitle={t("settings.general.wsl_usage_sub")}>
          <Switch checked={settings.token_spend_wsl ?? false} disabled={!settings.token_spend_enabled} onChange={v => update({ token_spend_wsl: v })} label={t("settings.general.wsl_usage_short")} />
        </Row>
        {/* Round5d 项目二：Discord 状态广播（opt-in 默认关）。说明文案披露通信范围与
            隐私边界（只广播聚合数字，不含账号名/供应商明细）；连接失败静默。 */}
        <Row title={t("settings.general.discord_presence")} subtitle={t("settings.general.discord_presence_sub")}>
          <Switch checked={settings.discord_presence_enabled ?? false} onChange={v => update({ discord_presence_enabled: v })} label={t("settings.general.discord_presence")} />
        </Row>
        <div className="pt-2 border-t border-[var(--border)] space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-xs text-[var(--text-1)] font-medium">{t("settings.general.authorized_count", { n: settings.authorized_providers?.length || 0, total: PROVIDERS.length })}</div>
            <div className="flex items-center gap-2">
              <button
                className="text-[11px] text-[var(--ok)] hover:text-[var(--accent-strong)] cursor-pointer"
                onClick={() => update({ authorized_providers: PROVIDERS.map(p => p[0]) })}
              >
                {t("settings.general.select_all")}
              </button>
              <span className="text-[var(--text-3)]">·</span>
              <button
                className="text-[11px] text-[var(--ok)] hover:text-[var(--accent-strong)] cursor-pointer"
                onClick={() => update({ authorized_providers: ["claude", "codex", "antigravity", "kimi"] })}
              >
                {t("settings.general.select_common")}
              </button>
              <span className="text-[var(--text-3)]">·</span>
              <button
                className="text-[11px] text-[var(--text-2)] hover:text-[var(--text-1)] cursor-pointer"
                onClick={() => update({ authorized_providers: [] })}
              >
                {t("settings.general.select_none")}
              </button>
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-48 overflow-y-auto p-1 bg-[var(--surface)] rounded-xl border border-[var(--border)]">
            {PROVIDERS.map(([pid]) => {
              const checked = settings.authorized_providers?.includes(pid) ?? false;
              return (
                <label key={pid} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--hover)] cursor-pointer text-xs text-[var(--text-1)]">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={e => {
                      const cur = new Set(settings.authorized_providers || []);
                      if (e.target.checked) cur.add(pid);
                      else cur.delete(pid);
                      update({ authorized_providers: Array.from(cur) });
                    }}
                    className="accent-[var(--accent)] rounded"
                  />
                  <span className="truncate">{providerName(pid, t)}</span>
                </label>
              );
            })}
          </div>
        </div>
      </Section>

      <Section title={t("settings.general.proxy_section")} icon="🌐" subtitle={t("settings.general.proxy_section_sub")}>
        <Row title={t("settings.general.proxy_mode")} subtitle={t("settings.general.proxy_mode_sub")}>
          <select
            className={selectCls}
            value={settings.network_proxy?.mode || "auto"}
            onChange={e => update({
              network_proxy: {
                ...(settings.network_proxy || { host: "127.0.0.1", port: 7890 }),
                mode: e.target.value as "auto" | "manual_http" | "manual_socks5"
              }
            })}
          >
            <option value="auto">{t("settings.general.proxy_auto")}</option>
            <option value="manual_http">{t("settings.general.proxy_http")}</option>
            <option value="manual_socks5">{t("settings.general.proxy_socks5")}</option>
          </select>
        </Row>
        {settings.network_proxy?.mode !== "auto" && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2 border-t border-[var(--border)]">
            <div className="sm:col-span-2">
              <Field label={t("settings.general.proxy_host")}>
                <input
                  type="text"
                  className={selectCls}
                  placeholder="127.0.0.1"
                  value={settings.network_proxy?.host || ""}
                  onChange={e => update({
                    network_proxy: {
                      ...(settings.network_proxy || { mode: "manual_http", port: 7890 }),
                      host: e.target.value.trim()
                    }
                  })}
                />
              </Field>
            </div>
            <div>
              <Field label={t("settings.general.proxy_port")}>
                <input
                  type="number"
                  min={1}
                  max={65535}
                  className={selectCls}
                  placeholder="7890"
                  value={settings.network_proxy?.port || 7890}
                  onChange={e => update({
                    network_proxy: {
                      ...(settings.network_proxy || { mode: "manual_http", host: "127.0.0.1" }),
                      port: Math.max(1, Math.min(65535, parseInt(e.target.value) || 7890))
                    }
                  })}
                />
              </Field>
            </div>
          </div>
        )}
        <div className="pt-2 border-t border-[var(--border)] space-y-2">
          <div className="flex items-center justify-between p-2.5 rounded-xl bg-[var(--surface)] border border-[var(--border)] text-xs">
            <div className="space-y-0.5">
              <span className="text-[var(--text-2)]">{t("settings.general.detect_result")}</span>
              {/* proxyInfo.detail 为 Rust 探测输出，原样展示。TODO(EN-backend) */}
              <span className="text-[var(--text-1)] font-mono font-medium ml-1">{proxyInfo?.detail || t("settings.general.detecting")}</span>
            </div>
            <div className="flex gap-2 shrink-0">
              <button className={btnGhost} onClick={fetchProxyInfo}>{t("settings.general.redetect")}</button>
              <button className={btnGhost} disabled={testingProxy} onClick={() => void handleTestProxy()}>
                {testingProxy ? t("settings.general.testing") : t("settings.general.test_conn")}
              </button>
            </div>
          </div>
          {testResult && (
            <div className={`p-2.5 rounded-xl border text-xs font-mono ${testResult.ok ? "bg-[var(--ok-soft)] border-[var(--ok-border)] text-[var(--ok)]" : "bg-[var(--danger-soft)] border-[var(--danger-border)] text-[var(--danger)]"}`}>
              {testResult.ok ? t("settings.general.test_ok_line", { ms: testResult.duration_ms, target: testResult.target }) : t("settings.general.test_fail_line", { err: testResult.error || t("settings.general.unknown_error") })}
            </div>
          )}
        </div>
      </Section>

      <Section title={t("settings.general.startup_section")} icon="🚀">
        <Row
          title={t("settings.general.startup_login")}
          subtitle={isPortable ? t("settings.general.startup_portable_sub") : startup === null ? t("settings.general.startup_unknown_sub") : t("settings.general.startup_registry_sub")}
          disabled={startup === null}
        >
          <Switch
            checked={!!startup}
            disabled={startup === null}
            label={t("settings.general.startup_login")}
            onChange={v => void invoke<boolean>("set_startup", { enable: v }).then(s => { setStartup(s); toast("success", s ? t("settings.general.startup_on") : t("settings.general.startup_off")); }).catch(e => toast("error", String(e)))}
          />
        </Row>
        <Field label={t("settings.general.after_start")}>
          <select className={selectCls} value={settings.start_behavior} onChange={e => update({ start_behavior: e.target.value })}>
            <option value="rail">{t("settings.general.start_rail")}</option><option value="settings">{t("settings.general.start_settings")}</option><option value="tray">{t("settings.general.start_tray")}</option>
          </select>
        </Field>
      </Section>
    </div>
  );
}
