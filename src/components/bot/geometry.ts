/**
 * 上游 BotMarkGeometry.swift 的移植。环（ring）统一为 `[number, number][]`
 * （与 bot-data.json 的表示一致），路径直接生成 SVG 的 `d` 字符串。
 */
import { clamp } from "./math";

export type Ring = [number, number][];

export interface FaceTransform {
  x: number;
  y: number;
  sx: number;
  sy: number;
  eye: number;
}

export const centroid = (ring: Ring): [number, number] => {
  let x = 0, y = 0;
  for (const p of ring) { x += p[0]; y += p[1]; }
  return [x / (ring.length || 1), y / (ring.length || 1)];
};

/** 逐点插值。数据里每个环点数相同、角序一致，这是形变成立的前提。 */
export function lerpRing(from: Ring, to: Ring, amount: number): Ring {
  if (from.length !== to.length) return to;
  const out: Ring = new Array(from.length);
  for (let i = 0; i < from.length; i++) {
    out[i] = [from[i][0] + (to[i][0] - from[i][0]) * amount, from[i][1] + (to[i][1] - from[i][1]) * amount];
  }
  return out;
}

const f1 = (v: number) => (Math.round(v * 10) / 10).toString();

/** 直边路径，用于眼睛。 */
export function ringPathD(ring: Ring): string {
  if (!ring.length) return "";
  let d = `M${f1(ring[0][0])},${f1(ring[0][1])}`;
  for (let i = 1; i < ring.length; i++) d += `L${f1(ring[i][0])},${f1(ring[i][1])}`;
  return d + "Z";
}

/** 平滑路径，用于混合或转动中的头部：环上的 Catmull-Rom 切线，输出三次贝塞尔。 */
export function ringOutlineD(ring: Ring): string {
  if (ring.length <= 2) return ringPathD(ring);
  const n = ring.length;
  let d = `M${f1(ring[0][0])},${f1(ring[0][1])}`;
  for (let i = 0; i < n; i++) {
    const prev = ring[(i - 1 + n) % n], pt = ring[i], next = ring[(i + 1) % n], after = ring[(i + 2) % n];
    const c1x = pt[0] + (next[0] - prev[0]) / 6, c1y = pt[1] + (next[1] - prev[1]) / 6;
    const c2x = next[0] - (after[0] - pt[0]) / 6, c2y = next[1] - (after[1] - pt[1]) / 6;
    d += `C${f1(c1x)},${f1(c1y)},${f1(c2x)},${f1(c2y)},${f1(next[0])},${f1(next[1])}`;
  }
  return d + "Z";
}

/** JSON 的 path 段列表 → SVG d（提取器已归约为绝对 M/L/C/Q/Z）。 */
export function pathOpsD(ops: { op: string; values: number[] }[]): string {
  return ops.map(o => `${o.op}${o.values.map(f1).join(",")}`).join("");
}

/** 轮廓在高度 y 处的左右边界；headCentre 决定一个交点算左侧还是右侧。 */
export function spanAt(ring: Ring, y: number, headCentre: number): [number, number] {
  let left = -Infinity, right = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const s = ring[i], e = ring[(i + 1) % ring.length];
    if ((s[1] <= y) === (e[1] <= y)) continue;
    const x = s[0] + ((e[0] - s[0]) * (y - s[1])) / (e[1] - s[1]);
    if (x <= headCentre) { if (x > left) left = x; } else { if (x < right) right = x; }
  }
  return [Number.isFinite(left) ? left : headCentre, Number.isFinite(right) ? right : headCentre];
}

/** 形状预采样的 160 组 (left, right)，静止时免扫环。 */
export function shapeSpanAt(
  spanSamples: [number, number][] | null, top: number, bottom: number,
  y: number, headCentre: number, ring: Ring,
): [number, number] {
  if (!spanSamples || !spanSamples.length) return spanAt(ring, y, headCentre);
  const count = spanSamples.length;
  const pos = clamp(((y - top) / (bottom - top)) * count - 0.5, 0, count - 1);
  const start = Math.floor(pos);
  const end = Math.min(start + 1, count - 1);
  const amount = pos - start;
  return [spanSamples[start][0] + (spanSamples[end][0] - spanSamples[start][0]) * amount,
    spanSamples[start][1] + (spanSamples[end][1] - spanSamples[start][1]) * amount];
}

/** 关于竖直线 ax 的左右镜像。从自己的首点倒着走，保住绕向，
 * 使逐点混合不会在中途出现折痕。 */
export function reflected(ring: Ring, axis: number): Ring {
  const n = ring.length;
  const out: Ring = new Array(n);
  for (let i = 0; i < n; i++) {
    const src = ring[(n - i) % n];
    out[i] = [2 * axis - src[0], src[1]];
  }
  return out;
}

/** 实体形状（solid）在给定 yaw 下的径向剖面，用上游同款五点二项式平滑。 */
function radialSolidProfile(solid: number[][], angle: number): number[] {
  const cosine = Math.cos(angle), sine = Math.sin(angle);
  const raw = new Array<number>(96).fill(0);
  for (let i = 0; i < 96; i++) {
    const theta = (i / 96) * Math.PI * 2;
    const dx = Math.cos(theta), dy = Math.sin(theta);
    let radius = 0;
    for (const [x, y, z, r] of solid) {
      const rx = x * cosine + z * sine;
      const proj = dx * rx + dy * y;
      const disc = proj * proj - (rx * rx + y * y) + r * r;
      if (disc > 0) radius = Math.max(radius, proj + Math.sqrt(disc));
    }
    raw[i] = radius;
  }
  return smooth5(raw);
}

function smooth5(values: number[]): number[] {
  const n = values.length;
  return values.map((_, i) =>
    (values[(i - 2 + n) % n] + 4 * values[(i - 1 + n) % n] + 6 * values[i]
      + 4 * values[(i + 1) % n] + values[(i + 2) % n]) / 16);
}

/** 实体形状的未偏转基准剖面，解一次后缓存。 */
const solidBaselines = new Map<string, number[]>();

/** 形状环 yaw 偏转 angle 后的样子。扁边和实体形状会变形；其余不变——
 * 这就是圆团转身时只有眼睛在动的原因。 */
export function turnedShapeRing(
  shape: { ring: Ring; solid: number[][] | null; sides: number },
  identifier: string, angle: number, headCentre: number,
): Ring {
  if (shape.solid) {
    let baseline = solidBaselines.get(identifier);
    if (!baseline) {
      baseline = radialSolidProfile(shape.solid, 0);
      solidBaselines.set(identifier, baseline);
    }
    let profile = radialSolidProfile(shape.solid, angle).map((v, i) =>
      clamp((v + 12) / (baseline![i] + 12), 0.32, 1.5));
    for (let k = 0; k < 3; k++) profile = smooth5(profile);
    return shape.ring.map((p, i) =>
      [headCentre + (p[0] - headCentre) * profile[i], headCentre + (p[1] - headCentre) * profile[i]] as [number, number]);
  }
  if (shape.sides > 0) {
    const segment = (Math.PI * 2) / shape.sides;
    const wrapped = angle % segment;
    const positive = (wrapped + segment) % segment;
    const factor = 1 + (Math.cos(positive - segment / 2) / Math.cos(segment / 2) - 1) * 0.45;
    return shape.ring.map(p => [headCentre + (p[0] - headCentre) * factor, p[1]] as [number, number]);
  }
  return shape.ring;
}
