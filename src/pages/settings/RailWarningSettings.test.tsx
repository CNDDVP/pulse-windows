// @vitest-environment jsdom
// Round 5c 项目一：RailWarningSettings i18n 迁移后的测试。
// 既有断言保持 zh（未包 Provider 时回落 zh，与迁移前文案逐字一致）；
// 另加 en 抽查（本域组件测试断言英文渲染，docs/ROUND5C_PLAN.md 项目一第 5 条）。
import {useState} from 'react';
import {afterEach,it,expect,vi} from 'vitest';
import {render,fireEvent,screen,cleanup} from '@testing-library/react';
import {RailWarningSettings} from './RailWarningSettings';
import {defaultRailWarnings} from '../../railWarnings';
import {I18nProvider, setLang} from '../../lib/i18n';
import type {AppSettings} from '../../types';
vi.mock('@tauri-apps/api/event',()=>({listen:vi.fn(async()=>()=>{})}));
// en 抽查挂载受控 Provider 会把模块级语言置 en 且卸载不还原；每例后重置回 zh。
afterEach(() => { cleanup(); setLang('zh'); });
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
it('en renders localized labels and honest no-risk qualifier (component-level en assertion)',()=>{
  const saved=vi.fn();
  function Harness(){const [settings,setSettings]=useState(baseline());return <I18nProvider lang="en"><RailWarningSettings settings={settings} usages={[]} busy={false} onRefreshAll={async()=>{}} update={p=>{saved(p);setSettings(s=>({...s,...p}))}}/></I18nProvider>;}
  render(<Harness/>);
  expect(screen.getByText('Collapsed bar look and warnings')).toBeTruthy();
  expect(screen.getByLabelText('Percentage threshold mode')).toBeTruthy();
  // 诚实口径：固定/彩虹颜色「（不表示额度风险）」限定语必须保留。
  fireEvent.change(screen.getByLabelText('Collapsed bar color mode'),{target:{value:'custom'}});
  expect(screen.getByText('(does not indicate quota risk)')).toBeTruthy();
  expect(screen.queryByText('收纳条外观与预警')).toBeNull();
});
