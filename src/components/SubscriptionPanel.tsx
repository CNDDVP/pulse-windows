import {useEffect,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import type {SubscriptionRecord} from '../types';
import {SPEND_SOURCES} from '../lib/spend';
import {useLang} from '../lib/i18n';
import {
  convertFromUsd, formatMoney, formatMultiple, rateEstimateNote, subscriptionMultiple,
  type DisplayCurrency,
} from '../lib/currency';

const inputCls = 'bg-zinc-800 p-1 rounded text-xs text-zinc-200 border border-white/10 focus:outline-none focus:border-emerald-500';

export function SubscriptionPanel({subs, onSubsChange, onSaved, monthCostBySource, monthCoverageNote, displayCurrency, fxRate}: {
  /** 订阅记录草稿（TokenSpend 持有，导出也要用）；键为来源标识。 */
  subs: Record<string, SubscriptionRecord>;
  onSubsChange: (subs: Record<string, SubscriptionRecord>) => void;
  /** 保存成功后回调（供外层同步设置基线，避免后续设置保存把订阅写回旧值）。 */
  onSaved?: (subs: Record<string, SubscriptionRecord>) => void;
  /** 按来源的本月估算成本（USD 原值）；null = 尚未读取使用记录。 */
  monthCostBySource: Record<string, number> | null;
  monthCoverageNote: string | null;
  displayCurrency: DisplayCurrency;
  fxRate: number;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // msg 存词典键（渲染时经 t() 取词，语言切换后提示跟随）；err 为后端消息原样展示。
  const [msg, setMsg] = useState('');
  // Round 5c：面板内全部用户可见文案走 t()（未包 Provider 时回落 zh，与旧测试一致）。
  const {t,lang} = useLang();

  // 挂载即读一次（面板默认折叠，读取很轻：纯内存查询）。
  useEffect(() => {
    let alive = true;
    invoke<Record<string, SubscriptionRecord>>('get_subscriptions')
      .then(m => { if (alive && m && typeof m === 'object') onSubsChange(m); })
      .catch(e => { if (alive) setErr(String(e)); });
    return () => { alive = false; };
    // onSubsChange 由父组件以 useState setter 传入，保持稳定；仅挂载时读一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const recordOf = (src: string): SubscriptionRecord => subs[src] ?? {price: 0, currency: 'USD', cycle_days: 30, start_date: '', note: ''};
  const edit = (src: string, patch: Partial<SubscriptionRecord>) => {
    setErr(''); setMsg('');
    onSubsChange({...subs, [src]: {...recordOf(src), ...patch}});
  };
  const registered = SPEND_SOURCES.filter(([id]) => (subs[id]?.price ?? 0) > 0).length;

  const save = async () => {
    setBusy(true); setErr(''); setMsg('');
    try {
      // 价格 ≤0 视为未登记该来源，不落设置；其余字段交由后端校验（周期 1~366、币种三位大写、日期格式）。
      const payload: Record<string, SubscriptionRecord> = {};
      for (const [id] of SPEND_SOURCES) {
        const rec = subs[id];
        if (rec && Number(rec.price) > 0) payload[id] = {...rec, price: Number(rec.price), cycle_days: Math.round(Number(rec.cycle_days) || 0)};
      }
      const saved = await invoke<Record<string, SubscriptionRecord>>('save_subscriptions', {subscriptions: payload});
      onSubsChange(saved && typeof saved === 'object' ? saved : {});
      onSaved?.(saved && typeof saved === 'object' ? saved : {});
      setMsg('spend.subs.saved');
    } catch (e) {
      // TODO(EN-backend)：后端校验错误原样展示，不翻译（避免语义漂移）。
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const monthCost = (src: string): number | null => monthCostBySource == null ? null : (Number.isFinite(monthCostBySource[src]) ? monthCostBySource[src] : null);
  const note = rateEstimateNote(displayCurrency, fxRate, lang);

  return <div className="bg-zinc-900/60 rounded-xl border border-white/5">
    <button type="button" aria-expanded={open} className="w-full flex items-center justify-between px-4 py-2.5 cursor-pointer text-left"
      onClick={() => setOpen(o => !o)}>
      <span className="text-sm font-semibold text-zinc-200">{t('spend.subs.title')}{registered > 0 ? t('spend.subs.registered', {count: registered}) : ''}</span>
      <span className="text-xs text-zinc-400">{open ? t('spend.collapse') : t('spend.expand')}</span>
    </button>
    {open && <div className="px-4 pb-3 space-y-2">
      <p className="text-[11px] text-zinc-500">{t('spend.subs.description')}</p>
      <div className="overflow-auto">
        <table className="w-full text-xs text-right">
          <thead><tr>{(['source','price','currency','cycle','start','month_used','multiple'] as const).map(k => <th key={k} className="p-2 border-b border-zinc-700 first:text-left">{t(`spend.subs.col.${k}`)}</th>)}</tr></thead>
          <tbody>
            {SPEND_SOURCES.map(([id, label]) => {
              const rec = recordOf(id);
              const cost = monthCost(id);
              const mult = subscriptionMultiple(cost, Number(rec.price), rec.currency, fxRate);
              return <tr key={id}>
                <td className="p-2 text-left text-zinc-300">{label}</td>
                <td className="p-2"><input type="number" min={0} step={0.01} aria-label={t('spend.subs.aria_price', {label})} className={`${inputCls} w-24 text-right`} value={rec.price || ''} placeholder={t('spend.subs.placeholder_unregistered')} onChange={e => edit(id, {price: e.target.value === '' ? 0 : Number(e.target.value)})} /></td>
                <td className="p-2">
                  <select aria-label={t('spend.subs.aria_currency', {label})} className={inputCls} value={rec.currency} onChange={e => edit(id, {currency: e.target.value})}>
                    <option value="USD">USD</option><option value="CNY">CNY</option>
                  </select>
                </td>
                <td className="p-2"><input type="number" min={1} max={366} aria-label={t('spend.subs.aria_cycle', {label})} className={`${inputCls} w-16 text-right`} value={rec.cycle_days} onChange={e => edit(id, {cycle_days: Math.round(Number(e.target.value) || 0)})} /></td>
                <td className="p-2"><input type="date" aria-label={t('spend.subs.aria_start', {label})} className={inputCls} value={rec.start_date} onChange={e => edit(id, {start_date: e.target.value})} /></td>
                <td className="p-2 text-zinc-300">{cost == null ? '—' : formatMoney(convertFromUsd(cost, displayCurrency, fxRate), displayCurrency)}</td>
                <td className={`p-2 ${mult != null && mult >= 1 ? 'text-orange-500 font-semibold' : 'text-zinc-300'}`}>{mult == null ? '—' : formatMultiple(mult)}</td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-zinc-500">{t('spend.subs.footnote', {scan: t('spend.scan')})}{note && monthCostBySource != null ? t('spend.subs.month_cost_note', {note}) : ''}{monthCoverageNote ? ` ${monthCoverageNote}` : ''}</p>
      <div className="flex items-center gap-3">
        <button disabled={busy} className="bg-emerald-700 px-3 py-1 rounded text-xs disabled:opacity-40 cursor-pointer" onClick={() => void save()}>{busy ? t('spend.saving') : t('spend.subs.save')}</button>
        <span className="text-[11px] text-zinc-500">{t('spend.subs.zero_hint')}</span>
      </div>
      {msg && <p className="text-xs text-emerald-400">{t(msg)}</p>}
      {/* TODO(EN-backend)：err 为 Rust 侧消息，原样展示不翻译 */}
      {err && <p className="text-xs text-amber-400">{err}</p>}
    </div>}
  </div>;
}
