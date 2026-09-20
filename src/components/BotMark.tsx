import { useEffect, useRef, useState } from "react";

export type Mood = "idle" | "working" | "fetching" | "spent" | "asleep" | "unavailable";
export const PERSONAS = ["calm", "eager", "steady", "curious", "sleepy", "playful", "stoic", "proud"] as const;
export const SHAPES = ["blob", "pebble", "bean", "egg", "squircle", "tablet", "capsule", "cylinder", "hex", "gem", "crystal", "wedge", "shield", "dome", "arch", "cloud", "teardrop", "leaf"] as const;

interface BotData {
  headC: number;
  shapes: Record<string, { ring: [number, number][]; path: { op: string; values: number[] }[]; face: { x: number; y: number; sx: number; sy: number } }>;
  shapeOrder: string[];
  expressions: [number, number][][][];
  states: { id: string; blinkCadence: [number, number]; expressionCadence: [number, number]; expressionPool: number[] }[];
}

// P2-14：几何数据懒加载——只在第一次渲染机器人时才拉取分包（图标模式用户不付此成本）。
let dataPromise: Promise<BotData> | null = null;
function loadData(): Promise<BotData> {
  if (!dataPromise) dataPromise = import("../assets/bot-data.json").then(m => m.default as unknown as BotData);
  return dataPromise;
}

/** 个性 → 眨眼/表情节奏倍率与 working 态表情覆盖（对齐上游 Persona 表）。 */
const PERSONA: Record<string, { blink: number; expr: number; working?: string }> = {
  calm: { blink: 1, expr: 1 }, eager: { blink: 1.4, expr: 1.3, working: "excited" },
  steady: { blink: 0.8, expr: 0.7 }, curious: { blink: 1.1, expr: 1.6, working: "searching" },
  sleepy: { blink: 0.5, expr: 0.6 }, playful: { blink: 1.5, expr: 1.5, working: "excited" },
  stoic: { blink: 0.7, expr: 0.5 }, proud: { blink: 0.9, expr: 0.9 },
};
const MOOD_STATE: Record<Mood, string> = { idle: "idle", working: "working", fetching: "searching", spent: "sad", asleep: "sleeping", unavailable: "sleeping" };

/** 共享 rAF 时钟（≤30 FPS），页面隐藏时暂停；订阅者直接改 DOM 属性，不触发 React 渲染。 */
const subs = new Set<(t: number) => void>();
let raf = 0; let last = 0;
function tick(t: number) {
  if (t - last >= 33) { last = t; for (const f of subs) f(t); }
  raf = subs.size ? requestAnimationFrame(tick) : 0;
}
function subscribe(f: (t: number) => void) {
  subs.add(f);
  if (!raf && !document.hidden) raf = requestAnimationFrame(tick);
  return () => {
    subs.delete(f);
    if (!subs.size && raf) { cancelAnimationFrame(raf); raf = 0; }
  };
}
if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => {
  if (document.hidden && raf) { cancelAnimationFrame(raf); raf = 0; }
  else if (!raf && subs.size) raf = requestAnimationFrame(tick);
});

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const pathOps = (ops: { op: string; values: number[] }[]) => ops.map(o => o.op + o.values.join(",")).join("");
const centroidX = (pts: [number, number][]) => pts.reduce((a, p) => a + p[0], 0) / (pts.length || 1);
const centroidY = (pts: [number, number][]) => pts.reduce((a, p) => a + p[1], 0) / (pts.length || 1);
const pathD = (pts: [number, number][]) => pts.length ? `M${pts.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("L")}Z` : "";
/** 96 点轮廓环在高度 y 处的左右边界（水平线与多边形求交）。 */
function spanAtRing(ring: [number, number][], y: number): [number, number] | null {
  let left = Infinity, right = -Infinity, hit = false;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    if ((a[1] - y) * (b[1] - y) <= 0 && a[1] !== b[1]) {
      const x = a[0] + (b[0] - a[0]) * ((y - a[1]) / (b[1] - a[1]));
      left = Math.min(left, x); right = Math.max(right, x); hit = true;
    }
  }
  return hit ? [left, right] : null;
}
/** 表情环以头部中心为轴镜像并交换双眼（朝向翻转 = 同一只眼看另一侧）。 */
function mirrored(ring: [number, number][], headC: number): [number, number][] {
  return ring.map(p => [2 * headC - p[0], p[1]] as [number, number]).reverse() as [number, number][];
}

export function BotMark({ shape: shapeId, persona, color, mood, size, reduceMotion, animationEnabled = true, lookX = 0 }:
  { shape: string; persona: string; color?: string; mood: Mood; size: number; reduceMotion: boolean; animationEnabled?: boolean; lookX?: number }) {
  const [data, setData] = useState<BotData | null>(null);
  const bodyRef = useRef<SVGGElement>(null);
  const eyesGRef = useRef<SVGGElement>(null);
  const eyePathsRef = useRef<(SVGPathElement | null)[]>([]);
  useEffect(() => { if (!data) void loadData().then(setData).catch(() => {}); }, [data]);

  const shape = data?.shapes[shapeId] ?? data?.shapes.blob;
  const mod = PERSONA[persona] ?? PERSONA.calm;
  const hour = new Date().getHours();
  const isSleepyResting = persona === "sleepy" && (hour >= 23 || hour < 8);
  const effectiveMood: Mood = (mood === "idle" && isSleepyResting) ? "asleep" : mood;
  const stateId = mod.working && effectiveMood === "working" ? mod.working : MOOD_STATE[effectiveMood];
  const info = data?.states.find(s => s.id === stateId) ?? data?.states[0];
  const headC = data?.headC ?? 114.27;
  const initPool = info?.expressionPool ?? [];
  const initExpr = data?.expressions[initPool[0] ?? 0] ?? [[], []];

  // 动画引擎：有数据且允许动画时订阅；减少动态/页面隐藏时渲染静态首帧。
  const animate = !!data && !!shape && !!info && animationEnabled && !reduceMotion && !document.hidden;
  const look = Math.sign(lookX) as -1 | 0 | 1;
  useEffect(() => {
    if (!animate || !data || !shape || !info) {
      // P2-09：从动画切回静态时显式复位，避免残留上一动画帧的变换。
      eyesGRef.current?.setAttribute("transform", `translate(${shape?.face.x ?? 0} ${shape?.face.y ?? 0}) scale(${shape?.face.sx ?? 1} ${shape?.face.sy ?? 1})`);
      bodyRef.current?.removeAttribute("transform");
      return;
    }
    const ring = shape.ring;
    let nextExpr = 0, nextBlink = 0, blinkUntil = 0, idx = info.expressionPool[0] ?? 0;
    let gaze = 0; // 平滑视线：逐帧逼近目标朝向偏移
    const unsub = subscribe(t => {
      if (t >= nextExpr) {
        const pool = info.expressionPool.length ? info.expressionPool : [0];
        idx = pool[Math.floor(Math.random() * pool.length)];
        nextExpr = t + rnd(info.expressionCadence[0], info.expressionCadence[1]) / mod.expr;
      }
      if (t >= nextBlink) { blinkUntil = t + 130; nextBlink = t + rnd(info.blinkCadence[0], info.blinkCadence[1]) / mod.blink; }
      const expr = data.expressions[idx] ?? data.expressions[0];
      // 视线翻转（对齐上游 renderEyes 的 turn 机制）：表情自带朝向与目标相反时，
      // 以头部中心镜像并交换双眼——同一只眼看另一侧。
      const pairCx = (centroidX(expr[0]) + centroidX(expr[1])) / 2;
      const bakedSign = Math.sign(pairCx - headC) || 1;
      const turned = look !== 0 && bakedSign !== look;
      const e0 = turned ? mirrored(expr[1], headC) : expr[0];
      const e1 = turned ? mirrored(expr[0], headC) : expr[1];
      const pairCx2 = (centroidX(e0) + centroidX(e1)) / 2;
      const pairCy = (centroidY(e0) + centroidY(e1)) / 2;
      // 轮廓级钳制：在双眼中心高度扫描轮廓左右边界，整组平移不得把眼睛推出脸外。
      // 增加 2.5% 内边距限制，防止极端视角（gaze）或缩放眨眼时眼睛溢出脸部轮廓。
      const span = spanAtRing(ring, pairCy);
      gaze += (look * 30 - gaze) * 0.2;
      let dx = gaze;
      if (span) {
        const margin = (span[1] - span[0]) * 0.025;
        const boundedLeft = span[0] + margin;
        const boundedRight = span[1] - margin;
        const half = Math.max(Math.abs(centroidX(e0) - centroidX(e1)) / 2 + 8, 12);
        const minDx = boundedLeft + half - pairCx2;
        const maxDx = boundedRight - half - pairCx2;
        if (minDx <= maxDx) {
          dx = Math.min(Math.max(dx, minDx), maxDx);
        } else {
          dx = (minDx + maxDx) / 2;
        }
      }
      eyesGRef.current?.setAttribute("transform",
        `translate(${(shape.face.x + dx).toFixed(1)} ${(shape.face.y).toFixed(1)}) scale(${shape.face.sx} ${shape.face.sy * (t < blinkUntil ? 0.12 : 1)})`);
      for (const [el, pts] of [[eyePathsRef.current[0], e0], [eyePathsRef.current[1], e1]] as const) {
        el?.setAttribute("d", pathD(pts));
      }
      bodyRef.current?.setAttribute("transform",
        effectiveMood === "working" ? `rotate(${(Math.sin(t / 170) * 4).toFixed(2)} ${headC} ${headC})` : "");
    });
    return unsub;
  }, [animate, data, effectiveMood, look, persona, shapeId, mod.blink, mod.expr, mod.working, info, shape, headC]);

  return (
    <svg width={size} height={size} viewBox="0 0 228.54 228.54" aria-hidden>
      {shape && <g ref={bodyRef}><path d={pathOps(shape.path)} fill={color ?? "currentColor"} /></g>}
      <g ref={eyesGRef}>
        {(initExpr as [number, number][][]).map((eye, i) => (eye as [number, number][]).length ?
          <path key={i} ref={el => { if (i < 2) eyePathsRef.current[i] = el; }}
            d={pathD(eye as [number, number][])} fill={color ?? "currentColor"} fillRule="evenodd" /> : null)}
      </g>
    </svg>
  );
}
