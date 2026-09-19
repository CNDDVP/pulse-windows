import {useState,useEffect,useRef,useMemo} from "react";
import {invoke} from "@tauri-apps/api/core";
import {listen} from "@tauri-apps/api/event";
import {UsageRing} from "./UsageRing";
import {orderedIds} from "../ordering";
import type {AppSettings,ProviderUsage} from "../types";
export function FloatingRail({usages,settings}:{usages:ProviderUsage[];settings:AppSettings}){
  // 拖动中的停靠边预览：Rust 在光标进出吸附带时已同步 resize 窗口，布局必须同时切换，
  // 否则横排内容被塞进竖排窄窗只露出一个图标。settings-updated 到达后清掉回真实值。
  const [dragSide,setDragSide]=useState<string|null>(null);
  const effSide=(dragSide??settings.dock_side) as AppSettings["dock_side"];
  const free=effSide==="free";
  const [hovered,setHovered]=useState<string|null>(null),[inside,setInside]=useState(false),[collapsed,setCollapsed]=useState(false),[pinned,setPinned]=useState(false);
  const detailPointer=useRef(false);const leave=useRef<ReturnType<typeof setTimeout>|null>(null);
  const railRef=useRef<HTMLDivElement>(null);
  // Ring click → per-account refresh; the arc keeps spinning >=650ms even for fast replies.
  const [refreshing,setRefreshing]=useState<Record<string,number>>({});
  const refreshShownUntil=useRef<Record<string,number>>({});
  const suppressClickUntil=useRef(0);
  // Unified drag state machine: idle → armed(pointer down) → dragging(>6 dip) in every mode.
  const [draggingUI,setDraggingUI]=useState(false);
  const draggingRef=useRef(false);
  // Measured rail box (border-box) lets the collapsed edge bar mirror the rail's exact height.
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
        // The pointer is on the tray, not inside the window: never set `inside` here,
        // or no mouseleave will ever fire and the rail stops collapsing.
        setPinned(true);
        setCollapsed(false);
      }
    });
    return()=>{alive=false;void stop.then(f=>f())};
  },[]);
  useEffect(()=>{
    if(!pinned)return;
    const t=setTimeout(()=>setPinned(false),Math.max(settings.auto_collapse_seconds,5)*1000);
    return()=>clearTimeout(t);
  },[pinned,settings.auto_collapse_seconds]);
  const insideRef=useRef(false);
  useEffect(()=>{insideRef.current=inside;},[inside]);

  useEffect(()=>{
    if(draggingRef.current)return;
    if(free){setCollapsed(false);return}
    if(inside||pinned||settings.auto_collapse_seconds===0){setCollapsed(false);return}
    const t=setTimeout(()=>{
      setHovered(null);
      setCollapsed(true);
      void invoke("hide_detail");
    },settings.auto_collapse_seconds*1000);
    return()=>clearTimeout(t);
  },[inside,pinned,free,settings.auto_collapse_seconds]);

  useEffect(()=>{
    if(draggingRef.current)return;
    void invoke("set_window_state",{state:collapsed?"collapsed":"rail"});
  },[collapsed,settings.dock_side]);

  useEffect(()=>{
    const stop=listen<{account_id:string;request_id:number;phase:string}>("refresh-state",e=>{
      const {account_id,phase}=e.payload;
      if(phase==="started"){
        refreshShownUntil.current[account_id]=Date.now()+650;
        setRefreshing(r=>({...r,[account_id]:e.payload.request_id}));
      }else{
        // 过期请求的结束事件不关闭新一轮动画
        setRefreshing(r=>{
          if(r[account_id]!==undefined&&r[account_id]!==e.payload.request_id)return r;
          const wait=Math.max(0,(refreshShownUntil.current[account_id]??0)-Date.now());
          if(wait>0){window.setTimeout(()=>setRefreshing(cur=>{const {[account_id]:_,...rest}=cur;return rest;}),wait);return r;}
          const {[account_id]:_,...rest}=r;return rest;
        });
      }
    });
    return()=>{void stop.then(f=>f())};
  },[]);
  const refreshAccount=(id:string)=>{
      if(Date.now()<suppressClickUntil.current)return; // the pointerup that ended a drag must not refresh
      void invoke("refresh_account",{accountId:id}).catch(()=>{});
    };

  // The hover card is a separate overlay window in all modes so the rail bounds never move.
  useEffect(()=>{
    const stop=listen<boolean>("detail-pointer",e=>{
      detailPointer.current=e.payload;
      if(!e.payload&&!insideRef.current){
        if(leave.current)clearTimeout(leave.current);
        leave.current=setTimeout(()=>{
          if(!insideRef.current&&!detailPointer.current){
            setHovered(null);
            void invoke("hide_detail");
          }
        },200);
      }
    });
    return()=>{void stop.then(f=>f())};
  },[]);

  useEffect(()=>{
    if(!hovered)return;
    // hovered 是完整 slot key："account" 或拆分组时的 "account::组名"。
    // 原样传给后端透传，详情卡按组过滤窗口（App.tsx DetailOverlay）。
    const el=document.querySelector(`[data-account="${hovered}"]`);
    const rect=el?.getBoundingClientRect();
    const ratio=rect?(rect.top+rect.height/2)/(window.innerHeight||1):0.5;
    const horizontalRatio=rect?(rect.left+rect.width/2)/(window.innerWidth||1):0.5;
    void invoke("show_detail",{
      accountId:hovered,
      centerRatio:Math.min(1,Math.max(0,ratio)),
      horizontalRatio:Math.min(1,Math.max(0,horizontalRatio))
    });
  },[hovered]);

  const closeDetail=()=>{setHovered(null);void invoke("hide_detail");};

  // Unified drag: arm on any left press; >6 dip starts a real drag in EVERY mode (the rail
  // follows the pointer, edges re-snap with Rust-side hysteresis); release saves.
  useEffect(()=>{
    let arm:{x:number;y:number}|null=null;
    let dragging=false;let pending=false;
    const down=(e:PointerEvent)=>{
      if(e.button===2){
        // WebView2 swallows right-button events at the controller level: neither
        // `contextmenu` nor pointerdown(button=2) reaches the page. The tray menu
        // covers these actions; try the native menu anyway for a future fix.
        arm=null;void invoke("rail_menu_cmd").catch(()=>{});return;
      }
      if(e.button!==0)return;arm={x:e.clientX,y:e.clientY};
    };
    const move=(e:PointerEvent)=>{
      if(!arm)return;
      if(!dragging&&Math.hypot(e.clientX-arm.x,e.clientY-arm.y)>6){
        dragging=true;draggingRef.current=true;setDraggingUI(true);
        setHovered(null);void invoke("hide_detail");
        void invoke("drag_begin").catch(err=>{document.title="BEGERR "+String(err).slice(0,70)});
        document.title="DRAG-ON";
      }
      if(dragging){
        if(!pending){
          pending=true;
          requestAnimationFrame(()=>{pending=false;void invoke("drag_move").catch(err=>{document.title="MOVERR "+String(err).slice(0,70)});});
        }
      }
    };
    const up=(e:PointerEvent)=>{
      if(dragging){
        dragging=false;draggingRef.current=false;setDraggingUI(false);
        // 只有真正拖动了 rail（≥12 逻辑px）才抑制后续 click：6-12dip 的手抖"微拖"
        // 视为点击意图，不吞刷新（drag_end 照常执行，位移极小、保存的位置无害）。
        if(arm&&Math.hypot(e.clientX-arm.x,e.clientY-arm.y)>=12)suppressClickUntil.current=Date.now()+400;
        void invoke("drag_end");
        // settings-updated 通常先到（drag_end 同步保存）；超时兜底防 cancel 路径卡住预览态。
        setTimeout(()=>setDragSide(null),400);
      }
      arm=null;
    };
    const cancel=()=>{
      if(dragging){
        dragging=false;draggingRef.current=false;setDraggingUI(false);void invoke("drag_cancel");
        setTimeout(()=>setDragSide(null),400);
      }
      arm=null;
    };
    window.addEventListener("pointerdown",down);
    window.addEventListener("pointermove",move);
    window.addEventListener("pointerup",up);
    window.addEventListener("pointercancel",cancel);
    return()=>{
      window.removeEventListener("pointerdown",down);window.removeEventListener("pointermove",move);
      window.removeEventListener("pointerup",up);window.removeEventListener("pointercancel",cancel);
    };
  },[]);
  useEffect(()=>{
    let alive=true;
    const stop=listen<string>("drag-side",e=>{if(alive)setDragSide(e.payload)});
    const stop2=listen("settings-updated",()=>{if(alive)setDragSide(null)});
    return()=>{alive=false;void stop.then(f=>f());void stop2.then(f=>f())};
  },[]);
  useEffect(()=>()=>{if(leave.current)clearTimeout(leave.current)},[]);
  const top=effSide==="top",left=effSide==="left";
  const dark=settings.theme==="obsidian";
  const enter = () => {
    if (leave.current) clearTimeout(leave.current);
    insideRef.current=true;
    setInside(true);
    setCollapsed(false);
  };
  const exit = () => {
    if (leave.current) clearTimeout(leave.current);
    insideRef.current=false;
    leave.current = setTimeout(() => {
      setInside(false);
      if(!detailPointer.current){
        closeDetail();
      }
    }, 250);
  };

  // The rail follows the account order from settings, not the arrival order of readings.
  const rank=new Map(orderedIds(settings.providers).map((id,i)=>[id,i]));
  const ordered=[...usages].sort((a,b)=>(rank.get(a.account_id)??Number.MAX_SAFE_INTEGER)-(rank.get(b.account_id)??Number.MAX_SAFE_INTEGER));

  // Rail slots: an Antigravity account with split_model_groups renders one ring per model
  // group (same account, same refresh); everyone else is a single slot.
  const slots=useMemo(()=>{
    const out:{key:string;usage:ProviderUsage;account:string;group?:string}[]=[];
    for(const u of ordered){
      const cfg=settings.providers[u.account_id];
      if(cfg?.split_model_groups&&u.provider_id==="antigravity"&&u.windows.length>1){
        const groups:string[]=[];
        for(const w of u.windows){const g=w.name.split(" · ")[0];if(!groups.includes(g))groups.push(g);}
        for(const g of groups){
          const wins=u.windows.filter(w=>w.name.split(" · ")[0]===g);
          const primary=Math.max(...wins.map(x=>x.used_percent));
          out.push({key:`${u.account_id}::${g}`,account:u.account_id,group:g,
            usage:{...u,windows:wins,primary_percent:primary,display_name:g}});
        }
      }else out.push({key:u.account_id,account:u.account_id,usage:u});
    }
    return out;
  },[ordered,settings.providers]);

  // Only real readings drive the pressure glow; an account in an error state is "unknown".
  const readings=ordered.filter(u=>["live","stale"].includes(u.state));
  const maxPressure=readings.length?readings.reduce((max,u)=>Math.max(max,u.primary_percent??0),0):(ordered.length?Number.NaN:0);
  const red=settings.warning_threshold,amber=red-15;
  const glowClass=Number.isNaN(maxPressure)?"bg-zinc-500 shadow-[0_0_8px_#71717a]":maxPressure>=red?"bg-red-500 shadow-[0_0_10px_#ef4444]":maxPressure>=amber?"bg-amber-400 shadow-[0_0_8px_#f59e0b]":"bg-emerald-400 shadow-[0_0_8px_#10b981]";
  const lookX=left?1:free?0:-1;

  return <div
    className={`relative w-full h-full flex ${top?"flex-col items-center":left?"flex-row items-center":"flex-row-reverse items-center"} select-none overflow-hidden`}
    onMouseEnter={enter}
    onMouseLeave={exit}
    onContextMenu={e=>{e.preventDefault();void invoke("rail_menu_cmd").catch(()=>{})}}
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
      } p-1.5 ${dark ? "glass-obsidian text-zinc-200" : "glass-translucent text-zinc-800"} ${collapsed ? "invisible" : ""} cursor-move touch-none ${draggingUI ? "opacity-80" : ""}`}
    >
      <div className={`flex ${top ? "flex-row space-x-2" : "flex-col space-y-1.5"} overflow-y-auto max-h-full scrollbar-none`}>
        {slots.map(s => (
          <UsageRing key={s.key} dataKey={s.key} usage={s.usage} settings={settings} onHover={() => { if(!draggingRef.current) setHovered(s.key); }}
            refreshing={!!refreshing[s.account]} onClick={() => refreshAccount(s.account)} lookX={lookX} />
        ))}
        {!slots.length && (
          <button className="text-xs p-2 text-zinc-400 hover:text-zinc-200" onClick={() => void invoke("open_settings")}>
            添加账号
          </button>
        )}
      </div>
    </div>
    {/* Collapsed edge hint: 4 dip visual, flush to the docked edge, exactly as tall/wide
        as the rail. The hover hit area is the whole (10 dip) window, not just the bar.
        Right-click opens the rail menu; dragging the bar moves/re-docks the rail. */}
    {collapsed && (
      <div
        aria-label="展开 Pulse"
        onMouseEnter={enter}
        onDoubleClick={() => { setCollapsed(false); }}
        onContextMenu={e=>{e.preventDefault();void invoke("rail_menu_cmd").catch(()=>{})}}
        className={`absolute cursor-pointer rounded-full ${top ? "top-0 left-1/2 -translate-x-1/2 h-1" : left ? "left-0 top-1/2 -translate-y-1/2 w-1" : "right-0 top-1/2 -translate-y-1/2 w-1"} ${glowClass}`}
        style={top ? { width: railBox?.w ?? "100%" } : { height: railBox?.h ?? "100%" }}
      />
    )}
  </div>;
}
