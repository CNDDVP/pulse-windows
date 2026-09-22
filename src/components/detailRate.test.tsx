// @vitest-environment jsdom
import {afterEach,expect,it} from 'vitest';
import {cleanup,render} from '@testing-library/react';
import {UsageDetailCard} from './UsageDetailCard';
import type {AppSettings,ProviderUsage} from '../types';
afterEach(cleanup);

// Round4 项目一验收（ROUND4_PLAN 17-19）：详情卡账号行下新增「速率」行，仅工作状态显示；
// 渠道日志无 usage 字段（tok_per_min 缺省/None）显示「—」，不编造。
const base={account_id:'s',provider_id:'claude',display_name:'Claude',state:'live',primary_percent:null,windows:[],balances:[],error_message:null} as unknown as ProviderUsage;
const settings={providers:{s:{}},display_mode:'used',theme:'obsidian',warning_threshold:90,reduce_motion:true} as unknown as AppSettings;

it('working account without usage data shows the rate row with an honest —',()=>{
  const {container}=render(<UsageDetailCard usage={{...base,is_active:true}} settings={settings}/>);
  expect(container.textContent).toContain('速率：—');
});

it('working account renders the tok/min value (backend rounds; frontend never invents decimals)',()=>{
  const {container}=render(<UsageDetailCard usage={{...base,is_active:true,tok_per_min:42.4}} settings={settings}/>);
  expect(container.textContent).toContain('速率：42 tok/min');
});

it('the rate row is hidden when the account is not working',()=>{
  const {container}=render(<UsageDetailCard usage={{...base,is_active:false,tok_per_min:42}} settings={settings}/>);
  expect(container.textContent).not.toContain('速率');
});
