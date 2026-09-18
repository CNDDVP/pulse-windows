import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppSettings, ProviderUsage } from "../../types";
import { Section } from "./shared";
import { btnPrimary, btnGhost, STATE_LABEL, timeText } from "./constants";

const dot = (s: string) => s === "live" ? "bg-emerald-400" : s === "stale" ? "bg-amber-400" : "bg-red-400";

export function DiagnosticsPage({ usages, settings, busy, setBusy, toast, open }: {
  usages: ProviderUsage[]; settings: AppSettings; busy: boolean; setBusy: (b: boolean) => void;
  toast: (type: "success" | "info" | "error", text: string) => void; open: (id: string) => void;
}) {
  const [report, setReport] = useState("");
  return (
    <div className="space-y-5 max-w-3xl">
      <Section title="账号实时诊断" icon="🩺" subtitle="点击账号进入其页面可查看完整路由与下一步操作。">
        <div className="space-y-2">
          {usages.length === 0 && <p className="text-xs text-zinc-500">尚无启用的账号。</p>}
          {usages.map(u => {
            const cfg = settings.providers[u.account_id];
            return (
              <button key={u.account_id} onClick={() => open(u.account_id)} className="w-full text-left px-3 py-2 rounded-xl border border-white/5 bg-zinc-950/40 hover:border-white/15 transition-colors">
                <div className="flex items-center gap-2 text-xs">
                  <span className={`w-1.5 h-1.5 rounded-full ${dot(u.state)}`} />
                  <span className="text-zinc-200 font-medium">{cfg?.label || u.display_name}</span>
                  <span className="text-zinc-500">{u.display_name}</span>
                  <span className="ml-auto text-zinc-400 font-mono">{STATE_LABEL[u.state] ?? u.state} · {timeText(u.checked_at)}{u.duration_ms != null ? ` · ${u.duration_ms} ms` : ""}</span>
                </div>
                <div className="text-[11px] text-zinc-500 mt-0.5 truncate">{u.source || "—"}{u.error_message ? ` · ${u.error_message}` : ""}</div>
              </button>
            );
          })}
        </div>
      </Section>
      <Section title="诊断报告" icon="📋" subtitle="白名单生成：只含服务商、状态、错误分类与时间，不含账号名、凭据或本地路径。"
        aside={<div className="flex gap-2">
          <button className={btnPrimary} disabled={busy} onClick={() => void (async () => { setBusy(true); try { setReport(await invoke<string>("diagnostics")); toast("success", "诊断报告已生成"); } catch (e) { toast("error", `生成失败: ${String(e)}`); } finally { setBusy(false); } })()}>生成报告</button>
          {report && <button className={btnGhost} onClick={() => { void navigator.clipboard.writeText(report); toast("success", "已复制"); }}>复制</button>}
        </div>}>
        {report ? <pre className="w-full max-h-80 bg-zinc-950 p-4 font-mono text-xs text-zinc-300 rounded-2xl border border-white/5 overflow-auto select-text">{report}</pre> : <p className="text-xs text-zinc-500">尚未生成。</p>}
      </Section>
    </div>
  );
}
