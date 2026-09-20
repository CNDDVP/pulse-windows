import {describe,it,expect} from 'vitest';
import {evaluateRail,defaultRailWarnings,defaultAccountRule,advanceRail,railConfig} from './railWarnings';
import type {AppSettings,ProviderUsage,UsageWindow} from './types';
const now=Date.parse('2026-09-20T12:00:00Z');
const win=(used:number,id='five'):UsageWindow=>({id,name:id,used_percent:used,used_fraction:used/100,window_seconds:3600,resets_at:new Date(now+3600000).toISOString(),exhausted:used>=100});
const usage=(id:string,used=20):ProviderUsage=>({account_id:id,provider_id:'codex',display_name:id,state:'live',last_success_at:new Date(now).toISOString(),primary_percent:used,windows:[win(used)],balances:[],plan_name:null,is_active:false,error_code:null,error_message:null,source:'fixture',checked_at:new Date(now).toISOString(),retry_after_seconds:null,duration_ms:null});
const settings=(ids=['a']):AppSettings=>({rail_warnings:defaultRailWarnings(),warning_threshold:90,providers:Object.fromEntries(ids.map(id=>[id,{enabled:true,provider_id:'codex',label:id,primary_window:null}]))} as AppSettings);
describe('rail risk rules',()=>{
  it.each([[74.9,'green'],[75,'yellow'],[89.9,'yellow'],[90,'red'],[120,'red']])('used %s => %s',(used,level)=>{
    expect(evaluateRail(settings(),[usage('a',Number(used))],now).level).toBe(level);
  });
  it('independent manual thresholds never follow notification or remaining display',()=>{
    const s=settings();s.rail_warnings={...defaultRailWarnings(),custom_thresholds:true,yellow:30,red:50};s.display_mode='remaining';s.warning_threshold=95;
    expect(evaluateRail(s,[usage('a',50)],now).level).toBe('red');
  });
  it('selected IDs exclude other accounts and preserve unavailable selected IDs',()=>{
    const s=settings(['a','b']);s.rail_warnings!.scope='selected';s.rail_warnings!.account_ids=['a'];
    expect(evaluateRail(s,[usage('a',20),usage('b',99)],now).level).toBe('green');
    s.rail_warnings!.account_ids.push('deleted');expect(evaluateRail(s,[usage('a')],now).level).toBe('unknown');
    expect(evaluateRail(s,[usage('a')],now).reason).toContain('已删除');
  });
  it('honours pinned period, all periods, and missing period without fallback',()=>{
    const s=settings(),u=usage('a');u.windows.push(win(98,'week'));s.providers.a.primary_window='five';
    expect(evaluateRail(s,[u],now).level).toBe('green');
    s.rail_warnings!.accounts.a={...defaultAccountRule(),mode:'all'};expect(evaluateRail(s,[u],now).level).toBe('red');
    s.rail_warnings!.accounts.a={...defaultAccountRule(),mode:'window',window_id:'missing'};
    expect(evaluateRail(s,[u],now).level).toBe('unknown');
  });
  it('red risk wins over unknown, but green with unknown is grey',()=>{
    const s=settings(['a','b']);const broken={...usage('b'),state:'error'} as ProviderUsage;
    expect(evaluateRail(s,[usage('a',97),broken],now).level).toBe('red');
    expect(evaluateRail(s,[usage('a',20),broken],now).level).toBe('unknown');
  });
  it('stale and expired values never count as healthy or live risk',()=>{
    expect(evaluateRail(settings(),[{...usage('a',97),state:'stale'}],now).level).toBe('unknown');
    expect(evaluateRail(settings(),[usage('a')],now+600001).level).toBe('unknown');
  });
  it('no selected or enabled accounts is grey',()=>{
    const s=settings();s.providers.a.enabled=false;expect(evaluateRail(s,[usage('a')],now).level).toBe('unknown');
    s.rail_warnings!.scope='selected';expect(evaluateRail(s,[usage('a')],now).reason).toContain('未选择');
  });
  it.each([[21,'green'],[20,'yellow'],[5,'red'],[0,'red'],[-1,'red']])('money %s => %s',(amount,level)=>{
    const s=settings();s.rail_warnings!.accounts.a={...defaultAccountRule(),balances:{CNY:{yellow:20,red:5}}};
    const u=usage('a');u.windows=[];u.balances=[{currency:'CNY',amount:Number(amount)}];
    expect(evaluateRail(s,[u],now).level).toBe(level);
  });
  it('does not add currencies or pretend unconfigured balances are green',()=>{
    const s=settings(),u=usage('a');u.windows=[];u.balances=[{currency:'CNY',amount:100},{currency:'USD',amount:1}];
    expect(evaluateRail(s,[u],now).level).toBe('unknown');expect(evaluateRail(s,[u],now).excluded).toHaveLength(2);
    s.rail_warnings!.accounts.a={...defaultAccountRule(),balances:{CNY:{yellow:20,red:5},USD:{yellow:2,red:1}}};
    expect(evaluateRail(s,[u],now).level).toBe('red');
  });
  it('money and percentage compare risk levels, not numeric amounts',()=>{
    const s=settings(['a','b']),cash={...usage('b'),windows:[],balances:[{currency:'CNY',amount:5}]};
    s.rail_warnings!.accounts.b={...defaultAccountRule(),balances:{CNY:{yellow:20,red:5}}};
    expect(evaluateRail(s,[usage('a',80),cash],now).sources.filter(x=>x.level==='red')[0].account).toBe('b');
  });
  it('unconfigured cached money is explicitly excluded rather than treated as a failed selected risk source',()=>{
    const s=settings(['a','b']),cash={...usage('b'),state:'stale' as const,windows:[],balances:[{currency:'CNY',amount:1}]};
    const result=evaluateRail(s,[usage('a'),cash],now);
    expect(result.level).toBe('green');expect(result.excluded).toHaveLength(1);
  });
  it('legacy settings retain the former warning threshold',()=>{
    const s=settings();delete s.rail_warnings;s.warning_threshold=80;
    expect(railConfig(s)).toMatchObject({yellow:65,red:80,custom_thresholds:true});
  });
  it('upgrades immediately, delays downgrades, restarts on risk increase, bypasses delay on config/reset/data loss',()=>{
    const s=settings(),red=evaluateRail(s,[usage('a',99)],now),green=evaluateRail(s,[usage('a',1)],now);
    let state=advanceRail(null,red,'config',0);state=advanceRail(state,green,'config',1);
    expect(state.shown.level).toBe('red');expect(advanceRail(state,green,'config',10000).shown.level).toBe('red');
    expect(advanceRail(state,green,'config',10001).shown.level).toBe('green');
    state=advanceRail(state,red,'config',5000);state=advanceRail(state,green,'config',6000);
    expect(advanceRail(state,green,'config',10001).shown.level).toBe('red');
    expect(advanceRail(state,green,'changed',6001).shown.level).toBe('green');
    expect(advanceRail(state,{...green,resetKey:JSON.stringify({'a:five':now+7200000})},'config',6001).shown.level).toBe('green');
    expect(advanceRail(state,{...green,level:'unknown'},'config',6001).shown.level).toBe('unknown');
  });
  it('shortReason formats single, multiple, and partial failure triggers properly',()=>{
    const s=settings(['a','b']);
    // single trigger
    const single=evaluateRail(s,[usage('a',95),usage('b',20)],now);
    expect(single.shortReason).toContain('红色：a');
    expect(single.shortReason).toContain('达到红色阈值 90%');
    // multiple triggers
    const multiple=evaluateRail(s,[usage('a',95),usage('b',96)],now);
    expect(multiple.shortReason).toBe('2 个账号达到红色预警：a、b');
    // partial failure
    const broken={...usage('b'),state:'error'} as ProviderUsage;
    const partial=evaluateRail(s,[usage('a',95),broken],now);
    expect(partial.shortReason).toContain('（部分账号数据不可用）');
    // all green
    const green=evaluateRail(s,[usage('a',20),usage('b',30)],now);
    expect(green.shortReason).toBe('绿色：所有关注账号额度充足');
  });
  it('handles non-currency units and formatTimeAgo',()=>{
    const s=settings(['a']);
    const u=usage('a');u.balances=[{currency:'POINTS',amount:1000}];
    const res=evaluateRail(s,[u],now);
    expect(res.excluded[0]).toContain('此计量类型暂未配置预警规则');
  });
});
