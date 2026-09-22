// @vitest-environment jsdom
import {it,expect,vi,afterEach} from 'vitest';
import {render,fireEvent,screen,act,cleanup} from '@testing-library/react';
import {TokenSpend} from './TokenSpend';
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
