import {describe,it,expect} from 'vitest';
import {percentText,resetText,forecast,forecastKind,pickElapsedWindow,timingWindows} from './presentation';
import type {ProviderUsage,UsageWindow,ProviderConfig} from './types';
describe('truthful presentation',()=>{
  it('never draws error/loading as zero',()=>{for(const state of ['error','loading','unavailable'] as const){expect(percentText({state,primary_percent:0,balances:[]} as unknown as ProviderUsage)).toBe('—')}});
  it('separates stale, remaining, and money',()=>{expect(percentText({state:'stale',primary_percent:30} as ProviderUsage,'remaining')).toBe('70%*');expect(percentText({state:'live',primary_percent:null,balances:[{currency:'USD',amount:3}]} as ProviderUsage)).toBe('余额');expect(percentText({state:'stale',primary_percent:null,balances:[{currency:'USD',amount:3}]} as ProviderUsage)).toBe('余额*')});
  it('does not guess reset or forecast',()=>{expect(resetText(null)).toBe('未报告重置时间');expect(forecast({window_seconds:null,resets_at:'2030-01-01T00:00:00Z'} as UsageWindow)).toBeNull()});
  it('expired date is not future reset',()=>{expect(resetText('2026-01-01T00:00:00Z',Date.parse('2026-01-02T00:00:00Z'))).toContain('等待')});
  it('outer ring follows the pinned window or the soonest reset',()=>{
    const now=Date.parse('2026-09-17T12:00:00Z');
    const five={id:'5h',name:'5h',used_fraction:0.2,used_percent:20,resets_at:'2026-09-17T13:00:00Z',window_seconds:18000,exhausted:false};
    const week={id:'weekly',name:'weekly',used_fraction:0.3,used_percent:30,resets_at:'2026-09-20T00:00:00Z',window_seconds:604800,exhausted:false};
    const untimed={id:'x',name:'x',used_fraction:0,used_percent:0,resets_at:null,window_seconds:null,exhausted:false};
    expect(pickElapsedWindow([week,five,untimed],null,now)?.id).toBe('5h');
    expect(pickElapsedWindow([week,five],'weekly',now)?.id).toBe('weekly');
    expect(pickElapsedWindow([week,five,untimed],'x',now)).toBeNull();
    expect(pickElapsedWindow([untimed],null,now)).toBeNull();
  });
  it('timingWindows prioritizes data source and falls back to stepfun 30d or custom days',()=>{
    const stepUsage: ProviderUsage = {
      account_id: 'step-1', provider_id: 'stepfun', display_name: 'StepFun', state: 'live',
      primary_percent: 10, plan_name: null, error_code: null, error_message: null,
      source: 'test', checked_at: '2026-09-21T10:00:00Z', last_success_at: '2026-09-21T10:00:00Z',
      retry_after_seconds: null, duration_ms: 100,
      balances: [], is_active: false,
      windows: [
        { id: 'plan', name: 'Credit 套餐额度', used_fraction: 0.1, used_percent: 10, resets_at: '2026-10-20T00:00:00Z', window_seconds: null, exhausted: false },
        { id: '5h', name: '5小时限额', used_fraction: 0.2, used_percent: 20, resets_at: '2026-09-21T15:00:00Z', window_seconds: 18000, exhausted: false },
      ],
    };
    // 默认自动模式：5h 保留数据源周期，plan 按 30 天规则估算
    const autoTimed = timingWindows(stepUsage);
    expect(autoTimed.find(w => w.id === '5h')?.window_seconds).toBe(18000);
    expect(autoTimed.find(w => w.id === '5h')?.period_note).toBe('按数据源周期计算');
    expect(autoTimed.find(w => w.id === 'plan')?.window_seconds).toBe(30 * 86400);
    expect(autoTimed.find(w => w.id === 'plan')?.period_note).toBe('按 StepFun 30 天规则估算');

    // 自定义周期模式：用户设置 15 天，plan 按自定义周期估算，5h 仍保留数据源周期
    const customCfg: ProviderConfig = {
      provider_id: 'stepfun', label: 'StepFun', enabled: true, order: 0,
      use_local: false, credential_configured: true, primary_window: null,
      elapsed_window: null, elapsed_period_days: 15, ring_color: null,
      mark_mode: null, bot_persona: null, bot_shape: null, bot_color: null,
      secondary_window: null, split_model_groups: false, low_balance: null, low_balance_currency: null,
    };
    const customTimed = timingWindows(stepUsage, customCfg);
    expect(customTimed.find(w => w.id === 'plan')?.window_seconds).toBe(15 * 86400);
    expect(customTimed.find(w => w.id === 'plan')?.period_note).toBe('按自定义周期估算（15 天）');
    expect(customTimed.find(w => w.id === '5h')?.window_seconds).toBe(18000);
    expect(customTimed.find(w => w.id === '5h')?.period_note).toBe('按数据源周期计算');
  });
  it('forecast kinds map to the four severities',()=>{
    const t=Date.parse('2026-09-18T12:00:00Z');
    const mk=(fraction:number,resetsInS:number,windowS=3600)=>({id:'w',name:'w',used_fraction:fraction,used_percent:fraction*100,resets_at:new Date(t+resetsInS*1000).toISOString(),window_seconds:windowS,exhausted:fraction>=1});
    expect(forecastKind(mk(1,600),t)).toBe('exhausted');
    expect(forecastKind(mk(0.1,600),t)).toBe('ok');
    expect(forecastKind(mk(0.95,360),t)).toBe('soon');
    expect(forecastKind(mk(0.9,17280,86400),t)).toBe('risk');
  });
});
