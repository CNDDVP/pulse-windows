import type { HourlyUsage } from "../types";
import { balanceText } from "../presentation";

export function HourlyUsageChart({
  usages,
  compact = false,
}: {
  usages: HourlyUsage[];
  compact?: boolean;
}) {
  if (!usages || usages.length === 0) return null;

  // Aggregate by hour
  const hourlyMap = new Map<number, { timestamp: number; credits: number; calls: number; models: Record<string, number> }>();
  let totalCredits = 0;
  let totalCalls = 0;

  for (const u of usages) {
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
  const nowHour = Math.floor(Date.now() / 1000 / 3600) * 3600;
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
    <div className={`mt-3 p-2.5 rounded-xl border border-white/5 bg-zinc-900/40 text-xs ${compact ? "" : "p-3"}`}>
      <div className="flex justify-between items-center mb-1.5">
        <span className="font-medium text-zinc-300">24h 积分消耗趋势</span>
        <span className="text-[11px] text-zinc-400 font-mono">
          共 {balanceText("Credit", totalCredits)}
        </span>
      </div>
      <div className="h-12 flex items-end gap-[3px] pt-1">
        {hours.map((h, idx) => {
          const heightPct = Math.max(h.credits > 0 ? 10 : 3, Math.round((h.credits / maxHourCredits) * 100));
          const title = `${h.hourLabel}：消耗 ${balanceText("Credit", h.credits)}，调用 ${h.calls} 次`;
          return (
            <div
              key={idx}
              className="flex-1 h-full flex items-end group relative cursor-pointer"
              title={title}
            >
              <div
                className={`w-full rounded-t-sm transition-all ${
                  h.credits > 0 ? "bg-emerald-500 hover:bg-emerald-400" : "bg-zinc-700/30"
                }`}
                style={{ height: `${heightPct}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="flex justify-between text-[10px] text-zinc-500 mt-1">
        <span>24 小时前</span>
        <span>当前（{totalCalls} 次调用）</span>
      </div>
    </div>
  );
}
