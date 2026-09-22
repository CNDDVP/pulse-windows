// Round5d 项目一（浅色模式）：BotMark 眼色对比规则（纯函数，组件外置以便单测、
// 保持 BotMark.tsx only-export-components 干净）。
// 身体色策略：深色身体配浅色眼、浅色身体配深色眼（与上游 GIF 一致）。

// 眼色对比常量：与身体亮度取反，保证任何主题/品牌色下眼睛都可读。
const EYE_DARK = "#27272a";
const EYE_LIGHT = "#fafafa";

/** 简单亮度：决定眼睛用深色还是浅色。 */
function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 0.5;
  const n = parseInt(m[1]!, 16);
  return (0.2126 * (n >> 16 & 255) + 0.7152 * (n >> 8 & 255) + 0.0722 * (n & 255)) / 255;
}

/**
 * 眼色对比随主题自适应：
 * - 自定义身体色按亮度选眼色（阈值 0.45：橙/蓝等中亮度品牌色也配深色眼）；
 *   同一品牌色在两套主题下眼色一致（供应商品牌色不随主题翻转）。
 * - 未自定义时身体是 currentColor——随主题令牌翻转（深色主题=浅色身体配深色眼，
 *   浅色主题=深色身体配浅色眼），dark 参数即"深色主题"。
 */
export function botEyeColor(bodyColor: string | undefined, dark: boolean): string {
  if (bodyColor) return luminance(bodyColor) > 0.45 ? EYE_DARK : EYE_LIGHT;
  return dark ? EYE_DARK : EYE_LIGHT;
}
