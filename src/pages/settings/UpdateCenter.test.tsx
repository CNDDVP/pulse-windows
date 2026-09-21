// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {invoke} from '@tauri-apps/api/core';
import {UpdateCenter} from './UpdateCenter';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn()}));
vi.mock('@tauri-apps/api/event',()=>({listen:vi.fn(async()=>()=>{})}));
const state={phase:'ready',message:'已校验',current:'0.6.3',mode:'portable',offer:{version:'0.6.4',url:'',notes:'new'},received:1,total:1,preferences:{automatic:true,notify:true,last_check:null}};
beforeEach(()=>{vi.mocked(invoke).mockReset();vi.mocked(invoke).mockImplementation(async(command)=>command==='update_status'?state:undefined)});
afterEach(cleanup);
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
