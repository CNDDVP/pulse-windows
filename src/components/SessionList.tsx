import {useEffect,useRef,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {SPEND_SOURCES} from '../lib/spend';
import {convertFromUsd,formatMoney,type DisplayCurrency} from '../lib/currency';

// Round5B 项目一：会话级明细（会话 = 一个转录文件，或 ZCode CLI 库的一个 session 键）。
// 隐私边界：列表/明细只含统计字段、文件名尾段与 CLI session 键等元数据，不读取、不展示转录正文。
export interface SessionRow{source:string;path:string;session:string|null;title:string;note:string|null;first_ts:number;last_ts:number;input:number;output:number;cache_read:number;cache_write:number;cost_estimate:number|null;events:number;models:number}
export interface SessionEvent{ts:number;model:string;input:number;output:number;cache_read:number;cache_write:number}
export interface SessionDetail{path:string;total:number;truncated:boolean;events:SessionEvent[]}

export const SESSION_PAGE_SIZE=50;
const SESSION_DETAIL_CAP=500;

const pad=(n:number)=>String(n).padStart(2,'0');
const one=(d:Date)=>`${d.getMonth()+1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
/** 会话时间（本地时区 MM-DD HH:mm）；首末相同只显示一个时点。 */
function formatSessionRange(firstTs:number,lastTs:number):string{
  const f=new Date(firstTs*1000),l=new Date(lastTs*1000);
  return Number.isFinite(f.getTime())&&Number.isFinite(l.getTime())?(firstTs===lastTs?one(f):`${one(f)} ~ ${one(l)}`):'—';
}
const totalTokens=(r:SessionRow)=>r.input+r.output+r.cache_read+r.cache_write;

type DetailState={status:'loading'}|{status:'error';message:string}|{status:'ready';data:SessionDetail};

export function SessionList({active,displayCurrency,fxRate}:{active:boolean;displayCurrency:DisplayCurrency;fxRate:number}){
  const [source,setSource]=useState('');
  const [rows,setRows]=useState<SessionRow[]|null>(null);
  const [loading,setLoading]=useState(false);
  // 末页不满一页（或空页）即没有更多；满页时仍可能到尾，点「加载更多」由空页收敛。
  const [exhausted,setExhausted]=useState(true);
  const [error,setError]=useState('');
  const [open,setOpen]=useState<ReadonlySet<string>>(new Set());
  const [details,setDetails]=useState<Record<string,DetailState>>({});
  // 请求序号守卫：invoke 无法取消，「加载更多」与首页 effect（切换来源/激活会重置列表）共用
  // 同一序号——迟到的旧回包不得把旧筛选的页数据 append 进新列表、也不得清掉新请求的 loading。
  const seq=useRef(0);
  useEffect(()=>{
    if(!active)return;
    const my=++seq.current;
    setError('');setRows(null);setOpen(new Set());setDetails({});setExhausted(true);setLoading(true);
    invoke<SessionRow[]>('token_spend_sessions',{source:source||null,offset:0,limit:SESSION_PAGE_SIZE})
      .then(r=>{if(seq.current===my){setRows(r);setExhausted(r.length<SESSION_PAGE_SIZE);}})
      .catch(e=>{if(seq.current===my)setError(String(e));})
      .finally(()=>{if(seq.current===my)setLoading(false);});
    return()=>{
      // 失效写入：依赖变化/失活/卸载时令在途回包过期（与 ProviderStatus 的 stale ref 同角色）。
      // eslint-disable-next-line react-hooks/exhaustive-deps
      seq.current++;
    };
  },[active,source]);
  const loadMore=async()=>{
    if(!rows||loading||exhausted)return;
    const my=++seq.current;
    setLoading(true);setError('');
    try{
      const more=await invoke<SessionRow[]>('token_spend_sessions',{source:source||null,offset:rows.length,limit:SESSION_PAGE_SIZE});
      if(seq.current!==my)return;
      setRows(prev=>prev?[...prev,...more]:more);
      setExhausted(more.length<SESSION_PAGE_SIZE);
    }catch(e){if(seq.current===my)setError(String(e));}
    finally{if(seq.current===my)setLoading(false);}
  };
  const toggle=async(path:string)=>{
    const next=new Set(open);
    if(next.has(path)){next.delete(path);setOpen(next);return;}
    next.add(path);setOpen(next);
    // 懒加载：展开时才取明细；已加载过（就绪/失败/加载中）不重复 invoke。
    if(details[path])return;
    setDetails(prev=>({...prev,[path]:{status:'loading'}}));
    try{
      const data=await invoke<SessionDetail>('token_spend_session_detail',{path});
      setDetails(prev=>({...prev,[path]:{status:'ready',data}}));
    }catch(e){
      setDetails(prev=>({...prev,[path]:{status:'error',message:String(e)}}));
    }
  };
  if(!active)return null;
  return <div className="space-y-3">
    <div className="flex items-center gap-3">
      <select aria-label="会话来源筛选" className="bg-zinc-800 p-2 rounded" value={source} onChange={e=>setSource(e.target.value)}>
        <option value="">全部来源</option>
        {SPEND_SOURCES.map(([v,label])=><option key={v} value={v}>{label}</option>)}
      </select>
      <span className="text-xs text-zinc-500">会话 = 一个转录文件（ZCode CLI 库按其 session 键拆分）；只统计元数据，不读取转录正文。</span>
    </div>
    {error&&<p className="text-amber-400">{error}</p>}
    {loading&&<p className="text-xs text-zinc-500">正在读取会话…</p>}
    {rows&&!rows.length&&!loading&&<p className="text-sm text-zinc-400">暂无会话记录；请先在「汇总」页读取使用记录（统计开启时本页直接读取本地账本缓存）。</p>}
    {rows&&rows.length>0&&<div className="overflow-auto"><table className="w-full text-xs text-right">
      <thead><tr>{['会话','来源','时间','模型','事件','Tokens','成本'].map(h=><th key={h} className="p-2 border-b border-zinc-700">{h}</th>)}</tr></thead>
      <tbody>{rows.map(r=>{
        const isOpen=open.has(r.path);
        const detail=details[r.path];
        return <FragmentRow key={r.path} row={r} open={isOpen} onToggle={()=>void toggle(r.path)} detail={detail} displayCurrency={displayCurrency} fxRate={fxRate} cap={SESSION_DETAIL_CAP}/>;
      })}</tbody>
    </table></div>}
    {rows&&rows.length>0&&!exhausted&&<button disabled={loading} className="bg-zinc-800 px-3 py-1 rounded text-sm disabled:opacity-40" onClick={()=>void loadMore()}>{loading?'正在加载…':'加载更多'}</button>}
  </div>;
}

function FragmentRow({row,open,onToggle,detail,displayCurrency,fxRate,cap}:{row:SessionRow;open:boolean;onToggle:()=>void;detail?:DetailState;displayCurrency:DisplayCurrency;fxRate:number;cap:number}){
  return <>
    <tr>
      <td className="p-2 text-left max-w-[16rem]">
        <button type="button" aria-expanded={open} title={row.note??row.title} className="cursor-pointer text-zinc-300 hover:text-zinc-100 text-left block w-full truncate" onClick={onToggle}>{open?'▾':'▸'} {row.title}</button>
        {row.note&&<span className="block text-[11px] text-amber-400">{row.note}</span>}
      </td>
      <td className="p-2">{row.source}</td>
      <td className="p-2 whitespace-nowrap">{formatSessionRange(row.first_ts,row.last_ts)}</td>
      <td className="p-2">{row.models.toLocaleString()}</td>
      <td className="p-2">{row.events.toLocaleString()}</td>
      <td className="p-2" title={`输入 ${row.input.toLocaleString()} · 输出 ${row.output.toLocaleString()} · 缓存读取 ${row.cache_read.toLocaleString()} · 缓存写入 ${row.cache_write.toLocaleString()}`}>{totalTokens(row).toLocaleString()}</td>
      <td className="p-2">{row.cost_estimate==null?'—':formatMoney(convertFromUsd(row.cost_estimate,displayCurrency,fxRate),displayCurrency)}</td>
    </tr>
    {open&&<tr className="bg-zinc-900/40"><td colSpan={7} className="p-2 text-left">
      {(!detail||detail.status==='loading')&&<p className="text-xs text-zinc-500">正在加载明细…</p>}
      {detail?.status==='error'&&<p className="text-xs text-amber-400">{detail.message}</p>}
      {detail?.status==='ready'&&<div className="space-y-1">
        <p className="text-xs text-zinc-400">共 {detail.data.total.toLocaleString()} 条事件{detail.data.truncated?`；已达单会话明细上限 ${cap} 条，仅显示最早 ${detail.data.events.length} 条（已截断）`:''}。</p>
        {detail.data.events.length>0&&<table className="w-full text-xs text-right"><thead><tr>{['时间','模型','输入','输出','缓存读取','缓存写入'].map(h=><th key={h} className="p-1 border-b border-zinc-800">{h}</th>)}</tr></thead>
          <tbody>{detail.data.events.map((e,i)=><tr key={i}><td className="p-1 whitespace-nowrap">{formatSessionRange(e.ts,e.ts)}</td><td className="p-1">{e.model}</td><td className="p-1">{e.input.toLocaleString()}</td><td className="p-1">{e.output.toLocaleString()}</td><td className="p-1">{e.cache_read.toLocaleString()}</td><td className="p-1">{e.cache_write.toLocaleString()}</td></tr>)}</tbody>
        </table>}
      </div>}
    </td></tr>}
  </>;
}
