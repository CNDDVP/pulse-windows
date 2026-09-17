import {useRef} from "react";
import {ProviderIcon} from "./icons/ProviderIcons";
import {percentText,elapsed} from "../presentation";
import type {AppSettings,ProviderUsage} from "../types";
export function UsageRing({usage,settings,onHover}:{usage:ProviderUsage;settings:AppSettings;onHover:()=>void}){
  const ref=useRef<HTMLButtonElement>(null);
  const valid=["live","stale"].includes(usage.state)&&usage.primary_percent!==null;
  const used=usage.primary_percent??0,pct=valid?Math.min(100,settings.display_mode==="remaining"?Math.max(0,100-used):used):0;
  const color=!valid?"#71717a":usage.state==="stale"?"#a1a1aa":used>=90?"#ef4444":used>=75?"#f97316":used>=50?"#eab308":"#10b981";
  const target=usage.primary_percent;
  // Match with a tolerance and fall back to the highest window: the backend keeps the
  // primary percent equal to a window's value today, but exact float equality is fragile.
  const primary=target===null?undefined:usage.windows.find(w=>Math.abs(w.used_percent-target)<1e-9)??usage.windows.reduce((m,w)=>m===undefined||w.used_percent>m.used_percent?w:m,undefined as ProviderUsage["windows"][number]|undefined);
  const clock=settings.show_elapsed&&primary?elapsed(primary):null;
  const dark = settings.theme === "obsidian";
  return <button ref={ref} onMouseEnter={onHover} onFocus={onHover} title={`${usage.display_name} ${percentText(usage,settings.display_mode)}`} className="shrink-0 flex flex-col items-center p-1 text-xs rounded-lg focus:outline-2 focus:outline-emerald-500 hover:scale-105 transition-transform duration-150">
    <div className="relative w-11 h-11 flex items-center justify-center">
      <svg viewBox="0 0 44 44" className="w-11 h-11 -rotate-90">
        <circle cx="22" cy="22" r="18" fill="none" stroke={dark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.08)"} strokeWidth="2.8"/>
        <circle cx="22" cy="22" r="18" fill="none" stroke={color} strokeWidth="2.8" strokeLinecap="round" strokeDasharray={`${pct/100*113.097} 113.097`} className="transition-all duration-500 ease-out"/>
        {clock!==null&&<circle cx="22" cy="22" r="21" fill="none" stroke="#a1a1aa" strokeWidth="1" strokeDasharray={`${clock*131.95} 131.95`}/>}
      </svg>
      <span className={`absolute inset-1.5 rounded-full flex items-center justify-center ${dark ? "bg-zinc-800/40 text-zinc-200" : "bg-black/5 text-zinc-700"}`}>
        <ProviderIcon id={usage.provider_id} size={18}/>
      </span>
      {usage.is_active && (
        <div className="absolute inset-0 animate-spin pointer-events-none" style={{ animationDuration: '3s' }}>
          <div className="w-1.5 h-1.5 rounded-full bg-white shadow-[0_0_6px_#ffffff]" style={{ position: 'absolute', top: '1px', left: 'calc(50% - 3px)' }} />
        </div>
      )}
    </div>
    <span className={`text-[11px] font-medium mt-0.5 ${dark ? "text-zinc-300" : "text-zinc-700"}`}>{percentText(usage,settings.display_mode)}</span>
  </button>;
}
