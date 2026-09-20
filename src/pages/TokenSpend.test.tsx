// @vitest-environment jsdom
import {it,expect,vi,afterEach} from 'vitest';
import {render,fireEvent,screen,act,cleanup} from '@testing-library/react';
import {TokenSpend} from './TokenSpend';
const invoke=vi.hoisted(()=>vi.fn());
vi.mock('@tauri-apps/api/core',()=>({invoke}));
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
