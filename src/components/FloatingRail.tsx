import {useState,useEffect,useRef,useMemo} from "react";
import {invoke} from "@tauri-apps/api/core";
import {listen} from "@tauri-apps/api/event";
import {UsageRing} from "./UsageRing";
import {orderedIds} from "../ordering";
import {providerName} from "../pages/settings/constants";
import type {AppSettings,ProviderUsage} from "../types";
export function FloatingRail({usages,settings}:{usages:ProviderUsage[];settings:AppSettings}){
  // 拖动中的停靠边预览：Rust 在光标进出吸附带时已同步 resize 窗口，布局必须同时切换，
  // 否则横排内容被塞进竖排窄窗只露出一个图标。settings-updated 到达后清掉回真实值。
  const [dragSide,setDragSide]=useState<string|null>(null);
  const effSide=(dragSide??settings.dock_side) as AppSettings["dock_side"];
  const free=effSide==="free";
  const [hovered,setHovered]=useState<string|null>(null),[inside,setInside]=useState(false),[collapsed,setCollapsed]=useState(false),[collapsing,setCollapsing]=useState(false),[pinned,setPinned]=useState(false);
  const collapseTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
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
  const [antigravityAvailable, setAntigravityAvailable] = useState(false);
  useEffect(()=>{
    const el=railRef.current;if(!el)return;
    const measure=()=>setRailBox({w:el.offsetWidth,h:el.offsetHeight});
    measure();
    const ro=new ResizeObserver(measure);ro.observe(el);
    return()=>ro.disconnect();
  },[]);
  useEffect(() => {
    if (!settings.providers || Object.keys(settings.providers).length === 0) {
      invoke<boolean>("check_local_antigravity").then(setAntigravityAvailable).catch(() => {});
    }
  }, [settings.providers]);
  const handleQuickAddAntigravity = async () => {
    try {
      await invoke("quick_add_antigravity_account");
    } catch {
      void invoke("open_settings");
    }
  };

  const startCollapse = () => {
    if (free || insideRef.current || pinned || settings.auto_collapse_seconds === 0) return;
    if (settings.reduce_motion) {
      setCollapsed(true);
      setCollapsing(false);
      void invoke("set_window_state", { state: "collapsed" });
      return;
    }
    setCollapsing(true);
    if (collapseTimer.current) clearTimeout(collapseTimer.current);
    collapseTimer.current = setTimeout(() => {
      setCollapsing(false);
      setCollapsed(true);
      void invoke("set_window_state", { state: "collapsed" });
    }, 280);
  };

  const handleExpand = () => {
    if (collapseTimer.current) clearTimeout(collapseTimer.current);
    setCollapsing(false);
    setCollapsed(false);
    insideRef.current = true;
    setInside(true);
    void invoke("set_window_state", { state: "rail" });
  };

  useEffect(()=>{
    let alive=true;
    const stop=listen("reveal-rail",()=>{
      if(alive){
        if (collapseTimer.current) clearTimeout(collapseTimer.current);
        setCollapsing(false);
        setPinned(true);
        setCollapsed(false);
        void invoke("set_window_state", { state: "rail" });
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
    let alive=true;
    const stop=listen<string>("window-state-changed",e=>{
      if(alive){
        if (e.payload === "rail") {
          if (collapseTimer.current) clearTimeout(collapseTimer.current);
          setCollapsing(false);
          setCollapsed(false);
        } else if (e.payload === "collapsed") {
          setCollapsing(false);
          setCollapsed(true);
        }
      }
    });
    return()=>{alive=false;void stop.then(f=>f())};
  },[]);

  useEffect(() => {
    let alive = true;
    const stop = listen("request-collapse", () => {
      if (alive && !insideRef.current && !pinned && !free && settings.auto_collapse_seconds > 0) {
        startCollapse();
      }
    });
    return () => { alive = false; void stop.then(f => f()); };
  }, [settings.auto_collapse_seconds, pinned, free]);

  useEffect(()=>{
    const onBlur=()=>{
      insideRef.current=false;
      setInside(false);
    };
    const onDocLeave=(e:MouseEvent)=>{
      if(!e.relatedTarget&&!(e as unknown as {toElement:unknown}).toElement){
        insideRef.current=false;
        setInside(false);
      }
    };
    window.addEventListener("blur",onBlur);
    document.addEventListener("mouseleave",onDocLeave);
    return()=>{
      window.removeEventListener("blur",onBlur);
      document.removeEventListener("mouseleave",onDocLeave);
    };
  },[]);

  useEffect(()=>{
    if(draggingRef.current)return;
    if(free){
      if (collapseTimer.current) clearTimeout(collapseTimer.current);
      setCollapsed(false);
      setCollapsing(false);
      return;
    }
    if(inside||pinned||settings.auto_collapse_seconds===0){
      if(settings.auto_collapse_seconds===0){
        if (collapseTimer.current) clearTimeout(collapseTimer.current);
        setCollapsed(false);
        setCollapsing(false);
      }
      return;
    }
    const t=setTimeout(()=>{
      setHovered(null);
      void invoke("hide_detail");
      startCollapse();
    },settings.auto_collapse_seconds*1000);
    return()=>clearTimeout(t);
  },[inside,pinned,free,settings.auto_collapse_seconds]);

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
          if(wait>0){window.setTimeout(()=>setRefreshing(cur=>{
            // A 完成安排的延时回调不得关闭 B 已接管的动画：条目仍是完成事件的 request_id 才清。
            if(cur[account_id]!==undefined&&cur[account_id]!==e.payload.request_id)return cur;
            const {[account_id]:_,...rest}=cur;return rest;
          }),wait);return r;}
          const {[account_id]:_,...rest}=r;return rest;
        });
      }
    });
    return()=>{void stop.then(f=>f())};
  },[]);
  const clickTimer = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null);

  useEffect(() => {
    return () => {
      if (clickTimer.current) clearTimeout(clickTimer.current.timer);
    };
  }, []);

  const handleRingClick = (id: string) => {
    if (Date.now() < suppressClickUntil.current) return; // the pointerup that ended a drag must not refresh
    if (clickTimer.current) {
      if (clickTimer.current.id !== id) {
        clearTimeout(clickTimer.current.timer);
        const prevId = clickTimer.current.id;
        void invoke("refresh_account", { accountId: prevId }).catch(() => {});
      } else {
        clearTimeout(clickTimer.current.timer);
      }
      clickTimer.current = null;
    }
    const timer = setTimeout(() => {
      clickTimer.current = null;
      if (Date.now() < suppressClickUntil.current) return;
      void invoke("refresh_account", { accountId: id }).catch(() => {});
    }, 250);
    clickTimer.current = { id, timer };
  };

  const handleRingDoubleClick = () => {
    if (Date.now() < suppressClickUntil.current) return;
    if (clickTimer.current) {
      clearTimeout(clickTimer.current.timer);
      clickTimer.current = null;
    }
    void invoke("refresh_usages").catch(() => {});
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
      // B09：位移用屏幕坐标——窗口跟随鼠标时 client 坐标的差不代表真实拖动距离。
      if(e.button!==0)return;arm={x:e.screenX,y:e.screenY};
    };
    const move=(e:PointerEvent)=>{
      if(!arm)return;
      if(!dragging&&Math.hypot(e.screenX-arm.x,e.screenY-arm.y)>6){
        dragging=true;draggingRef.current=true;setDraggingUI(true);
        if(clickTimer.current){clearTimeout(clickTimer.current.timer);clickTimer.current=null;}
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
        if(arm&&Math.hypot(e.screenX-arm.x,e.screenY-arm.y)>=12)suppressClickUntil.current=Date.now()+400;
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
    handleExpand();
  };
  const exit = () => {
    if (leave.current) clearTimeout(leave.current);
    insideRef.current=false;
    leave.current = setTimeout(() => {
      setInside(false);
      if(!detailPointer.current){
        closeDetail();
      }
    }, 120);
  };

  // The rail follows the account order from settings, not the arrival order of readings.
  const enabledIds = useMemo(() => orderedIds(settings.providers).filter(id => settings.providers[id]?.enabled), [settings.providers]);
  const ordered = useMemo(() => {
    return enabledIds.map(id => {
      const cfg = settings.providers[id];
      const existing = usages.find(u => u.account_id === id);
      if (existing) return existing;
      const placeholder: ProviderUsage = {
        account_id: id,
        provider_id: cfg.provider_id,
        display_name: cfg.label || providerName(cfg.provider_id),
        state: "loading",
        primary_percent: null,
        plan_name: null,
        is_active: false,
        windows: [],
        balances: [],
        error_code: null,
        error_message: null,
        source: "等待查询",
        checked_at: null,
        last_success_at: null,
        retry_after_seconds: null,
        duration_ms: null,
      };
      return placeholder;
    });
  }, [enabledIds, usages, settings.providers]);

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

  const colorMode = settings.collapsed_bar_color_mode || "auto";
  let barGlowClass = "rail-breathe";
  let barColorStyle: React.CSSProperties = {};

  if (colorMode === "rainbow") {
    barGlowClass = "rail-rainbow";
  } else if (colorMode === "custom" && settings.collapsed_bar_color) {
    const custom = settings.collapsed_bar_color;
    barGlowClass = "rail-breathe";
    barColorStyle = {
      backgroundColor: custom,
      boxShadow: `0 0 5px ${custom}, 0 0 14px ${custom}d9, 0 0 28px ${custom}66`,
    };
  } else {
    // auto mode: according to quota pressure
    const pressureClass = Number.isNaN(maxPressure)
      ? "rail-glow-zinc"
      : maxPressure >= red
      ? "rail-glow-red"
      : maxPressure >= amber
      ? "rail-glow-amber"
      : "rail-glow-emerald";
    barGlowClass = `rail-breathe ${pressureClass}`;
  }
  const lookX=left?1:free?0:-1;

  const isSlidOut = collapsed || collapsing;
  const isHidden = collapsed && !collapsing;

  const transformCls = isSlidOut
    ? top
      ? "-translate-y-[calc(100%+24px)] opacity-0 scale-95 pointer-events-none"
      : left
      ? "-translate-x-[calc(100%+24px)] opacity-0 scale-95 pointer-events-none"
      : free
      ? "opacity-0 scale-95 pointer-events-none"
      : "translate-x-[calc(100%+24px)] opacity-0 scale-95 pointer-events-none"
    : "translate-x-0 translate-y-0 opacity-100 scale-100";

  const transitionCls = settings.reduce_motion
    ? ""
    : "transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]";

  return <div
    className={`relative w-full h-full flex ${top?"flex-col items-center":left?"flex-row items-center":"flex-row-reverse items-center"} select-none ${isSlidOut ? "" : "overflow-hidden"}`}
    onMouseEnter={enter}
    onMouseLeave={exit}
    onContextMenu={e=>{e.preventDefault();void invoke("rail_menu_cmd").catch(()=>{})}}
  >
    {/* The rail stays mounted (invisible when fully collapsed) so its live measurements keep driving the edge bar. */}
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
      } p-1.5 ${dark ? "glass-obsidian text-zinc-200" : "glass-translucent text-zinc-800"} ${isHidden ? "invisible" : ""} ${transformCls} ${transitionCls} cursor-move touch-none ${draggingUI ? "opacity-80" : ""}`}
    >
      <div className={`flex ${top ? "flex-row space-x-2" : "flex-col space-y-1.5"} overflow-y-auto max-h-full scrollbar-none`}>
        {slots.map(s => (
          <UsageRing key={s.key} dataKey={s.key} usage={s.usage} settings={settings} onHover={() => { if(!draggingRef.current) setHovered(s.key); }}
            refreshing={!!refreshing[s.account]} onClick={() => handleRingClick(s.account)} onDoubleClick={handleRingDoubleClick} lookX={lookX} />
        ))}
        {!slots.length && (
          antigravityAvailable ? (
            <button
              className="flex flex-col items-center justify-center p-2 text-center rounded-xl bg-indigo-950/70 hover:bg-indigo-900/90 border border-indigo-700/60 text-indigo-200 hover:text-white transition-all cursor-pointer group shadow-sm"
              onClick={() => void handleQuickAddAntigravity()}
              title="检测到本地运行中的 Antigravity，点击一键接入"
            >
              <span className="text-sm mb-0.5 animate-pulse">✨</span>
              <span className="text-[10px] font-semibold leading-tight whitespace-nowrap">一键接入</span>
              <span className="text-[9px] text-indigo-400 group-hover:text-indigo-300">Antigravity</span>
            </button>
          ) : (
            <button className="text-xs p-2 text-zinc-400 hover:text-zinc-200" onClick={() => void invoke("open_settings")}>
              添加账号
            </button>
          )
        )}
      </div>
    </div>
    {/* Collapsed edge hint: 4 dip visual (expanding to 6 dip on hover with gentle breathing pulse),
        flush to the docked edge, exactly as tall/wide as the rail. The hover hit area is the
        whole window. Right-click opens rail menu; double-click expands. */}
    {!free && (
      <div
        aria-label="展开 Pulse"
        onMouseEnter={enter}
        onDoubleClick={handleExpand}
        onContextMenu={e=>{e.preventDefault();void invoke("rail_menu_cmd").catch(()=>{})}}
        className={`absolute cursor-pointer rounded-full transition-all duration-300 ease-out hover:brightness-125 ${
          isSlidOut ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        } ${top ? "top-0 left-1/2 -translate-x-1/2 h-1 hover:h-1.5" : left ? "left-0 top-1/2 -translate-y-1/2 w-1 hover:w-1.5" : "right-0 top-1/2 -translate-y-1/2 w-1 hover:w-1.5"} ${barGlowClass}`}
        style={{ ...barColorStyle, ...(top ? { width: railBox?.w ?? "100%" } : { height: railBox?.h ?? "100%" }) }}
      />
    )}
  </div>;
}
