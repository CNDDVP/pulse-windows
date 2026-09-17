import {useEffect,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {listen} from "@tauri-apps/api/event";
import {getCurrentWebviewWindow} from "@tauri-apps/api/webviewWindow";
import type {AppSettings,ProviderUsage} from "./types";
import {FloatingRail} from "./components/FloatingRail";
import {SettingsWindow} from "./pages/SettingsWindow";

function getIsSettings(): boolean {
  // The settings window is created by Rust with label "settings" on the same
  // index.html; hash/search probing would misfire on any unrelated anchor.
  try {
    return getCurrentWebviewWindow().label === "settings";
  } catch {
    return false;
  }
}

export default function App(){
  const [settings,setSettings]=useState<AppSettings|null>(null);
  const [usages,setUsages]=useState<ProviderUsage[]>([]);
  const [error,setError]=useState("");
  const isSettings = getIsSettings();
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
  return isSettings?<SettingsWindow initialSettings={settings} usages={usages} onSaved={setSettings}/>:<FloatingRail usages={usages} settings={settings}/>;
}
