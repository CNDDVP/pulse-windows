// @vitest-environment jsdom
// Round 6 多设备同步设置区块组件测试：模式切换 / 状态行 / host 面板（地址+密钥）/ connect 面板。
// 合成 fixture（invoke mock），不读真实凭据与设置文件。
import {useState} from 'react';
import {afterEach,it,expect,vi} from 'vitest';
import {render,fireEvent,screen,cleanup} from '@testing-library/react';
import {SyncSettings} from './SyncSettings';
import {setLang} from '../../lib/i18n';
import type {AppSettings,SyncHubStatusInfo} from '../../types';

const invoke=vi.hoisted(()=>vi.fn());
vi.mock('@tauri-apps/api/core',()=>({invoke}));
const listen=vi.hoisted(()=>vi.fn(async()=>()=>{}));
vi.mock('@tauri-apps/api/event',()=>({listen}));

afterEach(()=>{cleanup();invoke.mockReset();listen.mockClear();setLang('zh');});

const idleStatus=():SyncHubStatusInfo=>({
  mode:'off',connect_url:'',hub_running:false,hub_port:0,hub_error:null,device_count:0,
  hub_secret_configured:false,client_secret_configured:false,last_poll:null,last_push:null,
});

const baseline=(patch:Partial<AppSettings>={}):AppSettings=>({
  sync_mode:'off',sync_connect_url:'',providers:{},
  notifications:{threshold:null,on_spent:false,on_reset:false,on_failure:false},
  hotkeys:{open_settings:null,toggle_rail:null},
  ...patch,
} as unknown as AppSettings);

function setup(settings:AppSettings, statusOverrides:Partial<SyncHubStatusInfo>={}) {
  const saved=vi.fn(),toast=vi.fn();
  const status:SyncHubStatusInfo={...idleStatus(),mode:(settings.sync_mode as string)??'off',...statusOverrides};
  invoke.mockImplementation((name:string)=>{
    if(name==='sync_hub_status') return Promise.resolve(status);
    if(name==='sync_lan_urls') return Promise.resolve(['http://192.168.1.10:45539']);
    return Promise.resolve();
  });
  function Harness(){
    const [cur,setCur]=useState(settings);
    return <SyncSettings settings={cur} update={p=>{saved(p);setCur(s=>({...s,...p}));}} toast={toast}/>;
  }
  render(<Harness/>);
  return {saved,toast};
}

const flush=()=>new Promise(r=>setTimeout(r,0));
const statusLine=()=>document.querySelector('[data-testid="sync-status-line"]')!;

it('mode switching: off → connect enters a draft until the URL is valid, then saves mode+URL together; off → host passes through',async()=>{
  const {saved,toast}=setup(baseline({sync_mode:'off'}));
  await flush();
  const select=screen.getByLabelText('同步模式') as HTMLSelectElement;
  // 无地址切 connect：后端会整表拒绝 → 不发起保存；进入草稿态，连接面板先亮出来。
  fireEvent.change(select,{target:{value:'connect'}});
  expect(saved).not.toHaveBeenCalled();
  expect(toast.mock.calls.some(c=>c[0]==='error')).toBe(true);
  expect(select.value).toBe('connect');
  expect(screen.getByLabelText('服务器地址')).toBeTruthy();
  // 地址合法的第一次输入：连同模式一并保存（用户意图明确）。
  fireEvent.change(screen.getByLabelText('服务器地址'),{target:{value:'http://192.168.1.10:45539'}});
  await flush();
  expect(saved).toHaveBeenCalledWith({sync_mode:'connect',sync_connect_url:'http://192.168.1.10:45539'});
  // 已在 connect 时改地址：只保存 URL。
  fireEvent.change(screen.getByLabelText('服务器地址'),{target:{value:'http://10.0.0.2:45539'}});
  expect(saved).toHaveBeenCalledWith({sync_connect_url:'http://10.0.0.2:45539'});
  // 切 off：直接保存。
  fireEvent.change(select,{target:{value:'off'}});
  expect(saved).toHaveBeenCalledWith({sync_mode:'off'});
  // 切 host：直接保存。
  fireEvent.change(select,{target:{value:'host'}});
  expect(saved).toHaveBeenCalledWith({sync_mode:'host'});
});

it('mode switching: host → connect without a valid URL still lights the connect panel (no dead end)',async()=>{
  // 回归：host+无地址时选「连接」必须亮出连接面板让用户填地址（草稿态与已存模式无关），
  // 不得只弹错误并把 select 弹回「托管」。
  const {saved,toast}=setup(baseline({sync_mode:'host'}),{hub_running:true,hub_port:45539,hub_secret_configured:true});
  await flush();
  const select=screen.getByLabelText('同步模式') as HTMLSelectElement;
  fireEvent.change(select,{target:{value:'connect'}});
  expect(saved).not.toHaveBeenCalled();
  expect(toast.mock.calls.some(c=>c[0]==='error')).toBe(true);
  expect(select.value).toBe('connect');
  expect(screen.getByLabelText('服务器地址')).toBeTruthy();
  // 地址首次合法：连同模式一并保存（用户意图明确，无需绕道「关闭」）。
  fireEvent.change(screen.getByLabelText('服务器地址'),{target:{value:'http://192.168.1.10:45539'}});
  await flush();
  expect(saved).toHaveBeenCalledWith({sync_mode:'connect',sync_connect_url:'http://192.168.1.10:45539'});
  // 草稿态下改选其他模式：草稿必须被清除（effectiveMode 跟随真实模式，面板收敛）。
  fireEvent.change(select,{target:{value:'off'}});
  await flush();
  expect(saved).toHaveBeenCalledWith({sync_mode:'off'});
  expect(screen.queryByLabelText('服务器地址')).toBeNull();
});

it('off mode: a hub binding error stays visible after the revert hides the host panel',async()=>{
  // 回归：绑定失败回退 off 后 host 面板（含唯一错误渲染点）整体卸载，
  // 错误必须在 off 态仍然可见（ROUND6_PLAN.md：回退 off + 界面报错）。
  setup(baseline({sync_mode:'off'}),{hub_running:false,hub_error:'端口 45539 监听失败；已回退为关闭'});
  await flush();
  expect(screen.getByText(/同步已关闭/)).toBeTruthy();
  expect(screen.getByText(/同步服务异常：端口 45539 监听失败；已回退为关闭/)).toBeTruthy();
});

it('host panel: generating the secret flips the button to reset without a manual refresh',async()=>{
  // 回归：hub_secret_configured 不在 sync-hub-status 事件载荷里，生成后必须
  // 立即重查状态，否则按钮停留在「生成密钥」。
  let configured=false;
  invoke.mockImplementation((name:string)=>{
    if(name==='sync_hub_status') return Promise.resolve({...idleStatus(),mode:'host',hub_running:true,hub_port:45539,hub_secret_configured:configured});
    if(name==='sync_lan_urls') return Promise.resolve(['http://192.168.1.10:45539']);
    if(name==='sync_hub_reset_secret'){configured=true;return Promise.resolve('abcd1234efgh5678');}
    return Promise.resolve();
  });
  const saved=vi.fn(),toast=vi.fn();
  function Harness(){const [s,setS]=useState(baseline({sync_mode:'host'}));return <SyncSettings settings={s} update={p=>{saved(p);setS(x=>({...x,...p}));}} toast={toast}/>}
  render(<Harness/>);
  await flush();
  expect(screen.getByText('生成密钥')).toBeTruthy();
  fireEvent.click(screen.getByText('生成密钥'));
  await flush();
  expect(screen.getByTestId('sync-secret').textContent).toBe('abcd1234efgh5678');
  expect(screen.getByText('重置密钥')).toBeTruthy();
  expect(screen.queryByText('生成密钥')).toBeNull();
});

it('status line: pull success shows device count, push success shows ✓, failures show the error verbatim',async()=>{
  setup(baseline(),{
    last_poll:{at:'2026-09-23T12:00:00Z',ok:true,devices:3,version:9},
    last_push:{at:'2026-09-23T12:00:00Z',ok:true},
  });
  await flush();
  expect(statusLine().textContent).toContain('3 台设备');
  expect(statusLine().textContent).toContain('✓');
  cleanup();
  setup(baseline(),{last_poll:{at:'2026-09-23T12:00:00Z',ok:false,error:'服务返回 HTTP 401'}});
  await flush();
  expect(statusLine().textContent).toContain('✗ 失败');
  expect(statusLine().textContent).toContain('服务返回 HTTP 401');
  cleanup();
  setup(baseline());
  await flush();
  expect(statusLine().textContent).toContain('尚无记录');
});

it('host panel: LAN URLs render with copy buttons, hub state and device count shown; generate key displays the one-time secret',async()=>{
  invoke.mockImplementation((name:string)=>{
    if(name==='sync_hub_status') return Promise.resolve({...idleStatus(),mode:'host',hub_running:true,hub_port:45539,device_count:2,hub_secret_configured:false});
    if(name==='sync_lan_urls') return Promise.resolve(['http://192.168.1.10:45539','http://DESKTOP:45539']);
    if(name==='sync_hub_reset_secret') return Promise.resolve('abcd1234efgh5678');
    return Promise.resolve();
  });
  const saved=vi.fn(),toast=vi.fn();
  function Harness(){const [s,setS]=useState(baseline({sync_mode:'host'}));return <SyncSettings settings={s} update={p=>{saved(p);setS(x=>({...x,...p}));}} toast={toast}/>}
  render(<Harness/>);
  await flush();
  expect(screen.getByText('http://192.168.1.10:45539')).toBeTruthy();
  expect(screen.getByText('同步服务运行中 · 端口 45539')).toBeTruthy();
  expect(screen.getByText('已注册设备：2 台（含本机）')).toBeTruthy();
  // 一次性密钥：生成后仅本次显示，并提示重置即失效。
  fireEvent.click(screen.getByText('生成密钥'));
  await flush();
  expect(invoke.mock.calls.some(c=>c[0]==='sync_hub_reset_secret')).toBe(true);
  expect(screen.getByTestId('sync-secret').textContent).toBe('abcd1234efgh5678');
  expect(screen.getByText(/仅本次显示/)).toBeTruthy();
  expect(toast.mock.calls.some(c=>c[0]==='success')).toBe(true);
  // 生成密钥不得偷改模式设置。
  expect(saved).not.toHaveBeenCalled();
});

it('host panel: binding failure (hub_error) is surfaced verbatim instead of a green state',async()=>{
  setup(baseline({sync_mode:'host'}),{hub_running:false,hub_error:'地址已被占用；已回退为关闭'});
  await flush();
  expect(screen.getByText(/同步服务异常：地址已被占用；已回退为关闭/)).toBeTruthy();
});

it('connect panel: valid URL saves, invalid URL shows hint without saving; secret saved via dedicated command',async()=>{
  const {saved}=setup(baseline({sync_mode:'connect'}),{client_secret_configured:false});
  await flush();
  const url=screen.getByLabelText('服务器地址') as HTMLInputElement;
  // 非法地址：不提交保存（后端会整表拒绝），显示修正提示。
  fireEvent.change(url,{target:{value:'ftp://hub'}});
  expect(saved).not.toHaveBeenCalledWith(expect.objectContaining({sync_connect_url:'ftp://hub'}));
  expect(screen.getByText('地址需为 http(s)://主机[:端口] 形式；修正后才会保存。')).toBeTruthy();
  fireEvent.change(url,{target:{value:'http://192.168.1.10:45539'}});
  expect(saved).toHaveBeenCalledWith({sync_connect_url:'http://192.168.1.10:45539'});
  // 密钥：经 sync_set_connect_secret 保存，不落设置表。
  fireEvent.change(screen.getByLabelText('访问密钥'),{target:{value:'abcd-1234'}});
  fireEvent.click(screen.getByText('保存密钥'));
  await flush();
  expect(invoke.mock.calls.some(c=>c[0]==='sync_set_connect_secret'&&(c[1] as {secret:string}).secret==='abcd-1234')).toBe(true);
});

it('off mode: shows the zero-network note and no host/connect panels',async()=>{
  setup(baseline({sync_mode:'off'}));
  await flush();
  expect(screen.getByText(/同步已关闭/)).toBeTruthy();
  expect(screen.queryByLabelText('服务器地址')).toBeNull();
  expect(screen.queryByText('本机地址（其他设备填入其「服务器地址」）')).toBeNull();
});
