// Round5c 项目一（misc 域）：托盘菜单标签桥。
// 托盘菜单是 Rust 侧原生 UI，走不了 useLang().t()——事实来源仍是前端词典
// （src/lib/i18n.ts 的 misc.tray.*，zh/en 两份）；本组件把当前语言的标签经
// "pulse-tray-labels" 事件下发给 tray.rs，由它重建菜单与 tooltip。
// 语言来源与 App.tsx 一致：settings-updated 事件 + 启动时 get_settings（带版本守卫，
// 迟到的 get_settings 不会盖掉更新的事件）；未就绪/失败回落 zh（与 tray.rs 默认值一致）。
// 挂载点在 main.tsx：main / settings / detail 各窗口各一份，重复下发同值幂等。
import { useEffect } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { normalizeLang, translate, type Lang } from "./lib/i18n";
import type { AppSettings } from "./types";

/** 托盘标签 payload：字段与 tray.rs 的 TrayLabels 一一对应（misc.i18n.test.tsx 钉住）。
 *  不导出——组件文件只导出组件（react only-export-components）；测试经 emit 实发断言。 */
function trayLabelPayload(lang: Lang) {
  return {
    toggle: translate(lang, "misc.tray.toggle"),
    refresh: translate(lang, "misc.tray.refresh"),
    settings: translate(lang, "misc.tray.settings"),
    quit: translate(lang, "misc.tray.quit"),
    tooltip: translate(lang, "misc.tray.tooltip"),
  };
}

export function TrayLabelsBridge() {
  useEffect(() => {
    let alive = true;
    let lang: Lang = "zh";
    let version = 0;
    const push = () => {
      if (alive) void emit("pulse-tray-labels", trayLabelPayload(lang)).catch(() => {});
    };
    push(); // webview 就绪即按默认 zh 下发（Rust 默认值与词典 zh 逐字一致，等值幂等）
    const apply = (settings: AppSettings | null | undefined) => {
      if (!alive) return;
      version++;
      lang = normalizeLang(settings?.language);
      push();
    };
    const stop = listen<AppSettings>("settings-updated", e => apply(e.payload)).catch(() => null);
    // 启动时补一次读取（保存过的语言在重启后也要生效）；版本守卫防止与事件乱序。
    const versionAtStart = version;
    void invoke<AppSettings>("get_settings")
      .then(s => { if (alive && version === versionAtStart) apply(s); })
      .catch(() => {});
    return () => {
      alive = false;
      void stop?.then(off => off?.()).catch(() => {});
    };
  }, []);
  return null;
}
