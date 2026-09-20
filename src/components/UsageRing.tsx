import {useRef, useState} from "react";
import {ProviderIcon} from "./icons/ProviderIcons";
import {BotMark} from "./BotMark";
import {percentText,elapsed,pickElapsedWindow} from "../presentation";
import type {AppSettings,ProviderUsage} from "../types";
export function UsageRing({usage,settings,onHover,refreshing,onClick,onDoubleClick,lookX=0,dataKey}:
  {usage:ProviderUsage;settings:AppSettings;onHover:()=>void;refreshing?:boolean;onClick?:()=>void;onDoubleClick?:()=>void;lookX?:number;dataKey?:string}){
  const ref=useRef<HTMLButtonElement>(null);
  // 旋转灯的相位对齐：CSS animate-spin 的相位取决于元素挂载时刻，各账号挂载时间不同
  // 导致卫星灯各转各的。用负 animation-delay 把相位锚到全局时钟（挂载时算一次，
  // 重渲染不变），所有灯任意时刻处于同一角度。刷新彩弧（1s）同理对齐到秒相位。
  const [spinDelay]=useState(()=>`-${Date.now()%3000}ms`);
  const [arcDelay]=useState(()=>`-${Date.now()%1000}ms`);
  const valid=["live","stale"].includes(usage.state)&&usage.primary_percent!==null;
  const used=usage.primary_percent??0,pct=valid?Math.min(100,settings.display_mode==="remaining"?Math.max(0,100-used):used):0;
  // The warning threshold only moves the amber→red step; a provider-reported exhaustion is always red,
  // and a per-account custom colour applies to the calm range only.
  const red=settings.warning_threshold,amber=red-15,custom=settings.providers[usage.account_id]?.ring_color??null;
  const cfg=settings.providers[usage.account_id];
  // 主环颜色只由主窗口的耗尽驱动：pin 了主窗口就看它；未 pin 时与后端 primary_percent
  // 的 max 语义一致取任一耗尽。此前 some() 会被未选中的次窗口绑架（主额度 0% 也全环变红）。
  const primaryWin=cfg?.primary_window?usage.windows.find(w=>w.id===cfg.primary_window):null;
  const exhausted=primaryWin?primaryWin.exhausted:usage.windows.some(w=>w.exhausted);
  const color=!valid?"#71717a":usage.state==="stale"?"#a1a1aa":(exhausted||used>=red)?"#ef4444":used>=amber?"#f97316":custom??(used>=50?"#eab308":"#10b981");
  // The outer time ring follows the account's own pick (or the soonest reset), independent of the inner quota ring.
  const timed=valid?pickElapsedWindow(usage.windows,cfg?.elapsed_window??null):null;
  const clock=settings.show_elapsed&&timed?elapsed(timed):null;
  const dark = settings.theme === "obsidian";
  // Animated bot mark replaces the provider badge when enabled; the white travelling
  // activity arc is not drawn then (the bot itself shows the working state).
  const useBot=cfg?.mark_mode==="bot";
  const mood:Parameters<typeof BotMark>[0]["mood"]=
    usage.is_active?"working":refreshing?"fetching":
    (exhausted||used>=100)?"spent":
    !["live","stale"].includes(usage.state)?"unavailable":"idle";
  // Second ring: only when the account explicitly picks a window; 关闭 means closed —
  // no auto-picked residue.
  const secCfg=cfg?.secondary_window??null;
  const sec=valid&&secCfg?usage.windows.find(w=>w.id===secCfg)??null:null;
  const secLive=sec&&["live","stale"].includes(usage.state)&&sec.id!==cfg?.primary_window;
  const secPct=sec?(settings.display_mode==="remaining"?Math.max(0,100-sec.used_percent):sec.used_percent):0;
  const secColor=sec?(sec.exhausted||sec.used_percent>=red?"#ef4444":sec.used_percent>=amber?"#f97316":"#10b981"):"#71717a";
  return <button ref={ref} data-account={dataKey??usage.account_id} onClick={onClick} onDoubleClick={onDoubleClick} onMouseEnter={onHover} onFocus={onHover} title={`${usage.display_name} ${percentText(usage,settings.display_mode)}`} className="shrink-0 flex flex-col items-center p-1 text-xs rounded-lg focus:outline-none hover:scale-105 transition-transform duration-150">
    <div className="relative w-11 h-11 flex items-center justify-center">
      <svg viewBox="0 0 44 44" className="w-11 h-11 -rotate-90">
        <circle cx="22" cy="22" r="18" fill="none" stroke={dark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.08)"} strokeWidth="2.8"/>
        <circle cx="22" cy="22" r="18" fill="none" stroke={color} strokeWidth="2.8" strokeLinecap="round" opacity={refreshing?0.35:1} strokeDasharray={`${pct/100*113.097} 113.097`} className="transition-all duration-500 ease-out"/>
        {refreshing&&<g className="animate-spin" style={{animationDuration:"1s",animationDelay:arcDelay,transformOrigin:"22px 22px"}}><circle cx="22" cy="22" r="18" fill="none" stroke={color} strokeWidth="2.8" strokeLinecap="round" strokeDasharray="22 91"/></g>}
        {secLive&&sec&&<circle cx="22" cy="22" r="11" fill="none" stroke={dark?"rgba(255,255,255,0.1)":"rgba(0,0,0,0.07)"} strokeWidth="2.2"/>}
        {secLive&&sec&&<circle cx="22" cy="22" r="11" fill="none" stroke={secColor} strokeWidth="2.2" strokeLinecap="round" strokeDasharray={`${Math.min(100,Math.max(0,secPct))/100*69.12} 69.12`} className="transition-all duration-500 ease-out"/>}
        {clock!==null&&<circle cx="22" cy="22" r="21" fill="none" stroke="#ffffff" strokeWidth="1.5" strokeLinecap="round" opacity="0.95" strokeDasharray={`${(clock>0?Math.max(clock,0.025):0)*131.95} 131.95`}/>}
      </svg>
      <span className={`absolute inset-1.5 rounded-full flex items-center justify-center ${dark ? "bg-zinc-800/40 text-zinc-200" : "bg-black/5 text-zinc-700"}`}>
        {useBot?
          <BotMark shape={cfg?.bot_shape??"blob"} persona={cfg?.bot_persona??"calm"} color={cfg?.bot_color??(usage.provider_id==="kimi"?"#7AA5FF":undefined)}
            mood={mood} size={20} reduceMotion={settings.reduce_motion||(typeof window<"u"&&window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches===true)} lookX={lookX}/>:
          <ProviderIcon id={usage.provider_id} size={18}/>}
      </span>
      {usage.is_active && !useBot && (
        <div className="absolute inset-0 animate-spin pointer-events-none" style={{ animationDuration: '3s', animationDelay: spinDelay }}>
          <div className="w-1.5 h-1.5 rounded-full bg-white shadow-[0_0_6px_#ffffff]" style={{ position: 'absolute', top: '1px', left: 'calc(50% - 3px)' }} />
        </div>
      )}
    </div>
    <span className={`text-[11px] font-medium mt-0.5 ${dark ? "text-zinc-300" : "text-zinc-700"}`}>{percentText(usage,settings.display_mode)}</span>
  </button>;
}
