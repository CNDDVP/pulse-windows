// Round5d 项目一（浅色模式）：主题 → 文档根元素同步。
// 设置值沿用既有设置通道的 theme 字段（"obsidian" 深色 | "translucent" 浅色），
// 后端 types.rs 的校验白名单不变；前端把它映射为 document.documentElement 上的
// data-theme="dark" | "light"，index.css 据此切换 --surface/--text-1 等语义变量。
// 深色是默认主题（:root 即深色，未同步时也成立）。各窗口（main/settings/detail）
// 各自在收到 settings 时调用 applyDocumentTheme，重复调用幂等。

/** 浅色主题判定：仅既有枚举值 "translucent" 表示浅色。 */
export function isLightTheme(theme: string | null | undefined): boolean {
  return theme === "translucent";
}

/** 主题缓存的 localStorage 键（存解析后的 data-theme 值 "dark" | "light"）。 */
const THEME_CACHE_KEY = "pulse.theme";

/** 把设置里的主题值同步到根元素 data-theme；null/未知回落深色。
 *  已知设置值（obsidian/translucent）会回写 localStorage 缓存，供下次启动首帧预设；
 *  null/未知（设置尚未加载或加载失败）不动缓存，避免把用户上次选择覆盖成默认深色。 */
export function applyDocumentTheme(theme: string | null | undefined): void {
  const resolved = isLightTheme(theme) ? "light" : "dark";
  document.documentElement.dataset.theme = resolved;
  if (theme === "translucent" || theme === "obsidian") {
    try { localStorage.setItem(THEME_CACHE_KEY, resolved); } catch { /* 无 localStorage（隐私模式等）时静默跳过 */ }
  }
}

/** 首帧预设：渲染前用上次缓存的主题设置 data-theme，消除浅色用户在 get_settings
 *  异步返回前的深色首帧闪烁（缓存缺失/损坏时保持深色默认，与上方取舍一致）。
 *  只读不写；随后的 applyDocumentTheme 总会以真实设置覆盖。 */
export function presetDocumentThemeFromCache(): void {
  try {
    const cached = localStorage.getItem(THEME_CACHE_KEY);
    if (cached === "light" || cached === "dark") {
      document.documentElement.dataset.theme = cached;
    }
  } catch { /* 无 localStorage 时保持深色默认 */ }
}
