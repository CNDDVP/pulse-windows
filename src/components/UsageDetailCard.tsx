import {useEffect,useState} from "react";
import type {AppSettings,ProviderUsage} from "../types";
import {resetText,forecast,forecastKind} from "../presentation";
export function UsageDetailCard({usage,settings,placement}:{usage:ProviderUsage;settings:AppSettings;placement?: "left" | "right" | "top" | "bottom"}){
  const [now,setNow]=useState(()=>Date.now());useEffect(()=>{const t=setInterval(()=>setNow(Date.now()),10000);return()=>clearInterval(t)},[]);
  const dark = settings.theme === "obsidian";
  const isRightOfRail = placement !== undefined ? placement === "right" : settings.dock_side === "left";
  // 侧向小箭头只在卡片位于 rail 左/右侧时有意义；正下/正上时朝向用 dock_side 兜底。
  const sideways = placement ? placement==="left"||placement==="right" : settings.dock_side!=="top";

  const isRemaining = settings.display_mode === "remaining";
  const red = settings.warning_threshold, amber = red - 15;

  const animClass = isRightOfRail ? "card-animate-left" : "card-animate-right";
  return <section className={`relative rounded-2xl p-4 max-h-full overflow-auto w-[290px] text-xs ${animClass} ${dark?"card-obsidian text-zinc-200":"card-translucent text-zinc-800"}`}>
    {sideways && (
      <div
        className={`absolute top-6 w-3 h-3 rotate-45 pointer-events-none ${
          isRightOfRail
            ? "-left-1.5 " + (dark ? "bg-[#131317] border-l border-b border-white/10" : "bg-white border-l border-b border-black/10")
            : "-right-1.5 " + (dark ? "bg-[#131317] border-r border-t border-white/10" : "bg-white border-r border-t border-black/10")
        }`}
      />
    )}
    <strong className="text-sm">{usage.display_name}</strong><p className="text-zinc-500">{usage.plan_name}</p>
    {usage.error_message&&<p className="text-amber-500 my-2">{usage.state==="stale"?"旧读数 · ":""}{usage.error_message}</p>}
    {usage.windows.map(w => {
      const pct = isRemaining ? Math.max(0, 100 - w.used_percent) : w.used_percent;
      const label = isRemaining ? "剩余" : "已用";
      const barColor = w.exhausted || w.used_percent >= red ? "#ef4444" : w.used_percent >= amber ? "#f97316" : w.used_percent >= 50 ? "#eab308" : "#10b981";
      return (
        <div key={w.id} className="mt-3">
          <div className="flex justify-between gap-2">
            <span>{w.name}</span>
            <b>{Number(pct.toFixed(2))}% {label}</b>
          </div>
          <div className="h-1.5 bg-zinc-500/20 rounded my-1">
            <div
              className="h-full rounded transition-all duration-300"
              style={{width:`${Math.min(100,w.used_percent)}%`,backgroundColor:barColor}}
            />
          </div>
          <p className="text-zinc-500">{resetText(w.resets_at,now)}</p>
          {settings.forecast&&usage.state==="live"&&(()=>{
            const kind=forecastKind(w,now);
            const color=kind==="exhausted"?"text-red-500":kind==="ok"?"text-emerald-500":kind==="soon"?"text-orange-500":"text-yellow-500";
            return <p className={color}>{forecast(w,now)}</p>;
          })()}
        </div>
      );
    })}
    {usage.balances.map((b,i)=><p key={i} className="mt-3 text-base">余额 {b.currency} {b.amount.toFixed(2)}</p>)}
    {!usage.windows.length&&!usage.balances.length&&!usage.error_message&&<p>尚无读数</p>}
    <p className="mt-3 text-[10px] text-zinc-500">{usage.source||"等待连接"}{usage.last_success_at&&` · 最近成功 ${new Date(usage.last_success_at).toLocaleString()}`}</p>
  </section>;
}
