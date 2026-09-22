// @vitest-environment jsdom
import {it,expect,vi,afterEach} from 'vitest';
import {render,fireEvent,screen,act,cleanup} from '@testing-library/react';
import {ScanPathsPanel} from './ScanPathsPanel';
const invoke=vi.hoisted(()=>vi.fn());
vi.mock('@tauri-apps/api/core',()=>({invoke}));
afterEach(()=>{cleanup();invoke.mockReset()});

const expand=()=>fireEvent.click(screen.getByText(/扫描路径/));
const dirInput=()=>screen.getByLabelText(/附加目录$/) as HTMLInputElement;
const typeIn=(value:string)=>fireEvent.change(dirInput(),{target:{value}});

it('adds a directory under its source and saves via save_token_spend_extra_paths; adopts the backend-returned map',async()=>{
  const saved={claude:['D:\\logs\\claude']};
  invoke.mockImplementation((name:string)=>name==='get_token_spend_extra_paths'
    ?Promise.resolve({})
    :name==='save_token_spend_extra_paths'?Promise.resolve(saved):Promise.resolve());
  render(<ScanPathsPanel />);
  await act(async()=>{expand();});
  typeIn('D:\\logs\\claude');
  fireEvent.click(screen.getByText('添加'));
  expect(screen.getByText('D:\\logs\\claude')).toBeTruthy();
  expect(dirInput().value).toBe('');
  expect(screen.getByText('1/20')).toBeTruthy();
  await act(async()=>{fireEvent.click(screen.getByText('保存扫描路径'));});
  const call=invoke.mock.calls.find(c=>c[0]==='save_token_spend_extra_paths');
  expect(call).toBeTruthy();
  expect(call![1]).toEqual({paths:{claude:['D:\\logs\\claude']}});
  expect(screen.getByText(/扫描路径已保存/)).toBeTruthy();
  // 保存成功后以后端返回为准（后端是权威数据）。
  expect(screen.getByText('D:\\logs\\claude')).toBeTruthy();
});

it('adds per source: switching the source dropdown adds under that source only',async()=>{
  invoke.mockImplementation((name:string)=>name==='get_token_spend_extra_paths'
    ?Promise.resolve({claude:['D:\\claude-logs']}):Promise.resolve({}));
  render(<ScanPathsPanel />);
  await act(async()=>{expand();});
  expect(screen.getByText('D:\\claude-logs')).toBeTruthy();
  expect(screen.getByText('1/20')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('选择来源'),{target:{value:'codex'}});
  expect(screen.queryByText('D:\\claude-logs')).toBeNull(); // 不串源显示
  expect(screen.getByText('0/20')).toBeTruthy();
  typeIn('E:\\codex-logs');
  fireEvent.click(screen.getByText('添加'));
  expect(screen.getByText('E:\\codex-logs')).toBeTruthy();
  await act(async()=>{fireEvent.click(screen.getByText('保存扫描路径'));});
  const call=invoke.mock.calls.find(c=>c[0]==='save_token_spend_extra_paths');
  expect(call![1]).toEqual({paths:{claude:['D:\\claude-logs'],codex:['E:\\codex-logs']}});
});

it('removes directories; entries of sources outside the dropdown survive the save',async()=>{
  invoke.mockImplementation((name:string)=>name==='get_token_spend_extra_paths'
    ?Promise.resolve({claude:['D:\\a','D:\\b'],future_source:['E:\\keep']}):Promise.resolve({}));
  render(<ScanPathsPanel />);
  await act(async()=>{expand();});
  expect(screen.getByText(/已添加 3 个目录/)).toBeTruthy();
  fireEvent.click(screen.getByLabelText('删除 D:\\a'));
  expect(screen.queryByText('D:\\a')).toBeNull();
  expect(screen.getByText('D:\\b')).toBeTruthy();
  await act(async()=>{fireEvent.click(screen.getByText('保存扫描路径'));});
  const call=invoke.mock.calls.find(c=>c[0]==='save_token_spend_extra_paths');
  // 面板下拉只暴露审计来源，但设置里合法的其它来源键不得被保存静默删除。
  expect(call![1]).toEqual({paths:{claude:['D:\\b'],future_source:['E:\\keep']}});
});

it('validates input: relative, empty and duplicate paths are rejected with a hint and never added',async()=>{
  invoke.mockImplementation((name:string)=>name==='get_token_spend_extra_paths'
    ?Promise.resolve({claude:['D:\\dup']}):Promise.resolve({}));
  render(<ScanPathsPanel />);
  await act(async()=>{expand();});
  // 相对路径：提示且不添加，输入原样保留供修改。
  typeIn('logs\\custom');
  fireEvent.click(screen.getByText('添加'));
  expect(screen.getByText(/必须是绝对路径/)).toBeTruthy();
  expect(screen.queryByText('logs\\custom')).toBeNull();
  expect(dirInput().value).toBe('logs\\custom');
  // 空输入。
  fireEvent.change(dirInput(),{target:{value:'   '}});
  fireEvent.click(screen.getByText('添加'));
  expect(screen.getByText('路径不能为空')).toBeTruthy();
  // 重复目录。
  fireEvent.change(dirInput(),{target:{value:' D:\\dup '}});
  fireEvent.click(screen.getByText('添加'));
  expect(screen.getByText('该目录已添加')).toBeTruthy();
  expect(screen.getAllByText('D:\\dup')).toHaveLength(1);
  // 校验通过后输入被清空、提示消失。
  fireEvent.change(dirInput(),{target:{value:'D:\\ok'}});
  fireEvent.click(screen.getByText('添加'));
  expect(screen.queryByText(/必须是绝对路径/)).toBeNull();
  expect(screen.getByText('D:\\ok')).toBeTruthy();
  expect(dirInput().value).toBe('');
});

it('enforces the per-source limit of 20 with a hint instead of adding the 21st',async()=>{
  const twenty=Array.from({length:20},(_,i)=>`D:\\d${i}`);
  invoke.mockImplementation((name:string)=>name==='get_token_spend_extra_paths'
    ?Promise.resolve({claude:twenty}):Promise.resolve({}));
  render(<ScanPathsPanel />);
  await act(async()=>{expand();});
  expect(screen.getByText('20/20')).toBeTruthy();
  typeIn('D:\\d-new');
  fireEvent.click(screen.getByText('添加'));
  expect(screen.getByText('每来源最多 20 条')).toBeTruthy();
  expect(screen.queryByText('D:\\d-new')).toBeNull();
  expect(screen.getByText('20/20')).toBeTruthy();
  // 上限提示口径在面板说明里常驻（说明段 + 即时提示各一处）。
  expect(screen.getByText(/为各来源追加自定义扫描目录/).textContent).toContain('每来源最多 20 条');
  expect(screen.getAllByText(/每来源最多 20 条/).length).toBeGreaterThanOrEqual(2);
});

it('carries the honesty annotations: per-source double counting and non-blocking missing dirs',()=>{
  invoke.mockImplementation(()=>Promise.resolve({}));
  render(<ScanPathsPanel />);
  expand();
  // 双计口径（与 README/ledger.rs 一致，按源精确披露）：嵌套不双计；稳定 id 来源按 id 折叠；
  // 路径命名空间 id（Cline 系）与缺失 id 的事件才会双计。旧文案「跨目录复制同一文件会按路径双计」
  // 与实现相反，不得回归。
  expect(screen.getByText(/只按文件路径去重/)).toBeTruthy();
  expect(screen.getByText(/按 id 折叠/)).toBeTruthy();
  expect(screen.getByText(/KiloCode/)).toBeTruthy();
  expect(screen.queryByText(/复制同一文件会按路径双计/)).toBeNull();
  // 存在性提示不阻断：目录可不存在，缺失时扫描静默跳过（不代表账号没有消耗）。
  expect(screen.getByText(/目录可以不存在/)).toBeTruthy();
  expect(screen.getByText(/静默跳过/)).toBeTruthy();
});

it('hints per-entry existence (missing / not a directory) without blocking the save',async()=>{
  invoke.mockImplementation((name:string,args?:{path?:string})=>{
    if(name==='get_token_spend_extra_paths')return Promise.resolve({claude:['D:\\missing','D:\\a-file','D:\\real']});
    if(name==='scan_path_kind')return Promise.resolve(args?.path==='D:\\missing'?'missing':args?.path==='D:\\a-file'?'other':'dir');
    return Promise.resolve();
  });
  render(<ScanPathsPanel />);
  await act(async()=>{expand();});
  expect(screen.getByText('目录不存在，扫描时静默跳过')).toBeTruthy();
  expect(screen.getByText('不是目录（可能是文件），扫描时跳过')).toBeTruthy();
  // 在场目录无提示。
  const healthy=screen.getByText('D:\\real').closest('li')!.textContent!;
  expect(healthy).not.toContain('不存在');
  expect(healthy).not.toContain('不是目录');
  // 提示不阻断：保存照常成功。
  await act(async()=>{fireEvent.click(screen.getByText('保存扫描路径'));});
  expect(screen.getByText(/扫描路径已保存/)).toBeTruthy();
});

it('reports the backend-adopted map to onSaved so the host window can sync its snapshot',async()=>{
  const saved={claude:['D:\\logs\\claude']};
  const onSaved=vi.fn();
  invoke.mockImplementation((name:string)=>name==='get_token_spend_extra_paths'
    ?Promise.resolve({})
    :name==='save_token_spend_extra_paths'?Promise.resolve(saved):Promise.resolve());
  render(<ScanPathsPanel onSaved={onSaved} />);
  await act(async()=>{expand();});
  typeIn('D:\\logs\\claude');
  fireEvent.click(screen.getByText('添加'));
  await act(async()=>{fireEvent.click(screen.getByText('保存扫描路径'));});
  // 设置窗口靠该回调同步 appliedRef/settings 快照，否则下一次普通设置保存会把旧值整表写回（A03）。
  expect(onSaved).toHaveBeenCalledWith(saved);
  expect(onSaved).toHaveBeenCalledTimes(1);
});

it('a backend save rejection is shown verbatim and does not fake success',async()=>{
  invoke.mockImplementation((name:string)=>name==='get_token_spend_extra_paths'
    ?Promise.resolve({claude:['D:\\a']})
    :Promise.reject('来源 claude 的扫描路径必须是绝对路径: x'));
  render(<ScanPathsPanel />);
  await act(async()=>{expand();});
  await act(async()=>{fireEvent.click(screen.getByText('保存扫描路径'));});
  expect(screen.getByText('来源 claude 的扫描路径必须是绝对路径: x')).toBeTruthy();
  expect(screen.queryByText(/扫描路径已保存/)).toBeNull();
  // 草稿不被失败保存清掉。
  expect(screen.getByText('D:\\a')).toBeTruthy();
});

it('a failed read keeps the panel usable and shows the error instead of fake data',async()=>{
  invoke.mockImplementation((name:string)=>name==='get_token_spend_extra_paths'
    ?Promise.reject('设置读取失败'):Promise.resolve({}));
  render(<ScanPathsPanel />);
  await act(async()=>{expand();});
  expect(screen.getByText('设置读取失败')).toBeTruthy();
  expect(screen.getByText('0/20')).toBeTruthy();
  // 读取失败后仍可添加并保存。
  typeIn('D:\\recovered');
  fireEvent.click(screen.getByText('添加'));
  invoke.mockImplementation((name:string)=>name==='save_token_spend_extra_paths'
    ?Promise.resolve({claude:['D:\\recovered']}):Promise.resolve({}));
  await act(async()=>{fireEvent.click(screen.getByText('保存扫描路径'));});
  expect(screen.getByText(/扫描路径已保存/)).toBeTruthy();
});

it('trims and drops empty entries on save instead of sending them to the backend',async()=>{
  invoke.mockImplementation((name:string)=>name==='get_token_spend_extra_paths'
    ?Promise.resolve({claude:['  D:\\pad  ', '']}):Promise.resolve({}));
  render(<ScanPathsPanel />);
  await act(async()=>{expand();});
  expect(screen.getByText('D:\\pad')).toBeTruthy(); // 读取后即按 trim 展示
  await act(async()=>{fireEvent.click(screen.getByText('保存扫描路径'));});
  const call=invoke.mock.calls.find(c=>c[0]==='save_token_spend_extra_paths');
  expect(call![1]).toEqual({paths:{claude:['D:\\pad']}});
});
