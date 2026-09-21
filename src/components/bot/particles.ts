/**
 * 粒子层（上游 BotMarkParticles.swift ← particle-system.js）。
 *
 * 两种粒子。**爆裂（burst）**是普通彩纸：绕头一圈生成、向外抛出、
 * 受阻曳并下坠，画成圆点、拉长的条纹或星星。**轨道（orbit）**粒子只在
 * 角色旋转时存在：骑在绕头的倾斜滚转圆上，身后拖着锥形丝带，丝带颜色
 * 沿长度流动。丝带按粒子深度拆前后两层，从头后绕过再穿出来。
 */
import { clamp, random } from "./math";
import type { Painted } from "./types";

const COLORS = ["#f9705c", "#5b95f0", "#3fbe86", "#f5b13f", "#9a72ee", "#35c3bd"];

interface Orbit {
  angle: number;
  angularVelocity: number;
  tilt: number;
  roll: number;
  radius: number;
  radiusVelocity: number;
  follow: number;
  carry: number;
  arc: number;
}

interface TrailPoint { x: number; y: number; angle: number; z: number }

interface Particle {
  x: number; y: number; vx: number; vy: number;
  returnAmount: number;
  life: number;
  maximum: number;
  radius: number;
  rotation: number;
  rotationSpeed: number;
  curl: number;
  color: string;
  round: boolean;
  isStar: boolean;
  hue: number;
  hueSpan: number;
  hueVelocity: number;
  orbit: Orbit | null;
  history: TrailPoint[];
}

interface Layout { tilt: number; roll: number }

/** CSS hsl() 颜色（注意不是 HSB）。 */
export function hsl(degrees: number, saturation: number, lightness: number): string {
  const hue = (((degrees % 360) + 360) % 360) / 60;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const second = chroma * (1 - Math.abs((hue % 2) - 1));
  let red = 0, green = 0, blue = 0;
  switch (Math.floor(hue)) {
    case 0: red = chroma; green = second; break;
    case 1: red = second; green = chroma; break;
    case 2: green = chroma; blue = second; break;
    case 3: green = second; blue = chroma; break;
    case 4: red = second; blue = chroma; break;
    default: red = chroma; blue = second; break;
  }
  const match = lightness - chroma / 2;
  const to255 = (v: number) => Math.round((v + match) * 255);
  return `rgb(${to255(red)},${to255(green)},${to255(blue)})`;
}

export class BotParticles {
  private headC: number;
  private starD: string;
  private starGold: string;
  private particles: Particle[] = [];
  private spinAngle: number;
  private lastSpinAngle = 0;
  private angularVelocity = 0;
  private trailActive = false;
  private emissionQueue: { at: number; index: number }[] = [];
  private orbitLayouts: Layout[] = [];
  private hue = 0;
  private orbitCount = 4;
  private sizeScale = 1;
  private wideStyle = false;
  private beltRadius: number;
  back: Painted[] = [];
  front: Painted[] = [];

  constructor(headC: number, starPathD: string, starGold: string) {
    this.headC = headC;
    this.starD = starPathD;
    this.starGold = starGold;
    this.spinAngle = random(0, Math.PI * 2);
    this.beltRadius = headC;
  }

  private clear(): void {
    this.particles = [];
  }

  /** 新的旋转挑一组新的轨道面，两次旋转不会像同一个动画。 */
  private resetOrbitStyle(layoutCount = 1): void {
    const roll = random(-0.85, 0.85);
    this.orbitLayouts = Array.from({ length: layoutCount }, (_, index) => ({
      tilt: random(0.16, 0.5),
      roll: roll + (index * Math.PI) / layoutCount + random(-0.12, 0.12),
    }));
    this.orbitCount = layoutCount > 1 ? 3 * layoutCount : Math.round(random(3, 5));
    this.hue = random(0, 360);
  }

  private spawnOrbitParticle(angle: number, direction: number, index: number): void {
    if (this.particles.length > 110) return;
    if (!this.orbitLayouts.length) this.resetOrbitStyle();
    const layout = this.orbitLayouts[index % this.orbitLayouts.length]!;
    const countPerLayout = Math.max(Math.ceil(this.orbitCount / this.orbitLayouts.length) - 1, 1);
    const baseRadius = 116 * (this.beltRadius / this.headC);
    const particle: Particle = {
      x: this.headC, y: this.headC, vx: 0, vy: 0,
      returnAmount: 0, life: 0,
      maximum: 9,
      radius: this.orbitCount <= 3 ? random(8, 10.5)
        : this.orbitCount === 4 ? random(6.6, 8.6) : random(5.6, 7.4),
      rotation: random(0, 360),
      rotationSpeed: random(-240, 240),
      color: COLORS[Math.floor(Math.random() * COLORS.length)]!,
      round: false, isStar: false,
      curl: 0,
      hue: this.hue + (360 * index) / Math.max(this.orbitCount, 1) + random(-14, 14),
      hueSpan: random(45, 95) * (Math.random() < 0.5 ? 1 : -1),
      hueVelocity: random(18, 42) * (Math.random() < 0.5 ? 1 : -1),
      orbit: {
        angle,
        angularVelocity: direction * random(0.5, 1.1),
        tilt: layout.tilt + random(-0.04, 0.04),
        roll: layout.roll + random(-0.05, 0.05),
        radius: baseRadius + Math.floor(index / this.orbitLayouts.length) * (38 / countPerLayout)
          + random(-1.5, 1.5),
        radiusVelocity: random(0, 2.5),
        follow: random(0.74, 0.94),
        carry: 0,
        arc: random(2.2, 3.4),
      },
      history: [],
    };
    this.particles.push(particle);
  }

  /** 彩纸。机器人醒来和换体型时用。 */
  burst(count = 20, force = 1, curl = 0): void {
    if (this.particles.length > 120) return;
    for (let index = 0; index < count; index++) {
      const angle = (index / count) * Math.PI * 2 + random(-0.35, 0.35);
      const distance = random(96, 116) * (this.beltRadius / this.headC);
      const speed = random(170, 360) * force;
      const tangentX = -Math.sin(angle);
      const tangentY = Math.cos(angle);
      const curlVelocity = curl * speed * 0.2;
      const isStar = Math.random() < 0.18;
      this.particles.push({
        x: this.headC + Math.cos(angle) * distance,
        y: this.headC + Math.sin(angle) * distance,
        vx: Math.cos(angle) * speed + tangentX * curlVelocity,
        vy: Math.sin(angle) * speed + tangentY * curlVelocity - random(20, 75),
        returnAmount: 0,
        life: 0,
        maximum: random(0.45, 0.85),
        radius: isStar ? random(4, 7) : random(3.5, 8),
        rotation: random(0, 360),
        rotationSpeed: random(-260, 260),
        curl: curl,
        color: isStar ? this.starGold : COLORS[Math.floor(Math.random() * COLORS.length)]!,
        round: !isStar && Math.random() < 0.3,
        isStar,
        hue: 0, hueSpan: 0, hueVelocity: 0,
        orbit: null,
        history: [],
      });
    }
  }

  private projectOrbit(orbit: Orbit, angle: number): [number, number] {
    const horizontal = orbit.radius * Math.sin(angle);
    const vertical = -orbit.radius * Math.cos(angle) * Math.sin(orbit.tilt);
    const cosine = Math.cos(orbit.roll);
    const sine = Math.sin(orbit.roll);
    return [this.headC + horizontal * cosine - vertical * sine,
      this.headC + horizontal * sine + vertical * cosine];
  }

  private orbitDepth(orbit: Orbit, angle: number): number {
    return Math.cos(angle) * Math.cos(orbit.tilt);
  }

  /** 锥形丝带，按深度拆成头前/头后两段。 */
  private trailPaths(points: TrailPoint[], width: number): { front: string | null; back: string | null } {
    if (points.length < 2) return { front: null, back: null };
    let length = 0;
    for (let i = 1; i < points.length; i++) {
      length += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
    }
    if (length < 2) return { front: null, back: null };
    const actualWidth = Math.min(width, 0.34 * length);
    const normals: [number, number][] = [];
    for (let i = 0; i < points.length; i++) {
      const prev = points[i > 0 ? i - 1 : 0]!;
      const next = points[i < points.length - 1 ? i + 1 : points.length - 1]!;
      let dx = next.x - prev.x;
      let dy = next.y - prev.y;
      const magnitude = Math.hypot(dx, dy) || 1;
      dx /= magnitude;
      dy /= magnitude;
      // 丝带尾部的宽度是头部的一半。
      const halfWidth = (actualWidth * (0.5 + (i / (points.length - 1)) * 0.5)) / 2;
      normals.push([-dy * halfWidth, dx * halfWidth]);
    }
    const f = (v: number) => v.toFixed(1);

    function cap(pts: TrailPoint[], norms: [number, number][], index: number): string {
      // 端帽：半圆弧，sweep 0（负方向、走短的那条，与上游一致）。
      const n = norms[index]!;
      const r = Math.max(Math.hypot(n[0], n[1]), 0.2);
      const cx = pts[index]!.x;
      const cy = pts[index]!.y;
      void f;
      return `A${r.toFixed(1)},${r.toFixed(1)} 0 0 0 ${f(cx - n[0])},${f(cy - n[1])}`;
    }

    function segment(pts: TrailPoint[], norms: [number, number][], start: number, end: number): string {
      let d = "";
      for (let i = start; i <= end; i++) {
        const x = pts[i]!.x + norms[i]![0];
        const y = pts[i]!.y + norms[i]![1];
        d += (i === start ? `M${f(x)},${f(y)}` : `L${f(x)},${f(y)}`);
      }
      if (end === pts.length - 1) d += cap(pts, norms, end);
      for (let i = end; i >= start; i--) {
        d += `L${f(pts[i]!.x - norms[i]![0])},${f(pts[i]!.y - norms[i]![1])}`;
      }
      if (start === 0) d += cap(pts, norms, start);
      return d + "Z";
    }

    const frontParts: string[] = [];
    const backParts: string[] = [];
    let cursor = 0;
    while (cursor < points.length) {
      const isFront = points[cursor]!.z >= 0;
      let end = cursor;
      while (end + 1 < points.length && (points[end + 1]!.z >= 0) === isFront) end += 1;
      const segmentStart = Math.max(cursor - 1, 0);
      const segmentEnd = Math.min(end + 1, points.length - 1);
      if (segmentEnd > segmentStart) {
        const piece = segment(points, normals, segmentStart, segmentEnd);
        if (isFront) frontParts.push(piece);
        else backParts.push(piece);
      }
      cursor = end + 1;
    }
    return { front: frontParts.join("") || null, back: backParts.join("") || null };
  }

  update(now: number, delta: number, newSpinAngle: number, sizeScale: number,
    wideStyle: boolean, enabled: boolean, beltRadius: number, ribbonsEnabled = true): void {
    this.sizeScale = sizeScale;
    this.spinAngle = newSpinAngle;
    this.wideStyle = wideStyle;
    this.beltRadius = beltRadius;
    this.back = [];
    this.front = [];
    if (!enabled) {
      if (this.particles.length) this.clear();
      this.emissionQueue = [];
      this.trailActive = false;
      this.angularVelocity = 0;
      this.lastSpinAngle = this.spinAngle;
      return;
    }
    // 小画布上不渲染轨道丝带（每帧多条 48 点多边形路径 + 渐变更新，
    // 是 20px 环内最主要的卡顿来源）；彩纸爆裂保留。
    if (!ribbonsEnabled && this.particles.some(p => p.orbit)) {
      this.particles = this.particles.filter(p => !p.orbit);
      this.emissionQueue = [];
    }

    let difference = this.spinAngle - this.lastSpinAngle;
    if (!Number.isFinite(difference) || Math.abs(difference) > 1.2) difference = 0;
    this.lastSpinAngle = this.spinAngle;
    const wasSpinning = Math.abs(this.angularVelocity) >= 0.9;
    this.angularVelocity = delta > 0 ? difference / delta : 0;
    const isSpinning = Math.abs(this.angularVelocity) >= 0.9;
    if (!wasSpinning && isSpinning) {
      this.resetOrbitStyle(this.wideStyle ? 3 : 1);
      this.trailActive = false;
    }
    if (wasSpinning && !isSpinning) this.emissionQueue = [];
    if (!ribbonsEnabled) {
      this.trailActive = false;
    } else if (!this.trailActive && Math.abs(this.angularVelocity) >= 5) {
      this.trailActive = true;
      this.emissionQueue = Array.from({ length: this.orbitCount }, (_, index) => ({
        at: now + index * random(55, 105), index,
      }));
    }
    while (this.emissionQueue.length && now >= this.emissionQueue[0]!.at) {
      const first = this.emissionQueue.shift()!;
      this.spawnOrbitParticle(this.spinAngle - random(0, 0.18),
        this.angularVelocity < 0 ? -1 : 1, first.index);
    }

    const alive: Particle[] = [];
    for (const particle of this.particles) {
      particle.life += delta;
      const progress = clamp(particle.life / particle.maximum, 0, 1);
      if (particle.orbit) {
        const shouldReturn = !isSpinning || progress > 0.55;
        particle.returnAmount = clamp(
          particle.returnAmount + (shouldReturn ? delta / 0.5 : -delta / 0.35), 0, 1);
        if (particle.returnAmount >= 1) continue;
      } else if (particle.life >= particle.maximum) {
        continue;
      }

      const opacity = particle.orbit
        ? Math.min(1, particle.life / 0.26)
        : (progress < 0.1 ? progress / 0.1 : Math.pow(1 - (progress - 0.1) / 0.9, 1.7));

      if (particle.orbit) {
        const orbit = particle.orbit;
        if (isSpinning) {
          orbit.carry = this.angularVelocity * orbit.follow;
          orbit.angle += this.angularVelocity * delta * orbit.follow + orbit.angularVelocity * delta;
        } else {
          orbit.angle += (orbit.carry + orbit.angularVelocity) * delta;
          orbit.carry *= Math.exp(-2.6 * delta);
          orbit.angularVelocity *= Math.exp(-2.6 * delta);
        }
        orbit.radius += orbit.radiusVelocity * delta;
        const position = this.projectOrbit(orbit, orbit.angle);
        particle.x = position[0];
        particle.y = position[1];
        const depth = this.orbitDepth(orbit, orbit.angle);
        const depthScale = 0.72 + 0.28 * clamp(depth, 0, 1);
        const enter = Math.min(particle.life / 0.34, 1);
        const smoothEnter = enter * enter * (3 - 2 * enter);
        const width = Math.max(particle.radius * depthScale * 1.7 * this.sizeScale * smoothEnter
          * (1 - 0.72 * particle.returnAmount * particle.returnAmount), 0.5);

        // 细分步长，快速旋转也能画出曲线。
        const previousAngle = particle.history.length ? particle.history[particle.history.length - 1]!.angle : orbit.angle;
        const angleChange = orbit.angle - previousAngle;
        const subdivisions = Math.min(Math.ceil(Math.abs(angleChange) / 0.09), 24);
        for (let i = 1; i <= subdivisions; i++) {
          const angle = previousAngle + (angleChange * i) / subdivisions;
          const point = this.projectOrbit(orbit, angle);
          particle.history.push({ x: point[0], y: point[1], angle, z: this.orbitDepth(orbit, angle) });
        }
        if (!particle.history.length) {
          particle.history.push({ x: particle.x, y: particle.y, angle: orbit.angle, z: depth });
        }
        const arc = orbit.arc * (1 - particle.returnAmount * particle.returnAmount * (3 - 2 * particle.returnAmount));
        while (particle.history.length > 2
          && Math.abs(orbit.angle - particle.history[0]!.angle) > arc) {
          particle.history.shift();
        }
        const excess = Math.abs(orbit.angle - particle.history[0]!.angle) - arc;
        if (particle.history.length >= 2 && excess > 0) {
          const direction = orbit.angle - particle.history[0]!.angle < 0 ? -1 : 1;
          const angle = particle.history[0]!.angle + direction * excess;
          const point = this.projectOrbit(orbit, angle);
          particle.history[0] = { x: point[0], y: point[1], angle, z: this.orbitDepth(orbit, angle) };
        }
        if (particle.history.length > 48) {
          particle.history.splice(0, particle.history.length - 48);
        }
        if (particle.history.length >= 2) {
          const paths = this.trailPaths(particle.history, width);
          const travelling = particle.hue + particle.hueVelocity * particle.life;
          const stops: [string, number][] = Array.from({ length: 5 }, (_, index) => {
            const position = index / 4;
            const value = travelling + position * particle.hueSpan;
            return [hsl(value, 0.56, 0.56 + 0.11 * position), position];
          });
          const from = particle.history[0]!;
          const to = particle.history[particle.history.length - 1]!;
          const gradient = { stops, x1: from.x, y1: from.y, x2: to.x, y2: to.y };
          if (paths.back) {
            this.back.push({ d: paths.back, opacity, fill: "gradient", gradient });
          }
          if (paths.front) {
            this.front.push({ d: paths.front, opacity, fill: "gradient", gradient });
          }
        }
        alive.push(particle);
        continue;
      }

      if (particle.curl !== 0) {
        const cosine = Math.cos(particle.curl * delta);
        const sine = Math.sin(particle.curl * delta);
        const vx = particle.vx * cosine - particle.vy * sine;
        const vy = particle.vx * sine + particle.vy * cosine;
        particle.vx = vx;
        particle.vy = vy;
      }
      particle.x += particle.vx * delta;
      particle.y += particle.vy * delta;
      const drag = Math.pow(0.94, 60 * delta);
      particle.vx *= drag;
      particle.vy = particle.vy * drag + 40 * delta;
      const size = Math.max(particle.radius * (1 - 0.4 * progress), 0.5);

      if (particle.isStar) {
        particle.rotation += particle.rotationSpeed * delta;
        this.back.push({
          d: this.starD,
          transform: `translate(${particle.x.toFixed(1)},${particle.y.toFixed(1)}) rotate(${particle.rotation.toFixed(1)}) scale(${size.toFixed(2)})`,
          opacity, fill: particle.color,
        });
      } else if (particle.round) {
        this.back.push({
          d: `M${(particle.x - size).toFixed(1)},${particle.y.toFixed(1)}`
            + `A${size.toFixed(1)},${size.toFixed(1)} 0 1 1 ${(particle.x + size).toFixed(1)},${particle.y.toFixed(1)}`
            + `A${size.toFixed(1)},${size.toFixed(1)} 0 1 1 ${(particle.x - size).toFixed(1)},${particle.y.toFixed(1)}Z`,
          opacity, fill: particle.color,
        });
      } else {
        // 条纹：跑得越快，画得越长。
        const width = Math.max(2 * size, Math.min(0.05 * Math.hypot(particle.vx, particle.vy), 30));
        const height = 1.5 * size;
        const angle = Math.atan2(particle.vy, particle.vx);
        this.back.push({
          d: `M${(-width / 2).toFixed(1)},${(-height / 2).toFixed(1)}`
            + `L${(width / 2).toFixed(1)},${(-height / 2).toFixed(1)}`
            + `L${(width / 2).toFixed(1)},${(height / 2).toFixed(1)}`
            + `L${(-width / 2).toFixed(1)},${(height / 2).toFixed(1)}Z`,
          transform: `translate(${particle.x.toFixed(1)},${particle.y.toFixed(1)}) rotate(${((angle * 180) / Math.PI).toFixed(1)})`,
          opacity, fill: particle.color,
        });
      }
      alive.push(particle);
    }
    this.particles = alive;
  }
}
