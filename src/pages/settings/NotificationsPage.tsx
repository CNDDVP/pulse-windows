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
            isRegistered ? "bg-[var(--ok-soft)] border-[var(--ok-border)] text-[var(--ok)]" :
            isMoved ? "bg-[var(--warn-soft)] border-[var(--warn-border)] text-[var(--warn)]" :
            "bg-[var(--danger-soft)] border-[var(--danger-border)] text-[var(--danger)]"
          }`}>
            <div className="flex items-center justify-between">
              <span className="font-semibold flex items-center gap-1.5">
                <span>{isRegistered ? "✓" : isMoved ? "⚠️" : "✕"}</span>
                <span>{t("settings.notif.identity_title")}</span>
              </span>
              <span className="text-[10px] px-1.5 py-0.5 rounded font-mono bg-[var(--surface)]">
                {isRegistered ? t("settings.notif.id_registered") : isMoved ? t("settings.notif.id_moved") : t("settings.notif.id_unregistered")}
              </span>
            </div>
            <p className="text-[11px] text-[var(--text-2)]">
              {isRegistered ? t("settings.notif.id_ready") :
               isMoved ? t("settings.notif.id_stale_shortcut") :
               t("settings.notif.id_missing")}
            </p>
          </div>

          {/* 2. Windows 全局通知 */}
          <div className={`p-3 rounded-xl border text-xs space-y-1 ${
            isGlobalBlocked ? "bg-[var(--danger-soft)] border-[var(--danger-border)] text-[var(--danger)]" :
            status?.windows_toasts_enabled ? "bg-[var(--ok-soft)] border-[var(--ok-border)] text-[var(--ok)]" :
            "bg-[var(--surface-2)] border-[var(--border-strong)] text-[var(--text-1)]"
          }`}>
            <div className="flex items-center justify-between">
              <span className="font-semibold flex items-center gap-1.5">
                <span>{isGlobalBlocked ? "✕" : "✓"}</span>
                <span>{t("settings.notif.global_title")}</span>
              </span>
              <span className="text-[10px] px-1.5 py-0.5 rounded font-mono bg-[var(--surface)]">
                {isGlobalBlocked ? t("settings.common.off") : status?.windows_toasts_enabled ? t("settings.notif.allowed") : t("settings.notif.unconfigured_default_on")}
              </span>
            </div>
            <p className="text-[11px] text-[var(--text-2)]">
              {isGlobalBlocked ? t("settings.notif.global_blocked") : t("settings.notif.global_ok")}
            </p>
          </div>

          {/* 3. Pulse 应用授权 */}
          <div className={`p-3 rounded-xl border text-xs space-y-1 ${
            isAppBlocked ? "bg-[var(--danger-soft)] border-[var(--danger-border)] text-[var(--danger)]" :
            status?.app_notification_setting === "enabled" ? "bg-[var(--ok-soft)] border-[var(--ok-border)] text-[var(--ok)]" :
            "bg-[var(--surface-2)] border-[var(--border-strong)] text-[var(--text-1)]"
          }`}>
            <div className="flex items-center justify-between">
              <span className="font-semibold flex items-center gap-1.5">
                <span>{isAppBlocked ? "✕" : "ℹ"}</span>
                <span>{t("settings.notif.app_title")}</span>
              </span>
              <span className="text-[10px] px-1.5 py-0.5 rounded font-mono bg-[var(--surface)]">
                {status?.app_notification_setting === "enabled" ? t("settings.notif.allowed") :
                 isAppBlocked ? t("settings.notif.app_disabled") :
                 status?.app_notification_setting === "disabled_by_manifest" ? t("settings.notif.identity_unrecognized") : t("settings.common.unknown")}
              </span>
            </div>
            <p className="text-[11px] text-[var(--text-2)]">
              {isAppBlocked ? t("settings.notif.app_blocked_note") :
               status?.app_notification_setting === "enabled" ? t("settings.notif.app_allowed_note") :
               t("settings.notif.app_pending_note")}
            </p>
          </div>

          {/* 4. 最近测试交付 */}
          <div className={`p-3 rounded-xl border text-xs space-y-1 ${
            lastTest?.success ? "bg-[var(--ok-soft)] border-[var(--ok-border)] text-[var(--ok)]" :
            lastTest ? "bg-[var(--danger-soft)] border-[var(--danger-border)] text-[var(--danger)]" :
            "bg-[var(--surface-2)] border-[var(--border-strong)] text-[var(--text-1)]"
          }`}>
            <div className="flex items-center justify-between">
              <span className="font-semibold flex items-center gap-1.5">
                <span>{lastTest?.success ? "✓" : lastTest ? "✕" : "⏱"}</span>
                <span>{t("settings.notif.last_test_title")}</span>
              </span>
              <span className="text-[10px] px-1.5 py-0.5 rounded font-mono bg-[var(--surface)]">
                {lastTest?.success ? t("settings.notif.test_delivered") : lastTest ? t("settings.notif.test_delivery_failed") : t("settings.notif.not_tested")}
              </span>
            </div>
            <p className="text-[11px] text-[var(--text-2)]">
              {lastTest?.success ? t("settings.notif.last_test_ok", { id: lastTest.test_id }) :
               lastTest?.error ? lastTest.error :
               t("settings.notif.last_test_hint")}
            </p>
          </div>
        </div>

        {/* 注册管理与快捷操作栏 */}
        <div className="p-3 bg-[var(--surface)] rounded-xl border border-[var(--border)] flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="space-y-0.5 min-w-0">
            <div className="font-medium text-[var(--text-1)]">
              {isRegistered ? t("settings.notif.linked_ok") : isMoved ? t("settings.notif.moved_title") : t("settings.notif.not_initialized")}
            </div>
            <p className="text-[11px] text-[var(--text-3)] truncate">
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
                className="px-3 py-1.5 rounded-lg bg-[var(--accent-solid)] hover:brightness-110 text-[var(--on-solid)] font-medium cursor-pointer transition-colors shadow-sm"
              >
                {isMoved ? t("settings.notif.fix_path") : t("settings.notif.enable_toasts")}
              </button>
            ) : (
              <button
                disabled={loading}
                onClick={() => void handleUnregister()}
                className="px-2.5 py-1.5 rounded-lg bg-[var(--surface-3)] hover:bg-[var(--danger-soft)] hover:text-[var(--danger)] text-[var(--text-2)] border border-[var(--border-strong)] cursor-pointer transition-colors"
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
            lastTest.success ? "bg-[var(--surface-2)] border-[var(--ok-border)]" : "bg-[var(--danger-soft)] border-[var(--danger-border)]"
          }`}>
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1">
                <div className="text-xs font-semibold flex items-center gap-2">
                  <span>{lastTest.success ? "📢" : "❌"}</span>
                  <span className={lastTest.success ? "text-[var(--ok)]" : "text-[var(--danger)]"}>
                    {lastTest.success ? t("settings.notif.result_ok", { id: lastTest.test_id }) : t("settings.notif.result_fail")}
                  </span>
                </div>
                <p className="text-[11px] text-[var(--text-2)] leading-relaxed">
                  {lastTest.success
                    ? t("settings.notif.result_ok_note")
                    : lastTest.error || t("settings.notif.result_fail_note")}
                </p>
                {/* lastTest.hint 来自 Rust 测试链路，原样展示。TODO(EN-backend) */}
                {lastTest.hint && (
                  <p className="text-[11px] text-[var(--warn)] font-medium">
                    {lastTest.hint}
                  </p>
                )}
              </div>
            </div>

            {lastTest.success && (
              <div className="pt-2 border-t border-[var(--border)] flex flex-wrap items-center justify-between gap-2">
                <span className="text-[11px] text-[var(--text-2)]">{t("settings.notif.saw_banner_q")}</span>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setUserFeedback("seen");
                      setShowTroubleshoot(false);
                      toast("success", t("settings.notif.feedback_seen_toast"));
                    }}
                    className={`px-3 py-1 rounded-lg text-xs font-medium cursor-pointer transition-colors ${
                      userFeedback === "seen"
                        ? "bg-[var(--accent-solid)] text-[var(--on-solid)]"
                        : "bg-[var(--surface-3)] hover:bg-[var(--ok-soft)] hover:text-[var(--ok)] text-[var(--text-1)] border border-[var(--border-strong)]"
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
                        ? "bg-[var(--warn-solid)] text-[var(--on-solid)]"
                        : "bg-[var(--surface-3)] hover:bg-[var(--warn-soft)] hover:text-[var(--warn)] text-[var(--text-1)] border border-[var(--border-strong)]"
                    }`}
                  >
                    ✕ {t("settings.notif.not_seen")}
                  </button>
                </div>
              </div>
            )}

            {/* 展开的排查引导 */}
            {showTroubleshoot && (
              <div className="pt-3 border-t border-[var(--border)] space-y-2.5 text-xs text-[var(--text-1)] animate-in fade-in duration-150">
                <div className="font-semibold text-[var(--warn)] flex items-center gap-1.5">
                  <span>🛠️</span>
                  <span>{t("settings.notif.troubleshoot_title")}</span>
                </div>
                <ol className="space-y-2 text-[11px] list-decimal list-inside text-[var(--text-2)] pl-1 leading-relaxed">
                  <li>
                    <strong className="text-[var(--text-1)]">{t("settings.notif.step1_title")}</strong>
                    {t("settings.notif.step1_body_pre")} <kbd className="px-1.5 py-0.5 bg-[var(--surface-3)] border border-[var(--border-strong)] rounded text-[var(--text-1)]">Win</kbd> + <kbd className="px-1.5 py-0.5 bg-[var(--surface-3)] border border-[var(--border-strong)] rounded text-[var(--text-1)]">N</kbd>{t("settings.notif.step1_body_post")}
                  </li>
                  <li>
                    <strong className="text-[var(--text-1)]">{t("settings.notif.step2_title")}</strong>
                    {t("settings.notif.step2_body")}
                  </li>
                  <li>
                    <strong className="text-[var(--text-1)]">{t("settings.notif.step3_title")}</strong>
                    {t("settings.notif.step3_body")}
                  </li>
                  <li>
                    <strong className="text-[var(--text-1)]">{t("settings.notif.step4_title")}</strong>
                    {t("settings.notif.step4_body")}
                  </li>
                </ol>
                <div className="pt-2 flex justify-end gap-2">
                  <button
                    onClick={handleCopyDiagnostics}
                    className="px-2.5 py-1 rounded bg-[var(--surface-3)] hover:bg-[var(--surface-hover)] text-[var(--text-1)] text-[11px] cursor-pointer"
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
        <p className="text-[11px] text-[var(--text-3)]">{t("settings.notif.balance_note")}</p>
      </Section>
    </div>
  );
}
