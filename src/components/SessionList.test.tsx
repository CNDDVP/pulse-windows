// @vitest-environment jsdom
import {it,expect,vi,afterEach} from 'vitest';
import {render,fireEvent,screen,act,cleanup} from '@testing-library/react';
import {SessionList,SESSION_PAGE_SIZE,type SessionRow} from './SessionList';
const invoke=vi.hoisted(()=>vi.fn());
vi.mock('@tauri-apps/api/core',()=>({invoke}));
afterEach(()=>{cleanup();invoke.mockReset()});

const row=(over:Record<string,unknown>={})=>({
  source:'claude',path:'k1',session:null,title:'abc123.jsonl',note:null,
  first_ts:1_787_509_531,last_ts:1_787_519_531,input:100,output:20,cache_read:30,cache_write:5,
  cost_estimate:0.5,events:2,models:1,...over,
});
const callsOf=(name:string)=>invoke.mock.calls.filter((c:string[])=>c[0]===name);

it('lists sessions with title/source/models/tokens/cost and fetches page 1 unfiltered',async()=>{
  const r1=row();
  const r2=row({source:'zcode',path:'k2#sess_x',session:'sess_x',title:'sess_x',cost_estimate:null,events:1,input:0,output:0,cache_read:0,cache_write:0});
  invoke.mockImplementation((name:string)=>name==='token_spend_sessions'?Promise.resolve([r1,r2]):Promise.resolve());
  const {container}=render(<SessionList active displayCurrency="USD" fxRate={7.2}/>);
  await act(async()=>{});
  expect(callsOf('token_spend_sessions')[0][1]).toEqual({source:null,offset:0,limit:SESSION_PAGE_SIZE});
  expect(screen.getByText(/abc123\.jsonl/)).toBeTruthy();
  expect(screen.getByText(/sess_x/)).toBeTruthy();
  expect(container.textContent).toContain('claude');
  expect(container.textContent).toContain('zcode');
  // tokens 合计 155；成本 $0.50；未知定价显示 —（不当 0）。
  expect(container.textContent).toContain('155');
  expect(container.textContent).toContain('$0.50');
  expect(container.textContent).toContain('—');
  // 未展开时未请求明细（懒加载）。
  expect(callsOf('token_spend_session_detail')).toHaveLength(0);
});

it('loads detail lazily on expand, flags truncation, and does not refetch on re-expand',async()=>{
  invoke.mockImplementation((name:string)=>name==='token_spend_sessions'
    ?Promise.resolve([row()])
    :Promise.resolve({path:'k1',total:600,truncated:true,events:[
      {ts:1_787_509_531,model:'claude-sonnet',input:100,output:20,cache_read:30,cache_write:5},
      {ts:1_787_509_631,model:'claude-sonnet',input:1,output:1,cache_read:0,cache_write:0},
    ]}));
  render(<SessionList active displayCurrency="USD" fxRate={7.2}/>);
  await act(async()=>{});
  // 展开：此时才 invoke 明细，并标注「共 600 条…上限 500…已截断」。
  fireEvent.click(screen.getByText(/abc123\.jsonl/));
  await act(async()=>{});
  const detailCalls=callsOf('token_spend_session_detail');
  expect(detailCalls).toHaveLength(1);
  expect(detailCalls[0][1]).toEqual({path:'k1'});
  expect(screen.getByText(/共 600 条事件/).textContent).toContain('已截断');
  expect(screen.getAllByText(/claude-sonnet/)).toHaveLength(2);
  // 收起再展开：明细已缓存，不重复请求。
  fireEvent.click(screen.getByText(/abc123\.jsonl/));
  fireEvent.click(screen.getByText(/abc123\.jsonl/));
  await act(async()=>{});
  expect(callsOf('token_spend_session_detail')).toHaveLength(1);
});

it('shows the honest whole-library note row and surfaces detail failures without breaking the list',async()=>{
  invoke.mockImplementation((name:string)=>name==='token_spend_sessions'
    ?Promise.resolve([row({source:'zcode',path:'k3#whole-library',session:'whole-library',title:'db.sqlite',note:'按 CLI 库整体聚合，无会话拆分',cost_estimate:null})])
    :Promise.reject('会话明细读取失败'));
  render(<SessionList active displayCurrency="USD" fxRate={7.2}/>);
  await act(async()=>{});
  expect(screen.getByText('按 CLI 库整体聚合，无会话拆分')).toBeTruthy();
  fireEvent.click(screen.getByText(/db\.sqlite/));
  await act(async()=>{});
  expect(screen.getByText('会话明细读取失败')).toBeTruthy();
  // 失败后列表行仍在。
  expect(screen.getByText(/db\.sqlite/)).toBeTruthy();
});

it('re-queries from offset 0 when the source filter changes',async()=>{
  invoke.mockImplementation((name:string)=>name==='token_spend_sessions'?Promise.resolve([row()]):Promise.resolve());
  render(<SessionList active displayCurrency="USD" fxRate={7.2}/>);
  await act(async()=>{});
  fireEvent.change(screen.getByDisplayValue('全部来源'),{target:{value:'zcode'}});
  await act(async()=>{});
  const calls=callsOf('token_spend_sessions');
  expect(calls).toHaveLength(2);
  expect(calls[0][1]).toEqual({source:null,offset:0,limit:SESSION_PAGE_SIZE});
  expect(calls[1][1]).toEqual({source:'zcode',offset:0,limit:SESSION_PAGE_SIZE});
});

it('appends the next page via 加载更多 and stops when a short page comes back',async()=>{
  const page=(n:number,pathPrefix:string)=>Array.from({length:n},(_,i)=>row({path:`${pathPrefix}${i}`,title:`${pathPrefix}${i}.jsonl`}));
  invoke.mockImplementation((_name:string,args:{offset?:number})=>Promise.resolve((args.offset??0)===0?page(SESSION_PAGE_SIZE,'a'):page(30,'b')));
  const {container}=render(<SessionList active displayCurrency="USD" fxRate={7.2}/>);
  await act(async()=>{});
  expect(screen.getByText('加载更多')).toBeTruthy();
  await act(async()=>{fireEvent.click(screen.getByText('加载更多'))});
  const calls=callsOf('token_spend_sessions');
  expect(calls).toHaveLength(2);
  expect(calls[1][1]).toEqual({source:null,offset:SESSION_PAGE_SIZE,limit:SESSION_PAGE_SIZE});
  expect(container.textContent).toContain('b0.jsonl');
  // 短页（30 < 50）已到尾：按钮消失，不再发起第三次请求。
  expect(screen.queryByText('加载更多')).toBeNull();
  await act(async()=>{});
  expect(callsOf('token_spend_sessions')).toHaveLength(2);
});

it('discards a late loadMore response after the source filter changes',async()=>{
  // 回归（竞态）：invoke 无法取消，「加载更多」在途时切换来源筛选，旧回包后到——
  // 不得把旧筛选的页数据 append 进新列表（持久错显 + 分页 offset 被污染），
  // 也不得提前清掉新请求的 loading 或闪现「暂无会话记录」空态。
  const page=(n:number,prefix:string)=>Array.from({length:n},(_,i)=>row({path:`${prefix}${i}`,title:`${prefix}${i}.jsonl`,source:prefix}));
  const deferred=()=>{let resolve!:(v:SessionRow[])=>void;const promise=new Promise<SessionRow[]>(r=>{resolve=r});return{promise,resolve};};
  const oldMore=deferred();const zcodeFirst=deferred();
  invoke.mockImplementation((_name:string,args:{offset?:number;source?:string|null})=>{
    if((args.offset??0)===SESSION_PAGE_SIZE&&!args.source)return oldMore.promise;
    if((args.offset??0)===0&&args.source==='zcode')return zcodeFirst.promise;
    return Promise.resolve(page(SESSION_PAGE_SIZE,args.source?'z':'a'));
  });
  const {container}=render(<SessionList active displayCurrency="USD" fxRate={7.2}/>);
  await act(async()=>{});
  expect(container.textContent).toContain('a0.jsonl');
  await act(async()=>{fireEvent.click(screen.getByText('加载更多'))});
  await act(async()=>{fireEvent.change(screen.getByDisplayValue('全部来源'),{target:{value:'zcode'}})});
  // 旧包后到：不得落入新筛选列表，不得清 loading / 闪现空态。
  await act(async()=>{oldMore.resolve(page(30,'a'));});
  expect(container.textContent).not.toContain('a0.jsonl');
  expect(container.textContent).not.toContain('暂无会话记录');
  expect(screen.getByText('正在读取会话…')).toBeTruthy();
  // 新筛选首页回包：正常渲染、loading 收敛。
  await act(async()=>{zcodeFirst.resolve(page(SESSION_PAGE_SIZE,'z'));});
  expect(container.textContent).toContain('z0.jsonl');
  expect(container.textContent).not.toContain('a0.jsonl');
  expect(screen.queryByText('正在读取会话…')).toBeNull();
});

it('shows the gate error when token spend statistics are disabled',async()=>{
  invoke.mockImplementation((name:string)=>name==='token_spend_sessions'?Promise.reject('Token 消耗统计未启用；请在常规设置中开启'):Promise.resolve());
  render(<SessionList active displayCurrency="USD" fxRate={7.2}/>);
  await act(async()=>{});
  expect(screen.getByText('Token 消耗统计未启用；请在常规设置中开启')).toBeTruthy();
});
