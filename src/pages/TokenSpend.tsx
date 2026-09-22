import {Fragment,useEffect,useRef,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
import {HourlyUsageChart} from '../components/HourlyUsageChart';
import {TrendDashboard} from '../components/TrendDashboard';
import {SubscriptionPanel} from '../components/SubscriptionPanel';
import {ScanPathsPanel} from '../components/ScanPathsPanel';
import {convertFromUsd, formatMoney, normalizeDisplayCurrency, normalizeRate, rateEstimateNote} from '../lib/currency';
import {cacheHitRate, formatHitRate, groupSpendRows, monthCoverageNote, savableSubscriptions, sumCounts} from '../lib/spend';
import type {AppSettings, ProviderUsage, SubscriptionRecord} from '../types';

interface Row{source:string;model:string;day:string;hour:string;input:number;output:number;cache_read:number;cache_write:number;partial:boolean}
interface Summary{rows:Row[];scanned_files:number;changed_files:number;skipped_files:number;days:number;partial:boolean;cost_estimate:number|null;month_cost_by_source?:Record<string,number>;notes:string[];duration_ms?:number;coverage_gap?:boolean}

export function TokenSpend({ active = true, settings, onSubscriptionsSaved, onScanPathsSaved }: { active?: boolean; settings?: AppSettings | null; onSubscriptionsSaved?: (subs: Record<string, SubscriptionRecord>) => void; onScanPathsSaved?: (paths: Record<string, string[]>) => void }){
  const [days,setDays]=useState(7),[result,setResult]=useState<Summary|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[group,setGroup]=useState('day');
  const [exporting,setExporting]=useState(''),[exported,setExported]=useState('');
  const [tab,setTab]=useState<'summary'|'trend'>('summary');
  const [stepfunUsages, setStepfunUsages] = useState<ProviderUsage[]>([]);
  // Round4 项目三：订阅记录草稿由本页持有（导出 JSON 也要带上），面板读写同一份。
  const [subs,setSubs]=useState<Record<string,SubscriptionRecord>>({});
  // Round4 项目四：按来源 / 模型分组下被展开的行（切换分组或重扫后清空）。
  const [expanded,setExpanded]=useState<ReadonlySet<string>>(new Set());
  // A slip of the rate/currency setting must never render a stale conversion: read once per render.
  const displayCurrency=normalizeDisplayCurrency(settings?.display_currency);
  const fxRate=normalizeRate(settings?.usd_cny_rate);
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
    if (active) {
      const updateSf = (usages: ProviderUsage[]) => {
        const sf = (usages || []).filter(u => u.provider_id === 'stepfun' && u.hourly_usages && u.hourly_usages.length > 0);
        setStepfunUsages(sf);
      };
      invoke<ProviderUsage[]>('get_usages')
        .then(updateSf)
        .catch(() => {});
      let unlisten: Promise<() => void> | undefined;
      try {
        unlisten = listen<ProviderUsage[]>('usages-updated', event => {
          updateSf(event.payload);
        });
      } catch (_) {}
      return () => {
        if (unlisten) {
          unlisten.then(fn => fn()).catch(() => {});
        }
      };
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
    setExported('');
    try{
      await invoke('cancel_token_spend');
      if (seq !== request.current) return;
      const summary=await invoke<Summary>('token_spend',{days});
      if(seq===request.current){setResult(summary);setExpanded(new Set());}
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
    setExported('');
    if (busy) {
      setBusy(false);
      void invoke('cancel_token_spend').catch(() => {});
    }
  };

  const handleGroupChange=(g:string)=>{
    setGroup(g);
    setExpanded(new Set());
  };

  const toggleRow=(label:string)=>setExpanded(prev=>{const next=new Set(prev);if(next.has(label))next.delete(label);else next.add(label);return next;});

  const exportRows=async(format:'csv'|'json')=>{
    if(!result?.rows.length||exporting)return;
    // 导出也纳入 request 序列：切换天数或重新扫描后，在途导出的回包不得覆盖新状态。
    const seq=++request.current;
    setExporting(format);
    setError('');
    setExported('');
    try{
      // displayCurrency 仅作口径注明；导出数值保持 USD 原值（项目二）。
      // 订阅记录随 JSON 一并输出（项目三），与保存同口径：只携带「保存会接受」的记录——
      // 价格 ≤0 的未登记草稿，以及周期需 1~366 等会被后端拒绝的草稿，都不进导出文件。
      const savedSubs=savableSubscriptions(subs);
      const path=await invoke<string>('export_ledger',{rows:result.rows,format,displayCurrency,subscriptions:savedSubs});
      if(seq===request.current)setExported(path);
    }catch(e){
      if(seq===request.current)setError(String(e));
    }finally{
      setExporting('');
    }
  };

  const rows=groupSpendRows(result?.rows||[],group as 'day'|'hour'|'model');
  const sorted=[...rows.entries()].sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
  const total=rows.size?sumCounts([...rows.values()]):null;
  const totalRate=total?formatHitRate(cacheHitRate(total)):null;
  const costNote=rateEstimateNote(displayCurrency,fxRate);
  const monthNote=result?monthCoverageNote(result.days):null;
  return <section className="space-y-4"><h2 className="text-lg font-semibold">Token 消耗</h2><p className="text-sm text-zinc-400">读取本机使用记录，统计范围包含今天。根据已知模型公开定价估算云端费用（仅供参考）。</p><div className="flex gap-1 bg-zinc-900/60 rounded-lg p-1 w-fit border border-white/5"><button className={`px-3 py-1 rounded-md text-sm cursor-pointer ${tab==='summary'?'bg-zinc-800 text-zinc-100':'text-zinc-400 hover:text-zinc-200'}`} onClick={()=>setTab('summary')}>汇总</button><button className={`px-3 py-1 rounded-md text-sm cursor-pointer ${tab==='trend'?'bg-zinc-800 text-zinc-100':'text-zinc-400 hover:text-zinc-200'}`} onClick={()=>setTab('trend')}>趋势</button></div><div className={tab==='summary'?'space-y-4':'hidden'}><SubscriptionPanel subs={subs} onSubsChange={setSubs} onSaved={onSubscriptionsSaved} monthCostBySource={result?.month_cost_by_source??null} monthCoverageNote={monthNote} displayCurrency={displayCurrency} fxRate={fxRate} /><ScanPathsPanel onSaved={onScanPathsSaved} /><div className="flex gap-3"><select className="bg-zinc-800 p-2 rounded disabled:opacity-40" disabled={busy} value={days} onChange={e=>handleDaysChange(Number(e.target.value))}>{[7,30,90].map(d=><option key={d} value={d}>最近 {d} 天</option>)}</select><button disabled={busy} className="bg-emerald-700 px-3 rounded disabled:opacity-40" onClick={()=>void scan()}>{busy?'正在读取…':'读取使用记录'}</button><select className="bg-zinc-800 p-2 rounded" value={group} onChange={e=>handleGroupChange(e.target.value)}><option value="day">按天</option><option value="hour">按小时</option><option value="model">按来源 / 模型</option></select><button disabled={busy||!result?.rows.length||!!exporting} className="bg-zinc-800 px-3 rounded disabled:opacity-40" onClick={()=>void exportRows('csv')}>{exporting==='csv'?'正在导出…':'导出 CSV'}</button><button disabled={busy||!result?.rows.length||!!exporting} className="bg-zinc-800 px-3 rounded disabled:opacity-40" onClick={()=>void exportRows('json')}>{exporting==='json'?'正在导出…':'导出 JSON'}</button></div>{busy&&<p className="text-xs text-zinc-500">首次读取需要解析本机全部近期记录，可能要十几秒到一分钟；切换到其他页面会取消本次读取（页内「汇总 / 趋势」切换不会），已完成的结果会保留。</p>}{error&&<p className="text-amber-400">{error}</p>}{exported&&<p className="text-xs text-emerald-400 break-all">已导出到 {exported}</p>}
    {result&&<><div className="flex flex-wrap items-center gap-x-4 gap-y-1"><p className="text-zinc-400">最近 {result.days} 天：检查 {result.scanned_files} 个文件，更新 {result.changed_files} 个，跳过 {result.skipped_files} 项{result.duration_ms!=null?`（耗时 ${result.duration_ms} ms）`:''}。{result.partial?'统计不完整，请结合来源限制阅读。':''}</p>{result.cost_estimate!=null&&<span className="text-emerald-400 text-sm font-semibold bg-emerald-950/60 px-2 py-0.5 rounded border border-emerald-800/60">预估费用: ~{formatMoney(convertFromUsd(result.cost_estimate,displayCurrency,fxRate),displayCurrency)} {displayCurrency}</span>}{result.cost_estimate!=null&&costNote&&<span className="text-[11px] text-zinc-500">{costNote}（原始估算为 USD）</span>}</div>{result.coverage_gap&&<p className="text-amber-400 text-xs">检测到部分日志截断或存在统计缺口，未完整反映真实消耗。</p>}{result.notes.map((n,i)=><p key={i} className="text-xs text-zinc-500">{n}</p>)}<div className="overflow-auto"><table className="w-full text-xs text-right"><thead><tr>{['分组','输入','输出','缓存读取','缓存写入'].map(h=><th key={h} className="p-2 border-b border-zinc-700">{h}</th>)}</tr></thead><tbody>{sorted.map(([label,counts])=>{
      const hit=formatHitRate(cacheHitRate(counts));
      const open=group==='model'&&expanded.has(label);
      return <Fragment key={label}>
        <tr>
          <td className="p-2 text-left">{group==='model'?<button type="button" aria-expanded={open} className="cursor-pointer text-zinc-300 hover:text-zinc-100 text-left" onClick={()=>toggleRow(label)}>{open?'▾':'▸'} {label}</button>:label}</td>
          {(['input','output','cache_read','cache_write'] as const).map(k=><td key={k} className="p-2">{counts[k].toLocaleString()}</td>)}
        </tr>
        {open&&<tr className="bg-zinc-900/40"><td colSpan={5} className="p-2 text-left text-zinc-400">输入 {counts.input.toLocaleString()} · 输出 {counts.output.toLocaleString()} · 缓存读取 {counts.cache_read.toLocaleString()} · 缓存写入 {counts.cache_write.toLocaleString()}{hit?` · 缓存命中率 ${hit}`:''}</td></tr>}
      </Fragment>;
    })}{group==='model'&&total&&<tr className="border-t border-zinc-700"><td className="p-2 text-left font-semibold text-zinc-200">合计{totalRate?` · 全窗口缓存命中率 ${totalRate}`:''}</td>{(['input','output','cache_read','cache_write'] as const).map(k=><td key={k} className="p-2 font-semibold text-zinc-200">{total[k].toLocaleString()}</td>)}</tr>}</tbody></table></div>{group==='model'&&<p className="text-[11px] text-zinc-500">缓存命中率 = cache_read / (输入 + 缓存读取 + 输出)；缓存写入不计入分母，分母为 0 的行不显示命中率。点行首 ▸ 展开该来源 / 模型的四分项明细。</p>}{!rows.size&&<p>此区间未找到可解析记录；不代表账号没有消耗。</p>}</>}
    {stepfunUsages.length > 0 && (
      <div className="space-y-3 pt-2">
        {stepfunUsages.map(u => (
          <div key={u.account_id} className="p-4 bg-zinc-900/60 rounded-xl border border-white/5 space-y-2">
            <div className="flex justify-between items-center">
              <h3 className="text-sm font-semibold text-zinc-200">{u.display_name} · 24小时积分明细</h3>
              <span className="text-xs text-zinc-400">{u.plan_name}</span>
            </div>
            {u.hourly_usages && <HourlyUsageChart usages={u.hourly_usages} />}
          </div>
        ))}
      </div>
    )}
    </div>
    <div className={tab === 'trend' ? '' : 'hidden'}><TrendDashboard active={tab === 'trend'} /></div>
  </section>;
}
