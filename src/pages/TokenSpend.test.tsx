// @vitest-environment jsdom
import {it,expect,vi,afterEach} from 'vitest';
import {render,fireEvent,screen,act,cleanup} from '@testing-library/react';
import {TokenSpend} from './TokenSpend';
import type {AppSettings} from '../types';
const invoke=vi.hoisted(()=>vi.fn());
vi.mock('@tauri-apps/api/core',()=>({invoke}));
vi.mock('@tauri-apps/api/event',()=>({listen:vi.fn(()=>Promise.resolve(()=>{}))}));
afterEach(()=>{cleanup();invoke.mockReset()});
it('leaving a pending scan clears busy; a late result cannot replace a newer scan',async()=>{
  const resolvers:((v:unknown)=>void)[]=[];
  invoke.mockImplementation((name:string)=>name==='token_spend'?new Promise(resolve=>resolvers.push(resolve)):Promise.resolve());
  const view=render(<TokenSpend/>);
  await act(async()=>{fireEvent.click(screen.getByText('读取使用记录'))});
  expect(resolvers).toHaveLength(1);
  view.rerender(<TokenSpend active={false}/>);view.rerender(<TokenSpend active/>);
  expect((screen.getByText('读取使用记录') as HTMLButtonElement).disabled).toBe(false);
  await act(async()=>{fireEvent.click(screen.getByText('读取使用记录'))});
  expect(resolvers).toHaveLength(2);
  const summary=(note:string)=>({rows:[],scanned_files:1,changed_files:1,skipped_files:0,days:7,partial:false,cost_estimate:null,notes:[note]});
  await act(async()=>{resolvers[1](summary('new-result'))});
  await act(async()=>{resolvers[0](summary('obsolete-result'))});
  expect(screen.queryByText('obsolete-result')).toBeNull();expect(screen.getByText('new-result')).toBeTruthy();
  expect((screen.getByText('读取使用记录') as HTMLButtonElement).disabled).toBe(false);
});

it('export buttons stay disabled without rows; exporting sends current rows and shows the path',async()=>{
  const row={source:'claude',model:'glm-5',day:'2026-09-23',hour:'08:00',input:11,output:4,cache_read:6,cache_write:2,partial:false};
  invoke.mockImplementation((name:string)=>name==='token_spend'?Promise.resolve({rows:[row],scanned_files:1,changed_files:1,skipped_files:0,days:7,partial:false,cost_estimate:null,notes:[]}):name==='export_ledger'?Promise.resolve('D:\\data\\exports\\token-spend-20260923-120000.csv'):Promise.resolve());
  render(<TokenSpend/>);
  // 尚无统计结果：导出按钮禁用。
  expect((screen.getByText('导出 CSV') as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByText('导出 JSON') as HTMLButtonElement).disabled).toBe(true);
  await act(async()=>{fireEvent.click(screen.getByText('读取使用记录'))});
  expect((screen.getByText('导出 CSV') as HTMLButtonElement).disabled).toBe(false);
  await act(async()=>{fireEvent.click(screen.getByText('导出 CSV'))});
  const call=invoke.mock.calls.find((c:string[])=>c[0]==='export_ledger');
  expect(call).toBeTruthy();
  expect(call![1]).toMatchObject({format:'csv'});
  expect((call![1] as {rows:unknown[]}).rows).toEqual([row]);
  expect(screen.getByText(/已导出到 D:\\data\\exports\\token-spend-20260923-120000\.csv/)).toBeTruthy();
  // 导出失败走既有错误提示区域。
  invoke.mockImplementation((name:string)=>name==='export_ledger'?Promise.reject('导出文件写入失败：boom'):Promise.resolve());
  await act(async()=>{fireEvent.click(screen.getByText('导出 CSV'))});
  expect(screen.getByText('导出文件写入失败：boom')).toBeTruthy();
});

it('USD default shows the estimate un-annotated; a bad rate cannot corrupt the display',async()=>{
  const summary=(cost:number|null)=>({rows:[],scanned_files:1,changed_files:1,skipped_files:0,days:7,partial:false,cost_estimate:cost,notes:[]});
  invoke.mockImplementation((name:string)=>name==='token_spend'?Promise.resolve(summary(10)):Promise.resolve());
  render(<TokenSpend/>);
  await act(async()=>{fireEvent.click(screen.getByText('读取使用记录'))});
  expect(screen.getByText(/预估费用: ~\$10\.00 USD/)).toBeTruthy();
  expect(screen.queryByText(/按固定汇率/)).toBeNull();
});

it('CNY display converts the cost badge with the fixed-rate annotation and export carries displayCurrency + subscriptions',async()=>{
  const row={source:'claude',model:'claude-sonnet',day:'2026-09-23',hour:'08:00',input:100,output:4,cache_read:0,cache_write:0,partial:false};
  invoke.mockImplementation((name:string)=>name==='token_spend'
    ?Promise.resolve({rows:[row],scanned_files:1,changed_files:1,skipped_files:0,days:7,partial:false,cost_estimate:10,month_cost_by_source:{claude:10},notes:[]})
    :name==='get_subscriptions'
      ?Promise.resolve({claude:{price:20,currency:'USD',cycle_days:30,start_date:'',note:''},codex:{price:0,currency:'USD',cycle_days:30,start_date:'',note:''},gemini:{price:5,currency:'USD',cycle_days:0,start_date:'',note:''}})
      :Promise.resolve('D:\\x\\exports\\token-spend.json'));
  const settings={display_currency:'CNY',usd_cny_rate:7.2} as AppSettings;
  render(<TokenSpend settings={settings}/>);
  await act(async()=>{fireEvent.click(screen.getByText('读取使用记录'))});
  // $10 × 7.2 = ¥72.00，且必须就近标注固定汇率口径（原始估算为 USD）。
  expect(screen.getByText(/预估费用: ~¥72\.00 CNY/)).toBeTruthy();
  expect(screen.getByText(/按固定汇率 7\.20 估算/)).toBeTruthy();
  await act(async()=>{fireEvent.click(screen.getByText('导出 JSON'))});
  const call=invoke.mock.calls.find(c=>c[0]==='export_ledger');
  expect(call![1]).toMatchObject({format:'json',displayCurrency:'CNY'});
  // 与保存同口径：价格 0（未登记）与后端会拒绝的草稿（周期 0）都不进导出文件。
  expect(Object.keys((call![1] as {subscriptions:Record<string,unknown>}).subscriptions)).toEqual(['claude']);
  expect((call![1] as {subscriptions:Record<string,{price:number}>}).subscriptions.claude).toMatchObject({price:20,currency:'USD'});
});

it('model group rows expand to the four-way breakdown with hit rates; the totals row carries the window rate; zero-denominator rows show none',async()=>{
  const rows=[
    {source:'claude',model:'claude-sonnet',day:'2026-09-23',hour:'08:00',input:60,output:10,cache_read:30,cache_write:5,partial:false},
    {source:'codex',model:'gpt-4o',day:'2026-09-23',hour:'09:00',input:0,output:0,cache_read:0,cache_write:0,partial:false},
  ];
  invoke.mockImplementation((name:string)=>name==='token_spend'
    ?Promise.resolve({rows,scanned_files:1,changed_files:1,skipped_files:0,days:7,partial:false,cost_estimate:null,notes:[]})
    :Promise.resolve());
  render(<TokenSpend/>);
  await act(async()=>{fireEvent.click(screen.getByText('读取使用记录'))});
  fireEvent.change(screen.getByDisplayValue('按天'),{target:{value:'model'}});
  // 未展开时只有分组行与汇总行，没有展开明细（用四分项串判断，避免撞上汇总行的命中率）。
  expect(screen.queryByText(/输入 60 · 输出 10/)).toBeNull();
  fireEvent.click(screen.getByText(/claude \/ claude-sonnet/));
  expect(screen.getByText(/输入 60 · 输出 10 · 缓存读取 30 · 缓存写入 5 · 缓存命中率 30\.0%/)).toBeTruthy();
  // 分母 0 的行不显示命中率（连“命中率 0%”也不得编造）。
  fireEvent.click(screen.getByText(/codex \/ gpt-4o/));
  expect(screen.getByText(/输入 0 · 输出 0 · 缓存读取 0 · 缓存写入 0$/)).toBeTruthy();
  expect(screen.queryByText(/缓存写入 0 · 缓存命中率/)).toBeNull();
  // 汇总行：全窗口命中率 = 30/(60+30+10) = 30.0%。
  expect(screen.getByText(/合计 · 全窗口缓存命中率 30\.0%/)).toBeTruthy();
});
