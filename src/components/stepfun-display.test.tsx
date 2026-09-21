// @vitest-environment jsdom
import {afterEach,expect,it} from 'vitest';
import {cleanup,render} from '@testing-library/react';
import {UsageDetailCard} from './UsageDetailCard';
import {UsageRing} from './UsageRing';
import type {AppSettings,ProviderUsage} from '../types';
afterEach(cleanup);
const usage={account_id:'s',provider_id:'stepfun',display_name:'StepFun',state:'live',primary_percent:0.75,windows:[{id:'plan',name:'Credit 套餐额度',used_percent:0.75,used_fraction:0.0075,resets_at:null,window_seconds:null,exhausted:false}],balances:[{currency:'CNY',amount:15},{currency:'Credit',amount:1588018947}],error_message:null,is_active:true} as ProviderUsage;
const settings={providers:{s:{primary_window:null}},display_mode:'used',theme:'obsidian',warning_threshold:90,reduce_motion:true} as unknown as AppSettings;
it('shows cash, credits and quota together while preserving partial-source warning',()=>{
 const {container}=render(<UsageDetailCard usage={{...usage,error_message:'套餐：部分信息不可用'}} settings={settings}/>);
 expect(container.textContent).toContain('API 可用余额：¥15.00');expect(container.textContent).toContain('套餐剩余：15.88 亿 Credit');expect(container.textContent).toContain('0.75%');expect(container.textContent).toContain('部分信息不可用');
});
it('shows topup bucket with expiry and hourly usages chart',()=>{
 const usageWithTopup: ProviderUsage = {
   ...usage,
   balances: [
     { currency: 'CNY', amount: 15 },
     { currency: 'Credit', amount: 1000000 },
     { currency: 'Credit-Topup', amount: 500000, expires_at: '2026-12-31T23:59:59Z' },
   ],
   hourly_usages: [
     { timestamp: 1774137600, model_id: 'step-2-16k', calls: 12, credit_consumed: 3000 },
     { timestamp: 1774141200, model_id: 'step-2-16k', calls: 5, credit_consumed: 1500 },
   ],
 };
 const {container}=render(<UsageDetailCard usage={usageWithTopup} settings={settings}/>);
 expect(container.textContent).toContain('加油包剩余：50.00 万 Credit');
 expect(container.textContent).toContain('到期时间：');
 expect(container.textContent).toContain('24h 积分消耗趋势');
 expect(container.textContent).toContain('共 4,500 Credit');
});
it('reduced motion removes both activity and refresh spins',()=>{
 const {container}=render(<UsageRing usage={usage} settings={settings} onHover={()=>{}} refreshing/>);
 expect(container.querySelector('.animate-spin')).toBeNull();expect(container.querySelector('.bg-white')).not.toBeNull();
});
