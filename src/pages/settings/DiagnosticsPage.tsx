import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppSettings, ProviderUsage } from "../../types";
import { useLang } from "../../lib/i18n";
import { Section } from "./shared";
import { btnPrimary, btnGhost, stateLabel, timeText } from "./constants";

const dot = (s: string) => s === "live" ? "bg-[var(--ok)]" : s === "stale" ? "bg-[var(--warn)]" : "bg-[var(--danger)]";

export function DiagnosticsPage({ usages, settings, busy, setBusy, toast, open }: {
  usages: ProviderUsage[]; settings: AppSettings; busy: boolean; setBusy: (b: boolean) => void;
  toast: (type: "success" | "info" | "error", text: string) => void; open: (id: string) => void;
}) {
  const { t } = useLang();
  const [report, setReport] = useState("");
  return (
    <div className="space-y-5 max-w-3xl">
      <Section title={t("settings.diag.title")} icon="🩺" subtitle={t("settings.diag.subtitle")}>
        <div className="space-y-2">
          {usages.length === 0 && <p className="text-xs text-[var(--text-3)]">{t("settings.diag.no_accounts")}</p>}
          {usages.map(u => {
            const cfg = settings.providers[u.account_id];
            return (
              <button key={u.account_id} onClick={() => open(u.account_id)} className="w-full text-left px-3 py-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] hover:border-[var(--border-strong)] transition-colors">
                <div className="flex items-center gap-2 text-xs">
                  <span className={`w-1.5 h-1.5 rounded-full ${dot(u.state)}`} />
                  <span className="text-[var(--text-1)] font-medium">{cfg?.label || u.display_name}</span>
                  <span className="text-[var(--text-3)]">{u.display_name}</span>
                  <span className="ml-auto text-[var(--text-2)] font-mono">{stateLabel(t, u.state)} · {timeText(u.checked_at)}{u.duration_ms != null ? ` · ${u.duration_ms} ms` : ""}</span>
                </div>
                {/* TODO(EN-backend)：u.error_message 为 Rust 侧消息，原样拼接展示不翻译。 */}
                <div className="text-[11px] text-[var(--text-3)] mt-0.5 truncate">{u.source || "—"}{u.error_message ? ` · ${u.error_message}` : ""}</div>
              </button>
            );
          })}
        </div>
      </Section>
      <Section title={t("settings.diag.report_title")} icon="📋" subtitle={t("settings.diag.report_sub")}
        aside={<div className="flex gap-2">
          <button className={btnPrimary} disabled={busy} onClick={() => void (async () => { setBusy(true); try { setReport(await invoke<string>("diagnostics")); toast("success", t("settings.diag.generated")); } catch (e) { toast("error", t("settings.diag.generate_fail", { err: String(e) })); } finally { setBusy(false); } })()}>{t("settings.diag.generate")}</button>
          {report && <button className={btnGhost} onClick={() => { void navigator.clipboard.writeText(report); toast("success", t("settings.common.copied")); }}>{t("settings.diag.copy")}</button>}
        </div>}>
        {/* 诊断报告正文来自 Rust `diagnostics` 命令，原样展示；TODO(EN-backend) 后端文案暂为中文。 */}
        {report ? <pre className="w-full max-h-80 bg-[var(--surface)] p-4 font-mono text-xs text-[var(--text-1)] rounded-2xl border border-[var(--border)] overflow-auto select-text">{report}</pre> : <p className="text-xs text-[var(--text-3)]">{t("settings.diag.not_generated")}</p>}
      </Section>
    </div>
  );
}
