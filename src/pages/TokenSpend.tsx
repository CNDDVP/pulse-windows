import {useEffect, useRef, useState} from 'react';
import {invoke} from '@tauri-apps/api/core';

interface Row{source:string;model:string;day:string;hour:string;input:number;output:number;cache_read:number;cache_write:number;partial:boolean}
interface Summary{rows:Row[];scanned_files:number;changed_files:number;skipped_files:number;days:number;partial:boolean;cost_estimate:number|null;notes:string[];duration_ms?:number;coverage_gap?:boolean}

export function TokenSpend({ active = true }: { active?: boolean }){
  const [days,setDays]=useState(7),[result,setResult]=useState<Summary|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[group,setGroup]=useState('day');
  // A scan can take seconds; a reply for a range the user has since left must be dropped.
  const request=useRef(0);

  useEffect(() => {
    if (!active) {
      request.current++;
      setBusy(false);
      void invoke('cancel_token_spend').catch(() => {});
    }
  }, [active]);

  useEffect(() => {
    return () => {
      request.current++;
      void invoke('cancel_token_spend').catch(() => {});
    };
  }, []);

  const scan=async()=>{
    const seq=++request.current;
    setBusy(true);
    setError('');
    try{
      await invoke('cancel_token_spend');
      if (seq !== request.current) return;
      const summary=await invoke<Summary>('token_spend',{days});
      if(seq===request.current)setResult(summary)
    }catch(e){
      const errStr = String(e);
      if(seq===request.current && errStr !== '已取消' && !errStr.includes('已取消')) setError(errStr);
    }finally{
      if(seq===request.current)setBusy(false)
    }
  };

  const handleDaysChange = (newDays: number) => {
    request.current++;
    setDays(newDays);
    setResult(null);
    if (busy) {
      setBusy(false);
      void invoke('cancel_token_spend').catch(() => {});
    }
  };

  const rows=new Map<string,number[]>();for(const r of result?.rows||[]){const key=group==='model'?`${r.source} / ${r.model}`:group==='hour'?`${r.day} ${r.hour}`:r.day;const old=rows.get(key)||[0,0,0,0];rows.set(key,old.map((n,i)=>n+[r.input,r.output,r.cache_read,r.cache_write][i]));}
  return <section className="space-y-4"><h2 className="text-lg font-semibold">Token 消耗</h2><p className="text-sm text-zinc-400">读取本机使用记录，统计范围包含今天。根据已知模型公开定价估算云端费用（仅供参考）。</p><div className="flex gap-3"><select className="bg-zinc-800 p-2 rounded disabled:opacity-40" disabled={busy} value={days} onChange={e=>handleDaysChange(Number(e.target.value))}>{[7,30,90].map(d=><option key={d} value={d}>最近 {d} 天</option>)}</select><button disabled={busy} className="bg-emerald-700 px-3 rounded disabled:opacity-40" onClick={()=>void scan()}>{busy?'正在读取…':'读取使用记录'}</button><select className="bg-zinc-800 p-2 rounded" value={group} onChange={e=>setGroup(e.target.value)}><option value="day">按天</option><option value="hour">按小时</option><option value="model">按来源 / 模型</option></select></div>{busy&&<p className="text-xs text-zinc-500">首次读取需要解析本机全部近期记录，可能要十几秒到一分钟；切换页签会取消本次读取，已完成的结果会保留。</p>}{error&&<p className="text-amber-400">{error}</p>}
    {result&&<><div className="flex flex-wrap items-center gap-x-4 gap-y-1"><p className="text-zinc-400">最近 {result.days} 天：检查 {result.scanned_files} 个文件，更新 {result.changed_files} 个，跳过 {result.skipped_files} 项{result.duration_ms!=null?`（耗时 ${result.duration_ms} ms）`:''}。{result.partial?'统计不完整，请结合来源限制阅读。':''}</p>{result.cost_estimate!=null&&<span className="text-emerald-400 text-sm font-semibold bg-emerald-950/60 px-2 py-0.5 rounded border border-emerald-800/60">预估费用: ~${result.cost_estimate.toFixed(2)} USD</span>}</div>{result.coverage_gap&&<p className="text-amber-400 text-xs">检测到部分日志截断或存在统计缺口，未完整反映真实消耗。</p>}{result.notes.map((n,i)=><p key={i} className="text-xs text-zinc-500">{n}</p>)}<div className="overflow-auto"><table className="w-full text-xs text-right"><thead><tr>{['分组','输入','输出','缓存读取','缓存写入'].map(h=><th key={h} className="p-2 border-b border-zinc-700">{h}</th>)}</tr></thead><tbody>{[...rows.entries()].sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0).map(([label,counts])=><tr key={label}><td className="p-2 text-left">{label}</td>{counts.map((n,i)=><td key={i} className="p-2">{n.toLocaleString()}</td>)}</tr>)}</tbody></table></div>{!rows.size&&<p>此区间未找到可解析记录；不代表账号没有消耗。</p>}</>}
  </section>;
}
