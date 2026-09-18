import {useEffect,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {listen} from "@tauri-apps/api/event";
import {getCurrentWebviewWindow} from "@tauri-apps/api/webviewWindow";
import type {AppSettings,ProviderUsage} from "./types";
import {FloatingRail} from "./components/FloatingRail";
import {UsageDetailCard} from "./components/UsageDetailCard";
import {SettingsWindow} from "./pages/SettingsWindow";

function windowLabel(): string {
  try { return getCurrentWebviewWindow().label; } catch { return "main"; }
}

/** The free-mode hover card lives in its own overlay window ("detail"); Rust tells it
 *  which account to draw via the "detail-account" event. */
function DetailOverlay() {
  const [usages,setUsages]=useState<ProviderUsage[]|null>(null);
  const [accountId,setAccountId]=useState<string|null>(null);
  const [settings,setSettings]=useState<AppSettings|null>(null);
  const [placement,setPlacement]=useState<"left"|"right">("left");
  useEffect(()=>{
    let alive=true;const stops:(()=>void)[]=[];let settingsVersion=0,usageVersion=0;
    void(async()=>{
      const a=await listen<string>("detail-account",e=>{if(alive)setAccountId(e.payload)}).catch(()=>null);
      if(a){if(!alive){void a();return}stops.push(a)}
      const b=await listen<ProviderUsage[]>("usages-updated",e=>{usageVersion++;if(alive)setUsages(e.payload)}).catch(()=>null);
      if(b){if(!alive){void b();return}stops.push(b)}
      const c=await listen<AppSettings>("settings-updated",e=>{settingsVersion++;if(alive)setSettings(e.payload)}).catch(()=>null);
      if(c){if(!alive){void c();return}stops.push(c)}
      const d=await listen<"left"|"right">("detail-placement",e=>{if(alive)setPlacement(e.payload)}).catch(()=>null);
      if(d){if(!alive){void d();return}stops.push(d)}

      const sv=settingsVersion,uv=usageVersion;
      void invoke<ProviderUsage[]>("get_usages").then(u=>{if(alive&&uv===usageVersion)setUsages(u)}).catch(()=>{});
      void invoke<AppSettings>("get_settings").then(x=>{if(alive&&sv===settingsVersion)setSettings(x)}).catch(()=>{});
      // The create-time "detail-account" event can fire before this listener exists; ask directly.
      void invoke<string|null>("detail_account").then(id=>{if(alive&&id)setAccountId(id)}).catch(()=>{});
    })();
    return()=>{alive=false;stops.forEach(f=>f())};
  },[]);
  const usage=usages?.find(u=>u.account_id===accountId);
  return <div className="w-full h-full p-2 flex items-center"
    onMouseEnter={()=>void invoke("set_detail_hover",{hovered:true})}
    onMouseLeave={()=>void invoke("set_detail_hover",{hovered:false})}
    onContextMenu={e=>e.preventDefault()}>
    {usage&&settings?<UsageDetailCard usage={usage} settings={settings} placement={placement}/>:null}
  </div>;
}

function MainApp({label}:{label:string}){
  const [settings,setSettings]=useState<AppSettings|null>(null);
  const [usages,setUsages]=useState<ProviderUsage[]>([]);
  const [error,setError]=useState("");
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
      }catch{if(alive)setError("无法加载配置。原设置已保留；请检查配置文件或查看启动诊断后重启 Pulse。");return}
      try{
        const u=await invoke<ProviderUsage[]>("get_usages");
        if(alive&&uv===usageVersion)setUsages(u);
      }catch{/* 读数加载失败不阻塞界面；下一次刷新事件会补上 */}
    })();return()=>{alive=false;stops.forEach(f=>f())};
  },[]);
  if(error)return <div className="p-4 bg-zinc-900 text-amber-300 text-sm">{error}</div>;
  if(!settings)return <div className="p-3 bg-zinc-900 text-zinc-400 text-xs">正在加载…</div>;
  return label==="settings"?<SettingsWindow initialSettings={settings} usages={usages} onSaved={setSettings}/>:<FloatingRail usages={usages} settings={settings}/>;
}

export default function App(){
  const label=windowLabel();
  if(label==="detail")return <DetailOverlay/>;
  return <MainApp label={label}/>;
}
