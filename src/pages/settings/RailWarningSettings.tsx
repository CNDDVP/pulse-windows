import {useEffect,useState,useMemo} from 'react';
import {listen} from '@tauri-apps/api/event';
import type {AppSettings,ProviderUsage,RailWarnings,RailAccountRule} from '../../types';
import {defaultRailWarnings,defaultAccountRule,railConfig,evaluateRail,levelColor,levelName,formatTimeAgo,type RailResult} from '../../railWarnings';
import {useLang} from '../../lib/i18n';
import {Section,Field} from './shared';
import {selectCls,inputCls,btnGhost} from './constants';

function Thresholds({yellow,red,money,label,onPreview,onSave}:{yellow:number;red:number;money?:boolean;label:string;onPreview:(yellow:number,red:number)=>void;onSave:(yellow:number,red:number)=>void}) {
  const {t}=useLang();
  const [values,setValues]=useState([String(yellow),String(red)]);
  useEffect(()=>setValues([String(yellow),String(red)]),[yellow,red]);
  const parsed=values.map(Number),valid=values.every(v=>v.trim()!==''&&Number.isFinite(Number(v))) &&
    (money?0<=parsed[1]&&parsed[1]<parsed[0]:0<parsed[0]&&parsed[0]<parsed[1]&&parsed[1]<=100);
  return <div className="space-y-2"><div className="grid grid-cols-2 gap-2">{[t('settings.railwarn.yellow'),t('settings.railwarn.red')].map((name,i)=><label key={name} className="text-xs text-zinc-400">{name}：{money?t('settings.railwarn.money_prefix'):t('settings.railwarn.pct_prefix')}
    <div className="flex items-center gap-1 mt-0.5"><input className={inputCls} type="number" step={money?'0.01':'1'} min="0" max={money?undefined:100} aria-label={t('settings.railwarn.threshold_aria',{label,name})} value={values[i]} aria-invalid={!valid}
      onChange={e=>{const next=values.map((v,j)=>j===i?e.target.value:v);setValues(next);const [y,r]=next.map(Number);
        if(next.every(v=>v.trim()!==''&&Number.isFinite(Number(v)))&&(money?0<=r&&r<y:0<y&&y<r&&r<=100))onPreview(y,r);}}
      onBlur={()=>{if(valid)onSave(parsed[0],parsed[1])}}/>{!money&&<span>%</span>}</div></label>)}</div>
    {!valid&&<p role="alert" className="text-amber-400 text-xs">{money?t('settings.railwarn.invalid_money'):t('settings.railwarn.invalid_pct')}</p>}
    <p className="text-xs text-zinc-500">{t('settings.railwarn.preview_then_save')}</p></div>;
}

export function RailWarningSettings({settings,usages,update,busy,onRefreshAll}:{settings:AppSettings;usages:ProviderUsage[];update:(p:Partial<AppSettings>)=>void;busy:boolean;onRefreshAll:()=>Promise<void>}) {
  const {t}=useLang();
  const config=useMemo(()=>railConfig(settings),[settings]),[draft,setDraft]=useState<RailWarnings>(config);
  const [actual,setActual]=useState<RailResult|null>(null),[now,setNow]=useState(Date.now);
  const [currency,setCurrency]=useState<Record<string,string>>({});
  const [colorDraft,setColorDraft]=useState(settings.collapsed_bar_color||'#7AA5FF');
  useEffect(()=>setColorDraft(settings.collapsed_bar_color||'#7AA5FF'),[settings.collapsed_bar_color]);
  const validColor=/^#[0-9a-fA-F]{6}$/.test(colorDraft);
  useEffect(()=>setDraft(config),[config]); // saved/rolled-back configuration
  useEffect(()=>{const t=setInterval(()=>setNow(Date.now()),1000);const stop=listen<RailResult>('rail-warning-state',e=>setActual(e.payload));return()=>{clearInterval(t);void stop.then(f=>f())}},[]);
  const commit=(next:RailWarnings)=>{setDraft(next);update({rail_warnings:next})};
  const changeRule=(id:string,patch:Partial<RailAccountRule>,save=true)=>{
    const next={...draft,accounts:{...draft.accounts,[id]:{...(draft.accounts[id]??defaultAccountRule()),...patch}}};
    if(save)commit(next);else setDraft(next);
  };
  const result=evaluateRail({...settings,rail_warnings:draft},usages,now);
  const mode=settings.collapsed_bar_color_mode??'auto';
  const ids=[...new Set([...Object.keys(settings.providers),...draft.account_ids,...Object.keys(draft.accounts)])];
  // levelName/shortReason/reason 与 formatTimeAgo 来自 railWarnings.ts（悬浮栏域共享库），本轮保持库内文案，原样展示。
  return <Section title={t('settings.railwarn.title')} icon="🎨" subtitle={t('settings.railwarn.subtitle')}>
    <Field label={t('settings.railwarn.color_mode')}><select aria-label={t('settings.railwarn.color_mode_aria')} className={selectCls} value={mode} disabled={busy} onChange={e=>update({collapsed_bar_color_mode:e.target.value as 'auto'|'custom'|'rainbow'})}>
      <option value="auto">{t('settings.railwarn.mode_auto')}</option><option value="custom">{t('settings.railwarn.mode_custom')}</option><option value="rainbow">{t('settings.railwarn.mode_rainbow_option')}</option></select></Field>
    {mode==='custom'&&<Field label={t('settings.railwarn.fixed_color')}><div className="flex gap-2 items-center flex-wrap">
      <input aria-label={t('settings.railwarn.fixed_color_aria')} type="color" value={settings.collapsed_bar_color||'#7AA5FF'} disabled={busy} onChange={e=>update({collapsed_bar_color:e.target.value})}/>
      <input aria-label={t('settings.railwarn.hex_aria')} className={`${inputCls} max-w-32`} maxLength={7} value={colorDraft} onChange={e=>setColorDraft(e.target.value)} onBlur={()=>{if(validColor)update({collapsed_bar_color:colorDraft})}} aria-invalid={!validColor}/>
      {['#7AA5FF','#10B981','#8B5CF6','#EC4899','#F97316','#38BDF8'].map(color=><button key={color} aria-label={t('settings.railwarn.pick_color_aria',{color})} title={color} disabled={busy} className="w-6 h-6 rounded-full border border-white/20" style={{background:color}} onClick={()=>update({collapsed_bar_color:color})}/>)}
      {!validColor&&<p role="alert" className="text-amber-400 text-xs">{t('settings.railwarn.invalid_color')}</p>}
    </div></Field>}
    <div className="p-4 rounded-xl bg-black/20 border border-white/10 space-y-3" aria-label={t('settings.railwarn.preview_aria')}>
      <div className="flex items-center gap-3">
        <div className={`w-2 h-10 rounded-full transition-all duration-300 ${
          mode === 'rainbow' && !settings.reduce_motion ? 'rail-rainbow' : ''
        }`} style={{
          background: mode === 'custom'
            ? (validColor ? colorDraft : settings.collapsed_bar_color || '#7AA5FF')
            : mode === 'rainbow'
            ? '#10b981'
            : levelColor[result.level],
          boxShadow: mode === 'custom'
            ? `0 0 8px ${validColor ? colorDraft : settings.collapsed_bar_color || '#7AA5FF'}`
            : mode === 'rainbow'
            ? undefined
            : `0 0 8px ${levelColor[result.level]}`,
        }}/>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium flex items-center gap-2">
            <span>{t('settings.railwarn.current_result')}</span>
            <span className="font-semibold" style={{
              color: mode === 'custom' ? (validColor ? colorDraft : '#7AA5FF') : mode === 'rainbow' ? '#34d399' : levelColor[result.level]
            }}>
              {mode === 'auto' ? levelName[result.level] : mode === 'custom' ? t('settings.railwarn.mode_custom') : t('settings.railwarn.mode_rainbow')}
            </span>
            {mode !== 'auto' && <span className="text-xs text-zinc-500 font-normal">{t('settings.railwarn.not_risk')}</span>}
          </div>
          {mode === 'auto' && (
            <p className="text-xs text-zinc-400 mt-0.5 truncate">{result.shortReason}</p>
          )}
        </div>
      </div>

      {mode === 'auto' && (
        <div className="border-t border-white/5 pt-2.5 space-y-2 text-xs">
          {(result.level === 'yellow' || result.level === 'red') && (
            <div className="bg-white/5 rounded-lg p-2.5 space-y-1">
              <div className="font-medium text-zinc-300 mb-1">{t('settings.railwarn.trigger_detail')}</div>
              {result.sources.filter(s => s.level === result.level).map((s, i) => (
                <div key={i} className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-zinc-400">
                  <div>{t('settings.railwarn.trigger_account')}<span className="text-zinc-200">{s.name}</span></div>
                  <div>
                    {s.type === 'balance' ? t('settings.railwarn.currency_label') : t('settings.railwarn.window_label')}
                    <span className="text-zinc-200">{s.type === 'balance' ? s.currency : s.windowName || t('settings.railwarn.default_window')}</span>
                  </div>
                  <div>
                    {s.type === 'balance' ? t('settings.railwarn.current_balance') : t('settings.railwarn.used_label')}
                    <span className="text-zinc-200">{s.type === 'balance' ? `${s.currency} ${s.amount?.toFixed(2)}` : `${Number(s.usedPercent?.toFixed(1))}%`}</span>
                  </div>
                  <div>
                    {t('settings.railwarn.level_threshold',{level:levelName[result.level]})}
                    <span className="text-zinc-200">{s.type === 'balance' ? `≤ ${result.level === 'red' ? s.redThreshold : s.yellowThreshold}` : `${result.level === 'red' ? s.redThreshold : s.yellowThreshold}%`}</span>
                  </div>
                  <div className="col-span-2 text-zinc-500">
                    {t('settings.railwarn.updated_at')}<span>{formatTimeAgo(s.updated, now)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-wrap gap-x-4 gap-y-1 text-zinc-400">
            <span>{t('settings.railwarn.rated_prefix')}<strong className="text-zinc-200">{new Set(result.sources.filter(s => s.level !== 'unknown').map(s => s.account)).size}</strong>{t('settings.railwarn.rated_suffix')}</span>
            {result.excluded.length > 0 && (
              <span>{t('settings.railwarn.excluded_line',{n:result.excluded.length})}</span>
            )}
            {result.sources.some(s => s.level === 'unknown') && (
              <span className="text-amber-400/90">{t('settings.railwarn.unknown_line',{n:new Set(result.sources.filter(s => s.level === 'unknown').map(s => s.account)).size})}</span>
            )}
          </div>

          {result.excluded.length > 0 && (
            <div className="text-zinc-500 space-y-0.5">
              {result.excluded.map(x => <div key={x}>• {x}</div>)}
            </div>
          )}

          {result.sources.filter(s => s.level === 'unknown').length > 0 && (
            <div className="text-amber-400/80 space-y-0.5">
              {result.sources.filter(s => s.level === 'unknown').map((s, i) => (
                <div key={i}>• {s.name}：{s.reason}</div>
              ))}
            </div>
          )}

          {actual && (
            <div className="border-t border-white/5 pt-1.5 text-zinc-400 flex items-center justify-between">
              <span>{t('settings.railwarn.actual_rail')}<span style={{ color: levelColor[actual.level] }}>{levelName[actual.level]}</span> · {actual.shortReason || actual.reason}</span>
            </div>
          )}

          <p className="text-[11px] text-zinc-500">
            {t('settings.railwarn.hysteresis_note')}
          </p>
        </div>
      )}
    </div>
    {mode==='auto'&&<>
      <Field label={t('settings.railwarn.scope_label')}><select aria-label={t('settings.railwarn.scope_aria')} className={selectCls} value={draft.scope} disabled={busy} onChange={e=>commit({...draft,scope:e.target.value as 'all'|'selected'})}>
        <option value="all">{t('settings.railwarn.scope_all')}</option><option value="selected">{t('settings.railwarn.scope_selected')}</option></select></Field>
      <Field label={t('settings.railwarn.pct_threshold_label')}><select aria-label={t('settings.railwarn.pct_threshold_aria')} className={selectCls} disabled={busy} value={draft.custom_thresholds?'custom':'default'} onChange={e=>commit({...draft,custom_thresholds:e.target.value==='custom'})}>
        <option value="default">{t('settings.railwarn.pct_default')}</option><option value="custom">{t('settings.railwarn.pct_custom')}</option></select></Field>
      {draft.custom_thresholds&&<Thresholds label={t('settings.railwarn.pct_label')} yellow={draft.yellow} red={draft.red} onPreview={(yellow,red)=>setDraft({...draft,yellow,red})} onSave={(yellow,red)=>commit({...draft,yellow,red})}/>}
      <p className="text-xs text-zinc-500">{t('settings.railwarn.aggregate_note')}</p>
      {ids.map(id=>{
        const account=settings.providers[id],rule=draft.accounts[id]??defaultAccountRule(),usage=usages.find(u=>u.account_id===id);
        const selected=draft.scope==='all'?!!account?.enabled:draft.account_ids.includes(id);
        const standardBalances=(usage?.balances??[]).filter(b=>/^[A-Z]{3}$/.test(b.currency));
        const nonCurrencyBalances=(usage?.balances??[]).filter(b=>!/^[A-Z]{3}$/.test(b.currency));
        const detectedCurrencies=[...new Set([...standardBalances.map(b=>b.currency),...Object.keys(rule.balances)])];
        const hasWindows=(usage?.windows?.length??0)>0;
        return <div key={id} className="p-3 rounded-xl border border-white/10 space-y-3">
          <div className="flex items-center justify-between">
            <label className="flex gap-2 items-center"><input type="checkbox" checked={selected} disabled={busy||draft.scope==='all'} onChange={e=>commit({...draft,account_ids:e.target.checked?[...draft.account_ids,id]:draft.account_ids.filter(x=>x!==id)})}/>
              <span className="font-medium">{account?.label||id}</span>
              {!account?<span className="text-xs text-red-400">{t('settings.railwarn.deleted_note')}</span>:!account.enabled?<span className="text-xs text-zinc-500">{t('settings.railwarn.disabled_note')}</span>:null}
            </label>
            {!hasWindows&&usage?.balances?.length?<span className="text-xs px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-700">{t('settings.railwarn.balance_badge')}</span>:null}
          </div>
          {selected&&<>{hasWindows?(
            <>
              <select aria-label={t('settings.railwarn.source_aria',{label:account?.label||id})} className={selectCls} disabled={busy} value={rule.mode} onChange={e=>changeRule(id,{mode:e.target.value as RailAccountRule['mode'],window_id:e.target.value==='window'?(rule.window_id||usage?.windows[0]?.id||null):rule.window_id})}>
                <option value="primary">{t('settings.railwarn.src_primary')}</option><option value="all">{t('settings.railwarn.src_all')}</option><option value="window" disabled={!usage?.windows.length&&!rule.window_id}>{t('settings.railwarn.src_window')}</option>
              </select>
              {rule.mode==='window'&&<select aria-label={t('settings.railwarn.src_window')} className={selectCls} value={rule.window_id??''} disabled={busy} onChange={e=>changeRule(id,{window_id:e.target.value})}>
                {rule.window_id&&!usage?.windows.some(w=>w.id===rule.window_id)&&<option value={rule.window_id}>{t('settings.railwarn.window_unavailable',{id:rule.window_id})}</option>}
                {usage?.windows.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}
              </select>}
            </>
          ):null}

            {/* 余额预警配置 */}
            <div className="space-y-2 border-t border-white/5 pt-2">
              <div className="text-xs font-medium text-zinc-400">{t('settings.railwarn.balance_section')}</div>
              {detectedCurrencies.map(code=>{
                const balanceObj=usage?.balances?.find(b=>b.currency===code);
                const isConfigured=!!rule.balances[code];
                return <div key={code} className="p-2.5 rounded-lg bg-white/5 space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-zinc-300">
                      {t('settings.railwarn.balance_line',{code,amount:balanceObj?balanceObj.amount.toFixed(2):'--'})}
                      {!isConfigured&&<span className="text-zinc-500 ml-1.5 font-normal">{t('settings.railwarn.not_in_color')}</span>}
                    </span>
                    {isConfigured?(
                      <button className={btnGhost} disabled={busy} onClick={()=>{const balances={...rule.balances};delete balances[code];changeRule(id,{balances})}}>{t('settings.railwarn.disable_alert')}</button>
                    ):(
                      <button className={btnGhost} disabled={busy} onClick={()=>changeRule(id,{balances:{...rule.balances,[code]:{yellow:20,red:5}}})}>{t('settings.railwarn.enable_alert')}</button>
                    )}
                  </div>
                  {isConfigured&&rule.balances[code]&&(
                    <Thresholds money label={`${id} ${code}`} {...rule.balances[code]} onPreview={(yellow,red)=>changeRule(id,{balances:{...rule.balances,[code]:{yellow,red}}},false)} onSave={(yellow,red)=>changeRule(id,{balances:{...rule.balances,[code]:{yellow,red}}})}/>
                  )}
                </div>;
              })}

              {/* 非标准货币（积分/Token等）提示 */}
              {nonCurrencyBalances.map(b=>(
                <div key={b.currency} className="p-2 rounded bg-amber-500/10 border border-amber-500/20 text-xs text-amber-300 flex items-center justify-between">
                  <span>{b.currency}：{b.amount}</span>
                  <span className="text-[11px] text-amber-400/80">{t('settings.railwarn.unsupported_unit')}</span>
                </div>
              ))}

              <div className="flex gap-2 items-center pt-1">
                <input className={inputCls} aria-label={t('settings.railwarn.currency_input_aria',{id})} placeholder={t('settings.railwarn.currency_ph')} maxLength={3} list={`currencies-${id}`} value={currency[id]??''} onChange={e=>setCurrency({...currency,[id]:e.target.value.toUpperCase()})}/>
                <datalist id={`currencies-${id}`}>{detectedCurrencies.map(c=><option key={c} value={c}/>)}</datalist>
                <button className={btnGhost} disabled={busy||!/^[A-Z]{3}$/.test(currency[id]??'')||!!rule.balances[currency[id]]} onClick={()=>changeRule(id,{balances:{...rule.balances,[currency[id]]:{yellow:20,red:5}}})}>{t('settings.railwarn.add_currency')}</button>
              </div>
            </div>
          </>}
        </div>;
      })}
    </>}
    <div className="flex gap-2"><button className={btnGhost} disabled={busy} onClick={()=>void onRefreshAll()}>{t('settings.railwarn.refresh_readings')}</button>
      <button className={btnGhost} disabled={busy} onClick={()=>{const next=defaultRailWarnings();setDraft(next);update({rail_warnings:next,collapsed_bar_color_mode:'auto',collapsed_bar_color:null})}}>{t('settings.railwarn.reset_defaults')}</button></div>
    <p className="text-xs text-zinc-500">{t('settings.railwarn.footer_note')}</p>
  </Section>;
}
