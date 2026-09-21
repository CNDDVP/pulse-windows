import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { btnGhost } from "./constants";
interface UpdateStatus {
 last_result?: string; phase: string; message: string; current: string; mode: string;
 offer: {version: string; url: string; notes: string} | null;
 received: number; total: number;
 preferences: {automatic: boolean; notify: boolean; last_check: number | null};
}
export function UpdateCenter({hasDraft}: {hasDraft: () => boolean}) {
 const [status,setStatus]=useState<UpdateStatus|null>(null);
 const [error,setError]=useState("");
 const [busy,setBusy]=useState(false);
 useEffect(()=>{
  let active=true; let revision=0; let unlisten:(()=>void)|undefined;
  void listen<UpdateStatus>("update-status",e=>{revision++;if(active)setStatus(e.payload)}).then(async stop=>{
   if(!active){stop();return} unlisten=stop;const before=revision;
   try{const state=await invoke<UpdateStatus>("update_status");if(active&&revision===before)setStatus(state)}catch(e){if(active)setError(String(e))}
  }).catch(e=>{if(active)setError(String(e))});
  return ()=>{active=false;unlisten?.()};
 },[]);
 async function act(command:string,args?:Record<string,unknown>) {
  if(command==="update_apply" && hasDraft()){setError("请先保存或放弃账号/凭据草稿，再退出升级。");return}
  setBusy(true);setError("");
  try{await invoke(command,args);setStatus(await invoke<UpdateStatus>("update_status"))}catch(e){setError(String(e))}finally{setBusy(false)}
 }
 if(!status)return <p className="text-xs text-zinc-400">{error||"读取更新状态…"}</p>;
 const transferring=["downloading","verifying","staging","waiting_for_exit"].includes(status.phase);
 const isLatest = status.phase === "up_to_date" || (!status.offer && status.phase !== "checking" && status.phase !== "failed");
 const mbReceived = (status.received / (1024 * 1024)).toFixed(1);
 const mbTotal = (status.total / (1024 * 1024)).toFixed(1);
 const pct = status.total > 0 ? Math.round((status.received / status.total) * 100) : 0;
 return <div className="space-y-3 text-xs text-zinc-300">
  <div className="grid grid-cols-2 gap-2 p-3 bg-zinc-900/60 rounded-lg border border-white/5">
   <div>
    <span className="text-zinc-500">当前版本：</span>
    <span className="font-mono text-zinc-200">v{status.current}</span>
   </div>
   <div>
    <span className="text-zinc-500">最新版本：</span>
    <span className="font-mono text-zinc-200">{status.offer ? `v${status.offer.version}` : isLatest ? `✓ 已是最新版` : "正在检查…"}</span>
   </div>
   <div className="col-span-2">
    <span className="text-zinc-500">部署模式与更新方案：</span>
    <span className="text-zinc-200">{status.mode==="portable"?"便携版（下载 ZIP 并安全替换程序文件，保留 data/）":status.mode==="installed"?"安装版（下载 Setup.exe 并覆盖安装）":"开发或自定义部署（请通过发布页面手动更新）"}</span>
   </div>
  </div>
  <label className="flex gap-2"><input type="checkbox" checked={status.preferences.automatic} disabled={busy} onChange={e=>void act("update_preferences",{automatic:e.target.checked,notify:status.preferences.notify})}/>启动后自动检查，每 2 小时再检查</label>
  <label className="flex gap-2"><input type="checkbox" checked={status.preferences.notify} disabled={busy} onChange={e=>void act("update_preferences",{automatic:status.preferences.automatic,notify:e.target.checked})}/>发现新版时通知（每版一次）</label>
  {status.last_result&&<p className="text-zinc-400">上次升级结果：{status.last_result==='awaiting_confirmation'?'等待新版启动确认':status.last_result}</p>}
  <p role="status">{status.message}</p>
  {status.preferences.last_check&&<p className="text-zinc-500">最近检查：{new Date(status.preferences.last_check*1000).toLocaleString()}</p>}
  {status.phase==="downloading"&&status.total>0&&(
   <div className="space-y-1">
    <progress className="w-full" value={status.received} max={status.total}/>
    <div className="flex justify-between text-[11px] text-zinc-400">
     <span>下载进度: {pct}%</span>
     <span>{mbReceived} MB / {mbTotal} MB</span>
    </div>
   </div>
  )}
  {error&&<p role="alert" className="text-red-400">{error}</p>}
  <div className="flex flex-wrap gap-2">
   <button className={btnGhost} disabled={busy||transferring||status.phase==="ready"} onClick={()=>void act("update_check")}>{status.phase==="checking"?"检查中...":"检查更新"}</button>
   {status.offer&&status.mode!=="advanced"&&status.phase!=="ready"&&<button className={btnGhost} disabled={busy||transferring} onClick={()=>void act("update_download")}>下载 v{status.offer.version}</button>}
   {status.phase==="downloading"&&<button className={btnGhost} onClick={()=>void invoke("update_cancel").catch(e=>setError(String(e)))}>取消下载</button>}
   {status.phase==="ready"&&<button className={btnGhost} disabled={busy} onClick={()=>void act("update_apply")}>退出并更新到 v{status.offer?.version}</button>}
   {status.phase==="ready"&&<button className={btnGhost} disabled={busy} onClick={()=>void act("update_discard")}>取消本次升级</button>}
   <a className={btnGhost} href="https://github.com/CNDDVP/pulse-windows/releases" target="_blank" rel="noreferrer" onClick={e => { e.preventDefault(); void invoke("open_external_url", { url: "https://github.com/CNDDVP/pulse-windows/releases" }).catch(console.error); }}>发布页面 / 手动下载</a>
  </div>
  {status.offer&&<details className="mt-2 p-2 bg-zinc-900/40 rounded border border-white/5"><summary className="cursor-pointer font-medium text-zinc-300">v{status.offer.version} 更新说明</summary><pre className="whitespace-pre-wrap font-sans mt-2 text-zinc-400 text-xs">{status.offer.notes||"此版本未提供说明。"}</pre></details>}
  <p className="text-zinc-500">只自动检查；下载和安装由你确认。安装版会打开安装向导。包体通过 HTTPS 和 SHA256 校验，尚未配置独立发布签名。</p>
 </div>;
}
