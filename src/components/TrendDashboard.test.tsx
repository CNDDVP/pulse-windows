// @vitest-environment jsdom
import {it,expect,vi,afterEach} from 'vitest';
import {render,screen,fireEvent,act,cleanup} from '@testing-library/react';
import {TrendDashboard} from './TrendDashboard';
const invoke=vi.hoisted(()=>vi.fn());
vi.mock('@tauri-apps/api/core',()=>({invoke}));
afterEach(()=>{cleanup();invoke.mockReset()});

const payload={
  days:Array.from({length:14},(_,i)=>({day:`2026-09-${String(i+1).padStart(2,'0')}`,tokens:i===13?100:i===12?75:i+1,per_source:{}})),
  active_days:14,current_streak:14,longest_streak:14,peak_day:'2026-09-14',peak_tokens:100,active_seconds:233400
};

it('renders metric cards, 5-level heatmap and 7-day candles from trend_metrics',async()=>{
  invoke.mockImplementation((name:string)=>name==='trend_metrics'?Promise.resolve(payload):Promise.resolve('D:\\data\\exports\\token-trend-x.json'));
  const {container}=render(<TrendDashboard/>);
  await act(async()=>{});
  expect(invoke.mock.calls.some(c=>c[0]==='trend_metrics')).toBe(true);
  // 指标卡：活跃/活跃时间/当前连续/最长连续/峰值单日/窗口总量。
  expect(screen.getByText('活跃天数')).toBeTruthy();
  expect(screen.getByText('活跃时间')).toBeTruthy();
  expect(screen.getByText('当前连续')).toBeTruthy();
  expect(screen.getByText('最长连续')).toBeTruthy();
  expect(screen.getByText('峰值单日')).toBeTruthy();
  expect(screen.getByText('窗口总量')).toBeTruthy();
  // 活跃时间：233400s = 64h 50m（对齐规格口径格式），并注明不去重口径。
  expect(container.textContent).toContain('64h 50m');
  expect(container.textContent).toContain('跨来源不去重、并行累计');
  expect(container.textContent).toContain('14 天');
  expect(container.textContent).toContain('2026-09-14');
  expect(container.textContent).toContain('100');
  // 热力图 5 档：max=100；75 与 100 → 4 档（2 格），1..13 → 1 档（12 格），无 0 档格。
  expect(container.querySelectorAll('[data-level="4"]')).toHaveLength(2);
  expect(container.querySelectorAll('[data-level="1"]')).toHaveLength(12);
  expect(container.querySelectorAll('[data-level="0"]')).toHaveLength(0);
  expect(container.querySelectorAll('[data-level="2"],[data-level="3"]')).toHaveLength(0);
  // K 线：14 天按 7 天分桶 → 2 桶，两桶收>开均为阳线。
  const groups=container.querySelectorAll('.trend-candle');
  expect(groups).toHaveLength(2);
  expect(groups[0].getAttribute('data-up')).toBe('1');
  expect(groups[1].getAttribute('data-up')).toBe('1');
  // 导出走同一回传的 metrics 形状。
  await act(async()=>{fireEvent.click(screen.getByText('导出趋势 JSON'))});
  const call=invoke.mock.calls.find(c=>c[0]==='export_trend');
  expect(call).toBeTruthy();
  expect(call![1]).toEqual({metrics:payload});
  await act(async()=>{});
  expect(screen.getByText(/已导出到 D:\\data\\exports\\token-trend-x\.json/)).toBeTruthy();
});

it('surfaces trend_metrics errors and disables export',async()=>{
  invoke.mockImplementation((name:string)=>name==='trend_metrics'?Promise.reject('Token 消耗统计未启用；请在常规设置中开启'):Promise.resolve());
  const {container}=render(<TrendDashboard/>);
  await act(async()=>{});
  expect(screen.getByText('Token 消耗统计未启用；请在常规设置中开启')).toBeTruthy();
  expect(container.querySelector('.trend-candle')).toBeNull();
  expect((screen.getByText('导出趋势 JSON') as HTMLButtonElement).disabled).toBe(true);
});

it('keeps an empty-state hint without data',async()=>{
  invoke.mockImplementation((name:string)=>name==='trend_metrics'?Promise.resolve({days:[],active_days:0,current_streak:0,longest_streak:0,peak_day:null,peak_tokens:0,active_seconds:0}):Promise.resolve());
  const {container}=render(<TrendDashboard/>);
  await act(async()=>{});
  expect(container.textContent).toContain('暂无归档数据');
  expect(container.querySelector('.trend-candle')).toBeNull();
});

it('treats an all-zero window as empty instead of rendering zero-filled cards',async()=>{
  // 生产形状：后端恒补零返回满窗（此处以 370 天全 0 代表），不得渲染「峰值 0 + 旧日期」。
  const zero={days:Array.from({length:370},()=>({day:'2026-01-01',tokens:0,per_source:{}})),active_days:0,current_streak:0,longest_streak:0,peak_day:'2026-01-01',peak_tokens:0,active_seconds:0};
  invoke.mockImplementation((name:string)=>name==='trend_metrics'?Promise.resolve(zero):Promise.resolve());
  const {container}=render(<TrendDashboard/>);
  await act(async()=>{});
  expect(container.textContent).toContain('暂无归档数据');
  expect(screen.queryByText('峰值单日')).toBeNull();
  expect(screen.queryByText('活跃天数')).toBeNull();
  expect(container.querySelector('.trend-candle')).toBeNull();
});

it('debounces export clicks while one export is in flight',async()=>{
  let resolveExport!: (v: string) => void;
  invoke.mockImplementation((name:string)=>name==='trend_metrics'?Promise.resolve(payload):new Promise<string>(res=>{resolveExport=res}));
  render(<TrendDashboard/>);
  await act(async()=>{});
  fireEvent.click(screen.getByText('导出趋势 JSON'));
  // 在途：按钮禁用并显示进行中文案，连点不再派发第二次导出（不再生成多个重复导出文件）。
  const inFlight=screen.getByText('正在导出…') as HTMLButtonElement;
  expect(inFlight.disabled).toBe(true);
  fireEvent.click(inFlight);
  await act(async()=>{});
  expect(invoke.mock.calls.filter(c=>c[0]==='export_trend')).toHaveLength(1);
  await act(async()=>{resolveExport('D:\\data\\exports\\token-trend-x.json')});
  expect(screen.getByText(/已导出到 D:\\data\\exports\\token-trend-x\.json/)).toBeTruthy();
  expect((screen.getByText('导出趋势 JSON') as HTMLButtonElement).disabled).toBe(false);
});
