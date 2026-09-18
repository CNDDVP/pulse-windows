import { useEffect, useRef } from "react";
import data from "../assets/bot-data.json";

export type Mood = "idle" | "working" | "fetching" | "spent" | "asleep";
export const PERSONAS = ["calm", "eager", "steady", "curious", "sleepy", "playful", "stoic", "proud"] as const;
export const SHAPES = data.shapeOrder as string[];

interface Shape { path: { op: string; values: number[] }[]; face: { x: number; y: number; sx: number; sy: number } }
interface StateInfo { id: string; blinkCadence: [number, number]; expressionCadence: [number, number]; expressionPool: number[] }
const lib = data as unknown as {
  shapes: Record<string, Shape>; expressions: [number, number][][][]; states: StateInfo[];
};

/** Persona → blink/expression cadence multipliers and a working-state override. */
const PERSONA: Record<string, { blink: number; expr: number; working?: string }> = {
  calm: { blink: 1, expr: 1 }, eager: { blink: 1.4, expr: 1.3, working: "excited" },
  steady: { blink: 0.8, expr: 0.7 }, curious: { blink: 1.1, expr: 1.6, working: "searching" },
  sleepy: { blink: 0.5, expr: 0.6 }, playful: { blink: 1.5, expr: 1.5, working: "excited" },
  stoic: { blink: 0.7, expr: 0.5 }, proud: { blink: 0.9, expr: 0.9 },
};
const MOOD_STATE: Record<Mood, string> = { idle: "idle", working: "working", fetching: "searching", spent: "sad", asleep: "sleeping" };

/** One shared rAF clock at ≤30 FPS, paused while the page is hidden. Subscribers mutate
 *  DOM attributes directly so the React tree is not re-rendered per frame. */
const subs = new Set<(t: number) => void>();
let raf = 0; let last = 0;
function tick(t: number) {
  if (t - last >= 33) { last = t; for (const f of subs) f(t); }
  raf = requestAnimationFrame(tick);
}
function subscribe(f: (t: number) => void) {
  subs.add(f);
  if (!raf) raf = requestAnimationFrame(tick);
  return () => { subs.delete(f); if (!subs.size && raf) { cancelAnimationFrame(raf); raf = 0; } };
}
if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => {
  if (document.hidden && raf) { cancelAnimationFrame(raf); raf = 0; }
  else if (!raf && subs.size) raf = requestAnimationFrame(tick);
});

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const pathD = (pts: [number, number][]) => pts.length ? `M${pts.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("L")}Z` : "";
const pathOps = (ops: { op: string; values: number[] }[]) => ops.map(o => o.op + o.values.join(",")).join("");

export function BotMark({ shape: shapeId, persona, color, mood, size, reduceMotion, lookX = 0 }:
  { shape: string; persona: string; color?: string; mood: Mood; size: number; reduceMotion: boolean; lookX?: number }) {
  const eyesRef = useRef<SVGGElement>(null);
  const bodyRef = useRef<SVGGElement>(null);
  const shape = lib.shapes[shapeId] ?? lib.shapes.blob;
  const mod = PERSONA[persona] ?? PERSONA.calm;
  const stateId = mod.working && mood === "working" ? mod.working : MOOD_STATE[mood];
  const info = lib.states.find(s => s.id === stateId) ?? lib.states[0];
  const initExpr = lib.expressions[info.expressionPool[0] ?? 0] ?? [[], []];
  const d = pathOps(shape.path);

  useEffect(() => {
    if (reduceMotion || document.hidden) return;
    let nextExpr = 0, nextBlink = 0, blinkUntil = 0, idx = info.expressionPool[0] ?? 0;
    const unsub = subscribe(t => {
      if (t >= nextExpr) {
        const pool = info.expressionPool.length ? info.expressionPool : [0];
        idx = pool[Math.floor(Math.random() * pool.length)];
        nextExpr = t + rnd(info.expressionCadence[0], info.expressionCadence[1]) / mod.expr;
      }
      if (t >= nextBlink) { blinkUntil = t + 130; nextBlink = t + rnd(info.blinkCadence[0], info.blinkCadence[1]) / mod.blink; }
      const expr = lib.expressions[idx] ?? lib.expressions[0];
      let cy = 0, n = 0;
      for (const eye of expr) for (const p of eye) { cy += p[1]; n++; }
      cy = n ? cy / n : 0;
      const sy = t < blinkUntil ? 0.12 : 1;
      const dx = lookX * 34 + (mood === "working" ? Math.sin(t / 260) * 7 : 0);
      eyesRef.current?.setAttribute("transform",
        `translate(${(shape.face.x + dx).toFixed(1)} ${(shape.face.y + cy * (1 - sy) * shape.face.sy).toFixed(1)}) scale(${shape.face.sx} ${shape.face.sy * sy})`);
      const g = eyesRef.current;
      if (g) for (let i = 0; i < g.children.length && i < expr.length; i++) {
        const pts = expr[i] as [number, number][];
        if (pts.length) g.children[i].setAttribute("d", pathD(pts));
      }
      bodyRef.current?.setAttribute("transform",
        mood === "working" ? `rotate(${(Math.sin(t / 170) * 4).toFixed(2)} 114.27 114.27)` : "");
    });
    return unsub;
  }, [mood, reduceMotion, lookX, persona, shapeId, mod.blink, mod.expr, mod.working, shape.face.x, shape.face.sy, info]);

  return (
    <svg width={size} height={size} viewBox="0 0 228.54 228.54" aria-hidden>
      <g ref={bodyRef}><path d={d} fill={color ?? "currentColor"} /></g>
      <g ref={eyesRef}>
        {initExpr.map((eye, i) => (eye as [number, number][]).length ?
          <path key={i} d={pathD(eye as [number, number][])} fill={color ?? "currentColor"} fillRule="evenodd" /> : null)}
      </g>
    </svg>
  );
}
