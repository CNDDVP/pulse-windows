import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useLang } from "../../lib/i18n";
import { btnGhost } from "./constants";
interface UpdateStatus {
 last_result?: string; phase: string; message: string; current: string; mode: string;
 offer: {version: string; url: string; notes: string} | null;
 received: number; total: number;
 preferences: {automatic: boolean; notify: boolean; last_check: number | null};
}
export function UpdateCenter({hasDraft}: {hasDraft: () => boolean}) {
 const {t}=useLang();
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
  if(command==="update_apply" && hasDraft()){setError(t("settings.update.draft_block"));return}
  setBusy(true);setError("");
  try{await invoke(command,args);setStatus(await invoke<UpdateStatus>("update_status"))}catch(e){setError(String(e))}finally{setBusy(false)}
 }
 if(!status)return <p className="text-xs text-zinc-400">{error||t("settings.update.loading")}</p>;
 const transferring=["downloading","verifying","staging","waiting_for_exit"].includes(status.phase);
 const isLatest = status.phase === "up_to_date" || (!status.offer && status.phase !== "checking" && status.phase !== "failed");
 const mbReceived = (status.received / (1024 * 1024)).toFixed(1);
 const mbTotal = (status.total / (1024 * 1024)).toFixed(1);
 const pct = status.total > 0 ? Math.round((status.received / status.total) * 100) : 0;
 return <div className="space-y-3 text-xs text-zinc-300">
  <div className="grid grid-cols-2 gap-2 p-3 bg-zinc-900/60 rounded-lg border border-white/5">
   <div>
    <span className="text-zinc-500">{t("settings.update.current_version")}</span>
    <span className="font-mono text-zinc-200">v{status.current}</span>
   </div>
   <div>
    <span className="text-zinc-500">{t("settings.update.latest_version")}</span>
    <span className="font-mono text-zinc-200">{status.offer ? `v${status.offer.version}` : isLatest ? `✓ ${t("settings.update.up_to_date")}` : t("settings.update.checking")}</span>
   </div>
   <div className="col-span-2">
    <span className="text-zinc-500">{t("settings.update.mode_label")}</span>
    <span className="text-zinc-200">{status.mode==="portable"?t("settings.update.mode_portable"):status.mode==="installed"?t("settings.update.mode_installed"):t("settings.update.mode_advanced")}</span>
   </div>
  </div>
  <label className="flex gap-2"><input type="checkbox" checked={status.preferences.automatic} disabled={busy} onChange={e=>void act("update_preferences",{automatic:e.target.checked,notify:status.preferences.notify})}/>{t("settings.update.auto_check")}</label>
  <label className="flex gap-2"><input type="checkbox" checked={status.preferences.notify} disabled={busy} onChange={e=>void act("update_preferences",{automatic:status.preferences.automatic,notify:e.target.checked})}/>{t("settings.update.notify_new")}</label>
  {/* last_result 的枚举值里只有 awaiting_confirmation 有前端映射；其余为后端原文，原样展示。TODO(EN-backend) */}
  {status.last_result&&<p className="text-zinc-400">{t("settings.update.last_result")}{status.last_result==='awaiting_confirmation'?t("settings.update.last_result_awaiting"):status.last_result}</p>}
  {/* status.message 为 Rust 更新器 emit 的进度/结果文案，原样展示。TODO(EN-backend) */}
  <p role="status">{status.message}</p>
  {status.preferences.last_check&&<p className="text-zinc-500">{t("settings.update.last_check",{time:new Date(status.preferences.last_check*1000).toLocaleString()})}</p>}
  {status.phase==="downloading"&&status.total>0&&(
   <div className="space-y-1">
    <progress className="w-full" value={status.received} max={status.total}/>
    <div className="flex justify-between text-[11px] text-zinc-400">
     <span>{t("settings.update.progress",{pct})}</span>
     <span>{mbReceived} MB / {mbTotal} MB</span>
    </div>
   </div>
  )}
  {error&&<p role="alert" className="text-red-400">{error}</p>}
  <div className="flex flex-wrap gap-2">
   <button className={btnGhost} disabled={busy||transferring||status.phase==="ready"} onClick={()=>void act("update_check")}>{status.phase==="checking"?t("settings.update.checking_btn"):t("settings.update.check")}</button>
   {status.offer&&status.mode!=="advanced"&&status.phase!=="ready"&&<button className={btnGhost} disabled={busy||transferring} onClick={()=>void act("update_download")}>{t("settings.update.download",{version:status.offer.version})}</button>}
   {status.phase==="downloading"&&<button className={btnGhost} onClick={()=>void invoke("update_cancel").catch(e=>setError(String(e)))}>{t("settings.update.cancel_download")}</button>}
   {status.phase==="ready"&&<button className={btnGhost} disabled={busy} onClick={()=>void act("update_apply")}>{t("settings.update.apply",{version:status.offer?.version??""})}</button>}
   {status.phase==="ready"&&<button className={btnGhost} disabled={busy} onClick={()=>void act("update_discard")}>{t("settings.update.discard_upgrade")}</button>}
   <a className={btnGhost} href="https://github.com/CNDDVP/pulse-windows/releases" target="_blank" rel="noreferrer" onClick={e => { e.preventDefault(); void invoke("open_external_url", { url: "https://github.com/CNDDVP/pulse-windows/releases" }).catch(console.error); }}>{t("settings.update.release_page")}</a>
  </div>
  {/* offer.notes 来自发布通道（Rust 透传），原样展示。TODO(EN-backend) */}
  {status.offer&&<details className="mt-2 p-2 bg-zinc-900/40 rounded border border-white/5"><summary className="cursor-pointer font-medium text-zinc-300">{t("settings.update.notes_title",{version:status.offer.version})}</summary><pre className="whitespace-pre-wrap font-sans mt-2 text-zinc-400 text-xs">{status.offer.notes||t("settings.update.no_notes")}</pre></details>}
  <p className="text-zinc-500">{t("settings.update.policy_note")}</p>
 </div>;
}
