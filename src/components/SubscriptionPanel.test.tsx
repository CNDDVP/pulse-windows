// @vitest-environment jsdom
import {it,expect,vi,afterEach} from 'vitest';
import {render,fireEvent,screen,act,cleanup} from '@testing-library/react';
import {SubscriptionPanel} from './SubscriptionPanel';
import {I18nProvider, setLang} from '../lib/i18n';
import type {SubscriptionRecord} from '../types';
const invoke=vi.hoisted(()=>vi.fn());
vi.mock('@tauri-apps/api/core',()=>({invoke}));
// en 抽查挂载受控 Provider 会把模块级语言置 en 且卸载不还原；每例后重置回 zh。
afterEach(()=>{cleanup();invoke.mockReset();setLang('zh')});

const subs=(over:Record<string,SubscriptionRecord>={}):Record<string,SubscriptionRecord>=>({...over});
const usd=(price:number):SubscriptionRecord=>({price,currency:'USD',cycle_days:30,start_date:'',note:''});

it('renders one row per audited source; missing data shows — and never fabricates numbers',()=>{
  invoke.mockImplementation(()=>Promise.resolve(subs()));
  render(<SubscriptionPanel subs={{}} onSubsChange={()=>{}} monthCostBySource={null} monthCoverageNote={null} displayCurrency="USD" fxRate={7.2} />);
  // 展开面板
  fireEvent.click(screen.getByText(/订阅记录/));
  for(const label of ['Claude Code','Codex','Gemini CLI','Cline','Roo Code','Kilo Code','OpenClaw','ZCode','Qwen CLI','OpenCode']){
    expect(screen.getByText(label)).toBeTruthy();
  }
  // 未读取使用记录：本月已用与倍数两列共 20 个「—」= 10 来源 × 2（脚注里出现的是长句，不计）。
  expect(screen.getAllByText('—')).toHaveLength(20);
});

it('shows the monthly estimate and an orange multiple ≥1; multiple stays — without a recorded price',async()=>{
  invoke.mockImplementation((name:string)=>name==='get_subscriptions'?Promise.resolve({claude:usd(5)}):Promise.resolve());
  const {container}=render(<SubscriptionPanel subs={{claude:usd(5)}} onSubsChange={()=>{}} monthCostBySource={{claude:10,codex:3}} monthCoverageNote={null} displayCurrency="USD" fxRate={7.2} />);
  fireEvent.click(screen.getByText(/订阅记录/));
  // claude：$10 / $5 = 2.0×，≥1 橙色强调。
  const orange=container.querySelector('.text-orange-500');
  expect(orange).toBeTruthy();
  expect(orange!.textContent).toBe('2×');
  expect(container.textContent).toContain('$10.00');
  // codex 有本月成本但未登记订阅价 → 倍数 —（不当作 0 或 1）。
  expect(container.textContent).toContain('$3.00');
});

it('CNY display converts the monthly estimate and annotates the fixed rate once',()=>{
  invoke.mockImplementation(()=>Promise.resolve(subs()));
  const {container}=render(<SubscriptionPanel subs={{}} onSubsChange={()=>{}} monthCostBySource={{claude:10}} monthCoverageNote={null} displayCurrency="CNY" fxRate={7.2} />);
  fireEvent.click(screen.getByText(/订阅记录/));
  expect(container.textContent).toContain('¥72.00');
  expect(container.textContent).toContain('按固定汇率 7.20 估算');
});

it('saves via save_subscriptions with trimmed records, feeds the result back, and surfaces backend errors',async()=>{
  const onSubsChange=vi.fn();const onSaved=vi.fn();
  invoke.mockImplementation((name:string)=>name==='get_subscriptions'
    ?Promise.resolve({})
    :Promise.reject('订阅记录 claude 无效：订阅周期需为 1~366 天'));
  const draft={claude:{...usd(20),cycle_days:0},codex:usd(0)};
  render(<SubscriptionPanel subs={draft} onSubsChange={onSubsChange} onSaved={onSaved} monthCostBySource={null} monthCoverageNote={null} displayCurrency="USD" fxRate={7.2} />);
  fireEvent.click(screen.getByText(/订阅记录/));
  await act(async()=>{fireEvent.click(screen.getByText('保存订阅记录'));});
  const call=invoke.mock.calls.find(c=>c[0]==='save_subscriptions');
  expect(call).toBeTruthy();
  // 价格 0 的来源不落设置；价格>0 的整条记录上送。
  expect(Object.keys(call![1].subscriptions)).toEqual(['claude']);
  expect(call![1].subscriptions.claude).toMatchObject({price:20,currency:'USD',cycle_days:0});
  // 后端拒绝 → 错误原样展示，不假报成功。
  expect(screen.getByText(/订阅周期需为 1~366 天/)).toBeTruthy();
  expect(onSaved).not.toHaveBeenCalled();
});

it('successful save calls back with the authoritative map returned by the backend',async()=>{
  const onSubsChange=vi.fn();const onSaved=vi.fn();
  const saved={claude:usd(20)};
  invoke.mockImplementation((name:string)=>name==='get_subscriptions'?Promise.resolve({}):Promise.resolve(saved));
  render(<SubscriptionPanel subs={{claude:usd(20)}} onSubsChange={onSubsChange} onSaved={onSaved} monthCostBySource={null} monthCoverageNote={null} displayCurrency="USD" fxRate={7.2} />);
  fireEvent.click(screen.getByText(/订阅记录/));
  await act(async()=>{fireEvent.click(screen.getByText('保存订阅记录'));});
  expect(onSaved).toHaveBeenCalledWith(saved);
  expect(onSubsChange).toHaveBeenCalledWith(saved);
  expect(screen.getByText('订阅记录已保存')).toBeTruthy();
});

it('a failed read keeps the panel usable and shows the error instead of fake data',async()=>{
  invoke.mockImplementation(()=>Promise.reject('设置读取失败'));
  render(<SubscriptionPanel subs={{}} onSubsChange={()=>{}} monthCostBySource={null} monthCoverageNote={null} displayCurrency="USD" fxRate={7.2} />);
  await act(async()=>{fireEvent.click(screen.getByText(/订阅记录/));});
  expect(screen.getByText('设置读取失败')).toBeTruthy();
  expect(screen.getAllByText('—')).toHaveLength(20);
});

it('en spot-check: header, columns, honest description and save flow render in English',async()=>{
  invoke.mockImplementation((name:string)=>name==='get_subscriptions'
    ?Promise.resolve({})
    :name==='save_subscriptions'?Promise.resolve({}):Promise.resolve());
  const {container}=render(
    <I18nProvider lang="en">
      <SubscriptionPanel subs={{claude:usd(5)}} onSubsChange={()=>{}} monthCostBySource={{claude:10}} monthCoverageNote={null} displayCurrency="CNY" fxRate={7.2} />
    </I18nProvider>);
  fireEvent.click(screen.getByText(/Subscriptions/));
  // 折叠/展开、说明段（诚实口径逐句对应）。
  expect(screen.getByText('Collapse ▴')).toBeTruthy();
  expect(screen.getByText(/Multiple = this month's estimated cost ÷ subscription price/)).toBeTruthy();
  expect(screen.getByText(/for reference only, and do not represent actual billing/)).toBeTruthy();
  // 表头与 aria 标签。
  expect(screen.getByText('Subscription price')).toBeTruthy();
  expect(screen.getByText('Cycle (days)')).toBeTruthy();
  expect(screen.getByText('Used this month (estimated)')).toBeTruthy();
  expect(screen.getByLabelText('Claude Code subscription price')).toBeTruthy();
  // CNY 换算 + 固定汇率口径标注（英译不弱化）。
  expect(container.textContent).toContain('¥72.00');
  expect(container.textContent).toContain('estimated at the fixed exchange rate 7.20');
  expect(container.textContent).toContain('(the raw estimate is in USD)');
  // 保存流程：按钮与成功提示走英译（msg 以词典键存取，渲染时取词）。
  await act(async()=>{fireEvent.click(screen.getByText('Save subscription records'));});
  expect(screen.getByText('Subscription records saved')).toBeTruthy();
  expect(screen.getByText(/Enter 0 or leave the price empty/)).toBeTruthy();
});
