import type {AppSettings, ProviderUsage, RailWarnings, RailAccountRule} from './types';

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
export const levelColor:Record<RailLevel,string>={unknown:'#71717a',green:'#10b981',yellow:'#f59e0b',red:'#ef4444'};
export const levelName:Record<RailLevel,string>={unknown:'灰色',green:'绿色',yellow:'黄色',red:'红色'};
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
  if(!dateStr) return '尚未更新';
  const ts=Date.parse(dateStr);
  if(!Number.isFinite(ts)) return '尚未更新';
  const diffSec=Math.floor(Math.max(0,now-ts)/1000);
  if(diffSec<10) return '刚刚';
  if(diffSec<60) return `${diffSec} 秒前`;
  const diffMin=Math.floor(diffSec/60);
  if(diffMin<60) return `${diffMin} 分钟前`;
  const diffHour=Math.floor(diffMin/60);
  if(diffHour<24) return `${diffHour} 小时前`;
  return new Date(ts).toLocaleDateString();
}

export function evaluateRail(settings:AppSettings,usages:ProviderUsage[],now=Date.now()):RailResult {
  const config=railConfig(settings),sources:RailSource[]=[],excluded:string[]=[],resetKeys:Record<string,number>={};
  const ids=config.scope==='all'?Object.keys(settings.providers).filter(id=>settings.providers[id].enabled):config.account_ids;
  const yellow=config.custom_thresholds?config.yellow:75,red=config.custom_thresholds?config.red:90;
  for(const id of [...new Set(ids)]) {
    const account=settings.providers[id],usage=usages.find(u=>u.account_id===id);
    const name=account?.label||usage?.display_name||id;
    const add=(level:RailLevel,type:'window'|'balance'|'account',reason:string,extra?:Partial<RailSource>)=>
      sources.push({account:id,name,level,type,reason,updated:usage?.last_success_at??null,...extra});
    if(!account||!account.enabled){add('unknown','account',!account?'所选账号已删除':'所选账号已停用');continue}
    const rule=config.accounts[id]??defaultAccountRule();
    if(!usage){add('unknown','account','尚未取得读数');continue}

    const standardBalances=usage.balances.filter(b=>/^[A-Z]{3}$/.test(b.currency));
    const nonCurrencyBalances=usage.balances.filter(b=>!/^[A-Z]{3}$/.test(b.currency));
    for(const b of nonCurrencyBalances){
      excluded.push(`${name} · ${b.currency} 此计量类型暂未配置预警规则`);
    }

    if(usage.windows.length===0&&standardBalances.length>0&&Object.keys(rule.balances).length===0&&rule.mode!=='window'&&!account.primary_window){
      excluded.push(...standardBalances.map(b=>`${name} · ${b.currency} 未配置余额阈值，未参与评级`));continue;
    }
    const timestamp=Date.parse(usage.last_success_at??'');
    if(usage.state!=='live'||!Number.isFinite(timestamp)||timestamp>now||now-timestamp>600000) {
      const old=[...usage.windows.map(w=>`${w.name} 已使用 ${w.used_percent}%`),...usage.balances.map(b=>`${b.currency} ${b.amount.toFixed(2)}`)].join('；');
      add('unknown','account',`${usage.state==='stale'?'上次读数（缓存，待刷新）':usage.error_message||'读数不可用或已过期'}${old?`：${old}`:''}`);continue;
    }
    let windows=usage.windows;
    for(const w of windows){const at=Date.parse(w.resets_at??'');if(Number.isFinite(at))resetKeys[`${id}:${w.id}`]=at;}
    const pin=rule.mode==='window'?rule.window_id:rule.mode==='primary'?account.primary_window:null;
    if(pin) windows=windows.filter(w=>w.id===pin);
    else if(rule.mode==='window') windows=[];
    else if(rule.mode==='primary'&&windows.length)windows=[windows.reduce((a,b)=>a.used_percent>=b.used_percent?a:b)];
    if((pin||rule.mode==='window')&&!windows.length)add('unknown','window','所选额度周期不可用，等待该周期数据');
    for(const w of windows){
      if(!Number.isFinite(w.used_percent)||w.used_percent<0|| (w.resets_at!==null&&(!Number.isFinite(Date.parse(w.resets_at))||Date.parse(w.resets_at)<=now))) {
        add('unknown','window',`${w.name} 已重置或读数无效，等待更新`,{windowName:w.name});continue;
      }
      const level=w.used_percent>=red?'red':w.used_percent>=yellow?'yellow':'green';
      add(level,'window',`${w.name} · 已使用 ${Number(w.used_percent.toFixed(1))}% · 黄色 ${yellow}% / 红色 ${red}%`,{
        windowName:w.name,usedPercent:w.used_percent,yellowThreshold:yellow,redThreshold:red
      });
    }
    for(const [currency,threshold] of Object.entries(rule.balances)){
      const balance=usage.balances.find(b=>b.currency===currency);
      if(!balance||!Number.isFinite(balance.amount)){add('unknown','balance',`${currency} 余额不可用`,{currency});continue}
      const level=balance.amount<=threshold.red?'red':balance.amount<=threshold.yellow?'yellow':'green';
      add(level,'balance',`余额 ${currency} ${balance.amount.toFixed(2)} · 黄色 ≤ ${threshold.yellow} / 红色 ≤ ${threshold.red}`,{
        currency,amount:balance.amount,yellowThreshold:threshold.yellow,redThreshold:threshold.red
      });
    }
    for(const b of standardBalances)if(!rule.balances[b.currency])excluded.push(`${name} · ${b.currency} 未配置余额阈值，未参与评级`);
    if(!usage.windows.length&&!usage.balances.length&&!Object.keys(rule.balances).length&&!pin)add('unknown','account','没有可评级的额度数据');
  }
  const valid=sources.filter(s=>s.level!=='unknown'),missing=sources.filter(s=>s.level==='unknown');
  let level:RailLevel=valid.reduce<RailLevel>((best,s)=>levelRank[s.level]>levelRank[best]?s.level:best,'unknown');
  if(level==='green'&&missing.length)level='unknown';
  let reason=level==='unknown'?(missing.length?'数据不完整，无法确认整体状态':ids.length?'没有参与评级的有效读数':'未选择已启用账号'):
    sources.filter(s=>s.level===level).map(s=>`${s.name}：${s.reason}`).join('；');
  if(missing.length)reason+=`；${missing.map(s=>`${s.name}：${s.reason}`).join('；')}`;

  let shortReason='';
  if(level==='unknown'){
    shortReason=missing.length
      ? `灰色：数据不完整，无法确认整体状态`
      : ids.length
      ? '灰色：没有参与评级的有效读数'
      : '灰色：未选择已启用账号';
  } else if(level==='green'){
    shortReason='绿色：所有关注账号额度充足';
  } else {
    const triggers=sources.filter(s=>s.level===level);
    const triggerAccounts=[...new Set(triggers.map(s=>s.name))];
    if(triggerAccounts.length===1){
      const s=triggers[0];
      if(s.type==='balance'){
        const threshold=level==='red'?s.redThreshold:s.yellowThreshold;
        shortReason=`${levelName[level]}：${s.name} · 余额 ${s.currency} ${s.amount?.toFixed(2)}，达到${levelName[level]}阈值 ≤ ${threshold}`;
      } else {
        const threshold=level==='red'?s.redThreshold:s.yellowThreshold;
        const windowText=s.windowName?`${s.windowName} `:'';
        shortReason=`${levelName[level]}：${s.name} · ${windowText}已使用 ${Number(s.usedPercent?.toFixed(1))}%，达到${levelName[level]}阈值 ${threshold}%`;
      }
    } else {
      shortReason=`${triggerAccounts.length} 个账号达到${levelName[level]}预警：${triggerAccounts.join('、')}`;
    }
    if(missing.length>0){
      shortReason+='（部分账号数据不可用）';
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
    reason:`降级确认中（持续 10 秒后变色）；当前读数：${next.reason}`,
    shortReason:`${previous.shown.shortReason}（降级确认中，持续 10 秒后变色）`
  }};
  if(previous.pending===waiting.pending&&previous.since===waiting.since&&sameShown(previous.shown,waiting.shown))return previous;
  return waiting;
}
