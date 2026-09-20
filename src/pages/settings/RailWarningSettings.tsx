import {useEffect,useState,useMemo} from 'react';
import {listen} from '@tauri-apps/api/event';
import type {AppSettings,ProviderUsage,RailWarnings,RailAccountRule} from '../../types';
import {defaultRailWarnings,defaultAccountRule,railConfig,evaluateRail,levelColor,levelName,formatTimeAgo,type RailResult} from '../../railWarnings';
import {Section,Field} from './shared';
import {selectCls,inputCls,btnGhost} from './constants';

function Thresholds({yellow,red,money,label,onPreview,onSave}:{yellow:number;red:number;money?:boolean;label:string;onPreview:(yellow:number,red:number)=>void;onSave:(yellow:number,red:number)=>void}) {
  const [values,setValues]=useState([String(yellow),String(red)]);
  useEffect(()=>setValues([String(yellow),String(red)]),[yellow,red]);
  const parsed=values.map(Number),valid=values.every(v=>v.trim()!==''&&Number.isFinite(Number(v))) &&
    (money?0<=parsed[1]&&parsed[1]<parsed[0]:0<parsed[0]&&parsed[0]<parsed[1]&&parsed[1]<=100);
  return <div className="space-y-2"><div className="grid grid-cols-2 gap-2">{['黄色','红色'].map((name,i)=><label key={name} className="text-xs text-zinc-400">{name}：{money?'余额 ≤':'已使用达到'}
    <div className="flex items-center gap-1 mt-0.5"><input className={inputCls} type="number" step={money?'0.01':'1'} min="0" max={money?undefined:100} aria-label={`${label}${name}阈值`} value={values[i]} aria-invalid={!valid}
      onChange={e=>{const next=values.map((v,j)=>j===i?e.target.value:v);setValues(next);const [y,r]=next.map(Number);
        if(next.every(v=>v.trim()!==''&&Number.isFinite(Number(v)))&&(money?0<=r&&r<y:0<y&&y<r&&r<=100))onPreview(y,r);}}
      onBlur={()=>{if(valid)onSave(parsed[0],parsed[1])}}/>{!money&&<span>%</span>}</div></label>)}</div>
    {!valid&&<p role="alert" className="text-amber-400 text-xs">{money?'请输入 0 ≤ 红色金额 < 黄色金额':'请输入 0 < 黄色百分比 < 红色百分比 ≤ 100'}；无效输入不会保存。</p>}
    <p className="text-xs text-zinc-500">输入时预览，离开输入框后自动保存。</p></div>;
}

export function RailWarningSettings({settings,usages,update,busy,onRefreshAll}:{settings:AppSettings;usages:ProviderUsage[];update:(p:Partial<AppSettings>)=>void;busy:boolean;onRefreshAll:()=>Promise<void>}) {
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
  return <Section title="收纳条外观与预警" icon="🎨" subtitle="颜色规则独立于圆环和通知阈值。仅影响收纳条颜色，不改变通知规则。有效设置自动保存。">
    <Field label="颜色模式"><select aria-label="收纳条颜色模式" className={selectCls} value={mode} disabled={busy} onChange={e=>update({collapsed_bar_color_mode:e.target.value as 'auto'|'custom'|'rainbow'})}>
      <option value="auto">自动预警</option><option value="custom">固定颜色</option><option value="rainbow">彩虹</option></select></Field>
    {mode==='custom'&&<Field label="固定颜色"><div className="flex gap-2 items-center flex-wrap">
      <input aria-label="收纳条固定颜色" type="color" value={settings.collapsed_bar_color||'#7AA5FF'} disabled={busy} onChange={e=>update({collapsed_bar_color:e.target.value})}/>
      <input aria-label="收纳条十六进制颜色" className={`${inputCls} max-w-32`} maxLength={7} value={colorDraft} onChange={e=>setColorDraft(e.target.value)} onBlur={()=>{if(validColor)update({collapsed_bar_color:colorDraft})}} aria-invalid={!validColor}/>
      {['#7AA5FF','#10B981','#8B5CF6','#EC4899','#F97316','#38BDF8'].map(color=><button key={color} aria-label={`选择颜色 ${color}`} title={color} disabled={busy} className="w-6 h-6 rounded-full border border-white/20" style={{background:color}} onClick={()=>update({collapsed_bar_color:color})}/>)}
      {!validColor&&<p role="alert" className="text-amber-400 text-xs">请输入 #RRGGBB；无效颜色不会保存。</p>}
    </div></Field>}
    <div className="p-4 rounded-xl bg-black/20 border border-white/10 space-y-3" aria-label="收纳条实时预览">
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
            <span>当前结果：</span>
            <span className="font-semibold" style={{
              color: mode === 'custom' ? (validColor ? colorDraft : '#7AA5FF') : mode === 'rainbow' ? '#34d399' : levelColor[result.level]
            }}>
              {mode === 'auto' ? levelName[result.level] : mode === 'custom' ? '固定颜色' : '彩虹幻光'}
            </span>
            {mode !== 'auto' && <span className="text-xs text-zinc-500 font-normal">（不表示额度风险）</span>}
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
              <div className="font-medium text-zinc-300 mb-1">⚠️ 触发预警详情：</div>
              {result.sources.filter(s => s.level === result.level).map((s, i) => (
                <div key={i} className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-zinc-400">
                  <div>触发账号：<span className="text-zinc-200">{s.name}</span></div>
                  <div>
                    {s.type === 'balance' ? '币种：' : '额度周期：'}
                    <span className="text-zinc-200">{s.type === 'balance' ? s.currency : s.windowName || '默认周期'}</span>
                  </div>
                  <div>
                    {s.type === 'balance' ? '当前余额：' : '已使用：'}
                    <span className="text-zinc-200">{s.type === 'balance' ? `${s.currency} ${s.amount?.toFixed(2)}` : `${Number(s.usedPercent?.toFixed(1))}%`}</span>
                  </div>
                  <div>
                    {levelName[result.level]}阈值：
                    <span className="text-zinc-200">{s.type === 'balance' ? `≤ ${result.level === 'red' ? s.redThreshold : s.yellowThreshold}` : `${result.level === 'red' ? s.redThreshold : s.yellowThreshold}%`}</span>
                  </div>
                  <div className="col-span-2 text-zinc-500">
                    数据更新：<span>{formatTimeAgo(s.updated, now)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-wrap gap-x-4 gap-y-1 text-zinc-400">
            <span>参与评级：<strong className="text-zinc-200">{new Set(result.sources.filter(s => s.level !== 'unknown').map(s => s.account)).size}</strong> 个账号</span>
            {result.excluded.length > 0 && (
              <span>未参与：<strong className="text-zinc-200">{result.excluded.length}</strong> 项（未配置阈值）</span>
            )}
            {result.sources.some(s => s.level === 'unknown') && (
              <span className="text-amber-400/90">异常：<strong className="text-amber-300">{new Set(result.sources.filter(s => s.level === 'unknown').map(s => s.account)).size}</strong> 个账号数据不可用</span>
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
              <span>实际收纳条：<span style={{ color: levelColor[actual.level] }}>{levelName[actual.level]}</span> · {actual.shortReason || actual.reason}</span>
            </div>
          )}

          <p className="text-[11px] text-zinc-500">
            风险升高立即变色，降低需持续 10 秒；数据失效、设置变化和额度重置立即重算。
          </p>
        </div>
      )}
    </div>
    {mode==='auto'&&<>
      <Field label="关注账号"><select aria-label="关注账号范围" className={selectCls} value={draft.scope} disabled={busy} onChange={e=>commit({...draft,scope:e.target.value as 'all'|'selected'})}>
        <option value="all">全部已启用账号（新增账号自动纳入）</option><option value="selected">自选账号</option></select></Field>
      <Field label="百分比预警阈值"><select aria-label="百分比阈值方式" className={selectCls} disabled={busy} value={draft.custom_thresholds?'custom':'default'} onChange={e=>commit({...draft,custom_thresholds:e.target.value==='custom'})}>
        <option value="default">默认：已使用 75% 黄色 / 90% 红色</option><option value="custom">手动设置</option></select></Field>
      {draft.custom_thresholds&&<Thresholds label="百分比" yellow={draft.yellow} red={draft.red} onPreview={(yellow,red)=>setDraft({...draft,yellow,red})} onSave={(yellow,red)=>commit({...draft,yellow,red})}/>}
      <p className="text-xs text-zinc-500">多个账号取最高风险，不取平均值；始终以已使用百分比判断。余额按账号、币种单独设置，不换算或相加。</p>
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
              {!account?<span className="text-xs text-red-400">（已删除）</span>:!account.enabled?<span className="text-xs text-zinc-500">（已停用）</span>:null}
            </label>
            {!hasWindows&&usage?.balances?.length?<span className="text-xs px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-700">余额账号</span>:null}
          </div>
          {selected&&<>{hasWindows?(
            <>
              <select aria-label={`${account?.label||id}额度来源`} className={selectCls} disabled={busy} value={rule.mode} onChange={e=>changeRule(id,{mode:e.target.value as RailAccountRule['mode'],window_id:e.target.value==='window'?(rule.window_id||usage?.windows[0]?.id||null):rule.window_id})}>
                <option value="primary">跟随主圆环</option><option value="all">全部百分比额度</option><option value="window" disabled={!usage?.windows.length&&!rule.window_id}>指定额度周期</option>
              </select>
              {rule.mode==='window'&&<select aria-label="指定额度周期" className={selectCls} value={rule.window_id??''} disabled={busy} onChange={e=>changeRule(id,{window_id:e.target.value})}>
                {rule.window_id&&!usage?.windows.some(w=>w.id===rule.window_id)&&<option value={rule.window_id}>{rule.window_id}（当前不可用）</option>}
                {usage?.windows.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}
              </select>}
            </>
          ):null}

            {/* 余额预警配置 */}
            <div className="space-y-2 border-t border-white/5 pt-2">
              <div className="text-xs font-medium text-zinc-400">余额预警（按账号、币种单独配置）</div>
              {detectedCurrencies.map(code=>{
                const balanceObj=usage?.balances?.find(b=>b.currency===code);
                const isConfigured=!!rule.balances[code];
                return <div key={code} className="p-2.5 rounded-lg bg-white/5 space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-zinc-300">
                      {code} 余额：{balanceObj?balanceObj.amount.toFixed(2):'--'}
                      {!isConfigured&&<span className="text-zinc-500 ml-1.5 font-normal">（未参与颜色判断）</span>}
                    </span>
                    {isConfigured?(
                      <button className={btnGhost} disabled={busy} onClick={()=>{const balances={...rule.balances};delete balances[code];changeRule(id,{balances})}}>关闭预警</button>
                    ):(
                      <button className={btnGhost} disabled={busy} onClick={()=>changeRule(id,{balances:{...rule.balances,[code]:{yellow:20,red:5}}})}>启用预警</button>
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
                  <span className="text-[11px] text-amber-400/80">此计量类型暂未配置预警规则</span>
                </div>
              ))}

              <div className="flex gap-2 items-center pt-1">
                <input className={inputCls} aria-label={`${id}余额币种`} placeholder="添加其他币种，例如 USD" maxLength={3} list={`currencies-${id}`} value={currency[id]??''} onChange={e=>setCurrency({...currency,[id]:e.target.value.toUpperCase()})}/>
                <datalist id={`currencies-${id}`}>{detectedCurrencies.map(c=><option key={c} value={c}/>)}</datalist>
                <button className={btnGhost} disabled={busy||!/^[A-Z]{3}$/.test(currency[id]??'')||!!rule.balances[currency[id]]} onClick={()=>changeRule(id,{balances:{...rule.balances,[currency[id]]:{yellow:20,red:5}}})}>添加币种</button>
              </div>
            </div>
          </>}
        </div>;
      })}
    </>}
    <div className="flex gap-2"><button className={btnGhost} disabled={busy} onClick={()=>void onRefreshAll()}>刷新读数</button>
      <button className={btnGhost} disabled={busy} onClick={()=>{const next=defaultRailWarnings();setDraft(next);update({rail_warnings:next,collapsed_bar_color_mode:'auto',collapsed_bar_color:null})}}>恢复收纳条默认设置</button></div>
    <p className="text-xs text-zinc-500">减少动态时关闭呼吸和彩虹循环。此处不会修改凭据、主圆环或通知设置。</p>
  </Section>;
}
