import {useEffect,useState} from "react";
import type { HourlyUsage } from "../types";
import { balanceText } from "../presentation";
import { useLang } from "../lib/i18n";

export function HourlyUsageChart({
  usages,
  compact = false,
}: {
  usages: HourlyUsage[];
  compact?: boolean;
}) {
  const { t, lang } = useLang();
  const [nowSeconds,setNowSeconds]=useState(()=>Math.floor(Date.now()/1000));
  useEffect(()=>{const timer=setInterval(()=>setNowSeconds(Math.floor(Date.now()/1000)),60000);return()=>clearInterval(timer);},[]);
  if (!usages || usages.length === 0) return null;
  const nowHour=Math.floor(nowSeconds/3600)*3600;
  // Aggregate the same 24 displayed hour buckets for both bars and totals.
  const hourlyMap = new Map<number, { timestamp: number; credits: number; calls: number; models: Record<string, number> }>();
  let totalCredits = 0;
  let totalCalls = 0;

  for (const u of usages) {
    if(!Number.isFinite(u.timestamp)||u.timestamp<nowHour-23*3600||u.timestamp>nowSeconds||!Number.isFinite(u.credit_consumed)||u.credit_consumed<0||!Number.isFinite(u.calls)||u.calls<0)continue;
    totalCredits += u.credit_consumed;
    totalCalls += u.calls;
    // Align timestamp to hour
    const hourTs = Math.floor(u.timestamp / 3600) * 3600;
    const existing = hourlyMap.get(hourTs) || { timestamp: hourTs, credits: 0, calls: 0, models: {} };
    existing.credits += u.credit_consumed;
    existing.calls += u.calls;
    existing.models[u.model_id] = (existing.models[u.model_id] || 0) + u.credit_consumed;
    hourlyMap.set(hourTs, existing);
  }

  // Get last 24 hours

  const hours: { hourLabel: string; credits: number; calls: number; models: Record<string, number> }[] = [];
  let maxHourCredits = 1;

  for (let i = 23; i >= 0; i--) {
    const ts = nowHour - i * 3600;
    const item = hourlyMap.get(ts);
    const credits = item ? item.credits : 0;
    const calls = item ? item.calls : 0;
    const models = item ? item.models : {};
    if (credits > maxHourCredits) maxHourCredits = credits;
    const d = new Date(ts * 1000);
    const hourLabel = `${d.getHours().toString().padStart(2, "0")}:00`;
    hours.push({ hourLabel, credits, calls, models });
  }

  return (
    <div className={`mt-3 p-2.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] text-xs ${compact ? "" : "p-3"}`}>
      <div className="flex justify-between items-center mb-1.5">
        <span className="font-medium text-[var(--text-1)]">{t("rail.chart.title")}</span>
        <span className="text-[11px] text-[var(--text-2)] font-mono">
          {t("rail.chart.total",{amount:balanceText("Credit", totalCredits, lang)})}
        </span>
      </div>
      <div className="h-12 flex items-end gap-[3px] pt-1">
        {hours.map((h, idx) => {
          const heightPct = Math.max(h.credits > 0 ? 10 : 3, Math.round((h.credits / maxHourCredits) * 100));
            const title = t("rail.chart.bar_title",{hour:h.hourLabel,credits:balanceText("Credit", h.credits, lang),calls:h.calls});
          return (
            <div
              key={idx}
              className="flex-1 h-full flex items-end group relative cursor-pointer"
              title={title}
            >
              <div
                className={`w-full rounded-t-sm transition-all ${
                  h.credits > 0 ? "bg-[var(--accent)] hover:bg-[var(--accent-strong)]" : "bg-[var(--hover)]"
                }`}
                style={{ height: `${heightPct}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="flex justify-between text-[10px] text-[var(--text-3)] mt-1">
        <span>{t("rail.chart.ago_24h")}</span>
        <span>{t("rail.chart.now",{calls:totalCalls})}</span>
      </div>
    </div>
  );
}
