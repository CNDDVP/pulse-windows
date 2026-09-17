import {useState,useEffect,useRef} from "react";
import {invoke} from "@tauri-apps/api/core";
import {listen} from "@tauri-apps/api/event";
import {UsageRing} from "./UsageRing";
import {UsageDetailCard} from "./UsageDetailCard";
import type {AppSettings,ProviderUsage} from "../types";
export function FloatingRail({usages,settings}:{usages:ProviderUsage[];settings:AppSettings}){
  const [hovered,setHovered]=useState<string|null>(null),[inside,setInside]=useState(false),[collapsed,setCollapsed]=useState(false),[pinned,setPinned]=useState(false);
  const leave=useRef<ReturnType<typeof setTimeout>|null>(null);
  useEffect(()=>{
    let alive=true;
    const stop=listen("reveal-rail",()=>{
      if(alive){
        // The pointer is on the tray, not inside the window: never set `inside`
        // here, or no mouseleave will ever fire and the rail stops collapsing.
        setPinned(true);
        setCollapsed(false);
      }
    });
    return()=>{alive=false;void stop.then(f=>f())};
  },[]);
  // A tray reveal unpins itself after the same grace period; a real hover
  // keeps the rail open via `inside`.
  useEffect(()=>{
    if(!pinned)return;
    const t=setTimeout(()=>setPinned(false),Math.max(settings.auto_collapse_seconds,5)*1000);
    return()=>clearTimeout(t);
  },[pinned,settings.auto_collapse_seconds]);
  useEffect(()=>{if(inside||pinned||settings.auto_collapse_seconds===0){setCollapsed(false);return}const t=setTimeout(()=>{setHovered(null);setCollapsed(true)},settings.auto_collapse_seconds*1000);return()=>clearTimeout(t)},[inside,pinned,settings.auto_collapse_seconds]);
  useEffect(()=>{void invoke("set_window_state",{state:collapsed?"collapsed":hovered?"expanded":"rail"});},[collapsed,hovered,settings.dock_side]);
  useEffect(()=>()=>{if(leave.current)clearTimeout(leave.current)},[]);
  const active=usages.find(u=>u.account_id===hovered),top=settings.dock_side==="top",left=settings.dock_side==="left";
  const dark=settings.theme==="obsidian";
  const enter = () => {
    if (leave.current) clearTimeout(leave.current);
    setInside(true);
    setCollapsed(false);
  };
  const exit = () => {
    if (leave.current) clearTimeout(leave.current);
    leave.current = setTimeout(() => {
      setInside(false);
      setHovered(null);
    }, 250);
  };

  // Only real readings drive the pressure glow; an account in an error state is
  // "unknown", not healthy-green.
  const readings=usages.filter(u=>["live","stale"].includes(u.state));
  const maxPressure=readings.length?readings.reduce((max,u)=>Math.max(max,u.primary_percent??0),0):(usages.length?Number.NaN:0);
  const glowClass=Number.isNaN(maxPressure)?"bg-zinc-500 shadow-[0_0_8px_#71717a]":maxPressure>=90?"bg-red-500 shadow-[0_0_10px_#ef4444]":maxPressure>=75?"bg-amber-400 shadow-[0_0_8px_#f59e0b]":"bg-emerald-400 shadow-[0_0_8px_#10b981]";

  return <div
    className={`w-full h-full flex ${top?"flex-col items-center":left?"flex-row items-center":"flex-row-reverse items-center"} select-none`}
    onMouseEnter={enter}
    onMouseLeave={exit}
    onContextMenu={e=>{e.preventDefault();void invoke("open_settings")}}
  >
    {collapsed ? (
      <button
        aria-label="展开 Pulse"
        onMouseEnter={enter}
        onFocus={enter}
        className={`${top ? "w-28 h-2.5 rounded-b-full" : left ? "w-2.5 h-28 rounded-r-full" : "w-2.5 h-28 rounded-l-full"} ${glowClass} transition-all duration-300 hover:scale-110 cursor-pointer`}
      />
    ) : (
      <div
        className={`relative flex ${top ? "flex-row max-w-full" : "flex-col max-h-full"} shrink-0 ${
          top
            ? "rounded-b-2xl border-b border-x border-t-0"
            : left
            ? "rounded-r-2xl border-r border-y border-l-0"
            : "rounded-l-2xl border-l border-y border-r-0"
        } p-1.5 ${dark ? "glass-obsidian text-zinc-200" : "glass-translucent text-zinc-800"}`}
      >
        <div className={`flex ${top ? "flex-row space-x-2" : "flex-col space-y-1.5"} overflow-y-auto max-h-full scrollbar-none`}>
          {usages.map(u => (
            <UsageRing key={u.account_id} usage={u} settings={settings} onHover={() => setHovered(u.account_id)} />
          ))}
          {!usages.length && (
            <button className="text-xs p-2 text-zinc-400 hover:text-zinc-200" onClick={() => void invoke("open_settings")}>
              添加账号
            </button>
          )}
        </div>
      </div>
    )}
    {!collapsed && active && (
      <div className="p-2 min-h-0 max-h-full">
        <UsageDetailCard usage={active} settings={settings} />
      </div>
    )}
  </div>;
}
