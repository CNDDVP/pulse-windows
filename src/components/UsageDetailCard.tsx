import {useEffect,useState} from "react";
import type {AppSettings,ProviderUsage} from "../types";
import {resetText,forecast} from "../presentation";
export function UsageDetailCard({usage,settings}:{usage:ProviderUsage;settings:AppSettings}){
  const [now,setNow]=useState(()=>Date.now());useEffect(()=>{const t=setInterval(()=>setNow(Date.now()),10000);return()=>clearInterval(t)},[]);
  const dark = settings.theme === "obsidian";
  const left = settings.dock_side === "left";
  const top = settings.dock_side === "top";

  const animClass = left ? "card-animate-left" : "card-animate-right";
  return <section className={`relative rounded-2xl p-4 max-h-full overflow-auto w-[290px] text-xs ${animClass} ${dark?"card-obsidian text-zinc-200":"card-translucent text-zinc-800"}`}>
    {!top && (
      <div
        className={`absolute top-6 w-3 h-3 rotate-45 pointer-events-none ${
          left
            ? "-left-1.5 " + (dark ? "bg-[#131317] border-l border-b border-white/10" : "bg-white border-l border-b border-black/10")
            : "-right-1.5 " + (dark ? "bg-[#131317] border-r border-t border-white/10" : "bg-white border-r border-t border-black/10")
        }`}
      />
    )}
    <strong className="text-sm">{usage.display_name}</strong><p className="text-zinc-500">{usage.plan_name}</p>
    {usage.error_message&&<p className="text-amber-500 my-2">{usage.state==="stale"?"旧读数 · ":""}{usage.error_message}</p>}
    {usage.windows.map(w=><div key={w.id} className="mt-3"><div className="flex justify-between gap-2"><span>{w.name}</span><b>{Number(w.used_percent.toFixed(2))}% 已用</b></div><div className="h-1.5 bg-zinc-500/20 rounded my-1"><div className="h-full rounded bg-emerald-500" style={{width:`${Math.min(100,w.used_percent)}%`,backgroundColor:w.exhausted?"#ef4444":undefined}}/></div><p className="text-zinc-500">{resetText(w.resets_at,now)}</p>{settings.forecast&&usage.state==="live"&&<p className="text-amber-500">{forecast(w,now)}</p>}</div>)}
    {usage.balances.map((b,i)=><p key={i} className="mt-3 text-base">余额 {b.currency} {b.amount.toFixed(2)}</p>)}
    {!usage.windows.length&&!usage.balances.length&&!usage.error_message&&<p>尚无读数</p>}
    <p className="mt-3 text-[10px] text-zinc-500">{usage.source||"等待连接"}{usage.last_success_at&&` · 最近成功 ${new Date(usage.last_success_at).toLocaleString()}`}</p>
  </section>;
}
