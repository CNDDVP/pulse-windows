// @vitest-environment jsdom
// Round 5c 项目一：UpdateCenter i18n 迁移后的测试。
// 既有断言保持 zh（未包 Provider 时回落 zh）；另加 en 抽查（诚实口径句句对应）。
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {invoke} from '@tauri-apps/api/core';
import {UpdateCenter} from './UpdateCenter';
import {I18nProvider, setLang} from '../../lib/i18n';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn()}));
vi.mock('@tauri-apps/api/event',()=>({listen:vi.fn(async()=>()=>{})}));
const state={phase:'ready',message:'已校验',current:'0.6.3',mode:'portable',offer:{version:'0.6.4',url:'',notes:'new'},received:1,total:1,preferences:{automatic:true,notify:true,last_check:null}};
beforeEach(()=>{vi.mocked(invoke).mockReset();vi.mocked(invoke).mockImplementation(async(command)=>command==='update_status'?state:undefined)});
// en 抽查挂载受控 Provider 会经 useEffect 把模块级语言置 en 且卸载不还原；
// 每例后重置回 zh，消除「en 抽查必须放文件末尾」的隐性顺序依赖。
afterEach(() => { cleanup(); setLang('zh'); });
it('never applies on mount and blocks exiting with an unsaved credential draft',async()=>{
 render(<UpdateCenter hasDraft={()=>true}/>);const button=await screen.findByRole('button',{name:'退出并更新到 v0.6.4'});
 expect(invoke).not.toHaveBeenCalledWith('update_apply',expect.anything());fireEvent.click(button);
 await screen.findByRole('alert');
 expect(screen.getByRole('alert').textContent).toContain('草稿');expect(vi.mocked(invoke).mock.calls.some(c=>c[0]==='update_apply')).toBe(false);
});
it('only explicitly applies the verified package after click',async()=>{
 render(<UpdateCenter hasDraft={()=>false}/>);fireEvent.click(await screen.findByRole('button',{name:'退出并更新到 v0.6.4'}));await waitFor(()=>expect(invoke).toHaveBeenCalledWith('update_apply',undefined));
});
it('advanced deployment offers manual release page, never an installer action',async()=>{
 vi.mocked(invoke).mockResolvedValue({...state,phase:'available',mode:'advanced'});render(<UpdateCenter hasDraft={()=>false}/>);
 await screen.findByText(/开发或自定义部署/);expect(screen.queryByRole('button',{name:/下载 v/})).toBeNull();expect(screen.getByRole('link',{name:/手动下载/}).getAttribute('href')).toBe('https://github.com/CNDDVP/pulse-windows/releases');
});
it('en renders the update method with its honest signature caveat (component-level en assertion)',async()=>{
 vi.mocked(invoke).mockResolvedValue({...state,phase:'available',mode:'advanced'});
 render(<I18nProvider lang="en"><UpdateCenter hasDraft={()=>false}/></I18nProvider>);
 // 部署模式口径：开发/自定义部署 → 手动更新；签名口径：HTTPS + SHA256 校验、无独立发布签名。
 await screen.findByText(/Development or custom deployment/);
 expect(screen.getByText(/verified over HTTPS and SHA256/)).toBeTruthy();
 expect(screen.getByText(/no standalone release signature is configured yet/)).toBeTruthy();
 expect(screen.getByRole('link',{name:/Releases page \/ manual download/})).toBeTruthy();
 expect(screen.queryByRole('button',{name:/Download v/})).toBeNull();
 expect(screen.queryByText(/开发或自定义部署/)).toBeNull();
});
