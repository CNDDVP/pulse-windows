// @vitest-environment jsdom
// Round5c 项目一（misc 域）自测：misc.tray.* 词典 zh/en 奇偶校验、zh 值与 tray.rs 默认值
// 双向钉住、trayBridge 的 payload 形状与语言切换重发行为。Rust 侧解析语义由
// src-tauri/src/tray.rs 的单元测试覆盖（两侧用例一一对应）。
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {act,cleanup,render} from "@testing-library/react";
import {dictionaries} from "./lib/i18n";
import {TrayLabelsBridge} from "./trayBridge";
import type {AppSettings} from "./types";

const api=vi.hoisted(()=>({invoke:vi.fn(),emit:vi.fn(async()=>{}),listeners:new Map<string,(e:{payload:unknown})=>void>()}));
vi.mock("@tauri-apps/api/core",()=>({invoke:api.invoke}));
vi.mock("@tauri-apps/api/event",()=>({emit:api.emit,listen:vi.fn(async(name:string,handler:(e:{payload:unknown})=>void)=>{
  api.listeners.set(name,handler);return()=>{if(api.listeners.get(name)===handler)api.listeners.delete(name)};
})}));

// 与 tray.rs TrayLabels::zh() 逐字一致（Rust 侧同名测试反向钉住）。
const zhPayload={
  toggle:"显示/隐藏悬浮条",
  refresh:"立即刷新配额",
  settings:"设置...",
  quit:"退出 Pulse",
  tooltip:"Pulse - AI 配额监控器",
};
const enPayload={
  toggle:"Show/hide floating bar",
  refresh:"Refresh quotas now",
  settings:"Settings...",
  quit:"Quit Pulse",
  tooltip:"Pulse - AI quota monitor",
};
const settingsOf=(language:string)=>({language} as AppSettings);

beforeEach(()=>{
  api.listeners.clear();
  api.invoke.mockReset();
  api.emit.mockClear();
});
afterEach(()=>{cleanup();vi.restoreAllMocks();});

describe("misc.* 词典",()=>{
  it("zh 与 en 键集合一一对应且非空",()=>{
    const zhMisc=Object.keys(dictionaries.zh).filter(k=>k.startsWith("misc."));
    const enMisc=Object.keys(dictionaries.en).filter(k=>k.startsWith("misc."));
    expect(zhMisc.length).toBeGreaterThan(0);
    expect([...enMisc].sort()).toEqual([...zhMisc].sort());
    for(const k of zhMisc){
      expect(dictionaries.zh[k].length,"zh 空文案: "+k).toBeGreaterThan(0);
      expect(dictionaries.en[k]?.length,"en 缺失或空: "+k).toBeGreaterThan(0);
    }
  });
  it("托盘 zh 文案与 tray.rs 默认值逐字一致",()=>{
    // tray.rs 的 tray_default_labels_match_dictionary_zh_verbatim 测试反向钉住同一组值。
    expect(dictionaries.zh["misc.tray.toggle"]).toBe(zhPayload.toggle);
    expect(dictionaries.zh["misc.tray.refresh"]).toBe(zhPayload.refresh);
    expect(dictionaries.zh["misc.tray.settings"]).toBe(zhPayload.settings);
    expect(dictionaries.zh["misc.tray.quit"]).toBe(zhPayload.quit);
    expect(dictionaries.zh["misc.tray.tooltip"]).toBe(zhPayload.tooltip);
  });
  it("托盘 en 文案逐句对应且词典恰为五个字段",()=>{
    expect(Object.keys(dictionaries.en).filter(k=>k.startsWith("misc.tray.")).sort())
      .toEqual(["misc.tray.quit","misc.tray.refresh","misc.tray.settings","misc.tray.toggle","misc.tray.tooltip"]);
    expect(dictionaries.en["misc.tray.toggle"]).toBe(enPayload.toggle);
    expect(dictionaries.en["misc.tray.refresh"]).toBe(enPayload.refresh);
    expect(dictionaries.en["misc.tray.settings"]).toBe(enPayload.settings);
    expect(dictionaries.en["misc.tray.quit"]).toBe(enPayload.quit);
    expect(dictionaries.en["misc.tray.tooltip"]).toBe(enPayload.tooltip);
    expect(Object.keys(enPayload).sort()).toEqual(["quit","refresh","settings","toggle","tooltip"]);
  });
});

describe("TrayLabelsBridge",()=>{
  it("挂载即按 zh 下发；get_settings 返回 en 后重发 en",async()=>{
    let resolveGet:(s:AppSettings)=>void=()=>{};
    api.invoke.mockImplementation((cmd:string)=>cmd==="get_settings"
      ?new Promise<AppSettings>(r=>{resolveGet=r})
      :Promise.resolve([]));
    render(<TrayLabelsBridge/>);
    await act(async()=>{await Promise.resolve();});
    expect(api.emit).toHaveBeenNthCalledWith(1,"pulse-tray-labels",zhPayload);
    await act(async()=>{resolveGet(settingsOf("en"));});
    expect(api.emit).toHaveBeenNthCalledWith(2,"pulse-tray-labels",enPayload);
  });
  it("settings-updated 事件驱动语言切换重发",async()=>{
    // get_settings 挂起：本用例只走事件通道，避免与启动读取交错。
    api.invoke.mockImplementation(()=>new Promise<AppSettings>(()=>{}));
    render(<TrayLabelsBridge/>);
    await act(async()=>{await Promise.resolve();});
    await act(async()=>{api.listeners.get("settings-updated")?.({payload:settingsOf("en")});});
    expect(api.emit).toHaveBeenNthCalledWith(1,"pulse-tray-labels",zhPayload);
    expect(api.emit).toHaveBeenNthCalledWith(2,"pulse-tray-labels",enPayload);
    await act(async()=>{api.listeners.get("settings-updated")?.({payload:settingsOf("zh")});});
    expect(api.emit).toHaveBeenNthCalledWith(3,"pulse-tray-labels",zhPayload);
  });
  it("迟到的 get_settings 不覆盖更新的事件语言（版本守卫）",async()=>{
    let resolveGet:(s:AppSettings)=>void=()=>{};
    api.invoke.mockImplementation((cmd:string)=>cmd==="get_settings"
      ?new Promise<AppSettings>(r=>{resolveGet=r})
      :Promise.resolve([]));
    render(<TrayLabelsBridge/>);
    await act(async()=>{await Promise.resolve();});
    await act(async()=>{api.listeners.get("settings-updated")?.({payload:settingsOf("en")});});
    await act(async()=>{resolveGet(settingsOf("zh"));});
    expect(api.emit).toHaveBeenCalledTimes(2); // 迟到读数不得重发
    expect(api.emit).toHaveBeenLastCalledWith("pulse-tray-labels",enPayload);
  });
});
