import type {ProviderUsage,UsageWindow,ProviderConfig} from "./types";
import {getLang,translate} from "./lib/i18n";
import type {Lang} from "./lib/i18n";

// 文案全部走 translate(lang, key)（词典 rail.detail.* / rail.balance.*）；
// lang 缺省回落模块级语言，组件调用点显式传 useLang().lang（同 currency.ts 约定）。
export function percentText(usage:ProviderUsage,mode:"used"|"remaining"="used",lang:Lang=getLang()){
  if(!["live","stale"].includes(usage.state)||usage.primary_percent===null)return usage.balances?.length&&["live","stale"].includes(usage.state)?translate(lang,usage.state==="stale"?"rail.balance.label_stale":"rail.balance.label"):"—";
  const n=mode==="remaining"?Math.max(0,100-usage.primary_percent):usage.primary_percent;
  return `${Number(n.toFixed(1))}%${usage.state==="stale"?"*":""}`;
}
export function resetText(at:string|null,now=Date.now(),lang:Lang=getLang()){
  if(!at)return translate(lang,"rail.detail.reset_unreported");const time=Date.parse(at);if(!Number.isFinite(time))return translate(lang,"rail.detail.reset_invalid");
  const seconds=Math.ceil((time-now)/1000);if(seconds<=0)return translate(lang,"rail.detail.reset_waiting");
  if(seconds>=86400)return translate(lang,"rail.detail.reset_days",{d:Math.floor(seconds/86400),h:Math.floor(seconds%86400/3600)});
  if(seconds>=3600)return translate(lang,"rail.detail.reset_hours",{h:Math.floor(seconds/3600),m:Math.ceil(seconds%3600/60)});
  return translate(lang,"rail.detail.reset_minutes",{m:Math.ceil(seconds/60)});
}
export function elapsed(w:UsageWindow,now=Date.now()):number|null{
  if(!w.window_seconds||!w.resets_at)return null;const end=Date.parse(w.resets_at);if(!Number.isFinite(end)||end<=now)return null;
  const fraction=1-(end-now)/(w.window_seconds*1000);return fraction>=0&&fraction<=1?fraction:null;
}
/** Window the outer time ring follows: the pinned one, else the soonest reset. A pinned
 *  window without timing data yields null rather than silently switching to another. */
export function pickElapsedWindow(windows:UsageWindow[],pinned:string|null,now=Date.now()):UsageWindow|null{
  if(pinned){const w=windows.find(w=>w.id===pinned);return w&&elapsed(w,now)!==null?w:null}
  const usable=windows.filter(w=>elapsed(w,now)!==null);
  if(!usable.length)return null;
  return usable.reduce((best,w)=>Date.parse(w.resets_at!)<Date.parse(best.resets_at!)?w:best);
}
export type ForecastKind="exhausted"|"ok"|"soon"|"risk";
/** Severity class of the pace forecast, shared by the copy and its colour. */
export function forecastKind(w:UsageWindow,now=Date.now()):ForecastKind|null{
  // One source of truth: prefer the fraction, fall back to percent/100, so a
  // window carrying only one of the two fields never reports a bogus rate.
  const used=Number.isFinite(w.used_fraction)&&w.used_fraction>=0?w.used_fraction:(Number.isFinite(w.used_percent)&&w.used_percent>=0?w.used_percent/100:NaN);
  const e=elapsed(w,now);if(e===null||e<0.02||!Number.isFinite(used)||used<=0||!w.window_seconds)return null;
  const rate=used/e;const remainingSeconds=(1-used)/rate*w.window_seconds;
  if(used>=1)return "exhausted";
  if(rate<=1)return "ok";
  return remainingSeconds<7200?"soon":"risk";
}
export function forecast(w:UsageWindow,now=Date.now(),lang:Lang=getLang()):string|null{
  switch(forecastKind(w,now)){
    case "exhausted":return translate(lang,"rail.detail.forecast_exhausted");
    case "ok":return translate(lang,"rail.detail.forecast_ok");
    case "soon":{const e=elapsed(w,now)!;const sec=w.window_seconds??0;
      const used=Number.isFinite(w.used_fraction)&&w.used_fraction>=0?w.used_fraction:w.used_percent/100;
      const remaining=(1-used)/(used/e)*sec;
      return translate(lang,"rail.detail.forecast_soon",{minutes:Math.max(1,Math.ceil(remaining/60))});}
    case "risk":return translate(lang,"rail.detail.forecast_risk");
    default:return null;
  }
}

/** Monetary balances and plan credits are different units and never interchangeable.
 *  Credit 量级单位随语言取 zh（亿/万）或 en（B/M）——数值格式化随 locale，
 *  同 toLocaleString 先例，不进词典。 */
export function balanceText(currency:string,amount:number,lang:Lang=getLang()):string {
  if(currency==='Credit'||currency==='Credit-Topup'){
    if(lang==='en')return `${amount>=1e9?(amount/1e9).toFixed(2)+'B':amount>=1e6?(amount/1e6).toFixed(2)+'M':amount.toLocaleString('en-US',{maximumFractionDigits:2})} Credit`;
    return `${amount>=1e8?(amount/1e8).toFixed(2)+' 亿':amount>=1e4?(amount/1e4).toFixed(2)+' 万':amount.toLocaleString('zh-CN',{maximumFractionDigits:2})} Credit`;
  }
  if(currency==='CNY')return `¥${amount.toFixed(2)}`;
  return `${currency} ${amount.toFixed(2)}`;
}
export function balanceLabel(provider:string,currency:string,lang:Lang=getLang()):string {
  if(currency==='Credit-Topup')return translate(lang,'rail.balance.label_topup');
  return translate(lang,currency==='Credit'?'rail.balance.label_plan':provider==='stepfun'?'rail.balance.label_api':'rail.balance.label_available');
}

export type TimedWindow=UsageWindow & {period_note?:string};
/** Only timing presentation receives estimates; original usage and forecasts stay untouched. */
export function timingWindows(usage:ProviderUsage,cfg?:ProviderConfig,lang:Lang=getLang()):TimedWindow[] {
  return usage.windows.map(w=>{
    const days=cfg?.elapsed_period_days;
    if(days!=null&&Number.isFinite(days)&&days>=1/24&&days<=366){
      if(w.window_seconds && w.window_seconds>0 && cfg?.elapsed_window !== w.id) {
        return {...w,period_note:translate(lang,'rail.detail.period_source')};
      }
      return {...w,window_seconds:Math.round(days*86400),period_note:translate(lang,'rail.detail.period_custom',{days})};
    }
    if(w.window_seconds && w.window_seconds>0)return {...w,period_note:translate(lang,'rail.detail.period_source')};
    if(usage.provider_id==='stepfun'&&w.id==='plan')return {...w,window_seconds:30*86400,period_note:translate(lang,'rail.detail.period_stepfun')};
    return {...w,period_note:translate(lang,'rail.detail.period_unknown')};
  });
}
