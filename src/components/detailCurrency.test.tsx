// @vitest-environment jsdom
import {afterEach,expect,it} from 'vitest';
import {cleanup,render} from '@testing-library/react';
import {UsageDetailCard} from './UsageDetailCard';
import type {AppSettings,ProviderUsage} from '../types';
import {convertBalance,rateEstimateNote} from '../lib/currency';
afterEach(cleanup);

const usage={account_id:'s',provider_id:'claude',display_name:'Claude',state:'live',primary_percent:null,windows:[],balances:[{currency:'USD',amount:5},{currency:'CNY',amount:15}],error_message:null,is_active:true} as unknown as ProviderUsage;
const baseSettings={providers:{s:{}},display_mode:'used',theme:'obsidian',warning_threshold:90,reduce_motion:true} as unknown as AppSettings;

it('CNY display mode annotates the fixed-rate conversion of USD balances only',()=>{
  const settings={...baseSettings,display_currency:'CNY',usd_cny_rate:7.2} as AppSettings;
  const {container}=render(<UsageDetailCard usage={usage} settings={settings}/>);
  // USD 余额：折算参考行 + 口径标注（$5 × 7.2 = ¥36.00）。
  expect(container.textContent).toContain('≈ ¥36.00（按固定汇率 7.20 估算）');
  // 原生 CNY 余额不折算（显示原值），Credit 也不是货币；标注全文只出现一次（USD 行）。
  expect(container.textContent).toContain('可用余额：¥15.00');
  expect(container.textContent.split('按固定汇率 7.20 估算')).toHaveLength(2);
});

it('USD display mode (default) shows balances as-is without any conversion line',()=>{
  const {container}=render(<UsageDetailCard usage={usage} settings={baseSettings}/>);
  expect(container.textContent).not.toContain('≈');
  expect(container.textContent).not.toContain('按固定汇率');
  expect(container.textContent).toContain('USD 5.00');
});

it('missing or invalid rate fields fall back to the default 7.2 instead of breaking the card',()=>{
  const settings={...baseSettings,display_currency:'CNY'} as AppSettings;
  const {container}=render(<UsageDetailCard usage={usage} settings={settings}/>);
  expect(container.textContent).toContain('≈ ¥36.00（按固定汇率 7.20 估算）');
  expect(rateEstimateNote('CNY',Number.NaN)).toBe('按固定汇率 7.20 估算');
  expect(convertBalance(5,'USD','CNY',Number.NaN)).toBeCloseTo(36,10);
});
