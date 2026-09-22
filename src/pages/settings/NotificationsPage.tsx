import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppSettings, NotificationFullStatus, NotificationSendResult } from "../../types";
import { useLang } from "../../lib/i18n";
import { Section, Row, Switch } from "./shared";
import { selectCls, btnGhost, btnPrimary } from "./constants";

export function NotificationsPage({ settings, update, toast }: {
  settings: AppSettings; update: (patch: Partial<AppSettings>) => void;
  toast: (type: "success" | "info" | "error", text: string) => void;
}) {
  const { t } = useLang();
  const [status, setStatus] = useState<NotificationFullStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState(false);
  const [lastTest, setLastTest] = useState<NotificationSendResult | null>(null);
  const [userFeedback, setUserFeedback] = useState<"seen" | "not_seen" | null>(null);
  const [showTroubleshoot, setShowTroubleshoot] = useState(false);

  const loadStatus = async () => {
    try {
      setLoading(true);
      const res = await invoke<NotificationFullStatus>("get_notification_status");
      setStatus(res);
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadStatus();
  }, []);

  const handleRegister = async () => {
    try {
      setLoading(true);
      const res = await invoke<NotificationFullStatus>("register_notification_identity");
      setStatus(res);
      toast("success", t("settings.notif.registered"));
    } catch (e) {
      toast("error", t("settings.notif.register_fail", { err: String(e) }));
    } finally {
      setLoading(false);
    }
  };

  const handleUnregister = async () => {
    try {
      setLoading(true);
      const res = await invoke<NotificationFullStatus>("unregister_notification_identity");
      setStatus(res);
      toast("info", t("settings.notif.unregistered"));
    } catch (e) {
      toast("error", t("settings.notif.unregister_fail", { err: String(e) }));
    } finally {
      setLoading(false);
    }
  };

  const handleTest = async () => {
    if (testing) return;
    setTesting(true);
    setUserFeedback(null);
    setShowTroubleshoot(false);
    try {
      const res = await invoke<NotificationSendResult>("test_notification");
      setLastTest(res);
      if (res.success) {
        toast("success", t("settings.notif.test_submitted", { id: res.test_id }));
      } else {
        toast("error", t("settings.notif.test_fail", { err: res.error || t("settings.general.unknown_error") }));
      }
    } catch (e) {
      const failedRes: NotificationSendResult = {
        success: false,
        stage: "failed",
        setting: "unknown",
        test_id: "error",
        error: String(e),
        hint: null,
      };
      setLastTest(failedRes);
      toast("error", t("settings.notif.test_send_fail", { err: String(e) }));
    } finally {
      setTesting(false);
      void loadStatus();
    }
  };

  const handleCopyDiagnostics = () => {
    const lines = [
      t("settings.notif.copydiag.title"),
      t("settings.notif.copydiag.time", { v: new Date().toISOString() }),
      t("settings.notif.copydiag.identity", { v: status?.identity_status ?? t("settings.common.unknown") }),
      t("settings.notif.copydiag.shortcut_path", { v: status?.shortcut_path ?? t("settings.common.none") }),
      t("settings.notif.copydiag.shortcut_target", { v: status?.shortcut_target ?? t("settings.common.none") }),
      t("settings.notif.copydiag.exe_path", { v: status?.current_exe ?? t("settings.common.unknown") }),
      t("settings.notif.copydiag.portable", { v: status?.is_portable ? t("settings.common.yes") : t("settings.common.no") }),
      t("settings.notif.copydiag.global_toasts", { v: status?.windows_toasts_enabled === null ? t("settings.notif.copydiag.unconfigured_default_allow") : status?.windows_toasts_enabled ? t("settings.common.on") : t("settings.common.off") }),
      t("settings.notif.copydiag.app_setting", { v: status?.app_notification_setting ?? t("settings.common.unknown") }),
      t("settings.notif.copydiag.plugin_perm", { v: status?.plugin_permission ?? t("settings.common.unknown") }),
      t("settings.notif.copydiag.last_test", { v: lastTest ? `${lastTest.stage} (${lastTest.test_id})` : t("settings.notif.not_tested") }),
      t("settings.notif.copydiag.last_error", { v: lastTest?.error ?? t("settings.common.none") }),
    ];
    void navigator.clipboard.writeText(lines.join("\n"));
    toast("success", t("settings.notif.copydiag.copied"));
  };

  const n = settings.notifications;
  const isRegistered = status?.identity_status === "registered";
  const isMoved = status?.identity_status === "moved";
  const isGlobalBlocked = status?.windows_toasts_enabled === false;
  const isAppBlocked = status?.app_notification_setting === "disabled_for_app";

  return (
    <div className="space-y-5 max-w-2xl">
      <Section
        title={t("settings.notif.section_title")}
        icon="🔔"
        subtitle={t("settings.notif.section_sub")}
        aside={
          <div className="flex gap-2">
            <button
              className={btnGhost}
              disabled={loading || testing}
              onClick={() => void loadStatus()}
              title={t("settings.notif.refresh_title")}
            >
              ⟳ {t("settings.notif.refresh_status")}
            </button>
            <button
              className={btnPrimary}
              disabled={loading || testing}
              onClick={() => void handleTest()}
            >
              {testing ? t("settings.notif.submitting") : t("settings.notif.send_test")}
            </button>
          </div>
        }
      >
        {/* 4 项细粒度状态卡片 */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          {/* 1. 应用通知身份 */}
          <div className={`p-3 rounded-xl border text-xs space-y-1 ${
            isRegistered ? "bg-emerald-950/30 border-emerald-800/40 text-emerald-200" :
            isMoved ? "bg-amber-950/40 border-amber-800/50 text-amber-200" :
            "bg-red-950/40 border-red-800/50 text-red-200"
          }`}>
            <div className="flex items-center justify-between">
              <span className="font-semibold flex items-center gap-1.5">
                <span>{isRegistered ? "✓" : isMoved ? "⚠️" : "✕"}</span>
                <span>{t("settings.notif.identity_title")}</span>
              </span>
              <span className="text-[10px] px-1.5 py-0.5 rounded font-mono bg-black/30">
                {isRegistered ? t("settings.notif.id_registered") : isMoved ? t("settings.notif.id_moved") : t("settings.notif.id_unregistered")}
              </span>
            </div>
            <p className="text-[11px] text-zinc-400">
              {isRegistered ? t("settings.notif.id_ready") :
               isMoved ? t("settings.notif.id_stale_shortcut") :
               t("settings.notif.id_missing")}
            </p>
          </div>

          {/* 2. Windows 全局通知 */}
          <div className={`p-3 rounded-xl border text-xs space-y-1 ${
            isGlobalBlocked ? "bg-red-950/40 border-red-800/50 text-red-200" :
            status?.windows_toasts_enabled ? "bg-emerald-950/30 border-emerald-800/40 text-emerald-200" :
            "bg-zinc-900/60 border-zinc-700/50 text-zinc-300"
          }`}>
            <div className="flex items-center justify-between">
              <span className="font-semibold flex items-center gap-1.5">
                <span>{isGlobalBlocked ? "✕" : "✓"}</span>
                <span>{t("settings.notif.global_title")}</span>
              </span>
              <span className="text-[10px] px-1.5 py-0.5 rounded font-mono bg-black/30">
                {isGlobalBlocked ? t("settings.common.off") : status?.windows_toasts_enabled ? t("settings.notif.allowed") : t("settings.notif.unconfigured_default_on")}
              </span>
            </div>
            <p className="text-[11px] text-zinc-400">
              {isGlobalBlocked ? t("settings.notif.global_blocked") : t("settings.notif.global_ok")}
            </p>
          </div>

          {/* 3. Pulse 应用授权 */}
          <div className={`p-3 rounded-xl border text-xs space-y-1 ${
            isAppBlocked ? "bg-red-950/40 border-red-800/50 text-red-200" :
            status?.app_notification_setting === "enabled" ? "bg-emerald-950/30 border-emerald-800/40 text-emerald-200" :
            "bg-zinc-900/60 border-zinc-700/50 text-zinc-300"
          }`}>
            <div className="flex items-center justify-between">
              <span className="font-semibold flex items-center gap-1.5">
                <span>{isAppBlocked ? "✕" : "ℹ"}</span>
                <span>{t("settings.notif.app_title")}</span>
              </span>
              <span className="text-[10px] px-1.5 py-0.5 rounded font-mono bg-black/30">
                {status?.app_notification_setting === "enabled" ? t("settings.notif.allowed") :
                 isAppBlocked ? t("settings.notif.app_disabled") :
                 status?.app_notification_setting === "disabled_by_manifest" ? t("settings.notif.identity_unrecognized") : t("settings.common.unknown")}
              </span>
            </div>
            <p className="text-[11px] text-zinc-400">
              {isAppBlocked ? t("settings.notif.app_blocked_note") :
               status?.app_notification_setting === "enabled" ? t("settings.notif.app_allowed_note") :
               t("settings.notif.app_pending_note")}
            </p>
          </div>

          {/* 4. 最近测试交付 */}
          <div className={`p-3 rounded-xl border text-xs space-y-1 ${
            lastTest?.success ? "bg-emerald-950/30 border-emerald-800/40 text-emerald-200" :
            lastTest ? "bg-red-950/40 border-red-800/50 text-red-200" :
            "bg-zinc-900/60 border-zinc-700/50 text-zinc-300"
          }`}>
            <div className="flex items-center justify-between">
              <span className="font-semibold flex items-center gap-1.5">
                <span>{lastTest?.success ? "✓" : lastTest ? "✕" : "⏱"}</span>
                <span>{t("settings.notif.last_test_title")}</span>
              </span>
              <span className="text-[10px] px-1.5 py-0.5 rounded font-mono bg-black/30">
                {lastTest?.success ? t("settings.notif.test_delivered") : lastTest ? t("settings.notif.test_delivery_failed") : t("settings.notif.not_tested")}
              </span>
            </div>
            <p className="text-[11px] text-zinc-400">
              {lastTest?.success ? t("settings.notif.last_test_ok", { id: lastTest.test_id }) :
               lastTest?.error ? lastTest.error :
               t("settings.notif.last_test_hint")}
            </p>
          </div>
        </div>

        {/* 注册管理与快捷操作栏 */}
        <div className="p-3 bg-zinc-950/60 rounded-xl border border-white/5 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="space-y-0.5 min-w-0">
            <div className="font-medium text-zinc-200">
              {isRegistered ? t("settings.notif.linked_ok") : isMoved ? t("settings.notif.moved_title") : t("settings.notif.not_initialized")}
            </div>
            <p className="text-[11px] text-zinc-500 truncate">
              {isRegistered ? t("settings.notif.shortcut_line", { path: status?.shortcut_path || "Pulse.lnk" }) :
               isMoved ? t("settings.notif.moved_line", { old: status?.shortcut_target || t("settings.common.unknown"), neu: status?.current_exe || "" }) :
               t("settings.notif.init_note")}
            </p>
          </div>
          <div className="flex gap-2 shrink-0">
            {!isRegistered ? (
              <button
                disabled={loading}
                onClick={() => void handleRegister()}
                className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium cursor-pointer transition-colors shadow-sm"
              >
                {isMoved ? t("settings.notif.fix_path") : t("settings.notif.enable_toasts")}
              </button>
            ) : (
              <button
                disabled={loading}
                onClick={() => void handleUnregister()}
                className="px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-red-950/40 hover:text-red-300 text-zinc-400 border border-zinc-700/60 cursor-pointer transition-colors"
                title={t("settings.notif.remove_title")}
              >
                {t("settings.notif.remove_registration")}
              </button>
            )}
          </div>
        </div>

        {/* 测试反馈与排查引导卡片 */}
        {lastTest && (
          <div className={`p-4 rounded-xl border space-y-3 ${
            lastTest.success ? "bg-zinc-900/90 border-emerald-800/40" : "bg-red-950/40 border-red-800/60"
          }`}>
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1">
                <div className="text-xs font-semibold flex items-center gap-2">
                  <span>{lastTest.success ? "📢" : "❌"}</span>
                  <span className={lastTest.success ? "text-emerald-300" : "text-red-300"}>
                    {lastTest.success ? t("settings.notif.result_ok", { id: lastTest.test_id }) : t("settings.notif.result_fail")}
                  </span>
                </div>
                <p className="text-[11px] text-zinc-400 leading-relaxed">
                  {lastTest.success
                    ? t("settings.notif.result_ok_note")
                    : lastTest.error || t("settings.notif.result_fail_note")}
                </p>
                {/* lastTest.hint 来自 Rust 测试链路，原样展示。TODO(EN-backend) */}
                {lastTest.hint && (
                  <p className="text-[11px] text-amber-300/90 font-medium">
                    {lastTest.hint}
                  </p>
                )}
              </div>
            </div>

            {lastTest.success && (
              <div className="pt-2 border-t border-white/5 flex flex-wrap items-center justify-between gap-2">
                <span className="text-[11px] text-zinc-400">{t("settings.notif.saw_banner_q")}</span>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setUserFeedback("seen");
                      setShowTroubleshoot(false);
                      toast("success", t("settings.notif.feedback_seen_toast"));
                    }}
                    className={`px-3 py-1 rounded-lg text-xs font-medium cursor-pointer transition-colors ${
                      userFeedback === "seen"
                        ? "bg-emerald-600 text-white"
                        : "bg-zinc-800 hover:bg-emerald-900/50 hover:text-emerald-200 text-zinc-300 border border-zinc-700/60"
                    }`}
                  >
                    ✓ {t("settings.notif.saw_banner")}
                  </button>
                  <button
                    onClick={() => {
                      setUserFeedback("not_seen");
                      setShowTroubleshoot(true);
                    }}
                    className={`px-3 py-1 rounded-lg text-xs font-medium cursor-pointer transition-colors ${
                      userFeedback === "not_seen"
                        ? "bg-amber-700 text-white"
                        : "bg-zinc-800 hover:bg-amber-950/50 hover:text-amber-200 text-zinc-300 border border-zinc-700/60"
                    }`}
                  >
                    ✕ {t("settings.notif.not_seen")}
                  </button>
                </div>
              </div>
            )}

            {/* 展开的排查引导 */}
            {showTroubleshoot && (
              <div className="pt-3 border-t border-white/10 space-y-2.5 text-xs text-zinc-300 animate-in fade-in duration-150">
                <div className="font-semibold text-amber-300 flex items-center gap-1.5">
                  <span>🛠️</span>
                  <span>{t("settings.notif.troubleshoot_title")}</span>
                </div>
                <ol className="space-y-2 text-[11px] list-decimal list-inside text-zinc-400 pl-1 leading-relaxed">
                  <li>
                    <strong className="text-zinc-200">{t("settings.notif.step1_title")}</strong>
                    {t("settings.notif.step1_body_pre")} <kbd className="px-1.5 py-0.5 bg-zinc-800 border border-zinc-700 rounded text-zinc-300">Win</kbd> + <kbd className="px-1.5 py-0.5 bg-zinc-800 border border-zinc-700 rounded text-zinc-300">N</kbd>{t("settings.notif.step1_body_post")}
                  </li>
                  <li>
                    <strong className="text-zinc-200">{t("settings.notif.step2_title")}</strong>
                    {t("settings.notif.step2_body")}
                  </li>
                  <li>
                    <strong className="text-zinc-200">{t("settings.notif.step3_title")}</strong>
                    {t("settings.notif.step3_body")}
                  </li>
                  <li>
                    <strong className="text-zinc-200">{t("settings.notif.step4_title")}</strong>
                    {t("settings.notif.step4_body")}
                  </li>
                </ol>
                <div className="pt-2 flex justify-end gap-2">
                  <button
                    onClick={handleCopyDiagnostics}
                    className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[11px] cursor-pointer"
                  >
                    {t("settings.notif.copy_summary_btn")}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </Section>

      <Section title={t("settings.notif.quota_section")} icon="📈" subtitle={t("settings.notif.quota_section_sub")}>
        <Row title={t("settings.notif.threshold_row")} subtitle={t("settings.notif.threshold_row_sub")}>
          <select className={selectCls} value={n.threshold ?? ""} onChange={e => update({ notifications: { ...n, threshold: e.target.value ? Number(e.target.value) : null } })} aria-label={t("settings.notif.threshold_aria")}>
            <option value="">{t("settings.common.off")}</option><option value={75}>{t("settings.notif.at_75")}</option><option value={80}>{t("settings.notif.at_80")}</option><option value={90}>{t("settings.notif.at_90")}</option><option value={95}>{t("settings.notif.at_95")}</option>
          </select>
        </Row>
        <Row title={t("settings.notif.spent_row")} subtitle={t("settings.notif.spent_row_sub")}>
          <Switch checked={n.on_spent} onChange={v => update({ notifications: { ...n, on_spent: v } })} label={t("settings.notif.spent_row")} />
        </Row>
        <Row title={t("settings.notif.reset_row")} subtitle={t("settings.notif.reset_row_sub")} disabled={!n.threshold}>
          <Switch checked={n.on_reset} disabled={!n.threshold} onChange={v => update({ notifications: { ...n, on_reset: v } })} label={t("settings.notif.reset_row")} />
        </Row>
        <Row title={t("settings.notif.failure_row")} subtitle={t("settings.notif.failure_row_sub")}>
          <Switch checked={n.on_failure} onChange={v => update({ notifications: { ...n, on_failure: v } })} label={t("settings.notif.failure_row")} />
        </Row>
      </Section>

      <Section title={t("settings.notif.balance_section")} icon="💰" subtitle={t("settings.notif.balance_section_sub")}>
        <p className="text-[11px] text-zinc-500">{t("settings.notif.balance_note")}</p>
      </Section>
    </div>
  );
}
