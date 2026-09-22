import { detailViewportReady, waitForDetailLayout } from "./detailLayout";
import {useEffect,useRef,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {listen} from "@tauri-apps/api/event";
import {getCurrentWebviewWindow} from "@tauri-apps/api/webviewWindow";
import type {AppSettings,ProviderUsage} from "./types";
import {FloatingRail} from "./components/FloatingRail";
import {UsageDetailCard} from "./components/UsageDetailCard";
import {SettingsWindow} from "./pages/SettingsWindow";
import {I18nProvider, normalizeLang, useLang} from "./lib/i18n";
import {applyDocumentTheme} from "./lib/theme";

function windowLabel(): string {
  try { return getCurrentWebviewWindow().label; } catch { return "main"; }
}

// Round5c 项目一：加载/致命错误提示走 i18n。二者只在 settings 为空（语言未知）时出现，
// Provider 受控 lang 会回落 zh——文案经 useLang().t() 供词，语言可判定时自然跟随。
// Round5d 项目一：颜色走语义令牌（浅色模式下同样可读）。
function LoadingHint(){
  const {t}=useLang();
  return <div className="p-3 bg-[var(--surface-2)] text-[var(--text-2)] text-xs">{t("rail.loading")}</div>;
}
function LoadError(){
  const {t}=useLang();
  return <div className="p-4 bg-[var(--surface-2)] text-[var(--warn)] text-sm">{t("rail.error.load_settings")}</div>;
}

/** The free-mode hover card lives in its own overlay window ("detail"); Rust tells it
 *  which account to draw via the "detail-account" event. */
interface DetailLayout {request_id:number;account_id:string;placement:"left"|"right"|"top"|"bottom";width:number;height:number}
function DetailOverlay() {
  const [layout,setLayout]=useState<DetailLayout|null>(null);
  const [usages,setUsages]=useState<ProviderUsage[]|null>(null);
  const [accountId,setAccountId]=useState<string|null>(null);
  const [settings,setSettings]=useState<AppSettings|null>(null);
  const [placement,setPlacement]=useState<"left"|"right"|"top"|"bottom">("left");
  useEffect(()=>{
    let alive=true;const stops:(()=>void)[]=[];let settingsVersion=0,usageVersion=0;
    void(async()=>{
      let layoutVersion=0;
      const applyLayout=(v:DetailLayout|null)=>{if(alive){setLayout(v);setAccountId(v?.account_id??null);if(v)setPlacement(v.placement)}};
      const a=await listen<DetailLayout>("detail-layout",e=>{layoutVersion++;applyLayout(e.payload)}).catch(()=>null);
      if(a){if(!alive){void a();return}stops.push(a)}
      const lv=layoutVersion;
      void invoke<DetailLayout|null>("get_detail_layout").then(v=>{if(lv===layoutVersion)applyLayout(v)}).catch(()=>{});
      const b=await listen<ProviderUsage[]>("usages-updated",e=>{usageVersion++;if(alive)setUsages(e.payload)}).catch(()=>null);
      if(b){if(!alive){void b();return}stops.push(b)}
      const c=await listen<AppSettings>("settings-updated",e=>{settingsVersion++;if(alive)setSettings(e.payload)}).catch(()=>null);
      if(c){if(!alive){void c();return}stops.push(c)}
      const d=await listen<"left"|"right"|"top"|"bottom">("detail-placement",e=>{if(alive)setPlacement(e.payload)}).catch(()=>null);
      if(d){if(!alive){void d();return}stops.push(d)}

      const sv=settingsVersion,uv=usageVersion;
      void invoke<ProviderUsage[]>("get_usages").then(u=>{if(alive&&uv===usageVersion)setUsages(u)}).catch(()=>{});
      void invoke<AppSettings>("get_settings").then(x=>{if(alive&&sv===settingsVersion)setSettings(x)}).catch(()=>{});
    })();
    return()=>{alive=false;stops.forEach(f=>f())};
  },[]);
  const usage0=usages?.find(u=>u.account_id===accountId?.split("::")[0]);
  // 拆分模型组的 slot key 形如 "account::组名"：详情卡只显示该组的窗口，
  // 否则滑过 Gemini 圆环弹出的卡片会混杂 Claude/GPT 的额度（P2-06）。
  const groupId=accountId?.includes("::")?accountId.split("::")[1]:null;
  const usage=usage0&&groupId?{...usage0,windows:usage0.windows.filter(w=>w.name.split(" · ")[0]===groupId),display_name:`${usage0.display_name} · ${groupId}`}:usage0;
  // 窗口在 rail 侧方时卡片要贴向 rail 那一侧（否则留出 34-50px 透明断层，箭头悬空）；
  // 正下/正上时水平居中对准图标。
  // B15：独立窗口同样执行减少动态设置（根元素标记只在 MainApp 挂，detail 窗口拿不到）。
  useEffect(()=>{document.documentElement.classList.toggle("reduce-motion",!!settings?.reduce_motion);},[settings?.reduce_motion]);
  // Round5d 项目一：详情窗独立加载 settings，主题在自身根元素上同步。
  useEffect(()=>{applyDocumentTheme(settings?.theme);},[settings?.theme]);
  const detailContentReady = !!settings && usages !== null;
  useEffect(()=>{
    if(!layout||!detailContentReady)return;
    return waitForDetailLayout(
      () => detailViewportReady(window.innerWidth,window.innerHeight,window.devicePixelRatio,layout.width,layout.height),
      () => invoke<boolean>("detail_layout_ready",{requestId:layout.request_id}),
      () => console.warn("详情布局未就绪，保持隐藏；重新悬停可重试"),
    );
  },[layout,detailContentReady]);
  const justifyClass=placement==="left"?"justify-end":placement==="right"?"justify-start":"justify-center";
  // 窗口在 rail 正下/正上时内容贴边渲染，否则卡片矮时垂直居中会在窗口顶留出大片透明，
  // 视觉上像"详情卡离悬浮栏很远"。
  const alignClass=placement==="top"?"items-start":placement==="bottom"?"items-end":"items-center";
  // 高度自适应：测量卡片自然高度（scrollHeight 不受窗口裁切与容器 flex 居中影响），
  // 窗口高随之伸缩（resize_detail 后端再按工作区钳制）。仅当目标高度与当前相差 >8px
  // 时调用，避免与窗口变化互相触发循环。
  const cardRef=useRef<HTMLElement>(null);
  const lastHeightRef=useRef("");
  useEffect(()=>{
    const el=cardRef.current;if(!el||!usage||!settings||!layout)return;
    const rect=el.getBoundingClientRect();
    const target=Math.ceil(Math.max(el.scrollHeight,rect.height))+20;
    const current=window.innerHeight;
    if(Math.abs(target-current)>6&&lastHeightRef.current!==`${layout.request_id}:${target}`){
      lastHeightRef.current=`${layout.request_id}:${target}`;
      void invoke<DetailLayout|null>("resize_detail",{height:target,requestId:layout.request_id}).then(actual=>{
        if(actual)setLayout(prev=>prev?.request_id===actual.request_id?actual:prev);
      }).catch(()=>{lastHeightRef.current="";});
    }
  },[usage,settings,layout,accountId]);
  // Round5c 项目一：语言走既有设置通道——settings 派生语言经 Provider 受控下发；
  // <html lang> 由 Provider 同步。
  return <I18nProvider lang={normalizeLang(settings?.language)}>
  <div className={`w-full h-full p-2 flex ${justifyClass} ${alignClass}`}
    onMouseEnter={()=>void invoke("set_detail_hover",{hovered:true})}
    onMouseLeave={()=>void invoke("set_detail_hover",{hovered:false})}
    onContextMenu={e=>e.preventDefault()}>
    {usage&&settings?<UsageDetailCard key={accountId||"none"} usage={usage} settings={settings} placement={placement} cardRef={cardRef as React.RefObject<HTMLElement>}/>:null}
  </div>
  </I18nProvider>;
}

function MainApp({label}:{label:string}){
  const [settings,setSettings]=useState<AppSettings|null>(null);
  const [usages,setUsages]=useState<ProviderUsage[]>([]);
  const [error,setError]=useState(false);
  useEffect(()=>{
    let alive=true;const stops:(()=>void)[]=[];let settingsVersion=0,usageVersion=0;
    void(async()=>{
      // A dead event channel degrades to polling-free display; only settings
      // failing to load is fatal for rendering.
      const a=await listen<AppSettings>("settings-updated",e=>{settingsVersion++;if(alive)setSettings(e.payload)}).catch(()=>null);
      if(a){if(!alive){void a();return}stops.push(a)}
      const b=await listen<ProviderUsage[]>("usages-updated",e=>{usageVersion++;if(alive)setUsages(e.payload)}).catch(()=>null);
      if(b){if(!alive){void b();return}stops.push(b)}
      const sv=settingsVersion,uv=usageVersion;
      try{
        const s=await invoke<AppSettings>("get_settings");
        if(alive&&sv===settingsVersion)setSettings(s);
      }catch{if(alive)setError(true);return}
      try{
        const u=await invoke<ProviderUsage[]>("get_usages");
        if(alive&&uv===usageVersion)setUsages(u);
      }catch{/* 读数加载失败不阻塞界面；下一次刷新事件会补上 */}
    })();
    const refreshSnapshot = () => {
      if (!alive) return;
      void invoke<ProviderUsage[]>("get_usages").then(u => {
        if (alive) setUsages(u);
      }).catch(() => {});
    };
    window.addEventListener("focus", refreshSnapshot);
    const onVis = () => { if (document.visibilityState === "visible") refreshSnapshot(); };
    document.addEventListener("visibilitychange", onVis);
    return()=>{
      alive=false;
      window.removeEventListener("focus", refreshSnapshot);
      document.removeEventListener("visibilitychange", onVis);
      stops.forEach(f=>f());
    };
  },[]);
  // 减少动态效果：应用内开关挂到根元素，CSS 一处覆盖所有动画（A27）。
  useEffect(()=>{document.documentElement.classList.toggle("reduce-motion",!!settings?.reduce_motion);},[settings?.reduce_motion]);
  // Round5d 项目一：主题走既有设置通道（settings.theme），同步到根元素 data-theme；
  // index.css 的 [data-theme="light"] 据此切换语义令牌。设置保存经 settings-updated
  // 事件回流，rail/settings/detail 三类窗口立即随主题。
  useEffect(()=>{applyDocumentTheme(settings?.theme);},[settings?.theme]);
  useEffect(()=>{if(settings&&!error)void invoke("update_ui_ready").catch(()=>{});},[settings,error]);
  const content=error
    ?<LoadError/>
    :!settings
      ?<LoadingHint/>
      :label==="settings"
        ?<SettingsWindow initialSettings={settings} usages={usages} onSaved={setSettings}/>
        :<FloatingRail usages={usages} settings={settings}/>;
  // Round5c 项目一：语言走既有设置通道——settings.language 经 Provider 受控下发，
  // 设置保存后经 settings-updated 事件回流，语言切换立即生效；<html lang> 由 Provider 同步。
  return <I18nProvider lang={normalizeLang(settings?.language)}>{content}</I18nProvider>;
}

export default function App(){
  const label=windowLabel();
  if(label==="detail")return <DetailOverlay/>;
  return <MainApp label={label}/>;
}
