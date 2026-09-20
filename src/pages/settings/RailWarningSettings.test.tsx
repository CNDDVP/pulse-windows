// @vitest-environment jsdom
import {useState} from 'react';
import {afterEach,it,expect,vi} from 'vitest';
import {render,fireEvent,screen,cleanup} from '@testing-library/react';
import {RailWarningSettings} from './RailWarningSettings';
import {defaultRailWarnings} from '../../railWarnings';
import type {AppSettings} from '../../types';
vi.mock('@tauri-apps/api/event',()=>({listen:vi.fn(async()=>()=>{})}));
afterEach(cleanup);
const baseline=():AppSettings=>({rail_warnings:defaultRailWarnings(),warning_threshold:90,providers:{a:{enabled:true,label:'Codex',primary_window:null}},collapsed_bar_color_mode:'auto'} as unknown as AppSettings);
function setup() {
  const saved=vi.fn(),refresh=vi.fn(async()=>{});
  function Harness(){const [settings,setSettings]=useState(baseline());return <RailWarningSettings settings={settings} usages={[]} busy={false} onRefreshAll={refresh} update={p=>{saved(p);setSettings(s=>({...s,...p}))}}/>}
  render(<Harness/>);return {saved,refresh};
}
it('invalid numeric input does not save zero; valid values preview before blur commit',()=>{
  const {saved}=setup();fireEvent.change(screen.getByLabelText('百分比阈值方式'),{target:{value:'custom'}});saved.mockClear();
  const yellow=screen.getByLabelText('百分比黄色阈值');fireEvent.change(yellow,{target:{value:''}});fireEvent.blur(yellow);
  expect(saved).not.toHaveBeenCalled();expect(screen.getByRole('alert')).toBeTruthy();
  fireEvent.change(yellow,{target:{value:'60'}});expect(saved).not.toHaveBeenCalled();fireEvent.blur(yellow);
  expect(saved.mock.lastCall?.[0].rail_warnings.yellow).toBe(60);
});
it('selection, mode switching and local reset never mutate account or notification settings',()=>{
  const {saved,refresh}=setup();fireEvent.change(screen.getByLabelText('关注账号范围'),{target:{value:'selected'}});
  fireEvent.click(screen.getByRole('checkbox',{name:'Codex'}));
  expect(saved.mock.lastCall?.[0].rail_warnings.account_ids).toEqual(['a']);
  fireEvent.change(screen.getByLabelText('收纳条颜色模式'),{target:{value:'custom'}});
  expect(screen.queryByLabelText('关注账号范围')).toBeNull();
  fireEvent.change(screen.getByLabelText('收纳条颜色模式'),{target:{value:'auto'}});
  expect((screen.getByRole('checkbox',{name:'Codex'}) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByText('恢复收纳条默认设置'));
  expect(saved.mock.lastCall?.[0]).toEqual({rail_warnings:defaultRailWarnings(),collapsed_bar_color_mode:'auto',collapsed_bar_color:null});
  expect(refresh).not.toHaveBeenCalled();fireEvent.click(screen.getByText('刷新读数'));expect(refresh).toHaveBeenCalledTimes(1);
});
