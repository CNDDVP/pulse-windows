// @vitest-environment jsdom
// Round 5c 项目一：悬浮栏/详情卡域（rail.*）i18n 抽查——en 渲染 + 诚实口径逐句对应。
// 覆盖：FloatingRail（空槽位按钮/收纳条提示）、UsageRing（错误标题）、
// UsageDetailCard（速率/到期/无读数/来源兜底）、railWarnings（预警文案经模块级 t() 取词）。
// 既有中文断言的测试（detailRate/detailCurrency/stepfun-display/railWarnings.test）未包
// Provider，模块级语言默认 zh，t() 原样回中文，故保持不变。
import {it,expect,vi,afterEach,beforeEach} from 'vitest';
import {render,cleanup,screen} from '@testing-library/react';
import {FloatingRail} from './FloatingRail';
import {UsageRing} from './UsageRing';
import {UsageDetailCard} from './UsageDetailCard';
import {evaluateRail,formatTimeAgo,defaultRailWarnings} from '../railWarnings';
import {I18nProvider,setLang,translate} from '../lib/i18n';
import type {AppSettings,ProviderUsage} from '../types';

const invoke=vi.hoisted(()=>vi.fn());
vi.mock('@tauri-apps/api/core',()=>({invoke}));
vi.mock('@tauri-apps/api/event',()=>({listen:vi.fn(()=>Promise.resolve(()=>{}))}));
beforeEach(()=>{
  invoke.mockReset();invoke.mockResolvedValue(false);
  // jsdom 无 ResizeObserver：FloatingRail 用它量测收纳条尺寸。
  vi.stubGlobal('ResizeObserver',class{observe(){} disconnect(){}});
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();setLang('zh');});

const railSettings={providers:{},auto_collapse_seconds:1,dock_side:'right',reduce_motion:true,warning_threshold:85} as AppSettings;
const base={account_id:'s',provider_id:'claude',display_name:'Claude',state:'live',primary_percent:null,windows:[],balances:[],error_message:null,is_active:false,source:'fixture',plan_name:null,error_code:null,checked_at:null,last_success_at:null,retry_after_seconds:null,duration_ms:null} as unknown as ProviderUsage;
const settings={providers:{s:{}},display_mode:'used',theme:'obsidian',warning_threshold:90,reduce_motion:true} as unknown as AppSettings;

it('en 渲染悬浮栏：空槽位显示 Add account，收纳条 aria-label 与固定颜色口径标注为英文',()=>{
  render(<I18nProvider lang="en"><FloatingRail usages={[]} settings={railSettings}/></I18nProvider>);
  expect(screen.getByText('Add account')).toBeTruthy();
  expect(screen.queryByText('添加账号')).toBeNull();
  // 收纳条（collapsed edge bar）存在且 aria-label 已译。
  expect(screen.getByLabelText('Expand Pulse')).toBeTruthy();
  expect(document.documentElement.lang).toBe('en');
});

it('en 固定/彩虹颜色模式保留「不表示额度风险」诚实口径',()=>{
  const custom={...railSettings,collapsed_bar_color_mode:'custom',collapsed_bar_color:'#3366ff'} as AppSettings;
  const first=render(<I18nProvider lang="en"><FloatingRail usages={[]} settings={custom}/></I18nProvider>);
  expect(first.container.querySelector('[title="Fixed color (does not indicate quota risk)"]')).toBeTruthy();
  cleanup();
  const rainbow={...railSettings,collapsed_bar_color_mode:'rainbow'} as AppSettings;
  const view=render(<I18nProvider lang="en"><FloatingRail usages={[]} settings={rainbow}/></I18nProvider>);
  expect(view.container.querySelector('[title="Rainbow color (does not indicate quota risk)"]')).toBeTruthy();
});

it('en 圆环错误标题：连接异常兜底与「点击重新测试连接」口径译出，后端消息原样嵌入',()=>{
  const broken={...base,state:'error',error_message:'套餐：部分信息不可用'} as ProviderUsage;
  const {container}=render(<I18nProvider lang="en"><UsageRing usage={broken} settings={settings} onHover={()=>{}}/></I18nProvider>);
  const title=container.querySelector('button')!.getAttribute('title')!;
  expect(title).toContain('click to re-test the connection');
  // Rust 侧消息（本例为中文）不做翻译映射，原样展示。
  expect(title).toContain('套餐：部分信息不可用');
  expect(title).toContain('Claude');
  cleanup();
  // 无后端消息时展示连接异常兜底。
  const noMsg={...base,state:'error',error_message:null} as ProviderUsage;
  const view=render(<I18nProvider lang="en"><UsageRing usage={noMsg} settings={settings} onHover={()=>{}}/></I18nProvider>);
  expect(view.container.querySelector('button')!.getAttribute('title')).toContain('Connection error');
});

it('en 详情卡：速率行/无读数/来源兜底译出，stale 前缀译出而后端消息原样保留',()=>{
  const noSource={...base,source:''} as ProviderUsage;
  const {container}=render(<I18nProvider lang="en"><UsageDetailCard usage={{...noSource,is_active:true,tok_per_min:42.4}} settings={settings}/></I18nProvider>);
  expect(container.textContent).toContain('Rate: 42 tok/min');
  expect(container.textContent).toContain('No readings yet');
  expect(container.textContent).toContain('Waiting for connection');
  const stale={...base,state:'stale',error_code:'quota_error',error_message:'套餐：部分信息不可用'} as unknown as ProviderUsage;
  const view=render(<I18nProvider lang="en"><UsageDetailCard usage={stale} settings={settings}/></I18nProvider>);
  expect(view.container.textContent).toContain('Stale reading · 套餐：部分信息不可用');
});

it('en 详情卡剩余模式：百分比后跟 left（已用/剩余语义不互换），到期行用 Expires at',()=>{
  const withWin={...base,primary_percent:76,windows:[{id:'five',name:'Five hours',used_percent:76,used_fraction:0.76,resets_at:new Date(Date.now()+3600000).toISOString(),window_seconds:3600,exhausted:false}],balances:[{currency:'USD',amount:5,expires_at:'2026-12-31T23:59:59Z'}]} as unknown as ProviderUsage;
  const remaining={...settings,display_mode:'remaining'} as unknown as AppSettings;
  const {container}=render(<I18nProvider lang="en"><UsageDetailCard usage={withWin} settings={remaining}/></I18nProvider>);
  expect(container.textContent).toContain('24% left');
  expect(container.textContent).not.toContain('76% used');
  expect(container.textContent).toContain('Expires at:');
  expect(container.textContent).not.toContain('到期时间');
});

it('en railWarnings：shortReason/reason 经模块级 t() 取词，阈值口径句句对应；zh 纯函数不受模块语言影响',()=>{
  setLang('en');
  const now=Date.parse('2026-09-20T12:00:00Z');
  const usage=(id:string,used:number):ProviderUsage=>({account_id:id,provider_id:'codex',display_name:id,state:'live',last_success_at:new Date(now).toISOString(),primary_percent:used,windows:[{id:'five',name:'five',used_percent:used,used_fraction:used/100,window_seconds:3600,resets_at:new Date(now+3600000).toISOString(),exhausted:false}],balances:[],plan_name:null,is_active:false,error_code:null,error_message:null,source:'fixture',checked_at:null,retry_after_seconds:null,duration_ms:null} as ProviderUsage);
  const s=(ids=['a']):AppSettings=>({rail_warnings:defaultRailWarnings(),warning_threshold:90,providers:Object.fromEntries(ids.map(id=>[id,{enabled:true,provider_id:'codex',label:id,primary_window:null}]))} as AppSettings);
  const red=evaluateRail(s(),[usage('a',95)],now);
  expect(red.shortReason).toContain('Red: a');
  expect(red.shortReason).toContain('reached the Red threshold of 90%');
  const green=evaluateRail(s(['a','b']),[usage('a',20),usage('b',30)],now);
  expect(green.shortReason).toBe('Green: all watched accounts have ample quota');
  const multi=evaluateRail(s(['a','b']),[usage('a',95),usage('b',96)],now);
  expect(multi.shortReason).toBe('2 accounts reached the Red warning: a, b');
  expect(formatTimeAgo(null,now)).toBe('Not updated yet');
  // 纯函数 translate 不读模块级语言：zh 取词仍是中文原文（诚实文案不因模块语言漂移）。
  expect(translate('zh','rail.warn.short.green')).toBe('绿色：所有关注账号额度充足');
});
