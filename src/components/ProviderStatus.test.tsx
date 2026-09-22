// @vitest-environment jsdom
import {it,expect,vi,afterEach} from 'vitest';
import {render,fireEvent,screen,act,cleanup} from '@testing-library/react';
import {ProviderStatus} from './ProviderStatus';
import {NO_PUBLIC_ENDPOINT,indicatorColor,indicatorLabel,formatUpdatedAt} from '../lib/providerStatus';
const invoke=vi.hoisted(()=>vi.fn());
vi.mock('@tauri-apps/api/core',()=>({invoke}));
afterEach(()=>{cleanup();invoke.mockReset()});

const callsOf=(name:string)=>invoke.mock.calls.filter((c:string[])=>c[0]===name);
const entry=(over:Record<string,unknown>={})=>({
  provider:'anthropic',display_name:'Anthropic',indicator:'operational',
  description:'All Systems Operational',updated_at:'2026-09-23T05:42:11.123Z',state:'ok',...over,
});

it('renders four-color lights with labels, description and status-page updated time',async()=>{
  invoke.mockImplementation((name:string)=>name==='fetch_provider_status'
    ?Promise.resolve([
      entry(),
      entry({provider:'openai',display_name:'OpenAI',indicator:'outage',description:'Partial System Outage',updated_at:'2026-09-23T06:10:00.000Z',state:'ok'}),
      entry({provider:'x',display_name:'X',indicator:'unknown',description:'状态页返回 HTTP 503',updated_at:null,state:'unavailable'}),
    ]):Promise.resolve());
  const {container}=render(<ProviderStatus active/>);
  await act(async()=>{});
  const call=callsOf('fetch_provider_status');
  expect(call).toHaveLength(1);
  // 四色：绿/红/灰（class 断言，黄档由 indicatorColor 单独覆盖）。
  expect(container.querySelector('[data-provider="anthropic"] span')!.className).toContain('bg-emerald-500');
  expect(container.querySelector('[data-provider="openai"] span')!.className).toContain('bg-red-500');
  expect(container.querySelector('[data-provider="x"] span')!.className).toContain('bg-zinc-500');
  expect(screen.getByText('服务正常')).toBeTruthy();
  expect(screen.getByText('服务故障')).toBeTruthy();
  expect(screen.getByText('状态未知')).toBeTruthy();
  expect(screen.getByText('All Systems Operational')).toBeTruthy();
  expect(screen.getByText('状态页返回 HTTP 503')).toBeTruthy();
  // 更新时间本地化展示（期望值按同一 Date 逻辑计算，不写死时区）；失败条目无时间显示 —（不编造）。
  const local=(iso:string)=>{const d=new Date(iso);const p=(n:number)=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;};
  expect(screen.getByText(`更新于 ${local('2026-09-23T05:42:11.123Z')}`)).toBeTruthy();
  expect(screen.getByText(`更新于 ${local('2026-09-23T06:10:00.000Z')}`)).toBeTruthy();
  expect(screen.getByText(/更新于 —/)).toBeTruthy();
});

it('honestly marks providers without a public status endpoint',async()=>{
  invoke.mockImplementation((name:string)=>name==='fetch_provider_status'?Promise.resolve([]):Promise.resolve());
  const {container}=render(<ProviderStatus active/>);
  await act(async()=>{});
  expect(screen.getAllByText('该供应商无公开状态端点')).toHaveLength(NO_PUBLIC_ENDPOINT.length);
  expect(container.textContent).toContain('StepFun');
  expect(container.textContent).toContain('Zhipu');
});

it('fetches once on activation, not when inactive, and manual refresh re-invokes',async()=>{
  invoke.mockImplementation((name:string)=>name==='fetch_provider_status'?Promise.resolve([entry()]):Promise.resolve());
  const view=render(<ProviderStatus active={false}/>);
  await act(async()=>{});
  expect(callsOf('fetch_provider_status')).toHaveLength(0);
  view.rerender(<ProviderStatus active/>);
  await act(async()=>{});
  expect(callsOf('fetch_provider_status')).toHaveLength(1);
  await act(async()=>{fireEvent.click(screen.getByText('刷新状态'))});
  expect(callsOf('fetch_provider_status')).toHaveLength(2);
  // 刷新进行中按钮禁用并显示正在获取。
  invoke.mockImplementation((_name:string)=>new Promise(()=>{}));
  await act(async()=>{fireEvent.click(screen.getByText('刷新状态'))});
  expect(screen.getByText('正在获取…')).toBeTruthy();
  expect((screen.getByText('正在获取…') as HTMLButtonElement).disabled).toBe(true);
});

it('surfaces a command failure without losing the block or the honest endpoint notes',async()=>{
  invoke.mockImplementation((name:string)=>name==='fetch_provider_status'?Promise.reject('正在退出升级，请稍后操作'):Promise.resolve());
  render(<ProviderStatus active/>);
  await act(async()=>{});
  expect(screen.getByText('正在退出升级，请稍后操作')).toBeTruthy();
  expect(screen.getByText('刷新状态')).toBeTruthy();
  expect(screen.getAllByText('该供应商无公开状态端点')).toHaveLength(NO_PUBLIC_ENDPOINT.length);
});

it('indicator helpers cover the four colors and formatUpdatedAt rejects garbage',()=>{
  expect(indicatorColor('operational')).toContain('emerald');
  expect(indicatorColor('degraded')).toContain('amber');
  expect(indicatorColor('outage')).toContain('red');
  expect(indicatorColor('unknown')).toContain('zinc');
  expect(indicatorColor('anything-else')).toContain('zinc');
  expect(indicatorLabel('degraded')).toBe('服务降级');
  expect(indicatorLabel('weird')).toBe('状态未知');
  expect(formatUpdatedAt(null)).toBe('—');
  expect(formatUpdatedAt('not-a-date')).toBe('—');
  expect(formatUpdatedAt('2026-09-23T05:42:11.123Z')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});
