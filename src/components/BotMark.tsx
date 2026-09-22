import { useEffect, useId, useRef, useState } from "react";
import { loadBotData, type BotData } from "./bot/data";
import { BotMarkEngine, VIEW_BOX_CENTRE } from "./bot/engine";
import {
  gazeFromLookX, idleStates, isOvertime, personaEye, personaGaze, personaMotion,
  personaState, personaTempo, rotationEmphasis, squashEmphasis, tempoEmphasis,
  workingStates, type BotEvent, type Mood,
} from "./bot/mood";
import type { BotFrame, MorphShape, Painted } from "./bot/types";
import { botEyeColor } from "./bot/eye";

const PERSONAS = ["calm", "eager", "steady", "curious", "sleepy", "playful", "stoic", "proud"] as const;

/** 共享 rAF 时钟（≤30 FPS），页面隐藏时暂停；订阅者直接改 DOM 属性，不触发 React 渲染。 */
const subs = new Set<(t: number) => void>();
let raf = 0;
let last = 0;
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

// 池子大小：morph 同屏最多 活跃5 + 出场5 + 哼唱2 = 12；粒子爆裂上限 120、丝带前层 ≤9。
const SHAPE_POOL = 14;
const BACK_POOL = 140;
const FRONT_POOL = 20;

export interface BotMarkProps {
  shape: string;
  persona: string;
  color?: string;
  mood: Mood;
  size: number;
  reduceMotion: boolean;
  animationEnabled?: boolean;
  lookX?: number;
  /** 一次性事件（额度重置/完工/醒来），由调用方按持有窗口传入。 */
  event?: BotEvent | null;
  /** 戳一下：递增数字触发一次爆裂 + 弹跳。 */
  poke?: number;
  /** 深色主题（决定默认眼睛颜色）。 */
  dark?: boolean;
  /** 用量进入警戒区：空闲轮换里加入"！"警告。 */
  alerting?: boolean;
  /** 指针悬停：空闲机器人停下来听。 */
  pointed?: boolean;
  /** 调试/预览覆盖：直接指定播放列表（如 ["thinking"]、["alerting"]）。 */
  states?: string[] | null;
}

export function BotMark({ shape: shapeId, persona, color, mood, size, reduceMotion, animationEnabled = true, lookX = 0, event = null, poke = 0, dark = false, alerting = false, pointed = false, states = null }: BotMarkProps) {
  const [data, setData] = useState<BotData | null>(null);
  const engineRef = useRef<BotMarkEngine | null>(null);
  const clipId = useId();

  const svgRef = useRef<SVGSVGElement>(null);
  const clipPathRef = useRef<SVGPathElement>(null);
  const headGRef = useRef<SVGGElement>(null);
  const headPathRef = useRef<SVGPathElement>(null);
  const eyeRefs = useRef<(SVGPathElement | null)[]>([null, null]);
  const shapePoolRefs = useRef<(SVGPathElement | null)[]>([]);
  const backPoolRefs = useRef<(SVGPathElement | null)[]>([]);
  const frontPoolRefs = useRef<(SVGPathElement | null)[]>([]);
  const gradRefs = useRef<(SVGLinearGradientElement | null)[]>([]);
  const badgeRef = useRef<SVGCircleElement | null>(null);

  useEffect(() => { if (!data) void loadBotData().then(setData).catch(() => {}); }, [data]);

  const bodyColor = color ?? "currentColor";
  // 眼色对比规则见 botEyeColor；dark=深色主题（身体 currentColor 为浅色）→ 深色眼。
  const eyeColor = botEyeColor(color, dark);

  // 最新 props 供 rAF 回调读取，避免每次属性变化都重挂订阅。
  const propsRef = useRef({ shapeId, persona, mood, lookX, event, alerting, pointed, size, states: states ?? null });
  propsRef.current = { shapeId, persona, mood, lookX, event, alerting, pointed, size, states: states ?? null };

  const animate = !!data && animationEnabled && !reduceMotion;

  // 引擎随数据创建一次；换形状走引擎自己的体型混合（带反应动画）。
  useEffect(() => {
    if (data && !engineRef.current) engineRef.current = new BotMarkEngine(data);
  }, [data]);

  // 戳一下：爆裂 + 弹跳。
  const pokeRef = useRef(poke);
  useEffect(() => {
    if (poke !== pokeRef.current) {
      pokeRef.current = poke;
      engineRef.current?.poke();
    }
  }, [poke]);

  useEffect(() => {
    if (!animate || !data) return;
    // A new subscriber inherits DOM nodes, so reset all previous pooled output.
    for (const refs of [shapePoolRefs, backPoolRefs, frontPoolRefs]) {
      for (const el of refs.current) el?.setAttribute("visibility", "hidden");
    }
    badgeRef.current?.setAttribute("opacity", "0");
    let lastHeadD = "";
    let lastViewBox = "";
    // 每帧增量写 DOM：路径/可见性没变就不碰属性（悬浮栏 7 个机器人共享一个
    // 30fps 时钟，任何每帧固定开销都会 ×7×30 放大成可感知的卡顿）。
    const lastEyeD = ["", ""];
    const lastEyeVis = ["", ""];
    const shapeLast = { n: 0 };
    const backLast = { n: 0 };
    const frontLast = { n: 0 };
    let badgeOn = false;

    const applyFrame = (frame: BotFrame, gradCursor: { n: number }) => {
      const r = frame.viewBoxRadius;
      // viewBox 以内容中心 VIEW_BOX_CENTRE（=114.5）为圆心，半径 r。
      const vb = `${VIEW_BOX_CENTRE - r} ${VIEW_BOX_CENTRE - r} ${2 * r} ${2 * r}`;
      if (vb !== lastViewBox) { svgRef.current?.setAttribute("viewBox", vb); lastViewBox = vb; }
      if (frame.headD !== lastHeadD) {
        headPathRef.current?.setAttribute("d", frame.headD);
        clipPathRef.current?.setAttribute("d", frame.headD);
        lastHeadD = frame.headD;
      }
      headGRef.current?.setAttribute("transform", frame.headTransform);
      headPathRef.current?.setAttribute("opacity", frame.headOpacity.toFixed(3));
      for (let i = 0; i < 2; i++) {
        const el = eyeRefs.current[i];
        if (!el) continue;
        const eye = frame.eyes[i];
        const d = eye?.d ?? "";
        if (d !== lastEyeD[i]) { el.setAttribute("d", d); lastEyeD[i] = d; }
        if (eye) el.setAttribute("transform", eye.transform);
        const vis = eye && eye.visible ? "1" : "0";
        if (vis !== lastEyeVis[i]) { el.setAttribute("opacity", vis); lastEyeVis[i] = vis; }
      }
      applyPool(shapePoolRefs.current, shapeLast, frame.shapes.length, (el, i) => {
        const s: MorphShape = frame.shapes[i]!;
        el.setAttribute("d", s.d);
        setAttr(el, "transform", s.transform);
        el.setAttribute("opacity", s.opacity.toFixed(3));
        if (s.strokeWidth) {
          el.setAttribute("stroke", bodyColor);
          el.setAttribute("stroke-width", s.strokeWidth.toFixed(2));
          el.setAttribute("fill", "none");
          el.setAttribute("stroke-linecap", "round");
        } else {
          el.removeAttribute("stroke");
          el.setAttribute("fill", bodyColor);
        }
      });
      applyParticles(backPoolRefs.current, backLast, frame.back, gradRefs.current, gradCursor);
      applyParticles(frontPoolRefs.current, frontLast, frame.front, gradRefs.current, gradCursor);
      const badgeEl = badgeRef.current;
      if (badgeEl) {
        if (frame.badge) {
          badgeEl.setAttribute("cx", frame.badge.x.toFixed(1));
          badgeEl.setAttribute("cy", frame.badge.y.toFixed(1));
          badgeEl.setAttribute("r", frame.badge.r.toFixed(1));
          badgeEl.setAttribute("fill", frame.badge.color);
          badgeEl.setAttribute("stroke", eyeColor);
          badgeEl.setAttribute("opacity", "1");
          badgeOn = true;
        } else if (badgeOn) {
          badgeEl.setAttribute("opacity", "0");
          badgeOn = false;
        }
      }
    };

    const unsub = subscribe(t => {
      const p = propsRef.current;
      const engine = engineRef.current;
      if (!engine) return;
      const gradCursor = { n: 0 };
      applyFrame(engine.advance(t / 1000, buildProgramme(data, p.shapeId, p.persona, p.mood,
        p.lookX, p.event, p.alerting, p.pointed, p.size, p.states)), gradCursor);
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animate, data, bodyColor, eyeColor]);

  // 减少动态：渲染"模拟 3 秒后安定"的定格帧——看得出是哪种心情，但不动。
  useEffect(() => {
    if (animate || !data || !engineRef.current) return;
    const p = propsRef.current;
    const frame = settledStill(data, p.shapeId, p.persona, p.mood, p.lookX, p.alerting, p.pointed, p.size, p.states);
    if (!frame) return;
    const r = frame.viewBoxRadius;
    svgRef.current?.setAttribute("viewBox", `${VIEW_BOX_CENTRE - r} ${VIEW_BOX_CENTRE - r} ${2 * r} ${2 * r}`);
    headPathRef.current?.setAttribute("d", frame.headD);
    clipPathRef.current?.setAttribute("d", frame.headD);
    headGRef.current?.setAttribute("transform", frame.headTransform);
    headPathRef.current?.setAttribute("opacity", frame.headOpacity.toFixed(3));
    for (let i = 0; i < 2; i++) {
      const eye = frame.eyes[i];
      eyeRefs.current[i]?.setAttribute("d", eye?.d ?? "");
      eyeRefs.current[i]?.setAttribute("transform", eye?.transform ?? "translate(0,0)");
      eyeRefs.current[i]?.setAttribute("opacity", eye?.visible ? "1" : "0");
    }
    // 定格：清空 morph/粒子层（n 初始化为池子大小 = 全量隐藏一遍）。
    applyPool(shapePoolRefs.current, { n: SHAPE_POOL }, 0, () => {});
    const gradCursor = { n: 0 };
    applyParticles(backPoolRefs.current, { n: BACK_POOL }, [], gradRefs.current, gradCursor);
    applyParticles(frontPoolRefs.current, { n: FRONT_POOL }, [], gradRefs.current, gradCursor);
    badgeRef.current?.setAttribute("opacity", "0");
  }, [animate, data, shapeId, persona, mood, lookX, alerting, pointed, size]);

  const pool = (refs: React.MutableRefObject<(SVGPathElement | null)[]>, count: number) =>
    Array.from({ length: count }, (_, i) => (
      <path key={i} ref={el => { refs.current[i] = el; }} opacity="0" />
    ));

  return (
    <svg ref={svgRef} width={size} height={size} viewBox={`${VIEW_BOX_CENTRE - 129.5} ${VIEW_BOX_CENTRE - 129.5} 259 259`} aria-hidden>
      <defs>
        <clipPath id={clipId}><path ref={clipPathRef} d="" /></clipPath>
        {Array.from({ length: 12 }, (_, i) => (
          <linearGradient key={i} id={`${clipId}-g${i}`} gradientUnits="userSpaceOnUse" ref={el => { gradRefs.current[i] = el; }}>
            <stop offset="0" /><stop offset="0.25" /><stop offset="0.5" /><stop offset="0.75" /><stop offset="1" />
          </linearGradient>
        ))}
      </defs>
      <g>{pool(backPoolRefs, BACK_POOL)}</g>
      <g>{pool(shapePoolRefs, SHAPE_POOL)}</g>
      <g ref={headGRef}>
        <path ref={headPathRef} d="" fill={bodyColor} />
        <g clipPath={`url(#${clipId})`}>
          <path ref={el => { eyeRefs.current[0] = el; }} d="" fill={eyeColor} fillRule="evenodd" />
          <path ref={el => { eyeRefs.current[1] = el; }} d="" fill={eyeColor} fillRule="evenodd" />
        </g>
        <circle ref={badgeRef} r="0" opacity="0" strokeWidth="10" stroke={eyeColor} />
      </g>
      <g>{pool(frontPoolRefs, FRONT_POOL)}</g>
    </svg>
  );
}

function setAttr(el: SVGElement, name: string, value: string | undefined) {
  if (value) el.setAttribute(name, value);
  else el.removeAttribute(name);
}

function applyPool(
  els: (SVGPathElement | null)[], last: { n: number }, count: number,
  write: (el: SVGPathElement, i: number) => void,
) {
  // 增量更新：只写活跃槽位，并只隐藏上一帧新空出来的槽位。
  for (let i = 0; i < count; i++) {
    const el = els[i];
    if (!el) continue;
    write(el, i);
    el.removeAttribute("visibility");
  }
  for (let i = count; i < last.n; i++) els[i]?.setAttribute("visibility", "hidden");
  last.n = count;
}

function applyParticles(
  els: (SVGPathElement | null)[], last: { n: number }, items: Painted[],
  grads: (SVGLinearGradientElement | null)[], cursor: { n: number },
) {
  for (let i = 0; i < items.length; i++) {
    const el = els[i];
    if (!el) continue;
    const p = items[i]!;
    el.removeAttribute("visibility");
    el.setAttribute("d", p.d);
    setAttr(el, "transform", p.transform);
    el.setAttribute("opacity", p.opacity.toFixed(3));
    if (p.gradient) {
      // 同一帧内按顺序分配渐变槽（前后层共用一个游标）。
      const grad = grads[cursor.n % grads.length];
      cursor.n += 1;
      if (grad) {
        grad.setAttribute("x1", p.gradient.x1.toFixed(1));
        grad.setAttribute("y1", p.gradient.y1.toFixed(1));
        grad.setAttribute("x2", p.gradient.x2.toFixed(1));
        grad.setAttribute("y2", p.gradient.y2.toFixed(1));
        const stops = grad.querySelectorAll("stop");
        p.gradient.stops.forEach(([color, offset], k) => {
          stops[k]?.setAttribute("stop-color", color);
          stops[k]?.setAttribute("offset", offset.toFixed(2));
        });
        el.setAttribute("fill", `url(#${grad.id})`);
      } else el.setAttribute("fill", "#fff");
    } else {
      el.setAttribute("fill", p.fill);
    }
    el.removeAttribute("stroke");
  }
  for (let i = items.length; i < last.n; i++) els[i]?.setAttribute("visibility", "hidden");
  last.n = items.length;
}

// MARK: - 节目单组装（上游 BotMarkView.programme 的对应物）

function buildProgramme(data: BotData, shapeId: string, persona: string, mood: Mood,
  lookX: number, event: BotEvent | null, alerting: boolean, pointed: boolean, size: number,
  statesOverride: string[] | null = null) {
  void data;
  const gaze = gazeFromLookX(lookX);
  const p = (PERSONAS as readonly string[]).includes(persona) ? persona as typeof PERSONAS[number] : "calm";
  const overtime = isOvertime();
  let states: string[];
  if (statesOverride) states = statesOverride;
  else if (mood === "working") states = workingStates(p, overtime, false);
  else if (mood === "idle") states = pointed ? ["listening"] : idleStates(p, alerting);
  else states = [personaState(p, mood)];
  return {
    states,
    hold: [2500, 4500] as [number, number],
    event,
    mood,
    shape: shapeId,
    tempo: personaTempo(p) * tempoEmphasis(mood),
    motionScale: personaMotion(p),
    gazeScale: personaGaze(p),
    eyeScale: personaEye(p),
    gazeBias: gaze.bias,
    flipX: gaze.mirrored,
    rotationScale: rotationEmphasis(mood),
    squashScale: squashEmphasis(mood),
    particlesEnabled: true,
    viewWidth: size,
  };
}

// MARK: - 定格（减少动态）

interface StillKey {
  state: string; shape: string; tempo: number; motionScale: number;
  gazeBias: number; flipX: boolean; squashScale: number; rotationScale: number;
}

const stills = new Map<string, BotFrame | null>();

function settledStill(data: BotData, shapeId: string, persona: string, mood: Mood,
  lookX: number, alerting: boolean, pointed: boolean, size: number,
  statesOverride: string[] | null = null): BotFrame | null {
  const programme = buildProgramme(data, shapeId, persona, mood, lookX, null, alerting, pointed, size, statesOverride);
  const quiet = { ...programme, states: [programme.states[0] ?? "idle"], event: null, particlesEnabled: false };
  const key: StillKey = {
    state: quiet.states[0]!, shape: quiet.shape, tempo: quiet.tempo, motionScale: quiet.motionScale,
    gazeBias: quiet.gazeBias, flipX: quiet.flipX, squashScale: quiet.squashScale, rotationScale: quiet.rotationScale,
  };
  const cacheKey = JSON.stringify(key);
  const cached = stills.get(cacheKey);
  if (cached !== undefined) return cached;
  // 全新引擎模拟 3 秒，让弹簧落位；再等眨眼收尾——闭眼的定格读起来像坏了。
  const engine = new BotMarkEngine(data);
  let t = 0;
  let frame = engine.advance(t, quiet);
  while (t < 3) {
    t += 1 / 60;
    frame = engine.advance(t, quiet);
  }
  let guard = 0;
  while (engine.isBlinking && guard < 120) {
    t += 1 / 60;
    frame = engine.advance(t, quiet);
    guard += 1;
  }
  if (stills.size > 64) stills.clear();
  stills.set(cacheKey, frame);
  return frame;
}
