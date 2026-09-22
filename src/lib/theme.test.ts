// @vitest-environment jsdom
/// <reference types="node" />
// Round5d 项目一（浅色模式）：主题同步与语义令牌定义的单测。
// - isLightTheme/applyDocumentTheme：既有设置通道的 theme 值 → documentElement data-theme；
// - index.css 令牌审计：:root（深色默认）与 [data-theme="light"] 必须定义同一组语义变量，
//   缺一面主题就会在浅色/深色下漏出未定义变量（fallback 到初始值，难以肉眼发现）；
// - 调色板对比度抽查：WCAG 相对亮度计算，配合复核员的人工抽查。
// 注：不能用 `index.css?raw`——tailwind vite 插件会拦截 CSS 导入，测试里拿到空串；
// 这里直接按文本读源文件（readFileSync），审计的就是构建真正吃的这份文件。
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { applyDocumentTheme, isLightTheme, presetDocumentThemeFromCache } from "./theme";

const themeCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "index.css"), "utf8");

const block = (re: RegExp): string => {
  const m = re.exec(themeCss);
  expect(m, `index.css 应存在 ${re} 块`).toBeTruthy();
  return m![1]!;
};
const darkBlock = block(/:root\s*\{([^}]*)\}/);
const lightBlock = block(/\[data-theme="light"\]\s*\{([^}]*)\}/);
const varsOf = (blockBody: string): string[] =>
  [...blockBody.matchAll(/--([a-z0-9-]+)\s*:/g)].map(m => m[1]!);
const varHex = (blockBody: string, name: string): string => {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(blockBody);
  expect(m, `--${name} 应为六位 hex 便于对比度计算`).toBeTruthy();
  return m![1]!;
};
/** WCAG 2.x 相对亮度对比度。 */
const contrast = (a: string, b: string): number => {
  const lum = (hex: string): number => {
    const n = parseInt(hex.replace("#", ""), 16);
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
  };
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
};

afterEach(() => {
  delete document.documentElement.dataset.theme;
  localStorage.clear();
});

describe("主题值 → data-theme 同步", () => {
  it("translucent 是唯一的浅色值（既有设置通道枚举不变）", () => {
    expect(isLightTheme("translucent")).toBe(true);
    expect(isLightTheme("obsidian")).toBe(false);
    expect(isLightTheme(null)).toBe(false);
    expect(isLightTheme(undefined)).toBe(false);
    expect(isLightTheme("light")).toBe(false); // 后端白名单里没有 "light"，不得误判
  });

  it("applyDocumentTheme 写入 data-theme，深浅两值幂等", () => {
    applyDocumentTheme("translucent");
    expect(document.documentElement.dataset.theme).toBe("light");
    applyDocumentTheme("translucent");
    expect(document.documentElement.dataset.theme).toBe("light");
    applyDocumentTheme("obsidian");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("settings 未加载（null/未知值）回落深色（默认主题）", () => {
    applyDocumentTheme(null);
    expect(document.documentElement.dataset.theme).toBe("dark");
    applyDocumentTheme("bogus");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});

describe("主题缓存首帧预设（消除浅色用户首帧闪深色）", () => {
  it("已知设置值回写缓存，presetDocumentThemeFromCache 渲染前恢复", () => {
    applyDocumentTheme("translucent");
    expect(localStorage.getItem("pulse.theme")).toBe("light");
    delete document.documentElement.dataset.theme;
    presetDocumentThemeFromCache();
    expect(document.documentElement.dataset.theme).toBe("light");
    applyDocumentTheme("obsidian");
    expect(localStorage.getItem("pulse.theme")).toBe("dark");
  });

  it("null/未知值（设置未加载或失败）不覆盖缓存；损坏缓存被忽略", () => {
    applyDocumentTheme("translucent");
    applyDocumentTheme(null);
    expect(localStorage.getItem("pulse.theme")).toBe("light");
    localStorage.setItem("pulse.theme", "bogus");
    delete document.documentElement.dataset.theme;
    presetDocumentThemeFromCache();
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});

describe("index.css 语义令牌两套映射", () => {
  it("规划要求的语义令牌在 :root（深色默认）全部定义", () => {
    const dark = new Set(varsOf(darkBlock));
    for (const v of ["surface", "surface-2", "border", "text-1", "text-2", "text-3", "accent", "ok", "warn", "danger"]) {
      expect(dark.has(v), `:root 缺 --${v}`).toBe(true);
    }
  });

  it("规划要求的语义令牌在 [data-theme=light] 全部定义", () => {
    const light = new Set(varsOf(lightBlock));
    for (const v of ["surface", "surface-2", "border", "text-1", "text-2", "text-3", "accent", "ok", "warn", "danger"]) {
      expect(light.has(v), `[data-theme=light] 缺 --${v}`).toBe(true);
    }
  });

  it("深色块定义的每个语义变量在浅色块都有对应映射（不允许半套主题）", () => {
    const dark = varsOf(darkBlock);
    const light = new Set(varsOf(lightBlock));
    const missing = dark.filter(v => !light.has(v));
    expect(missing, `浅色块缺少: ${missing.map(v => `--${v}`).join(", ")}`).toEqual([]);
  });

  it("浅色映射与深色默认取值不同（否则主题切换无效）", () => {
    for (const v of ["surface", "surface-2", "text-1", "accent"]) {
      expect(varHex(lightBlock, v), `--${v} 两套取值不应相同`).not.toBe(varHex(darkBlock, v));
    }
  });

  it("面板类使用令牌而非硬编码色（旧 obsidian/translucent 分叉类已移除）", () => {
    expect(themeCss).toContain(".glass-panel");
    expect(themeCss).toContain(".card-panel");
    expect(themeCss).not.toContain("glass-obsidian");
    expect(themeCss).not.toContain("card-translucent");
    expect(themeCss).toContain('[data-theme="light"]');
  });
});

describe("调色板对比度抽查（WCAG 相对亮度；配合复核员的人工抽查）", () => {
  it("浅色：正文两级文字对白卡片面 ≥ 4.5:1", () => {
    for (const v of ["text-1", "text-2"]) {
      expect(contrast(varHex(lightBlock, v), varHex(lightBlock, "surface-2"))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("浅色：状态/强调文字对白卡片面 ≥ 4.5:1", () => {
    for (const v of ["accent", "ok", "warn", "danger"]) {
      expect(contrast(varHex(lightBlock, v), "#ffffff")).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("浅色：白字在强调/警示/危险实底按钮上 ≥ 4.5:1", () => {
    for (const v of ["accent", "warn", "danger"]) {
      expect(contrast("#ffffff", varHex(lightBlock, v))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("深色（默认）：正文与状态文字对卡片面 ≥ 4.5:1", () => {
    for (const v of ["text-1", "text-2", "accent", "ok", "warn", "danger"]) {
      expect(contrast(varHex(darkBlock, v), varHex(darkBlock, "surface-2"))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("深色（默认）：白字在强调/警示实底按钮上 ≥ 4.5:1（--accent-solid/--warn-solid，评审回归门）", () => {
    for (const v of ["accent-solid", "warn-solid"]) {
      expect(contrast("#ffffff", varHex(darkBlock, v)), `深色 --${v} 垫白字`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("浅色：白字在强调/警示实底按钮上 ≥ 4.5:1（--accent-solid/--warn-solid）", () => {
    for (const v of ["accent-solid", "warn-solid"]) {
      expect(contrast("#ffffff", varHex(lightBlock, v)), `浅色 --${v} 垫白字`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("状态点/指示灯（非文字图形）对窗口底 ≥ 3:1（WCAG 1.4.11，深浅两套）", () => {
    for (const [name, blk] of [["深色", darkBlock], ["浅色", lightBlock]] as const) {
      for (const v of ["ok", "warn", "danger", "text-3"]) {
        expect(contrast(varHex(blk, v), varHex(blk, "surface")), `${name} --${v} 对 --surface`).toBeGreaterThanOrEqual(3);
      }
    }
  });
});
