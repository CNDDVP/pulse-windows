// @vitest-environment jsdom
import {it,expect,vi,afterEach} from 'vitest';
import {render,screen,fireEvent,act,cleanup} from '@testing-library/react';
import {TrendDashboard} from './TrendDashboard';
import {I18nProvider, setLang} from '../lib/i18n';
import {localTodayKey} from '../lib/syncDevices';
const invoke=vi.hoisted(()=>vi.fn());
vi.mock('@tauri-apps/api/core',()=>({invoke}));
// en 抽查挂载受控 Provider 会把模块级语言置 en 且卸载不还原；每例后重置回 zh。
afterEach(()=>{cleanup();invoke.mockReset();setLang('zh')});

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

it('en spot-check: description, metric cards with honest qualifiers, heatmap and candles render in English',async()=>{
  invoke.mockImplementation((name:string)=>name==='trend_metrics'?Promise.resolve(payload):Promise.resolve());
  const {container}=render(<I18nProvider lang="en"><TrendDashboard/></I18nProvider>);
  await act(async()=>{});
  // 描述与按钮。
  expect(screen.getByText(/cross-year trend view/)).toBeTruthy();
  expect(screen.getByText('Read trend')).toBeTruthy();
  expect(screen.getByText('Export trend JSON')).toBeTruthy();
  // 指标卡（含诚实口径限定语：「跨来源不去重」逐句对应）。
  expect(screen.getByText('Active days')).toBeTruthy();
  expect(screen.getByText('Active time')).toBeTruthy();
  expect(screen.getByText('Not deduplicated across sources; parallel sessions accumulate')).toBeTruthy();
  expect(screen.getByText('Counting back from today')).toBeTruthy();
  expect(screen.getByText('14 days in the window')).toBeTruthy();
  expect(container.textContent).toContain('64h 50m');
  expect(container.textContent).toContain('14 days');
  // 热力图与 K 线标题、图例（少/多 与色块同 div，textContent 断言）。
  expect(screen.getByText('Daily usage heatmap')).toBeTruthy();
  const legend = screen.getByText(/Less/);
  expect(legend.textContent).toContain('Less');
  expect(legend.textContent).toContain('More');
  expect(screen.getByText('7-day bucketed candlesticks')).toBeTruthy();
  expect(screen.getByText(/open = first day of the bucket/)).toBeTruthy();
  expect(screen.getByText(/Peak 100 tokens\/day/)).toBeTruthy();
});

// ---------------------------------------------------------------------------
// Round 6：设备筛选/汇总行（每设备今日 tokens + 在线状态；合并视图）。合成 fixture。
// ---------------------------------------------------------------------------

const today=localTodayKey();
const yday=(d:number)=>{const dt=new Date();dt.setDate(dt.getDate()-d);return localTodayKey(dt)};
const NOW=Date.now();

const syncMocks=(opts:{
  mode:string;
  devices:unknown[];
  profileId?:string;
  failSnapshot?:boolean;
})=>{
  invoke.mockImplementation((name:string)=>{
    if(name==='trend_metrics') return Promise.resolve(payload);
    if(name==='export_trend') return Promise.resolve('D:\\data\\exports\\token-trend-x.json');
    if(name==='sync_hub_status') return Promise.resolve({mode:opts.mode,connect_url:'',hub_running:opts.mode==='host',hub_port:45539,hub_error:null,device_count:opts.devices.length+1,hub_secret_configured:true,client_secret_configured:true,last_poll:null,last_push:null});
    if(name==='get_profile_info') return Promise.resolve({profile_id:opts.profileId??'self-id',created_at:'',mode:'installed'});
    if(name==='sync_devices_snapshot') return opts.failSnapshot?Promise.reject('设备快照无效：bad json'):Promise.resolve({version:7,devices:opts.devices});
    return Promise.resolve();
  });
};

it('device row renders local + remote chips with today tokens and online status; merged "all" view sums both',async()=>{
  syncMocks({mode:'connect',profileId:'self-id',devices:[
    // 在线设备：今日 12000 tokens；其 2026-09-13(+5000)/2026-09-14(+2000) 叠加进合并视图。
    {device_id:'dev-a',device_name:'Living PC',app_version:'0.6.6',last_active:new Date(NOW-30_000).toISOString(),
     days:[{day:today,source:'claude',model:'m',input:12000,output:0,cache_read:0,cache_write:0},
           {day:yday(9),source:'claude',model:'m',input:5000,output:0,cache_read:0,cache_write:0},
           {day:yday(10),source:'claude',model:'m',input:2000,output:0,cache_read:0,cache_write:0}]},
    // 离线设备：3 个轮询拍（180s）无心跳。
    {device_id:'dev-b',device_name:'Old Laptop',app_version:'0.6.5',last_active:new Date(NOW-600_000).toISOString(),days:[]},
  ]});
  const {container}=render(<TrendDashboard/>);
  await act(async()=>{});
  // 汇总行：本机 + 两台远端 + 全部设备；今日 tokens 与在线状态逐台可见。
  expect(screen.getByTestId('device-summary-row')).toBeTruthy();
  expect(screen.getByText('全部设备')).toBeTruthy();
  expect(screen.getByText('本机')).toBeTruthy();
  expect(screen.getByText('Living PC')).toBeTruthy();
  expect(screen.getByText('Old Laptop')).toBeTruthy();
  expect(screen.getAllByText('12K').length).toBeGreaterThan(0);   // dev-a 今日 12000
  expect(screen.getAllByText('0').length).toBeGreaterThan(0);     // dev-b 今日 0（诚实显示，不隐藏）
  expect(container.textContent).toContain('在线');
  expect(container.textContent).toContain('离线');
  // 在线判定：dev-a 在 180s 窗口内，dev-b 超出。
  expect(screen.getByTestId('device-dot-dev-a').className).toContain('ok');
  expect(screen.getByTestId('device-dot-dev-b').className).not.toContain('ok');
  expect(container.textContent).toContain('合并视图');
  // 默认「全部设备」合并视图：窗口总量 = 本机 253（1..12 + 75 + 100）+ 远端 19000 = 19253 → 19.3K。
  expect(container.textContent).toContain('19.3K');
  // 合并视图含远端：活跃时长诚实显示「—」（同步载荷不含 active_seconds）。
  expect(screen.getByText('—', {selector:'p'})).toBeTruthy();
  expect(container.textContent).toContain('同步载荷不含活跃时长');
});

it('selecting a remote device filters the dashboard to its synced window with an honest scope note',async()=>{
  syncMocks({mode:'connect',profileId:'self-id',devices:[
    {device_id:'dev-a',device_name:'Living PC',app_version:'0.6.6',last_active:new Date(NOW-30_000).toISOString(),
     days:[{day:today,source:'claude',model:'m',input:12000,output:0,cache_read:0,cache_write:0},
           {day:yday(1),source:'claude',model:'m',input:3000,output:0,cache_read:0,cache_write:0}]},
  ]});
  const {container}=render(<TrendDashboard/>);
  await act(async()=>{});
  fireEvent.click(screen.getByText('Living PC'));
  await act(async()=>{});
  // 口径说明切换为「仅该设备同步的最近 30 天」。
  expect(container.textContent).toContain('仅该设备同步的最近 30 天日聚合');
  // 该设备序列：今日 12000（4 档）、昨日 3000（25% → 2 档）。
  expect(container.querySelectorAll('[data-level="4"]').length).toBeGreaterThan(0);
  expect(container.querySelectorAll('[data-level="2"]').length).toBeGreaterThan(0);
  // 峰值卡来自设备序列（12000 → 12K），活跃时长为「—」。
  expect(container.textContent).toContain('12K');
  expect(container.textContent).toContain('同步载荷不含活跃时长');
  // 导出随当前视图：导出的是该设备合并序列（days 为设备两天）。
  fireEvent.click(screen.getByText('导出趋势 JSON'));
  await act(async()=>{});
  const call=invoke.mock.calls.find(c=>c[0]==='export_trend')!;
  const exported=(call![1] as {metrics:{days:{day:string;tokens:number}[]}}).metrics;
  expect(exported.days.map(d=>d.tokens)).toEqual([3000,12000]);
});

it('switching back to 本机 restores the local-only view and the 64h 50m active time',async()=>{
  syncMocks({mode:'host',profileId:'self-id',devices:[
    {device_id:'dev-a',device_name:'Living PC',app_version:'0.6.6',last_active:new Date(NOW-30_000).toISOString(),
     days:[{day:today,source:'claude',model:'m',input:12000,output:0,cache_read:0,cache_write:0}]},
  ]});
  const {container}=render(<TrendDashboard/>);
  await act(async()=>{});
  fireEvent.click(screen.getByText('本机'));
  await act(async()=>{});
  expect(container.textContent).toContain('仅本机 daily_archive');
  expect(container.textContent).toContain('64h 50m');
  expect(container.textContent).toContain('跨来源不去重、并行累计');
});

it('sync mode off hides the device row entirely (no stale snapshot display)',async()=>{
  syncMocks({mode:'off',profileId:'self-id',devices:[
    {device_id:'dev-a',device_name:'Living PC',app_version:'0.6.6',last_active:new Date(NOW-30_000).toISOString(),days:[]},
  ]});
  const {container}=render(<TrendDashboard/>);
  await act(async()=>{});
  expect(screen.queryByTestId('device-summary-row')).toBeNull();
  // 同步关闭 → 既有本机视图完整保留（活跃时长照常显示）。
  expect(container.textContent).toContain('64h 50m');
});

it('snapshot read failure degrades honestly: error text shown, local chip still renders',async()=>{
  syncMocks({mode:'connect',profileId:'self-id',failSnapshot:true,devices:[]});
  const {container}=render(<TrendDashboard/>);
  await act(async()=>{});
  expect(screen.getByTestId('device-summary-row')).toBeTruthy();
  expect(container.textContent).toContain('设备快照无效：bad json');
  expect(screen.getByText('本机')).toBeTruthy();
  expect(container.textContent).toContain('尚未同步到其他设备');
});
