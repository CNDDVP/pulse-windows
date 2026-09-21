/** 引擎每帧输出的渲染图元类型（供 BotMark.tsx 的 SVG 层消费）。 */

import type { Ring } from "./geometry";

/** morph/哼唱的图元：画在身体下层、用身体颜色；带 strokeWidth 时描边不填充。 */
export interface MorphShape {
  d: string;
  /** SVG transform 属性（已定位的字形/星形用）。 */
  transform?: string;
  opacity: number;
  strokeWidth?: number;
}

/** 粒子：自带颜色（或渐变 id）。 */
export interface Painted {
  d: string;
  transform?: string;
  opacity: number;
  fill: string;
  /** 丝带渐变：渲染层据此维护 <linearGradient> defs 池。 */
  gradient?: { stops: [string, number][]; x1: number; y1: number; x2: number; y2: number };
}

export interface EyeFrame {
  d: string;
  transform: string;
  visible: boolean;
}

export interface BotFrame {
  headD: string;
  /** 头部 d 与上一帧相同（静止形状走缓存路径）时为 true，渲染层可跳过写 d。 */
  headDStatic: boolean;
  headTransform: string;
  headOpacity: number;
  eyes: EyeFrame[];
  shapes: MorphShape[];
  badge: { x: number; y: number; r: number; color: string } | null;
  back: Painted[];
  front: Painted[];
  /** 半个 viewBox：静止 129.5，morph 需要空间时变化。 */
  viewBoxRadius: number;
  /** 本帧深入 morph 的程度 0…1。 */
  morphAmount: number;
}

export type { Ring };
