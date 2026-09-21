import type {ProviderUsage,UsageWindow} from "./types";
export function percentText(usage:ProviderUsage,mode:"used"|"remaining"="used"){
  if(!["live","stale"].includes(usage.state)||usage.primary_percent===null)return usage.balances?.length&&["live","stale"].includes(usage.state)?(usage.state==="stale"?"余额*":"余额"):"—";
  const n=mode==="remaining"?Math.max(0,100-usage.primary_percent):usage.primary_percent;
  return `${Number(n.toFixed(1))}%${usage.state==="stale"?"*":""}`;
}
export function resetText(at:string|null,now=Date.now()){
  if(!at)return "未报告重置时间";const time=Date.parse(at);if(!Number.isFinite(time))return "重置时间不可用";
  const seconds=Math.ceil((time-now)/1000);if(seconds<=0)return "等待重置后的新读数";
  if(seconds>=86400)return `${Math.floor(seconds/86400)}天 ${Math.floor(seconds%86400/3600)}小时后重置`;
  if(seconds>=3600)return `${Math.floor(seconds/3600)}小时 ${Math.ceil(seconds%3600/60)}分后重置`;
  return `${Math.ceil(seconds/60)}分钟后重置`;
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
export function forecast(w:UsageWindow,now=Date.now()):string|null{
  switch(forecastKind(w,now)){
    case "exhausted":return "已达到包含额度";
    case "ok":return "按当前平均速度，预计可用至窗口结束";
    case "soon":{const e=elapsed(w,now)!;const sec=w.window_seconds??0;
      const used=Number.isFinite(w.used_fraction)&&w.used_fraction>=0?w.used_fraction:w.used_percent/100;
      const remaining=(1-used)/(used/e)*sec;
      return `按窗口平均速度估算，约 ${Math.max(1,Math.ceil(remaining/60))} 分钟后用满`;}
    case "risk":return "按窗口平均速度估算，可能在重置前用满";
    default:return null;
  }
}

/** Monetary balances and plan credits are different units and never interchangeable. */
export function balanceText(currency:string,amount:number):string {
  if(currency==='Credit')return `${amount>=1e8?(amount/1e8).toFixed(2)+' 亿':amount>=1e4?(amount/1e4).toFixed(2)+' 万':amount.toLocaleString('zh-CN',{maximumFractionDigits:2})} Credit`;
  if(currency==='CNY')return `¥${amount.toFixed(2)}`;
  return `${currency} ${amount.toFixed(2)}`;
}
export function balanceLabel(provider:string,currency:string):string {
  return currency==='Credit'?'套餐剩余':provider==='stepfun'?'API 可用余额':'可用余额';
}
