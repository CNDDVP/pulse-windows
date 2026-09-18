import {useEffect,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {listen} from "@tauri-apps/api/event";
import {getCurrentWebviewWindow} from "@tauri-apps/api/webviewWindow";
import type {AppSettings,ProviderUsage} from "./types";
import {FloatingRail} from "./components/FloatingRail";
import {UsageDetailCard} from "./components/UsageDetailCard";
import {SettingsWindow} from "./pages/SettingsWindow";
import {emit} from "@tauri-apps/api/event";

function windowLabel(): string {
  try { return getCurrentWebviewWindow().label; } catch { return "main"; }
}

/** The free-mode hover card lives in its own overlay window ("detail"); Rust tells it
 *  which account to draw via the "detail-account" event. */
function DetailOverlay() {
  const [usages,setUsages]=useState<ProviderUsage[]|null>(null);
  const [accountId,setAccountId]=useState<string|null>(null);
  const [settings,setSettings]=useState<AppSettings|null>(null);
  useEffect(()=>{
    let alive=true;
    const a=listen<string>("detail-account",e=>{if(alive)setAccountId(e.payload)});
    const b=listen<ProviderUsage[]>("usages-updated",e=>{if(alive)setUsages(e.payload)});
    void invoke<ProviderUsage[]>("get_usages").then(u=>{if(alive)setUsages(u)}).catch(()=>{});
    void invoke<AppSettings>("get_settings").then(x=>{if(alive)setSettings(x)}).catch(()=>{});
    return()=>{alive=false;void a.then(f=>f());void b.then(f=>f())};
  },[]);
  const usage=usages?.find(u=>u.account_id===accountId);
  return <div className="w-full h-full p-2" onMouseEnter={()=>void emit("detail-pointer",true)} onMouseLeave={()=>void emit("detail-pointer",false)}
    onContextMenu={e=>e.preventDefault()}>
    {usage&&settings?<UsageDetailCard usage={usage} settings={settings}/>:null}
  </div>;
}


export default function App(){
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
  const label=windowLabel();
  if(label==="detail")return <DetailOverlay/>;
  if(error)return <div className="p-4 bg-zinc-900 text-amber-300 text-sm">{error}</div>;
  if(!settings)return <div className="p-3 bg-zinc-900 text-zinc-400 text-xs">正在加载…</div>;
  return label==="settings"?<SettingsWindow initialSettings={settings} usages={usages} onSaved={setSettings}/>:<FloatingRail usages={usages} settings={settings}/>;
}
