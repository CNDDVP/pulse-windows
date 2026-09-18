import {useState,useEffect,useRef} from "react";
import {invoke} from "@tauri-apps/api/core";
import {listen} from "@tauri-apps/api/event";
import {UsageRing} from "./UsageRing";
import {UsageDetailCard} from "./UsageDetailCard";
import {orderedIds} from "../ordering";
import type {AppSettings,ProviderUsage} from "../types";
export function FloatingRail({usages,settings}:{usages:ProviderUsage[];settings:AppSettings}){
  const free=settings.dock_side==="free";
  const [hovered,setHovered]=useState<string|null>(null),[inside,setInside]=useState(false),[collapsed,setCollapsed]=useState(false),[pinned,setPinned]=useState(false);
  const detailPointer=useRef(false);const dragArmed=useRef<{x:number;y:number;t:number}|null>(null);const draggingFree=useRef(false);
  const leave=useRef<ReturnType<typeof setTimeout>|null>(null);
  const railRef=useRef<HTMLDivElement>(null);
  // Measured rail box (border-box) lets the collapsed edge bar mirror the rail's exact
  // height — never a fixed stub — and the ResizeObserver keeps it in sync when the
  // account set, order or font scale changes, including while collapsed.
  const [railBox,setRailBox]=useState<{w:number;h:number}|null>(null);
  useEffect(()=>{
    const el=railRef.current;if(!el)return;
    const measure=()=>setRailBox({w:el.offsetWidth,h:el.offsetHeight});
    measure();
    const ro=new ResizeObserver(measure);ro.observe(el);
    return()=>ro.disconnect();
  },[]);
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
  useEffect(()=>{if(free){setCollapsed(false);return}if(inside||pinned||settings.auto_collapse_seconds===0){setCollapsed(false);return}const t=setTimeout(()=>{setHovered(null);setCollapsed(true)},settings.auto_collapse_seconds*1000);return()=>clearTimeout(t)},[inside,pinned,free,settings.auto_collapse_seconds]);
  useEffect(()=>{if(free){void invoke("set_window_state",{state:"rail"});return}void invoke("set_window_state",{state:collapsed?"collapsed":hovered?"expanded":"rail"});},[collapsed,hovered,free,settings.dock_side]);
  // Free mode: the hover card is a separate overlay window so the rail bounds never move.
  useEffect(()=>{
    if(!free)return;
    const stop=listen<boolean>("detail-pointer",e=>{detailPointer.current=e.payload});
    return()=>{void stop.then(f=>f())};
  },[free]);
  useEffect(()=>{
    if(!free||!hovered)return;
    const el=document.querySelector(`[data-account="${hovered}"]`);
    const ratio=el?(el.getBoundingClientRect().top+el.getBoundingClientRect().height/2)/(window.innerHeight||1):0.5;
    void invoke("show_detail",{accountId:hovered,centerRatio:Math.min(1,Math.max(0,ratio))});
  },[free,hovered]);
  const closeFreeDetail=()=>{setHovered(null);void invoke("hide_detail");};
  // Free-mode drag: 6dip threshold or 200ms hold on the rail background starts a native move.
  useEffect(()=>{
    if(!free)return;
    const up=()=>{if(draggingFree.current){draggingFree.current=false;void invoke("commit_free_position");}dragArmed.current=null;};
    window.addEventListener("pointerup",up);
    return()=>window.removeEventListener("pointerup",up);
  },[free]);
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
      if(free&&!detailPointer.current)closeFreeDetail();
    }, 250);
  };
  const onRailPointerDown=(e:React.PointerEvent)=>{
    if(!free||draggingFree.current)return;
    if(e.button!==0)return;
    dragArmed.current={x:e.clientX,y:e.clientY,t:Date.now()};
    const hold=setTimeout(()=>startFreeDrag(e.clientX,e.clientY),200);
    const move=(ev:PointerEvent)=>{if(Math.hypot(ev.clientX-e.clientX,ev.clientY-e.clientY)>6)startFreeDrag(ev.clientX,ev.clientY);};
    const cancel=()=>{clearTimeout(hold);window.removeEventListener("pointermove",move);window.removeEventListener("pointerup",cancel);};
    window.addEventListener("pointermove",move);window.addEventListener("pointerup",cancel);
  };
  const startFreeDrag=(_x:number,_y:number)=>{
    if(draggingFree.current)return;draggingFree.current=true;dragArmed.current=null;
    setHovered(null);void invoke("hide_detail");void invoke("begin_free_drag");
  };

  // The rail follows the account order from settings, not the arrival order of readings.
  const rank=new Map(orderedIds(settings.providers).map((id,i)=>[id,i]));
  const ordered=[...usages].sort((a,b)=>(rank.get(a.account_id)??Number.MAX_SAFE_INTEGER)-(rank.get(b.account_id)??Number.MAX_SAFE_INTEGER));

  // Only real readings drive the pressure glow; an account in an error state is
  // "unknown", not healthy-green.
  const readings=ordered.filter(u=>["live","stale"].includes(u.state));
  const maxPressure=readings.length?readings.reduce((max,u)=>Math.max(max,u.primary_percent??0),0):(ordered.length?Number.NaN:0);
  const red=settings.warning_threshold,amber=red-15;
  const glowClass=Number.isNaN(maxPressure)?"bg-zinc-500 shadow-[0_0_8px_#71717a]":maxPressure>=red?"bg-red-500 shadow-[0_0_10px_#ef4444]":maxPressure>=amber?"bg-amber-400 shadow-[0_0_8px_#f59e0b]":"bg-emerald-400 shadow-[0_0_8px_#10b981]";

  return <div
    className={`relative w-full h-full flex ${top?"flex-col items-center":left?"flex-row items-center":"flex-row-reverse items-center"} select-none overflow-hidden`}
    onMouseEnter={enter}
    onMouseLeave={exit}
    onContextMenu={e=>{e.preventDefault();void invoke("open_settings")}}
  >
    {/* The rail stays mounted (invisible) while collapsed so its live measurements keep driving the edge bar. */}
    <div
      ref={railRef}
      className={`relative flex ${top ? "flex-row max-w-full max-h-full" : "flex-col max-h-full"} shrink-0 ${
        top
          ? "rounded-b-2xl border-b border-x border-t-0"
          : left
          ? "rounded-r-2xl border-r border-y border-l-0"
          : free
          ? "rounded-2xl border"
          : "rounded-l-2xl border-l border-y border-r-0"
      } p-1.5 ${dark ? "glass-obsidian text-zinc-200" : "glass-translucent text-zinc-800"} ${collapsed ? "invisible" : ""} ${free?"cursor-move touch-none":""}`.replace("${top","${top")}
      onPointerDown={onRailPointerDown}
    >
      <div className={`flex ${top ? "flex-row space-x-2" : "flex-col space-y-1.5"} overflow-y-auto max-h-full scrollbar-none`}>
        {ordered.map(u => (
          <UsageRing key={u.account_id} usage={u} settings={settings} onHover={() => setHovered(u.account_id)} />
        ))}
        {!ordered.length && (
          <button className="text-xs p-2 text-zinc-400 hover:text-zinc-200" onClick={() => void invoke("open_settings")}>
            添加账号
          </button>
        )}
      </div>
    </div>
    {/* Collapsed edge hint: 4 dip visual, flush to the docked edge, exactly as tall/wide
        as the rail. The hover hit area is the whole (10 dip) window, not just the bar. */}
    {collapsed && (
      <div
        aria-label="展开 Pulse"
        onMouseEnter={enter}
        className={`absolute cursor-pointer rounded-full ${top ? "top-0 left-1/2 -translate-x-1/2 h-1" : left ? "left-0 top-1/2 -translate-y-1/2 w-1" : "right-0 top-1/2 -translate-y-1/2 w-1"} ${glowClass}`}
        style={top ? { width: railBox?.w ?? "100%" } : { height: railBox?.h ?? "100%" }}
      />
    )}
    {!collapsed && active && (
      <div className="p-2 min-h-0 max-h-full">
        <UsageDetailCard usage={active} settings={settings} />
      </div>
    )}
  </div>;
}
