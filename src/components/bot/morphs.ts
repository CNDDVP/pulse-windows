/**
 * 14 种一次性 morph 特效（上游 BotMarkMorphs.swift ← morph-system.js）。
 *
 * morph 不是切换：头部轮廓混入圆形（pencil 是倒泪滴），整个角色缩到特效
 * 的尺寸，特效自己的点、环、字形画在身体下层。RESET→ENTER→HOLD→EXIT→DONE
 * 由一根弹簧驱动，所以 morph 半路被打断也有明确定义。
 */
import { BotSpring, backOut, clamp, cubicInOut, cubicOut, unitRemainder } from "./math";
import type { Ring } from "./geometry";
import type { MorphShape } from "./types";

/** 特效在屏时角色缩到多小。 */
export const MORPH_SIZES: Record<string, number> = {
  dots: 22, orbit: 19, radar: 19, progress: 19, gather: 19,
  wave: 16, send: 20, receive: 20, dock: 20, ball: 18,
  whirl: 15, pencil: 17, bang: 13, standby: 13,
};

/** 每种特效把 viewBox 张开多少（只在小画布上生效）。 */
export const MORPH_VIEW_BOXES: Record<string, number> = {
  dots: 1.5, orbit: 1.14, radar: 1.14, progress: 1.32, gather: 1.15,
  wave: 1.42, send: 1.12, receive: 1.12, dock: 1.3, ball: 1.22,
  whirl: 1.45, pencil: 1.18, bang: 1.28, standby: 1.75,
};

export const MORPH_ORDER = ["dots", "orbit", "radar", "progress", "gather", "wave",
  "send", "receive", "dock", "ball", "whirl", "pencil", "bang", "standby"];

/** 引擎暴露给 morph 层的可变状态。 */
export interface MorphHost {
  headC: number;
  state: string;
  stateStartedAt: number;
  morph: BotSpring;
  morphBlend: BotSpring;
  turn: BotSpring;
  requestedMorphEffect: string | null;
  morphEffect: string | null;
  previousMorphEffect: string | null;
  morphVisible: boolean;
  morphStartedAt: number;
  morphShotStartedAt: number;
  morphRestStartedAt: number;
  oneShotResting: boolean;
  receiveCycle: number;
  receiveAngle: number;
  turnDirection: number;
  writingTrail: [number, number][];
  pencilGlyphD: string;
  alertGlyphD: string;
  pencilRing: Ring;
  circleRing: Ring;
}

export interface EffectPose {
  x: number;
  y: number;
  rotation: number;
  scale: number;
  opacity: number;
}

const newPose = (): EffectPose => ({ x: 0, y: 0, rotation: 0, scale: 1, opacity: 1 });

const expf = (v: number) => Math.exp(-v);

/** 生成一个圆的路径 d。 */
function circleD(x: number, y: number, r: number): string {
  const f = (v: number) => (Math.round(v * 10) / 10).toString();
  return `M${f(x - r)},${f(y)}A${f(r)},${f(r)} 0 1 1 ${f(x + r)},${f(y)}A${f(r)},${f(r)} 0 1 1 ${f(x - r)},${f(y)}Z`;
}

// MARK: - 生命周期

export function updateMorph(host: MorphHost, now: number, configMorph: string | null): void {
  const requested = configMorph;
  if (requested !== host.requestedMorphEffect) {
    host.requestedMorphEffect = requested;
    host.morphShotStartedAt = now;
    host.oneShotResting = false;
  }
  let visible = requested != null;
  // progress 和 spawning 是"一发一发"的：播完歇 1.5s 再播。
  if (requested != null && (host.state === "progress" || host.state === "spawning")) {
    const shot = host.state === "progress" ? 2500 : 2000;
    if (!host.oneShotResting && now - host.morphShotStartedAt > shot) {
      host.oneShotResting = true;
      host.morphRestStartedAt = now;
    } else if (host.oneShotResting && now - host.morphRestStartedAt > 1500) {
      host.oneShotResting = false;
      host.morphShotStartedAt = now;
    }
    visible = !host.oneShotResting;
  }
  host.morph.target = visible ? 1 : 0;

  if (requested != null && requested !== host.morphEffect) {
    if (host.morphEffect != null && host.morph.value > 0.02) {
      host.previousMorphEffect = host.morphEffect;
      host.morphBlend.value = 0;
      host.morphBlend.velocity = 0;
      host.morphBlend.target = 1;
    } else {
      host.previousMorphEffect = null;
      host.morphBlend.value = 1;
      host.morphBlend.velocity = 0;
      host.morphBlend.target = 1;
    }
    host.morphEffect = requested;
    host.morphStartedAt = now;
  }
  // 出场几何等弹簧完全归零后才丢弃。
  if (requested == null && host.morph.value < 0.004) {
    host.morphEffect = null;
    host.previousMorphEffect = null;
    host.morphBlend.value = 1;
    host.morphBlend.velocity = 0;
    host.morphBlend.target = 1;
  }
  if (host.previousMorphEffect != null && host.morphBlend.value > 0.996) host.previousMorphEffect = null;

  if (visible !== host.morphVisible) {
    if (visible) host.turnDirection = Math.random() < 0.5 ? 1 : -1;
    host.turn.target += Math.PI * host.turnDirection;
    host.morphVisible = visible;
  }
}

// MARK: - 特效绘制

/** 画所有在场的特效，返回角色本身的姿势。 */
export function renderMorphEffects(
  host: MorphHost, morphAmount: number, blend: number, previous: string | null,
  morphSize: number, now: number, delta: number, shapes: MorphShape[],
): EffectPose {
  const pose = newPose();
  const active = host.morphEffect;
  if (!active || morphAmount <= 0.004) return pose;
  const c = host.headC;
  const elapsed = now - host.stateStartedAt;

  for (const effect of MORPH_ORDER) {
    let amount: number;
    if (effect === active) amount = morphAmount * blend;
    else if (effect === previous) amount = morphAmount * (1 - blend);
    else continue;
    if (amount <= 0.004) continue;

    switch (effect) {
      case "dots": {
        const anchors = [c - 62, c + 62];
        for (let i = 0; i < 2; i++) {
          const phase = clamp((amount - 0.12 * i) / (1 - 0.12 * i), 0, 1);
          if (phase <= 0.004) continue;
          const grow = cubicOut(phase);
          const enter = backOut(phase);
          const raw = unitRemainder((now - host.morphStartedAt) / 1400 + 0.119);
          const pulseDistance = Math.abs(raw - (i * 2) / 3);
          const distance = Math.min(pulseDistance, 1 - pulseDistance);
          const pulse = expf((distance * distance) / 0.045);
          const lift = 9 * pulse * amount;
          const pop = 0.84 + 0.22 * pulse;
          // circleRing 半径即 headC，缩放后就是 22*grow*pop*1.02 的圆。
          const radius = 22 * grow * pop * 1.02;
          shapes.push({
            d: circleD(c + (anchors[i]! - c) * enter, c - lift, radius),
            opacity: grow * (1 - 0.5 * (1 - pulse)),
          });
        }
        const raw2 = unitRemainder((now - host.morphStartedAt) / 1400 + 0.119);
        const d2 = Math.abs(raw2 - 1 / 3);
        const pd = Math.min(d2, 1 - d2);
        const pulse2 = expf((pd * pd) / 0.045);
        const pop2 = 0.84 + 0.22 * pulse2;
        pose.scale *= 1 + (pop2 - 1) * (amount / Math.max(morphAmount, 0.001));
        pose.y -= 9 * pulse2 * amount * morphAmount;
        pose.opacity *= 1 - 0.5 * (1 - pulse2) * amount;
        break;
      }
      case "orbit": {
        const radius = 52 * backOut(amount);
        for (let i = 0; i < 5; i++) {
          const phase = 0.0017 * now + (i * Math.PI * 2) / 5;
          const cosine = Math.cos(phase);
          const depth = 0.5 + 0.5 * clamp(cosine, 0, 1);
          shapes.push({
            d: circleD(c + radius * Math.sin(phase), c - 0.42 * radius * Math.cos(phase),
              Math.max(12 * depth * cubicOut(amount), 0.3)),
            opacity: clamp((cosine + 0.4) / 0.6, 0.18, 1) * cubicOut(amount),
          });
        }
        break;
      }
      case "radar": {
        for (let i = 0; i < 3; i++) {
          const phase = unitRemainder(now / 1300 + i / 3);
          shapes.push({
            d: circleD(c, c, morphSize + (104 - morphSize) * phase),
            opacity: cubicOut(amount) * (1 - phase) * 0.9,
            strokeWidth: 3.4 * (1 - 0.55 * phase),
          });
        }
        break;
      }
      case "progress": {
        const radius = 62 * backOut(amount);
        shapes.push({ d: circleD(c, c, radius), opacity: 0.16 * cubicOut(amount), strokeWidth: 5 });
        const progress = clamp((now - host.morphShotStartedAt) / 2500 / 0.85, 0, 1);
        if (progress > 0) {
          // 十二点方向起的弧（上游画整圈再 dash；等价结果）。
          const a0 = -Math.PI / 2;
          const a1 = a0 + Math.PI * 2 * progress;
          const x0 = c + radius * Math.cos(a0), y0 = c + radius * Math.sin(a0);
          const x1 = c + radius * Math.cos(a1), y1 = c + radius * Math.sin(a1);
          const large = progress > 0.5 ? 1 : 0;
          shapes.push({
            d: `M${x0.toFixed(1)},${y0.toFixed(1)}A${radius.toFixed(1)},${radius.toFixed(1)} 0 ${large} 1 ${x1.toFixed(1)},${y1.toFixed(1)}`,
            opacity: cubicOut(amount), strokeWidth: 5,
          });
        }
        break;
      }
      case "gather": {
        for (let i = 0; i < 5; i++) {
          const phase = clamp(((now - host.morphShotStartedAt) / 2000 - 0.09 * i) / 0.62, 0, 1);
          if (phase >= 1) continue;
          const settle = 1 - Math.pow(1 - phase, 3);
          const angle = 2.4 * i + 2.2 * phase;
          const radius = 96 * (1 - settle);
          shapes.push({
            d: circleD(c + radius * Math.cos(angle), c + radius * Math.sin(angle) * 0.8,
              9 * (0.5 + 0.5 * settle) * cubicOut(amount)),
            opacity: cubicOut(amount) * clamp(5 * phase, 0, 1) * (1 - 0.25 * settle),
          });
        }
        break;
      }
      case "wave": {
        const offsets = [-2, -1, 1, 2];
        for (const offset of offsets) {
          const phase = clamp((amount - 0.1 * Math.abs(offset)) / (1 - 0.1 * Math.abs(offset)), 0, 1);
          if (phase <= 0.004) continue;
          const energy = (0.42 + 0.29 * Math.sin(0.0021 * now) * Math.sin(0.0034 * now)
            + 0.29 * Math.sin(0.0013 * now + 1.7))
            * (0.55 + 0.45 * Math.sin(0.012 * now - 1.05 * Math.abs(offset)));
          const size = (7 + 9 * clamp(energy, 0.08, 1)) * cubicOut(phase);
          const lift = 6 * clamp(energy, 0, 1) * phase;
          shapes.push({ d: circleD(c + 44 * offset * backOut(phase), c - lift, size), opacity: phase });
        }
        break;
      }
      case "send": {
        const phase = unitRemainder((now - host.stateStartedAt) / 1500);
        const travel = clamp((phase - 0.18) / 0.55, 0, 1);
        const eased = travel * travel * (0.4 + 0.6 * travel);
        const distance = 108 * eased;
        if (travel > 0 && travel < 1) {
          shapes.push({
            d: circleD(c + 0.74 * distance, c - 0.62 * distance, 10 * (1 - 0.55 * eased) * cubicOut(amount)),
            opacity: cubicOut(amount) * (1 - eased * eased),
          });
        }
        const secondTravel = clamp((phase - 0.26) / 0.55, 0, 1);
        const secondEase = secondTravel * secondTravel * (0.4 + 0.6 * secondTravel);
        if (travel > 0 && secondTravel > 0 && secondTravel < 1) {
          const secondDistance = 108 * secondEase;
          shapes.push({
            d: circleD(c + 0.74 * secondDistance, c - 0.62 * secondDistance, 5 * (1 - 0.6 * secondEase) * cubicOut(amount)),
            opacity: 0.3 * cubicOut(amount) * (1 - secondEase),
          });
        }
        const ringPhase = clamp((phase - 0.18) / 0.3, 0, 1);
        if (ringPhase > 0 && ringPhase < 1) {
          shapes.push({
            d: circleD(c, c, 20 + 34 * cubicOut(ringPhase)),
            opacity: cubicOut(amount) * (1 - ringPhase) * 0.8,
            strokeWidth: 2.8 * (1 - ringPhase),
          });
        }
        const bump = phase < 0.18 ? -0.06 * Math.sin((phase / 0.18) * Math.PI)
          : phase < 0.42 ? 0.05 * Math.sin(((phase - 0.18) / 0.24) * Math.PI) : 0;
        pose.scale *= 1 + bump * amount;
        break;
      }
      case "receive": {
        const el = now - host.stateStartedAt;
        const cycle = Math.floor(el / 1700);
        if (cycle !== host.receiveCycle) {
          host.receiveCycle = cycle;
          host.receiveAngle = -1.25 * Math.PI + Math.random() * 1.5 * Math.PI;
        }
        const phase = unitRemainder(el / 1700);
        const travel = clamp(phase / 0.6, 0, 1);
        const eased = 1 - Math.pow(1 - travel, 3);
        const radius = 108 * (1 - eased);
        const orbit = 18 * Math.sin(travel * Math.PI) * (1 - 0.7 * eased);
        const cosine = Math.cos(host.receiveAngle), sine = Math.sin(host.receiveAngle);
        if (travel < 1) {
          shapes.push({
            d: circleD(c + cosine * radius - sine * orbit, c + sine * radius + cosine * orbit,
              3.5 + 6.5 * eased),
            opacity: cubicOut(amount) * clamp(3.5 * travel, 0, 1) * (0.3 + 0.7 * eased),
          });
        }
        const ringPhase = clamp((phase - 0.58) / 0.32, 0, 1);
        if (ringPhase > 0 && ringPhase < 1) {
          shapes.push({
            d: circleD(c, c, 20 + 26 * cubicOut(ringPhase)),
            opacity: cubicOut(amount) * (1 - ringPhase) * 0.8,
            strokeWidth: 2.8 * (1 - ringPhase),
          });
        }
        const rcvPhase = clamp((unitRemainder(el / 1700) - 0.58) / 0.34, 0, 1);
        pose.scale *= 1 + 0.11 * Math.sin(rcvPhase * Math.PI) * amount;
        break;
      }
      case "dock": {
        const el = (now - host.stateStartedAt) / 1000;
        for (let i = 0; i < 2; i++) {
          const phase = clamp((el - (0.2 + 1.3 * i)) / 0.9, 0, 1);
          if (phase <= 0) continue;
          const eased = 1 - Math.pow(1 - phase, 3);
          const angle = 0.0011 * now + i * Math.PI;
          const targetX = c + 42 * Math.sin(angle);
          const targetY = c + 21 * Math.cos(angle) + 2 * Math.sin(0.003 * now + i);
          const startX = c - 120 + 30 * i;
          const startY = c + 95;
          shapes.push({
            d: circleD(startX + (targetX - startX) * eased, startY + (targetY - startY) * eased,
              (7 + 3 * eased) * cubicOut(amount)),
            opacity: cubicOut(amount) * clamp(4 * phase, 0, 1),
          });
        }
        break;
      }
      case "pencil": {
        const pencil = renderPencil(host, amount, now, shapes);
        pose.x += pencil.x * amount * morphAmount;
        pose.y += pencil.y * amount * morphAmount;
        pose.rotation += pencil.rotation * amount * morphAmount;
        break;
      }
      case "bang": {
        renderBang(host, amount, now, shapes);
        pose.y += 58 * amount * morphAmount;
        pose.scale *= 1 + 0.04 * expf(((elapsed / 1000) % 2.2) * 5.5) * amount;
        break;
      }
      case "standby": {
        renderStandby(host, amount, now, shapes);
        pose.opacity *= 1 - (0.28 + 0.2 * Math.sin(0.0016 * now)) * amount;
        break;
      }
      case "whirl": {
        // whirl 就是粒子带；头部只是漂移。
        pose.x += (2 * Math.sin(0.0009 * now) + 0.8 * Math.sin(0.0017 * now)) * amount * morphAmount;
        pose.y += (2.4 * Math.sin(0.0013 * now) + 1.2 * Math.sin(0.0006 * now)) * amount * morphAmount;
        break;
      }
      case "ball": {
        const seconds = elapsed / 1000;
        const gravity = 416 / 0.3844;
        const fall = Math.sqrt(80 / gravity);
        const cycle = unitRemainder((seconds - fall) / 0.62);
        const height = seconds < fall ? 40 - 0.5 * gravity * seconds * seconds : 208 * cycle * (1 - cycle);
        pose.y += (40 - height) * amount * morphAmount;
        break;
      }
    }
  }
  void delta;
  return pose;
}

function renderPencil(host: MorphHost, amount: number, now: number, shapes: MorphShape[]): EffectPose {
  const c = host.headC;
  const el = now - host.stateStartedAt;
  const cycle = unitRemainder(el / 2500);
  let px: number, py: number, wiggle: number, rotation: number, lift: boolean;
  if (cycle < 0.68) {
    const phase = cycle / 0.68;
    const envelope = clamp(phase / 0.08, 0, 1) * clamp((1 - phase) / 0.08, 0, 1);
    px = -54 + smoothstep01(phase) * 118;
    py = 26;
    wiggle = 3.2 * Math.sin(24 * phase) * envelope;
    rotation = 17 + Math.sin(0.0006 * el);
    lift = false;
  } else {
    const phase = cubicInOut((cycle - 0.68) / 0.32);
    px = 64 - 118 * phase;
    py = 26 - 20 * Math.sin(phase * Math.PI);
    wiggle = 0;
    rotation = 17 - 2 * Math.sin(phase * Math.PI) + Math.sin(0.0006 * el);
    lift = true;
  }
  const angle = ((rotation - 90) * Math.PI) / 180;
  const offsetX = 68 * Math.cos(angle);
  const offsetY = 68 * Math.sin(angle);
  const tx = c + (px + offsetX) * amount;
  const ty = c + (py + 0.15 * wiggle + offsetY) * amount;
  const scale = cubicOut(amount);
  shapes.push({
    d: host.pencilGlyphD,
    transform: `translate(${tx.toFixed(1)},${ty.toFixed(1)}) `
      + `rotate(${(rotation * amount).toFixed(2)}) scale(${scale.toFixed(3)}) `
      + `translate(${-c},${-c})`,
    opacity: clamp(1.6 * amount - 0.3, 0, 1),
  });

  // 写出的线：笔尖按下时铺点，抬起后从头吃掉。
  if (amount > 0.6 && !lift) {
    const point: [number, number] = [c + px, c + py + wiggle + 19];
    const last = host.writingTrail[host.writingTrail.length - 1];
    if (last && Math.hypot(point[0] - last[0], point[1] - last[1]) <= 2.4) {
      host.writingTrail[host.writingTrail.length - 1] = point;
    } else {
      host.writingTrail.push(point);
      if (host.writingTrail.length > 64) host.writingTrail.shift();
    }
  } else if (host.writingTrail.length) {
    host.writingTrail.splice(0, Math.min(2, host.writingTrail.length));
  }
  if (host.writingTrail.length >= 2) {
    const pts = host.writingTrail;
    let d = `M${pts[0]![0].toFixed(1)},${pts[0]![1].toFixed(1)}`;
    if (pts.length === 2) {
      d += `L${pts[1]![0].toFixed(1)},${pts[1]![1].toFixed(1)}`;
    } else {
      for (let i = 0; i < pts.length - 1; i++) {
        const prev = pts[Math.max(i - 1, 0)]!;
        const pt = pts[i]!;
        const next = pts[i + 1]!;
        const after = pts[Math.min(i + 2, pts.length - 1)]!;
        d += `C${(pt[0] + (next[0] - prev[0]) / 6).toFixed(1)},${(pt[1] + (next[1] - prev[1]) / 6).toFixed(1)},`
          + `${(next[0] - (after[0] - pt[0]) / 6).toFixed(1)},${(next[1] - (after[1] - pt[1]) / 6).toFixed(1)},`
          + `${next[0].toFixed(1)},${next[1].toFixed(1)}`;
      }
    }
    shapes.push({ d, opacity: clamp(1.2 * amount, 0, 1), strokeWidth: 6 });
  }
  return { x: px, y: py + 0.5 * wiggle, rotation, scale: 1, opacity: 1 };
}

function renderBang(host: MorphHost, amount: number, now: number, shapes: MorphShape[]): void {
  const c = host.headC;
  const el = (now - host.stateStartedAt) / 1000;
  const enter = cubicOut(clamp(1.1 * amount, 0, 1));
  const shake = 2.2 * Math.sin(42 * el) * expf((el % 2.2) * 5.5);
  const scale = clamp(1.2 * amount, 0, 1);
  // 复合顺序对齐上游（CG 行向量语义）：先移到原点、缩放、抬升 74，
  // 绕原点小幅摆动，再落回 (c, c-74) 上方，整体上移 dy。
  shapes.push({
    d: host.alertGlyphD,
    transform: `translate(0,${(-26 - (1 - enter) * 70).toFixed(1)}) `
      + `rotate(${shake.toFixed(2)}) translate(${c},${(c - 74).toFixed(1)}) `
      + `scale(${scale.toFixed(3)}) translate(${-c},${-c})`,
    opacity: clamp(1.5 * amount - 0.2, 0, 1),
  });
}

function renderStandby(host: MorphHost, amount: number, now: number, shapes: MorphShape[]): void {
  const c = host.headC;
  const pulse = 0.5 + 0.5 * Math.sin(0.0016 * now);
  shapes.push({ d: circleD(c, c, 26 + 7 * pulse), opacity: cubicOut(amount) * (0.06 + 0.1 * pulse) });
  if (amount < 0.995) {
    shapes.push({
      d: circleD(c, c, 104 - 88 * cubicOut(amount)),
      opacity: (1 - cubicOut(amount)) * 0.5, strokeWidth: 2.4,
    });
  }
}

function smoothstep01(v: number): number {
  return v * v * (3 - 2 * v);
}

/** morph 时头部混入的目标环：pencil 用倒泪滴，其余用单位圆。 */
export function morphTargetRing(host: MorphHost, effect: string | null): Ring {
  return effect === "pencil" ? host.pencilRing : host.circleRing;
}
