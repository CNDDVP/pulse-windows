// @vitest-environment jsdom
// Round 5c 项目一：示范页（TokenSpend）i18n 组件测试。
// 断言：en 渲染顶部段落与按钮（诚实口径句句对应）、en 下扫描/导出行为不变、
// 受控语言切换即时生效并同步 <html lang>；未包 Provider 时回落 zh（既有测试兼容）。
import {it,expect,vi,afterEach} from 'vitest';
import {render,fireEvent,screen,act,cleanup} from '@testing-library/react';
import {TokenSpend} from './TokenSpend';
import {I18nProvider, setLang} from '../lib/i18n';
import type {AppSettings} from '../types';

const invoke=vi.hoisted(()=>vi.fn());
vi.mock('@tauri-apps/api/core',()=>({invoke}));
vi.mock('@tauri-apps/api/event',()=>({listen:vi.fn(()=>Promise.resolve(()=>{}))}));
// en 用例挂载受控 Provider 会把模块级语言置 en 且卸载不还原；每例后重置回 zh。
afterEach(()=>{cleanup();invoke.mockReset();setLang('zh');});

const emptySummary={rows:[],scanned_files:1,changed_files:1,skipped_files:0,days:7,partial:false,cost_estimate:null,notes:[]};
const row={source:'claude',model:'glm-5',day:'2026-09-23',hour:'08:00',input:11,output:4,cache_read:6,cache_write:2,partial:false};

function En({children}:{children:React.ReactNode}){return <I18nProvider lang="en">{children}</I18nProvider>;}

it('en 渲染顶部标题/段落与按钮区，诚实口径句句对应',()=>{
  invoke.mockImplementation(()=>Promise.resolve());
  render(<En><TokenSpend/></En>);
  expect(screen.getByText('Token Spend')).toBeTruthy();
  // 段落口径：本地记录、含今天、公开定价估算、仅供参考——一个都不能少。
  expect(screen.getByText(/Reads usage records on this machine/)).toBeTruthy();
  expect(screen.getByText(/always includes today/)).toBeTruthy();
  expect(screen.getByText(/estimated from known public model pricing/)).toBeTruthy();
  expect(screen.getByText(/for reference only/)).toBeTruthy();
  // 页签与按钮。
  expect(screen.getByText('Summary')).toBeTruthy();
  expect(screen.getByText('Trend')).toBeTruthy();
  expect(screen.getByText('Sessions')).toBeTruthy();
  expect(screen.getByText('Read usage records')).toBeTruthy();
  expect(screen.getByText('Export CSV')).toBeTruthy();
  expect(screen.getByText('Export JSON')).toBeTruthy();
  // 下拉选项（天数插值 + 分组）。
  expect(screen.getByText('Last 7 days')).toBeTruthy();
  expect(screen.getByRole('option',{name:'By day'})).toBeTruthy();
  expect(screen.getByRole('option',{name:'By hour'})).toBeTruthy();
  expect(screen.getByRole('option',{name:'By source / model'})).toBeTruthy();
  // zh 文案不得再以硬编码形式出现在 en 渲染里。
  expect(screen.queryByText('读取使用记录')).toBeNull();
  expect(document.documentElement.lang).toBe('en');
});

it('en 渲染结果区：扫描摘要、费用徽标口径、表头与命中率脚注逐句对应',async()=>{
  const rows=[{source:'claude',model:'claude-sonnet',day:'2026-09-23',hour:'08:00',input:60,output:10,cache_read:30,cache_write:5,partial:false}];
  invoke.mockImplementation((name:string)=>name==='token_spend'
    ?Promise.resolve({rows,scanned_files:2,changed_files:1,skipped_files:0,days:7,partial:true,cost_estimate:10,duration_ms:1234,notes:['backend-note-zh'],coverage_gap:true})
    :Promise.resolve());
  // CNY 显示：同时驱动「固定汇率估算 + 原始估算为 USD」双口径标注的英译。
  render(<En><TokenSpend settings={{display_currency:'CNY',usd_cny_rate:7.2} as AppSettings}/></En>);
  await act(async()=>{fireEvent.click(screen.getByText('Read usage records'))});
  // 扫描摘要 + 耗时 + 句号 + 「统计不完整」限定语（诚实口径不得缺失）。
  expect(screen.getByText(/Last 7 days: checked 2 files, 1 updated, 0 skipped/)).toBeTruthy();
  expect(screen.getByText(/\(1234 ms elapsed\)\./)).toBeTruthy();
  expect(screen.getByText(/The statistics are incomplete/)).toBeTruthy();
  // 费用徽标 + 双口径标注（汇率口径与「原始估算为 USD」同 span，子串断言）。
  expect(screen.getByText('Estimated cost: ~¥72.00 CNY')).toBeTruthy();
  expect(screen.getByText(/estimated at the fixed exchange rate 7\.20 \(the raw estimate is in USD\)/)).toBeTruthy();
  // 截断/缺口警示。
  expect(screen.getByText(/not fully reflected/)).toBeTruthy();
  // Rust 侧 notes 原样展示（TODO(EN-backend)），不得伪译。
  expect(screen.getByText('backend-note-zh')).toBeTruthy();
  // 表头。
  expect(screen.getByText('Group')).toBeTruthy();
  expect(screen.getByText('Input')).toBeTruthy();
  expect(screen.getByText('Cache read')).toBeTruthy();
  // 切到「按来源 / 模型」分组：命中率脚注与合计行走英译。
  fireEvent.change(screen.getByDisplayValue('By day'),{target:{value:'model'}});
  fireEvent.click(screen.getByText(/claude \/ claude-sonnet/));
  expect(screen.getByText(/Cache hit rate = cache_read \/ \(input \+ cache read \+ output\)/)).toBeTruthy();
  expect(screen.getByText(/Input 60 · Output 10 · Cache read 30 · Cache write 5 · cache hit rate 30\.0%/)).toBeTruthy();
  expect(screen.getByText(/Total · whole-window cache hit rate 30\.0%/)).toBeTruthy();
  // StepFun 积分卡标题（数据来自 get_usages）不在本 mock 中；此处仅验证 24h 卡不存在时无 zh 残留。
  expect(screen.queryByText(/24小时积分明细/)).toBeNull();
});

it('en 下扫描与导出行为不变：参数、回包与导出路径提示照常',async()=>{
  invoke.mockImplementation((name:string)=>
    name==='token_spend'?Promise.resolve({...emptySummary,rows:[row]}):
    name==='export_ledger'?Promise.resolve('D:\\data\\exports\\a.csv'):
    Promise.resolve());
  render(<En><TokenSpend/></En>);
  await act(async()=>{fireEvent.click(screen.getByText('Read usage records'))});
  expect(invoke.mock.calls.some(c=>c[0]==='token_spend'&&JSON.stringify(c[1])===JSON.stringify({days:7}))).toBe(true);
  expect((screen.getByText('Export CSV') as HTMLButtonElement).disabled).toBe(false);
  await act(async()=>{fireEvent.click(screen.getByText('Export CSV'))});
  const call=invoke.mock.calls.find(c=>c[0]==='export_ledger');
  expect(call).toBeTruthy();
  expect(call![1]).toMatchObject({format:'csv'});
  expect(screen.getByText(/Exported to D:\\data\\exports\\a\.csv/)).toBeTruthy();
});

it('en 下读取中的按钮与提示（busy_hint）走英译',async()=>{
  let resolve!:(v:unknown)=>void;
  invoke.mockImplementation((name:string)=>name==='token_spend'?new Promise(r=>{resolve=r}):Promise.resolve());
  render(<En><TokenSpend/></En>);
  await act(async()=>{fireEvent.click(screen.getByText('Read usage records'))});
  expect(screen.getByText('Reading…')).toBeTruthy();
  // busy 提示：首次读取耗时、跨页取消口径全部译出。
  expect(screen.getByText(/ten-odd seconds to a minute/)).toBeTruthy();
  expect(screen.getByText(/switching to another page cancels the current read/)).toBeTruthy();
  expect(screen.getByText(/Completed results are kept/)).toBeTruthy();
  await act(async()=>{resolve(emptySummary)});
});

it('受控语言切换：provider lang 变化即时生效并同步 <html lang>',()=>{
  invoke.mockImplementation(()=>Promise.resolve());
  const view=render(<I18nProvider lang="zh"><TokenSpend/></I18nProvider>);
  expect(screen.getByText('Token 消耗')).toBeTruthy();
  expect(document.documentElement.lang).toBe('zh-CN');
  view.rerender(<I18nProvider lang="en"><TokenSpend/></I18nProvider>);
  expect(screen.getByText('Token Spend')).toBeTruthy();
  expect(screen.getByText('Read usage records')).toBeTruthy();
  expect(document.documentElement.lang).toBe('en');
  view.rerender(<I18nProvider lang="zh"><TokenSpend/></I18nProvider>);
  expect(screen.getByText('Token 消耗')).toBeTruthy();
  expect(document.documentElement.lang).toBe('zh-CN');
});

it('未包 Provider 时回落 zh：与既有中文断言/行为完全一致',async()=>{
  invoke.mockImplementation((name:string)=>name==='token_spend'?Promise.resolve({...emptySummary,rows:[row]}):Promise.resolve());
  render(<TokenSpend/>);
  expect(screen.getByText('Token 消耗')).toBeTruthy();
  expect(screen.getByText('读取使用记录')).toBeTruthy();
  expect(screen.getByText('汇总')).toBeTruthy();
  await act(async()=>{fireEvent.click(screen.getByText('读取使用记录'))});
  expect(invoke.mock.calls.some(c=>c[0]==='token_spend')).toBe(true);
});

it('脏语言值经 Provider 防御性归一：settings 流来的非法值回落 zh，不崩不猜',()=>{
  invoke.mockImplementation(()=>Promise.resolve());
  // 模拟后端/旧配置流来的脏值：Provider 内部经 normalizeLang 收敛。
  const dirty='fr' as unknown as AppSettings['language'];
  render(<I18nProvider lang={dirty}><TokenSpend/></I18nProvider>);
  expect(screen.getByText('Token 消耗')).toBeTruthy();
  expect(document.documentElement.lang).toBe('zh-CN');
});
