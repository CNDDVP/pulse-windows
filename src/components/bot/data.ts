/**
 * bot-data.json 的解码（对齐上游 BotMarkData.swift）。
 * JSON 由上游 extract-bot-data.py 生成：18 种体型（96 点轮廓环 + 原始贝塞尔
 * 轮廓 + 眼位采样）、25 种双眼神情、39 个状态的表情池与节奏、14 种 morph。
 * 这里不做任何计算——和 Web 组件画的是同一批数字。
 */
import type { FaceTransform, Ring } from "./geometry";

export interface BotMarkShape {
  ring: Ring;
  path: { op: string; values: number[] }[];
  face: FaceTransform;
  tiltScale: number;
  beltRadius: number;
  radius: number;
  top: number;
  bottom: number;
  sides: number;
  solid: number[][] | null;
  spanSamples: [number, number][] | null;
}

export interface BotMarkStateInfo {
  id: string;
  en: string;
  zh: string;
  /** 该状态一次性变身的特效，无则 null。 */
  morph: string | null;
  /** 两次眨眼间隔毫秒；null 表示该状态不眨眼。 */
  blinkCadence: [number, number] | null;
  expressionCadence: [number, number];
  expressionPool: number[];
}

export interface BotData {
  headC: number;
  eyeHalf: number;
  circleRing: Ring;
  starPath: { op: string; values: number[] }[];
  starGold: string;
  shapes: Record<string, BotMarkShape>;
  shapeOrder: string[];
  /** 25 种神情，每种是一对眼睛的环。 */
  expressions: Ring[][];
  states: BotMarkStateInfo[];
  /** 最大胆的神情把双眼中心带离头部中心的距离（上游单位）。 */
  eyeReach: number;
}

interface RawFile {
  headC: number;
  eyeHalf: number;
  circleRing: number[][];
  starPath: { op: string; values: number[] }[];
  starGold: string;
  shapes: Record<string, {
    ring: number[][]; path: { op: string; values: number[] }[];
    face: FaceTransform; tiltScale: number; beltRadius: number; radius: number;
    top: number; bottom: number; sides: number; solid: number[][] | null;
    spanSamples: number[][] | null;
  }>;
  shapeOrder: string[];
  expressions: number[][][][];
  states: { id: string; en: string; zh: string; morph: string | null;
    blinkCadence: number[] | null; expressionCadence: number[]; expressionPool: number[] }[];
}

function decode(raw: RawFile): BotData {
  const ring = (pts: number[][]): Ring => pts.map(p => [p[0], p[1]]);
  const expressions = raw.expressions.map(pair => pair.map(ring));
  // 空环跳过而不是除零：eyeReach 是钳制边界，坏表会 NaN 化，
  // 让整列眼睛落到 NaN 处且无处报错。
  let eyeReach = 0;
  for (const pair of expressions) {
    const centres = pair.filter(r => r.length).map(r => r.reduce((a, p) => a + p[0], 0) / r.length);
    if (!centres.length) continue;
    const centre = centres.reduce((a, b) => a + b, 0) / centres.length;
    eyeReach = Math.max(eyeReach, Math.abs(centre - raw.headC));
  }
  return {
    headC: raw.headC,
    eyeHalf: raw.eyeHalf,
    circleRing: ring(raw.circleRing),
    starPath: raw.starPath,
    starGold: raw.starGold,
    shapeOrder: raw.shapeOrder,
    expressions,
    eyeReach,
    states: raw.states.map(s => ({
      id: s.id, en: s.en, zh: s.zh, morph: s.morph,
      blinkCadence: s.blinkCadence && s.blinkCadence.length === 2
        ? [Math.min(s.blinkCadence[0], s.blinkCadence[1]), Math.max(s.blinkCadence[0], s.blinkCadence[1])]
        : null,
      expressionCadence: [s.expressionCadence[0], s.expressionCadence[1]],
      expressionPool: s.expressionPool,
    })),
    shapes: Object.fromEntries(Object.entries(raw.shapes).map(([k, s]) => [k, {
      ring: ring(s.ring),
      path: s.path,
      face: s.face,
      tiltScale: s.tiltScale,
      beltRadius: s.beltRadius,
      radius: s.radius,
      top: s.top,
      bottom: s.bottom,
      sides: s.sides,
      solid: s.solid ?? null,
      spanSamples: s.spanSamples ? s.spanSamples.map(p => [p[0], p[1]] as [number, number]) : null,
    }])),
  };
}

// P2-14：几何数据懒加载——只在第一次渲染机器人时才拉取分包（图标模式用户不付此成本）。
let dataPromise: Promise<BotData> | null = null;
export function loadBotData(): Promise<BotData> {
  if (!dataPromise) {
    dataPromise = import("../../assets/bot-data.json").then(m => decode(m.default as unknown as RawFile));
  }
  return dataPromise;
}

export function shapeOf(data: BotData, id: string): BotMarkShape {
  return data.shapes[id] ?? data.shapes.blob;
}

export function stateOf(data: BotData, id: string): BotMarkStateInfo {
  return data.states.find(s => s.id === id) ?? data.states[0];
}
