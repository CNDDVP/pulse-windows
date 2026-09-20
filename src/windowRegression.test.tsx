// @vitest-environment jsdom
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {render,act,cleanup} from '@testing-library/react';
import {FloatingRail} from './components/FloatingRail';
import {waitForDetailLayout} from './detailLayout';
import type {AppSettings} from './types';

const api=vi.hoisted(()=>({invoke:vi.fn(),listeners:new Map<string,(e:{payload:unknown})=>void>()}));
vi.mock('@tauri-apps/api/core',()=>({invoke:api.invoke}));
vi.mock('@tauri-apps/api/event',()=>({listen:vi.fn(async(name:string,handler:(e:{payload:unknown})=>void)=>{
  api.listeners.set(name,handler);return()=>{if(api.listeners.get(name)===handler)api.listeners.delete(name)};
})}));
vi.mock('./components/UsageRing',()=>({UsageRing:()=>null}));
const settings={providers:{},auto_collapse_seconds:1,dock_side:'right',reduce_motion:false,warning_threshold:85} as AppSettings;
const emit=(name:string,payload:unknown=null)=>act(()=>{api.listeners.get(name)?.({payload})});
const collapsedCalls=()=>api.invoke.mock.calls.filter(([name,args])=>name==='set_window_state'&&args.state==='collapsed');
beforeEach(()=>{
  vi.useFakeTimers();api.listeners.clear();api.invoke.mockReset();api.invoke.mockResolvedValue(false);
  vi.stubGlobal('ResizeObserver',class {observe(){} disconnect(){}});
});
afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals()});

it('repeated backend requests do not postpone the first transition',async()=>{
  render(<FloatingRail settings={settings} usages={[]}/>);
  emit('request-collapse');await act(()=>vi.advanceTimersByTimeAsync(250));
  emit('request-collapse');await act(()=>vi.advanceTimersByTimeAsync(30));
  expect(collapsedCalls()).toHaveLength(1);
});
it('reading the separate detail window blocks and cancels collapse',async()=>{
  render(<FloatingRail settings={settings} usages={[]}/>);
  emit('request-collapse');await act(()=>vi.advanceTimersByTimeAsync(100));
  emit('detail-pointer',true);emit('request-collapse');
  await act(()=>vi.advanceTimersByTimeAsync(10000));
  expect(collapsedCalls()).toHaveLength(0);
  expect(api.invoke.mock.calls.filter(([name])=>name==='hide_detail')).toHaveLength(0);
  emit('detail-pointer',false);emit('request-collapse');
  await act(()=>vi.advanceTimersByTimeAsync(280));expect(collapsedCalls()).toHaveLength(1);
});
it('changing reduced motion cancels old animation and uses the new policy immediately',async()=>{
  const view=render(<FloatingRail settings={settings} usages={[]}/>);
  emit('request-collapse');
  view.rerender(<FloatingRail settings={{...settings,reduce_motion:true}} usages={[]}/>);
  emit('request-collapse');expect(collapsedCalls()).toHaveLength(1);
  await act(()=>vi.advanceTimersByTimeAsync(500));expect(collapsedCalls()).toHaveLength(1);
});
it('reveal cancels an outstanding collapse and pins subsequent requests',async()=>{
  render(<FloatingRail settings={settings} usages={[]}/>);
  emit('request-collapse');emit('reveal-rail');emit('request-collapse');
  await act(()=>vi.advanceTimersByTimeAsync(4999));expect(collapsedCalls()).toHaveLength(0);
});
it('slow layout never presents until two matching measurements',async()=>{
  let ready=false;const present=vi.fn(async()=>true),timeout=vi.fn();
  const stop=waitForDetailLayout(()=>ready,present,timeout);
  await vi.advanceTimersByTimeAsync(1000);expect(present).not.toHaveBeenCalled();
  ready=true;await vi.advanceTimersByTimeAsync(100);expect(present).toHaveBeenCalledTimes(1);
  expect(timeout).not.toHaveBeenCalled();stop();
});
it('layout timeout and cancelled old request cannot force presentation',async()=>{
  const present=vi.fn(async()=>true),timeout=vi.fn();
  const stop=waitForDetailLayout(()=>false,present,timeout);
  await vi.advanceTimersByTimeAsync(5100);expect(timeout).toHaveBeenCalledTimes(1);
  expect(present).not.toHaveBeenCalled();stop();
  const cancel=waitForDetailLayout(()=>true,present,timeout);cancel();
  await vi.advanceTimersByTimeAsync(200);expect(present).not.toHaveBeenCalled();
});
it('transient rejected presentation is retried without bypassing measurement',async()=>{
  const present=vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const stop=waitForDetailLayout(()=>true,present,vi.fn());
  await vi.advanceTimersByTimeAsync(150);expect(present).toHaveBeenCalledTimes(2);stop();
});
