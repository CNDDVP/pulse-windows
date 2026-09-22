import type {AppSettings, ProviderUsage, RailWarnings, RailAccountRule} from './types';
// Round 5c 项目一：本模块是纯逻辑（非 React），经模块级 t() 取词（I18nProvider 在各窗口
// 挂载时把当前语言同步到模块级，悬浮栏与设置页共用同一通道）；纯函数测试可用
// translate(lang,…) 或维持默认 zh。产出的 reason/shortReason/excluded 文案同时显示在
// 悬浮栏收纳条悬停提示与设置页「悬浮栏预警」预览里。
import {t} from './lib/i18n';

export type RailLevel='unknown'|'green'|'yellow'|'red';
export interface RailSource {
  account:string;
  name:string;
  level:RailLevel;
  type:'window'|'balance'|'account';
  windowName?:string;
  currency?:string;
  amount?:number;
  usedPercent?:number;
  yellowThreshold?:number;
  redThreshold?:number;
  reason:string;
  updated:string|null;
}
export interface RailResult {
  level:RailLevel;
  sources:RailSource[];
  excluded:string[];
  reason:string;
  shortReason:string;
  resetKey:string;
}
export const levelRank:Record<RailLevel,number>={unknown:-1,green:0,yellow:1,red:2};
// Round5d 项目一：预警四档颜色走语义令牌（内联 style 原生支持 var()），
// 深浅主题下由 index.css 各自给出可读取值；RailWarningSettings 预览与实际档位同步变色。
export const levelColor:Record<RailLevel,string>={unknown:'var(--text-3)',green:'var(--ok)',yellow:'var(--warn)',red:'var(--danger)'};
// levelName 保持「按下标取词」的既有用法（RailWarningSettings 以 levelName[level] 直接索引），
// 改为 getter：取值时机延迟到访问时，语言切换后立即生效。
export const levelName:Record<RailLevel,string>={
  get unknown(){return t('rail.warn.level.unknown');},
  get green(){return t('rail.warn.level.green');},
  get yellow(){return t('rail.warn.level.yellow');},
  get red(){return t('rail.warn.level.red');},
};
export const defaultRailWarnings=():RailWarnings=>({scope:'all',account_ids:[],custom_thresholds:false,yellow:75,red:90,accounts:{}});
export const defaultAccountRule=():RailAccountRule=>({mode:'primary',window_id:null,balances:{}});
export function railConfig(settings:AppSettings):RailWarnings {
  const base=settings.rail_warnings??{...defaultRailWarnings(),custom_thresholds:settings.warning_threshold!==90,
    yellow:settings.warning_threshold-15,red:settings.warning_threshold};
  // 未启用自定义阈值时跟随通用预警阈值：避免用户调整 warning_threshold 后
  // 收纳条颜色与圆环颜色不一致。
  if(base.custom_thresholds)return base;
  return {...base,yellow:Math.max(0,settings.warning_threshold-15),red:settings.warning_threshold};
}

export function formatTimeAgo(dateStr:string|null|undefined,now=Date.now()):string {
  if(!dateStr) return t('rail.warn.time.never');
  const ts=Date.parse(dateStr);
  if(!Number.isFinite(ts)) return t('rail.warn.time.never');
  const diffSec=Math.floor(Math.max(0,now-ts)/1000);
  if(diffSec<10) return t('rail.warn.time.just_now');
  if(diffSec<60) return t('rail.warn.time.seconds',{n:diffSec});
  const diffMin=Math.floor(diffSec/60);
  if(diffMin<60) return t('rail.warn.time.minutes',{n:diffMin});
  const diffHour=Math.floor(diffMin/60);
  if(diffHour<24) return t('rail.warn.time.hours',{n:diffHour});
  return new Date(ts).toLocaleDateString();
}

export function evaluateRail(settings:AppSettings,usages:ProviderUsage[],now=Date.now()):RailResult {
  const config=railConfig(settings),sources:RailSource[]=[],excluded:string[]=[],resetKeys:Record<string,number>={};
  const ids=config.scope==='all'?Object.keys(settings.providers).filter(id=>settings.providers[id].enabled):config.account_ids;
  const yellow=config.yellow,red=config.red;
  for(const id of [...new Set(ids)]) {
    const account=settings.providers[id],usage=usages.find(u=>u.account_id===id);
    const name=account?.label||usage?.display_name||id;
    const add=(level:RailLevel,type:'window'|'balance'|'account',reason:string,extra?:Partial<RailSource>)=>
      sources.push({account:id,name,level,type,reason,updated:usage?.last_success_at??null,...extra});
    if(!account||!account.enabled){add('unknown','account',!account?t('rail.warn.src.account_deleted'):t('rail.warn.src.account_disabled'));continue}
    const rule=config.accounts[id]??defaultAccountRule();
    if(!usage){add('unknown','account',t('rail.warn.src.no_reading'));continue}

    const standardBalances=usage.balances.filter(b=>/^[A-Z]{3}$/.test(b.currency));
    const nonCurrencyBalances=usage.balances.filter(b=>!/^[A-Z]{3}$/.test(b.currency));
    for(const b of nonCurrencyBalances){
      excluded.push(t('rail.warn.excluded.unit_type',{name,currency:b.currency}));
    }

    const isPureBalance = account.primary_window === '__balance__';
    if(usage.windows.length===0&&standardBalances.length>0&&Object.keys(rule.balances).length===0&&rule.mode!=='window'&&(!account.primary_window || isPureBalance)){
      excluded.push(...standardBalances.map(b=>t('rail.warn.excluded.no_balance_rule',{name,currency:b.currency})));continue;
    }
    const timestamp=Date.parse(usage.last_success_at??'');
    if(usage.state!=='live'||!Number.isFinite(timestamp)||timestamp>now||now-timestamp>600000) {
      // TODO(EN-backend)：usage.error_message 为 Rust 侧消息，拼接时原样保留不翻译。
      const old=[...usage.windows.map(w=>t('rail.warn.old_window',{name:w.name,percent:w.used_percent})),...usage.balances.map(b=>t('rail.warn.old_balance',{currency:b.currency,amount:b.amount.toFixed(2)}))].join(t('rail.warn.list_sep'));
      add('unknown','account',`${usage.state==='stale'?t('rail.warn.stale_cached'):usage.error_message||t('rail.warn.reading_unavailable')}${old?t('rail.warn.reading_suffix',{old}):''}`);continue;
    }
    let windows=usage.windows;
    for(const w of windows){const at=Date.parse(w.resets_at??'');if(Number.isFinite(at))resetKeys[`${id}:${w.id}`]=at;}
    const pin=rule.mode==='window'?rule.window_id:(rule.mode==='primary'&&!isPureBalance?account.primary_window:null);
    if(isPureBalance && rule.mode==='primary') windows=[];
    else if(pin) windows=windows.filter(w=>w.id===pin);
    else if(rule.mode==='window') windows=[];
    else if(rule.mode==='primary'&&windows.length)windows=[windows.reduce((a,b)=>a.used_percent>=b.used_percent?a:b)];
    if((pin||(rule.mode==='window'&&!isPureBalance))&&!windows.length)add('unknown','window',t('rail.warn.src.window_missing'));
    for(const w of windows){
      if(!Number.isFinite(w.used_percent)||w.used_percent<0|| (w.resets_at!==null&&(!Number.isFinite(Date.parse(w.resets_at))||Date.parse(w.resets_at)<=now))) {
        add('unknown','window',t('rail.warn.src.window_reset',{name:w.name}),{windowName:w.name});continue;
      }
      const level=w.used_percent>=red?'red':w.used_percent>=yellow?'yellow':'green';
      add(level,'window',t('rail.warn.src.window',{name:w.name,percent:Number(w.used_percent.toFixed(1)),yellow,red}),{
        windowName:w.name,usedPercent:w.used_percent,yellowThreshold:yellow,redThreshold:red
      });
    }
    for(const [currency,threshold] of Object.entries(rule.balances)){
      const balance=usage.balances.find(b=>b.currency===currency);
      if(!balance||!Number.isFinite(balance.amount)){add('unknown','balance',t('rail.warn.src.balance_unavailable',{currency}),{currency});continue}
      const level=balance.amount<=threshold.red?'red':balance.amount<=threshold.yellow?'yellow':'green';
      add(level,'balance',t('rail.warn.src.balance',{currency,amount:balance.amount.toFixed(2),yellow:threshold.yellow,red:threshold.red}),{
        currency,amount:balance.amount,yellowThreshold:threshold.yellow,redThreshold:threshold.red
      });
    }
    for(const b of standardBalances)if(!rule.balances[b.currency])excluded.push(t('rail.warn.excluded.no_balance_rule',{name,currency:b.currency}));
    if(!usage.windows.length&&!usage.balances.length&&!Object.keys(rule.balances).length&&!pin)add('unknown','account',t('rail.warn.src.nothing_to_rate'));
  }
  const valid=sources.filter(s=>s.level!=='unknown'),missing=sources.filter(s=>s.level==='unknown');
  let level:RailLevel=valid.reduce<RailLevel>((best,s)=>levelRank[s.level]>levelRank[best]?s.level:best,'unknown');
  if(level==='green'&&missing.length)level='unknown';
  const reasonItem=(s:RailSource)=>t('rail.warn.reason_item',{name:s.name,reason:s.reason});
  let reason=level==='unknown'?(missing.length?t('rail.warn.reason.incomplete'):ids.length?t('rail.warn.reason.no_valid_readings'):t('rail.warn.reason.no_accounts')):
    sources.filter(s=>s.level===level).map(reasonItem).join(t('rail.warn.list_sep'));
  if(missing.length)reason+=t('rail.warn.list_sep')+missing.map(reasonItem).join(t('rail.warn.list_sep'));

  let shortReason='';
  if(level==='unknown'){
    shortReason=missing.length
      ? t('rail.warn.short.unknown_incomplete')
      : ids.length
      ? t('rail.warn.short.unknown_no_readings')
      : t('rail.warn.short.unknown_no_accounts');
  } else if(level==='green'){
    shortReason=t('rail.warn.short.green');
  } else {
    const triggers=sources.filter(s=>s.level===level);
    const triggerAccounts=[...new Set(triggers.map(s=>s.name))];
    if(triggerAccounts.length===1){
      const s=triggers[0];
      const threshold=String(level==='red'?s.redThreshold:s.yellowThreshold);
      if(s.type==='balance'){
        shortReason=t('rail.warn.short.balance_trigger',{level:levelName[level],name:s.name,currency:String(s.currency),amount:String(s.amount?.toFixed(2)),threshold});
      } else {
        const windowText=s.windowName?`${s.windowName} `:'';
        shortReason=t('rail.warn.short.window_trigger',{level:levelName[level],name:s.name,window:windowText,percent:Number(s.usedPercent?.toFixed(1)),threshold});
      }
    } else {
      shortReason=t('rail.warn.short.multi_trigger',{count:triggerAccounts.length,level:levelName[level],names:triggerAccounts.join(t('rail.warn.name_sep'))});
    }
    if(missing.length>0){
      shortReason+=t('rail.warn.short.partial_suffix');
    }
  }

  return {level,sources,excluded,reason,shortReason,resetKey:JSON.stringify(resetKeys)};
}

function periodAdvanced(previous:string,next:string):boolean {
  const before=JSON.parse(previous) as Record<string,number>,after=JSON.parse(next) as Record<string,number>;
  return Object.keys(before).some(id=>Number.isFinite(after[id])&&after[id]>before[id]);
}

export interface RailTransition {shown:RailResult;configKey:string;pending:RailLevel|null;since:number}
/** Pure clock-driven transition; reset/config changes and data loss bypass the downgrade delay. */
function sameShown(a:RailResult,b:RailResult):boolean {
  return a.level===b.level&&a.reason===b.reason&&a.shortReason===b.shortReason&&a.resetKey===b.resetKey
    &&a.excluded.length===b.excluded.length&&a.sources.length===b.sources.length;
}
export function advanceRail(previous:RailTransition|null,next:RailResult,configKey:string,now:number):RailTransition {
  const immediate=(shown:RailResult):RailTransition=>({shown,configKey,pending:null,since:now});
  // 状态语义未变时复用旧引用：避免秒级 tick 每次产生新对象触发下游重渲染与 IPC（B 稳定性）。
  const reuseIfSame=(t:RailTransition):RailTransition=>
    previous&&previous.configKey===configKey&&previous.pending===null&&sameShown(previous.shown,t.shown)?previous:t;
  if(!previous||previous.configKey!==configKey||periodAdvanced(previous.shown.resetKey,next.resetKey)||next.sources.some(s=>s.level==='unknown')||next.level==='unknown'||previous.shown.level==='unknown'||levelRank[next.level]>=levelRank[previous.shown.level]){
    return reuseIfSame(immediate(next));
  }
  const since=previous.pending===next.level?previous.since:now;
  if(now-since>=10000){
    return reuseIfSame(immediate(next));
  }
  const waiting:RailTransition={...previous,pending:next.level,since,shown:{
    ...previous.shown,
    reason:t('rail.warn.pending.reason',{reason:next.reason}),
    shortReason:t('rail.warn.pending.short',{short:previous.shown.shortReason})
  }};
  if(previous.pending===waiting.pending&&previous.since===waiting.since&&sameShown(previous.shown,waiting.shown))return previous;
  return waiting;
}
