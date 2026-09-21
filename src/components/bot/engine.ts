/**
 * 动画引擎（上游 BotMarkEngine.swift ← grok-bot-engine.js /
 * physics-system.js / state-behavior-system.js）。
 *
 * 同样的弹簧、同样的频率、同样的每状态运动公式、同样的眨眼队列与表情池、
 * 同样的手势。时间用毫秒（上游公式按毫秒书写），delta 用秒。
 * 每帧输出 SVG 可直接消费的图元；渲染层只做属性写入，不做布局计算。
 */
import { BotSpring, FIXED_STEP, clamp, cubicInOut, mix, random, smoothstep } from "./math";
import {
  centroid, lerpRing, pathOpsD, reflected, ringOutlineD, ringPathD, shapeSpanAt,
  spanAt, turnedShapeRing, type FaceTransform, type Ring,
} from "./geometry";
import { shapeOf, stateOf, type BotData, type BotMarkShape } from "./data";
import type { Programme } from "./mood";
import { eventDuration, eventState, type Mood } from "./mood";
import {
  MORPH_SIZES, MORPH_VIEW_BOXES, morphTargetRing, renderMorphEffects, updateMorph,
  type MorphHost,
} from "./morphs";
import { BotParticles } from "./particles";
import type { BotFrame, EyeFrame, MorphShape } from "./types";

/** 每帧引擎读到的配置：状态自己的表，加上节目的缩放。 */
interface Config {
  shape: string;
  expressionPool: number[];
  expressionCadence: [number, number];
  blinkCadence: [number, number] | null;
  morph: string | null;
  tempo: number;
  motionScale: number;
  gazeScale: number;
  eyeScale: number;
  gazeBias: number;
  flipX: boolean;
  rotationScale: number;
  squashScale: number;
  particlesEnabled: boolean;
  viewWidth: number;
}

const BADGE_COLOR = "#1d9bf0";

interface Gesture {
  kind: string;
  startedAt: number;
  direction: number;
  turns: number;
}

interface GesturePose {
  turn: number;
  rotation: number;
  x: number;
  y: number;
  bounceY: number;
  gazeX: number;
  gazeY: number;
  eyeOpen: number | null;
  eyeScale: number | null;
}

const newGesturePose = (): GesturePose => ({
  turn: 0, rotation: 0, x: 0, y: 0, bounceY: 0, gazeX: 0, gazeY: 0, eyeOpen: null, eyeScale: null,
});

interface ResolvedShape {
  shape: BotMarkShape;
  identifier: string;
  transitioning: boolean;
  ring: Ring;
  face: FaceTransform;
  tiltScale: number;
  beltRadius: number;
}

/** 上游 viewBox 中心（`-15 -15 259 259`）。 */
export const VIEW_BOX_CENTRE = 114.5;

export class BotMarkEngine implements MorphHost {
  private data: BotData;
  readonly headC: number;

  // MARK: 状态
  state = "idle";
  stateStartedAt = 0;
  private clockTime = 0;
  private lastTimestamp: number | null = null;
  private delta = 1 / 60;

  // MARK: 表情
  private expressionFrom: Ring[];
  private expressionTo: Ring[];
  private expressionIndex = 0;
  private expressionSpring = new BotSpring(1);
  private expressionFrequency = 7;
  private expressionCursor = 0;
  private expressionNext = 0;

  // MARK: 弹簧
  private rotation = new BotSpring(0);
  /** 朝向：+1 正着，-1 转过去。用弹簧而不是布尔——拖到另一侧时眼睛划过去。 */
  private facing: BotSpring | null = null;
  private headX = new BotSpring(0);
  private headY = new BotSpring(0);
  private scaleY = new BotSpring(1);
  private eyeOpen = new BotSpring(1);
  private eyeScaleS = new BotSpring(1);
  private aimX = new BotSpring(0);
  private aimY = new BotSpring(0);
  morph = new BotSpring(0);
  morphBlend = new BotSpring(1);
  private shapeBlend = new BotSpring(1);
  turn = new BotSpring(0);
  private notify = new BotSpring(0);
  private humming = new BotSpring(0);
  private spinSpring: BotSpring | null = null;

  // MARK: 计时器与一次性动作
  private blinkNext = 0;
  private gazeNext = 0;
  private blinkQueue: { at: number; value: number }[] = [];
  private blinkTarget: number | null = null;
  private wakeBurst = false;
  private drowsyStartedAt = 0;
  private listenNodUntil = 0;
  private listenNodNext = 0;
  private impulseNext = 0;
  private impulseUntil = 0;
  private behaviorNext = 0;
  private winkAt = -Infinity;
  private winkEye = 0;
  private winkNext = 0;
  private dragCycle = -1;
  private notifyTriggered = false;
  private spinAngle = 0;

  private gesture: Gesture | null = null;
  private bounceStartedAt = -1;
  private ambientNext = 0;
  private celebrateCycle = -1;
  celebrateWildActive = false;
  turnDirection = 1;

  private directTurn = 0;
  private directRotation = 0;
  private directX = 0;
  private directY = 0;
  private directGazeX = 0;
  private directGazeY = 0;

  // MARK: morph（morphs.ts 读写）
  requestedMorphEffect: string | null = null;
  morphEffect: string | null = null;
  previousMorphEffect: string | null = null;
  morphVisible = false;
  morphStartedAt = 0;
  morphShotStartedAt = 0;
  morphRestStartedAt = 0;
  oneShotResting = false;
  receiveCycle = -1;
  receiveAngle = -0.7;
  writingTrail: [number, number][] = [];
  pencilRing: Ring;
  circleRing: Ring;
  pencilGlyphD: string;
  alertGlyphD: string;

  readonly particles: BotParticles;

  // MARK: 节目单
  private playlist: string[] = [];
  private playlistCursor = 0;
  private playlistNext = 0;
  private playedMood: Mood | null = null;
  private playedEventSeq: number | null = null;
  private eventUntil = 0;
  private particleSpinAngle = 0;

  // MARK: 体型混合
  private shapeId = "blob";
  private shapeFromRing: Ring;
  private shapeFromFace: FaceTransform;
  private shapeFromTiltScale: number;
  private shapeFromBeltRadius: number;
  private shapeChangeCycle = 0;
  private shapeChangeWide = false;
  private currentBeltRadius: number;

  // 静止头部的缓存：形状未混合、未转身、未 morph 时直接用原始贝塞尔。
  private staticHeadCache = new Map<string, string>();

  /** 眼睛当前开合度。 */
  get eyelid(): number { return this.eyeOpen.value; }

  /** 是否有眨眼在途。定格帧要等的是它，不是 eyelid——见上游注释。 */
  get isBlinking(): boolean { return this.blinkQueue.length > 0 || this.blinkTarget != null; }

  constructor(data: BotData) {
    this.data = data;
    this.headC = data.headC;
    const blob = shapeOf(data, "blob");
    const centre = data.headC;
    const teardrop = shapeOf(data, "teardrop").ring;
    const half = teardrop.length / 2;
    // 上游把环移半圈并旋转同样的角度，让尖端落到下面。
    this.pencilRing = Array.from({ length: teardrop.length }, (_, i) => {
      const p = teardrop[((i - half) % teardrop.length + teardrop.length) % teardrop.length]!;
      return [centre - (p[0] - centre), centre - (p[1] - centre)] as [number, number];
    });
    this.pencilGlyphD = roundedRectD(centre - 15, centre - 44, 30, 88, 15);
    this.alertGlyphD = alertGlyphD(centre);
    this.circleRing = data.circleRing;
    this.expressionFrom = data.expressions[0]!;
    this.expressionTo = data.expressions[0]!;
    this.shapeFromRing = blob.ring;
    this.shapeFromFace = blob.face;
    this.shapeFromTiltScale = blob.tiltScale;
    this.shapeFromBeltRadius = blob.beltRadius;
    this.currentBeltRadius = blob.beltRadius;
    this.shapeChangeCycle = Math.floor(random(0, 5));
    this.winkNext = random(3000, 8000);
    this.ambientNext = random(2500, 5000);
    this.particles = new BotParticles(centre, pathOpsD(data.starPath), data.starGold);
    this.setStateInternal("idle", {
      shape: "blob", expressionPool: [0, 8], expressionCadence: [9000, 16000],
      blinkCadence: [6000, 14000], morph: null, tempo: 1, motionScale: 1, gazeScale: 1,
      eyeScale: 1, gazeBias: 0, flipX: false, rotationScale: 1, squashScale: 1,
      particlesEnabled: true, viewWidth: 96,
    });
  }

  // MARK: - 帧

  /** 推进到墙钟时间戳（秒），返回要画的帧。 */
  advance(timestamp: number, programme: Programme): BotFrame {
    const previous = this.lastTimestamp ?? timestamp;
    this.lastTimestamp = timestamp;
    // 上游把一帧钳到 100ms：离开很久的标签页醒来时从原地继续。
    this.delta = clamp(timestamp - previous, 0, 0.1);
    this.clockTime += this.delta * 1000;

    const config = this.step(programme);
    this.aimFacing(programme.flipX ? -1 : 1);
    updateMorph(this, this.clockTime, config.morph);
    this.updateStateTargets(this.clockTime, config);
    this.stepPhysics(this.delta);
    const frame = this.render(this.clockTime, config);

    if (this.spinSpring && Math.abs(this.spinSpring.target - this.spinSpring.value) < 0.004
      && Math.abs(this.spinSpring.velocity) < 0.015) {
      this.spinSpring = null;
      this.shapeChangeWide = false;
    }

    if (this.spinSpring) {
      this.particleSpinAngle = this.spinSpring.value;
    } else if (Math.abs(this.directTurn) > 0.001) {
      this.particleSpinAngle = this.directTurn;
    } else if (this.state === "humming" || this.state === "loading") {
      this.particleSpinAngle = this.spinAngle;
    }
    const sizeScale = clamp(Math.pow(340 / Math.max(programme.viewWidth, 1), 0.7), 1, 2.6);
    this.particles.update(this.clockTime, this.delta, this.particleSpinAngle, sizeScale,
      this.state === "humming" || this.celebrateWildActive || this.shapeChangeWide,
      config.particlesEnabled, this.currentBeltRadius,
      // 环内小尺寸（≤36px）关掉轨道丝带：SVG 逐帧拼长路径的代价会把
      // 整条悬浮栏的点击拖死；彩纸爆裂与大画布丝带保留。
      programme.viewWidth > 36);
    frame.back = this.particles.back;
    frame.front = this.particles.front;
    return frame;
  }

  /** 櫪出本帧该播的状态，返回其配置。 */
  private step(programme: Programme): Config {
    const event = programme.event;
    if (event && event.seq !== this.playedEventSeq) {
      this.playedEventSeq = event.seq;
      this.eventUntil = this.clockTime + eventDuration(event.kind);
      this.playlist = [];
      const config = this.configuration(programme, eventState(event.kind));
      this.setStateInternal(eventState(event.kind), config);
      return config;
    }
    if (!event) this.playedEventSeq = null;
    if (this.clockTime < this.eventUntil) {
      return this.configuration(programme, this.state);
    }

    const due = this.clockTime >= this.playlistNext;
    if (this.playlist !== programme.states || programme.mood !== this.playedMood) {
      this.playlist = programme.states;
      this.playedMood = programme.mood;
      this.playlistCursor = programme.states.length > 1
        ? Math.floor(random(0, programme.states.length))
        : 0;
    } else if (due && programme.states.length > 1) {
      // 每次都换个不同的：两态歌单交替而不是有时重复。
      const stepSize = 1 + Math.floor(random(0, programme.states.length - 1));
      this.playlistCursor = (this.playlistCursor + stepSize) % programme.states.length;
    } else if (!due) {
      return this.configuration(programme, this.state);
    }

    this.playlistNext = this.clockTime + random(programme.hold[0], programme.hold[1]);
    const next = programme.states[Math.min(this.playlistCursor, programme.states.length - 1)]!;
    const config = this.configuration(programme, next);
    this.setStateInternal(next, config);
    return config;
  }

  private configuration(programme: Programme, stateId: string): Config {
    const info = stateOf(this.data, stateId);
    return {
      shape: programme.shape,
      expressionPool: info.expressionPool,
      expressionCadence: info.expressionCadence,
      blinkCadence: info.blinkCadence,
      morph: info.morph,
      tempo: programme.tempo,
      motionScale: programme.motionScale,
      gazeScale: programme.gazeScale,
      eyeScale: programme.eyeScale,
      gazeBias: programme.gazeBias,
      flipX: programme.flipX,
      rotationScale: programme.rotationScale,
      squashScale: programme.squashScale,
      particlesEnabled: programme.particlesEnabled,
      viewWidth: programme.viewWidth,
    };
  }

  private setStateInternal(identifier: string, config: Config): void {
    if (identifier === this.state) return;
    const now = this.clockTime;
    this.state = identifier;
    this.stateStartedAt = now;
    this.expressionCursor = 0;
    this.expressionNext = now + random(config.expressionCadence[0], config.expressionCadence[1]) * config.tempo;
    this.blinkNext = now + random(1500, 7000);
    this.gazeNext = now + random(500, 1400);
    this.listenNodNext = now + random(1200, 2200);
    this.impulseNext = now + random(500, 1200);
    this.behaviorNext = now + (identifier === "excited" ? random(400, 1100)
      : identifier === "searching" ? random(800, 1600)
        : identifier === "working" ? random(1200, 2400)
          : random(6000, 10000));
    this.winkNext = now + random(3000, 8000);
    this.blinkQueue = [];
    this.blinkTarget = null;
    this.wakeBurst = false;
    this.drowsyStartedAt = 0;
    this.dragCycle = -1;
    this.notifyTriggered = false;
    this.celebrateWildActive = false;
    if (identifier === "celebrate") {
      this.turnDirection = Math.random() < 0.5 ? 1 : -1;
      this.celebrateCycle = -1;
    }
    const firstExpression = config.expressionPool[0] ?? 0;
    if (identifier !== "waking" && identifier !== "sleeping") {
      if (identifier !== "drowsy") this.scheduleBlink(now);
      this.setExpression(firstExpression, identifier === "excited" ? 10 : 8);
    }
  }

  private setExpression(index: number, frequency = 7): void {
    if (index === this.expressionIndex && this.expressionSpring.target === 1) return;
    const amount = clamp(this.expressionSpring.value, 0, 1);
    this.expressionFrom = [
      lerpRing(this.expressionFrom[0]!, this.expressionTo[0]!, amount),
      lerpRing(this.expressionFrom[1]!, this.expressionTo[1]!, amount),
    ];
    this.expressionTo = this.data.expressions[index] ?? this.data.expressions[0]!;
    this.expressionIndex = index;
    this.expressionSpring.value = 0;
    this.expressionSpring.velocity = 0;
    this.expressionSpring.target = 1;
    this.expressionFrequency = frequency;
  }

  /** 闭、合、过冲张开、回落——七分之一是双眨。 */
  private scheduleBlink(now: number): void {
    this.blinkTarget = this.eyeOpen.target;
    this.blinkQueue.push(
      { at: now, value: 0.05 }, { at: now + 70, value: 0.05 },
      { at: now + 150, value: 1.08 }, { at: now + 300, value: 1 },
    );
    if (Math.random() < 0.14) {
      this.blinkQueue.push({ at: now + 370, value: 0.05 }, { at: now + 480, value: 1 });
    }
  }

  private aimFacing(target: number): void {
    if (!this.facing) this.facing = new BotSpring(target);
    else this.facing.target = target;
  }

  private get facingValue(): number { return this.facing?.value ?? 1; }

  private stepPhysics(delta: number): void {
    const steps = Math.max(1, Math.ceil(delta / FIXED_STEP));
    const step = delta / steps;
    for (let i = 0; i < steps; i++) {
      this.expressionSpring.step(this.expressionFrequency, 1, step);
      this.rotation.step(5, 0.9, step);
      this.facing?.step(9, 0.85, step);
      this.headX.step(3.5, 1, step);
      this.headY.step(4, 1, step);
      this.scaleY.step(10, 0.8, step);
      this.eyeOpen.step(26, 1, step);
      this.eyeScaleS.step(9, 0.85, step);
      this.aimX.step(13, 1, step);
      this.aimY.step(13, 1, step);
      this.morph.step(14, 1, step);
      this.morphBlend.step(11, 1, step);
      this.shapeBlend.step(10, 1, step);
      this.turn.step(14, 1, step);
      this.notify.step(9, 0.55, step);
      this.humming.step(6, 1, step);
      if (this.spinSpring) this.spinSpring.step(6.2, 1, step);
    }
  }

  // MARK: - 每状态运动

  private updateStateTargets(now: number, config: Config): void {
    const elapsed = (now - this.stateStartedAt) / 1000;
    const runtime = now / 1000;
    const motion = config.motionScale;
    let eyeOpenTarget = 1;
    let eyeScaleTarget = 1;
    let rotationTarget = 0;
    let x = 0;
    let y = 0;
    let scaleYTarget = 1;
    let gesture = this.updateGestures(now);

    switch (this.state) {
      case "sleeping": {
        if (config.expressionPool.includes(this.expressionIndex)) {
          eyeOpenTarget = this.expressionSpring.value > 0.85 ? 1 : 0.08;
        } else if (elapsed < 1.2) {
          eyeOpenTarget = Math.max(0.08, 1 - Math.min(1, elapsed) * (1 + 0.15 * Math.sin(6.5 * elapsed)));
        } else {
          eyeOpenTarget = 0.08;
          if (this.eyeOpen.value < 0.18) this.setExpression(13, 11);
        }
        const settle = Math.min(elapsed / 2, 1);
        const dip = Math.sin(clamp(elapsed / 0.5, 0, 1) * Math.PI);
        rotationTarget = 4 * settle + 2 * Math.sin(0.25 * runtime);
        x = -2 * settle;
        y = 8 * settle + 3 * Math.sin(0.55 * runtime) - 5 * dip;
        scaleYTarget = 1 + 0.016 * Math.sin(0.55 * runtime) + 0.05 * dip;
        break;
      }
      case "waking": {
        if (elapsed < 0.5) {
          eyeOpenTarget = 0.07;
          this.setExpression(3, 12);
          y = 6;
        } else if (elapsed < 1.2) {
          eyeOpenTarget = 1;
          eyeScaleTarget = 1.12;
          y = -5;
          scaleYTarget = 1.04;
          if (!this.wakeBurst) {
            this.particles.burst(Math.round(random(9, 13)), 0.8);
            this.wakeBurst = true;
          }
        } else if (elapsed < 2.2) {
          if (!this.blinkQueue.length && elapsed < 1.4) this.scheduleBlink(now);
          this.setExpression(0);
        } else {
          const settle = Math.min((elapsed - 2.2) / 0.8, 1);
          rotationTarget = 6 * Math.sin(settle * Math.PI * 3) * (1 - settle);
          y = 2 * Math.sin(0.9 * runtime);
        }
        break;
      }
      case "idle":
        rotationTarget = 1.5 * Math.sin(0.5 * runtime) + 0.6 * Math.sin(0.17 * runtime);
        x = Math.sin(0.27 * runtime);
        y = 1.2 * Math.sin(0.85 * runtime);
        scaleYTarget = 1 + 0.007 * Math.sin(0.85 * runtime);
        break;
      case "listening": {
        rotationTarget = 8 + 1.5 * Math.sin(0.5 * runtime);
        x = 2;
        y = -2 + 0.8 * Math.sin(0.8 * runtime);
        scaleYTarget = 1.015;
        if (now >= this.listenNodNext) {
          this.listenNodUntil = now + 380;
          this.listenNodNext = now + random(1800, 3200);
        }
        if (now < this.listenNodUntil) {
          const phase = 1 - (this.listenNodUntil - now) / 380;
          y += 4.5 * Math.sin(phase * Math.PI);
          rotationTarget += 2 * Math.sin(phase * Math.PI);
        }
        break;
      }
      case "thinking":
        rotationTarget = -9 + 5 * Math.sin(0.35 * runtime);
        x = 5 * Math.sin(0.3 * runtime);
        y = 2.5 * Math.sin(0.6 * runtime);
        break;
      case "searching": {
        const wave = Math.sin(1.3 * runtime);
        rotationTarget = 13 * wave;
        x = 7 * wave;
        y = 3 * Math.sin(1.7 * runtime);
        break;
      }
      case "working": {
        const wave = Math.sin(runtime * Math.PI * 3.2);
        rotationTarget = 4 + 2.5 * wave;
        x = 3;
        y = 1.5 + 3 * Math.max(0, wave);
        scaleYTarget = 1 - 0.02 * Math.max(0, wave);
        break;
      }
      case "excited": {
        const phase = (2.2 * runtime) % 1;
        y = -10 * Math.sin(phase * Math.PI) + 2;
        scaleYTarget = phase < 0.1 ? 0.92 : phase < 0.3 ? 1.05 : 1;
        x = 4 * Math.sin(1.1 * runtime);
        eyeScaleTarget = 1.06;
        rotationTarget = 7 * Math.sin(runtime * Math.PI * 2.2);
        break;
      }
      case "surprised": {
        const settle = Math.min(elapsed / 1.2, 1);
        x = -4 * (1 - settle);
        y = -8 * (1 - settle);
        scaleYTarget = elapsed < 0.2 ? 1.08 : 1;
        eyeScaleTarget = 1.15 - 0.08 * settle;
        rotationTarget = 1.5 * Math.sin(11 * runtime) * (1 - settle);
        break;
      }
      case "suspicious":
        rotationTarget = -6 + 3 * Math.sin(0.3 * runtime);
        x = -4 * Math.sin(0.25 * runtime);
        y = 1 + 1.2 * Math.sin(0.45 * runtime);
        eyeOpenTarget = 0.85;
        if (now >= this.impulseNext) {
          this.rotation.velocity += (30 * Math.PI) / 180;
          this.impulseNext = now + random(4000, 7000);
        }
        break;
      case "angry": {
        if (now >= this.impulseNext) {
          this.impulseUntil = now + 420;
          this.headY.velocity += 70;
          this.impulseNext = now + random(1800, 3200);
        }
        rotationTarget = now < this.impulseUntil ? 4.5 * Math.sin(0.05 * now) : 0;
        y = 3.5;
        scaleYTarget = 0.975;
        break;
      }
      case "drowsy": {
        rotationTarget = 2.5 * Math.sin(0.32 * runtime);
        x = 1.5 * Math.sin(0.2 * runtime);
        y = 6 + 2.2 * Math.sin(0.36 * runtime);
        scaleYTarget = 1 + 0.022 * Math.sin(0.36 * runtime);
        eyeOpenTarget = 0.34 + 0.07 * Math.sin(0.8 * runtime);
        if (now >= this.listenNodNext && this.drowsyStartedAt === 0) this.drowsyStartedAt = now;
        if (this.drowsyStartedAt !== 0) {
          const phase = (now - this.drowsyStartedAt) / 1000;
          if (phase < 1.7) {
            const progress = phase / 1.7;
            const squared = progress * progress;
            y = 6 + 19 * squared + 2.2 * Math.sin(progress * Math.PI * 2.5) * (1 - progress);
            rotationTarget = 10 * squared;
            eyeOpenTarget = 0.34 - squared * 0.3;
            scaleYTarget = 1 - 0.045 * squared;
          } else if (phase < 2) {
            const rebound = Math.sin(((phase - 1.7) / 0.3) * Math.PI);
            y = 25 - 7 * rebound;
            rotationTarget = 10 - 4 * rebound;
            eyeOpenTarget = 0.04 + 0.42 * rebound;
          } else if (phase < 3.5) {
            const progress = (phase - 2) / 1.5;
            const recovery = 1 - Math.pow(1 - progress, 2.2);
            y = 25 - 19 * recovery;
            rotationTarget = 10 * (1 - recovery);
            eyeOpenTarget = 0.46 - 0.12 * recovery;
            if (progress > 0.32 && progress < 0.46) eyeOpenTarget = 0.05;
          } else {
            this.drowsyStartedAt = 0;
            this.listenNodNext = now + random(1500, 3500);
          }
        }
        break;
      }
      case "happy": {
        const wave = Math.sin(2.4 * runtime);
        rotationTarget = 3 * Math.sin(1.2 * runtime);
        x = 2.5 * Math.sin(1.1 * runtime);
        y = -3 * Math.abs(wave);
        scaleYTarget = 1 + 0.02 * wave;
        eyeScaleTarget = 1.05;
        break;
      }
      case "curious": {
        rotationTarget = 10 + 6 * Math.sin(0.7 * runtime);
        x = 5 * Math.sin(0.6 * runtime);
        y = -2 + 1.5 * Math.sin(0.9 * runtime);
        scaleYTarget = 1.01;
        eyeScaleTarget = 1.08;
        if (now >= this.listenNodNext) {
          this.listenNodUntil = now + 440;
          this.listenNodNext = now + random(1600, 2800);
        }
        if (now < this.listenNodUntil) {
          const phase = 1 - (this.listenNodUntil - now) / 440;
          x += 8 * Math.sin(phase * Math.PI);
          rotationTarget += 5 * Math.sin(phase * Math.PI);
        }
        break;
      }
      case "confused": {
        const wave = Math.sin(0.8 * runtime);
        rotationTarget = 12 * wave;
        x = 3 * wave;
        y = 2 * Math.sin(0.5 * runtime);
        eyeOpenTarget = 0.9;
        if (now >= this.impulseNext) {
          this.rotation.velocity += (22 * Math.PI) / 180;
          this.impulseNext = now + random(2600, 4200);
        }
        break;
      }
      case "bored":
        rotationTarget = -3 + 4 * Math.sin(0.25 * runtime);
        x = 4 * Math.sin(0.2 * runtime);
        y = 5 + 1.5 * Math.sin(0.35 * runtime);
        scaleYTarget = 0.99;
        eyeOpenTarget = 0.6;
        eyeScaleTarget = 0.98;
        if (now >= this.impulseNext) {
          this.impulseUntil = now + 600;
          this.impulseNext = now + random(4000, 7000);
        }
        if (now < this.impulseUntil) {
          const phase = 1 - (this.impulseUntil - now) / 600;
          scaleYTarget = 1 + 0.05 * Math.sin(phase * Math.PI);
          y += 3 * Math.sin(phase * Math.PI);
        }
        break;
      case "proud":
        rotationTarget = 2.5 * Math.sin(0.4 * runtime);
        x = 2 * Math.sin(0.35 * runtime);
        y = -4 + Math.sin(0.6 * runtime);
        scaleYTarget = 1.03;
        eyeScaleTarget = 1.02;
        eyeOpenTarget = 0.9;
        break;
      case "shy":
        rotationTarget = -8 + 3 * Math.sin(0.5 * runtime);
        x = -3 + 2 * Math.sin(0.4 * runtime);
        y = 3;
        scaleYTarget = 0.98;
        eyeScaleTarget = 0.95;
        eyeOpenTarget = 0.85;
        break;
      case "sad":
        rotationTarget = 3 + 2 * Math.sin(0.3 * runtime);
        x = 1.5 * Math.sin(0.25 * runtime);
        y = 7 + Math.sin(0.4 * runtime);
        scaleYTarget = 0.97;
        eyeScaleTarget = 0.97;
        eyeOpenTarget = 0.7;
        break;
      case "laughing": {
        const wave = Math.sin(runtime * Math.PI * 6.4);
        rotationTarget = 4 * wave;
        x = 2 * Math.sin(2 * runtime);
        y = -5 * Math.abs(wave);
        scaleYTarget = 1 + 0.03 * wave;
        eyeOpenTarget = 0.7;
        break;
      }
      case "scared":
        rotationTarget = 2 * Math.sin(0.04 * now);
        x = -2 + 1.5 * Math.sin(0.05 * now);
        y = 2 + Math.sin(1.5 * runtime);
        scaleYTarget = 0.97;
        eyeScaleTarget = 1.12;
        eyeOpenTarget = 1.05;
        break;
      case "playful":
        rotationTarget = 8 * Math.sin(1.4 * runtime);
        x = 4 * Math.sin(1.1 * runtime);
        y = -3 * Math.abs(Math.sin(2.2 * runtime));
        scaleYTarget = 1 + 0.015 * Math.sin(2.2 * runtime);
        eyeScaleTarget = 1.06;
        break;
      case "celebrate":
        y = -2.5 * Math.abs(Math.sin(1.6 * runtime));
        eyeScaleTarget = 1.1;
        eyeOpenTarget = 1.1;
        gesture = this.celebratePose(elapsed);
        break;
      case "dragging": {
        const phase = (elapsed % 3.4) / 3.4;
        const cycle = Math.floor(elapsed / 3.4);
        if (phase < 0.12) {
          x = -16;
          y = -22;
          rotationTarget = -5;
        } else if (phase < 0.62) {
          x = -16 + 32 * cubicInOut((phase - 0.12) / 0.5);
          y = -22 + 2 * Math.sin(1.4 * runtime);
          rotationTarget = 6 * Math.sin(2.6 * runtime);
          eyeScaleTarget = 1.06;
        } else {
          if (cycle !== this.dragCycle) {
            this.dragCycle = cycle;
            this.headY.velocity += 90;
          }
          x = 16;
        }
        break;
      }
      case "humming":
        rotationTarget = 2 * Math.sin(0.4 * runtime);
        x = 1.5 * Math.sin(0.3 * runtime);
        y = 1.5 * Math.sin(0.7 * runtime);
        break;
      case "notifying":
        if (!this.notifyTriggered && elapsed > 0.12) {
          this.notifyTriggered = true;
          this.headY.velocity -= 26;
          this.scheduleBlink(now);
        }
        eyeScaleTarget = 1 + 0.05 * Math.exp(-3 * elapsed);
        rotationTarget = 3;
        x = 2;
        y = -1;
        break;
      default:
        break;
    }

    const blinkOverride = this.updateExpressionAndBlink(now, config);
    this.updateAim(now, config);

    if (gesture.eyeOpen != null) eyeOpenTarget = gesture.eyeOpen;
    if (gesture.eyeScale != null) eyeScaleTarget = gesture.eyeScale;
    this.directTurn = gesture.turn;
    this.directRotation = gesture.rotation;
    this.directX = gesture.x;
    this.directY = gesture.y + gesture.bounceY;
    this.directGazeX = gesture.gazeX;
    this.directGazeY = gesture.gazeY;

    this.rotation.target = ((rotationTarget * motion * config.rotationScale) * Math.PI) / 180;
    this.headX.target = x * motion;
    this.headY.target = y * motion;
    // 夸大的是偏离静止身体的量——完全不压扁的状态依然不压扁。且有界：
    // 各状态的压扁差一个数量级，无界会把 excited 压到五分之一高。
    const squashed = 1 + (scaleYTarget - 1) * config.squashScale;
    this.scaleY.target = clamp(squashed, 0.9, 1.12);
    this.eyeOpen.target = blinkOverride ?? eyeOpenTarget;
    this.eyeScaleS.target = eyeScaleTarget * config.eyeScale;
    this.notify.target = this.state === "notifying" ? 1 : 0;
    this.humming.target = this.state === "humming" ? 1 : 0;

    if (this.state === "humming" || this.state === "loading") {
      const settled = this.state === "loading" ? 3.0 : 1.6;
      const speed = elapsed < 0.5
        ? 7 * cubicInOut(elapsed / 0.5)
        : elapsed < 1.3
          ? 7 + (settled - 7) * cubicInOut((elapsed - 0.5) / 0.8)
          : settled + 0.3 * Math.sin(0.5 * elapsed);
      this.spinAngle += speed * this.delta;
    } else if (this.state !== "celebrate") {
      this.spinAngle *= 0.94;
    }
  }

  /** 轮换状态的表情池，并跑眨眼队列。眨眼在途时返回眼睑覆盖值。 */
  private updateExpressionAndBlink(now: number, config: Config): number | null {
    if (this.state !== "waking" && this.state !== "sleeping" && now >= this.expressionNext) {
      const pool = config.expressionPool;
      if (pool.length) {
        // 随机步进游标，同一张脸不会连续出现两次。
        this.expressionCursor = (this.expressionCursor + 1 + Math.floor(random(0, Math.max(pool.length - 1, 1)))) % pool.length;
        this.setExpression(pool[this.expressionCursor]!,
          this.state === "searching" || this.state === "excited" ? 10 : 6);
      }
      this.expressionNext = now + random(config.expressionCadence[0], config.expressionCadence[1]) * config.tempo;
    }
    if (config.blinkCadence && now >= this.blinkNext) {
      this.scheduleBlink(now);
      this.blinkNext = now + random(config.blinkCadence[0], config.blinkCadence[1]) * config.tempo;
    }
    while (this.blinkQueue.length && now >= this.blinkQueue[0]!.at) {
      this.blinkTarget = this.blinkQueue.shift()!.value;
    }
    if (this.blinkQueue.length) return this.blinkTarget;
    if (this.blinkTarget != null) {
      const target = this.blinkTarget;
      this.blinkTarget = null;
      return target;
    }
    return null;
  }

  /** 警戒方向的扫视八成折向屏幕内侧，剩下五分之一随它去。 */
  private inward(x: number, config: Config): number {
    if (config.gazeBias === 0 || Math.random() >= 0.8) return x;
    return Math.abs(x);
  }

  /** 眼睛下一步看哪，多久后再换。 */
  private updateAim(now: number, config: Config): void {
    if (now < this.gazeNext) return;
    const direction = () => (Math.random() < 0.5 ? -1 : 1);
    let x = 0;
    let y = 0;
    let low = 2500;
    let high = 5000;
    switch (this.state) {
      case "idle": low = 2500; high = 5500; break;
      case "listening": x = 15 * random(-0.3, 0.3); y = 9 * random(-0.25, 0.25); low = 2200; high = 4200; break;
      case "thinking": x = direction() * random(0.5, 1) * 15; y = -9 * random(0.4, 1); low = 1500; high = 2800; break;
      case "searching": x = direction() * random(0.7, 1) * 15; y = 9 * random(-1, 1); low = 550; high = 1150; break;
      case "working": x = 15 * random(-0.4, 0.4); y = 9 * random(0.4, 1); low = 1200; high = 2400; break;
      case "excited": x = 15 * random(-1, 1); y = 9 * random(-1, 0.3); low = 700; high = 1400; break;
      case "surprised": low = 1600; high = 2600; break;
      case "suspicious": x = 15 * direction(); y = 2.7; low = 2200; high = 4200; break;
      case "angry": x = 15 * random(-0.2, 0.2); y = 1.8; low = 1800; high = 3200; break;
      case "drowsy": x = 15 * random(-0.4, 0.4); y = 9 * random(0.4, 1); low = 2500; high = 4500; break;
      case "happy": x = 15 * random(-0.7, 0.7); y = -9 * random(0, 0.6); low = 1800; high = 3400; break;
      case "curious": x = direction() * random(0.6, 1) * 15; y = 9 * random(-1, 1); low = 950; high = 1900; break;
      case "confused": x = direction() * random(0.5, 1) * 15; y = 9 * random(-0.6, 1); low = 1100; high = 2300; break;
      case "bored": x = direction() * random(0.7, 1) * 15; y = 9 * random(0.4, 0.9); low = 3000; high = 6000; break;
      case "proud": x = 15 * random(-0.3, 0.3); y = -9 * random(0.3, 0.7); low = 2600; high = 4600; break;
      case "shy": x = direction() * random(0.6, 1) * 15; y = 9 * random(0.5, 1); low = 2000; high = 4000; break;
      case "sad": x = 15 * random(-0.3, 0.3); y = 9 * random(0.6, 1); low = 2800; high = 5000; break;
      case "laughing": x = 15 * random(-0.5, 0.5); y = -9 * random(0.2, 0.6); low = 800; high = 1700; break;
      case "scared": x = direction() * random(0.7, 1) * 15; y = 9 * random(-0.6, 0.6); low = 450; high = 1050; break;
      case "playful": x = direction() * random(0.5, 1) * 15; y = -9 * random(0, 0.6); low = 900; high = 1800; break;
      case "notifying": {
        const focused = Math.random() < 0.72;
        x = (focused ? 0.45 : 0.1) * 15;
        y = -9 * (focused ? 0.3 : 0.05);
        low = 1200;
        high = 2400;
        break;
      }
      default:
        x = 15 * random(-0.4, 0.4);
        y = 9 * random(-0.3, 0.3);
        break;
    }
    this.aimX.target = this.inward(x, config) * config.gazeScale;
    this.aimY.target = y * config.gazeScale;
    this.gazeNext = now + random(low, high) * config.tempo;
  }

  // MARK: - 手势

  private startSpin(turns = 1, direction?: number): boolean {
    if (this.spinSpring) return false;
    const chosen = direction ?? (Math.random() < 0.5 ? 1 : -1);
    const spring = new BotSpring(0);
    spring.target = turns * 2 * Math.PI * chosen;
    this.spinSpring = spring;
    return true;
  }

  private startGesture(kind: string): void {
    if (this.gesture || this.spinSpring) return;
    const turns = kind === "spinDizzy" ? Math.round(random(3, 4)) : 1;
    this.gesture = { kind, startedAt: this.clockTime, direction: Math.random() < 0.5 ? 1 : -1, turns };
  }

  private startBounce(now: number): void {
    if (this.bounceStartedAt < 0) this.bounceStartedAt = now;
  }

  /** 外部交互入口：戳一下 = 爆裂 + 后坐弹跳（GIF 同款点击反馈）。 */
  poke(): void {
    this.particles.burst(Math.round(random(10, 14)), 0.85, 0.15);
    this.startBounce(this.clockTime);
    this.headY.velocity -= 40;
  }

  private updateGestures(now: number): GesturePose {
    const output = newGesturePose();
    if (["idle", "happy", "excited", "curious", "playful"].includes(this.state) && now >= this.winkNext) {
      this.winkAt = now;
      this.winkEye = Math.random() < 0.5 ? 0 : 1;
      this.winkNext = now + random(4500, 10000);
    }
    if (now >= this.behaviorNext && !this.gesture && !this.spinSpring) {
      switch (this.state) {
        case "searching": this.startSpin(); this.behaviorNext = now + random(4000, 7000); break;
        case "working": this.startSpin(1, 1); this.behaviorNext = now + random(6000, 9000); break;
        case "excited": this.startSpin(1); this.behaviorNext = now + random(2800, 5000); break;
        case "playful": this.startSpin(1); this.behaviorNext = now + random(3500, 6000); break;
        default: break;
      }
    }
    if (now >= this.ambientNext) {
      if (!this.gesture && !this.spinSpring) {
        const roll = Math.random();
        if (["happy", "excited", "proud"].includes(this.state)) {
          if (roll < 0.55) this.startSpin(1);
          else this.startGesture("spinBounce");
        } else if (this.state === "playful") {
          if (roll < 0.34) this.startGesture("spinBounce");
          else if (roll < 0.62) this.startBounce(now);
          else if (roll < 0.86) this.startGesture("spinDizzy");
          else this.startSpin(1);
        }
      }
      this.ambientNext = now + random(9000, 18000);
    }
    if (this.gesture) {
      const active = this.gesture;
      const elapsed = (now - active.startedAt) / 1000;
      if (active.kind === "spinBounce") {
        if (elapsed < 0.7) {
          output.turn = active.turns * 2 * Math.PI * active.direction * cubicInOut(elapsed / 0.7);
        } else {
          this.startBounce(now);
          this.gesture = null;
        }
      } else if (active.kind === "spinDizzy") {
        const spinDuration = 0.55 + 0.16 * active.turns;
        if (elapsed < spinDuration) {
          output.turn = active.turns * 2 * Math.PI * active.direction * Math.pow(elapsed / spinDuration, 2);
        } else if (elapsed < spinDuration + 1.5) {
          const shakeTime = elapsed - spinDuration;
          const envelope = Math.pow(1 - shakeTime / 1.5, 1.3);
          output.rotation = 17 * Math.sin(10 * shakeTime) * active.direction * envelope;
          output.x = 10 * Math.cos(10 * shakeTime) * active.direction * envelope;
          output.y = 3 * Math.sin(20 * shakeTime) * envelope;
          output.eyeOpen = 0.46 + 0.14 * Math.sin(21 * shakeTime);
          output.eyeScale = 1.03;
        } else {
          this.gesture = null;
        }
      }
    }
    if (this.bounceStartedAt >= 0) {
      const sequence: [number, number][] = [[48, 0.5], [28, 0.382], [14, 0.27], [6, 0.177]];
      let elapsed = (now - this.bounceStartedAt) / 1000;
      let step = 0;
      while (step < sequence.length && elapsed >= sequence[step]![1]) {
        elapsed -= sequence[step]![1];
        step += 1;
      }
      if (step >= sequence.length) {
        this.bounceStartedAt = -1;
      } else {
        const phase = elapsed / sequence[step]![1];
        output.bounceY = -4 * sequence[step]![0] * phase * (1 - phase);
      }
    }
    return output;
  }

  /** 庆祝循环：蓄力，九圈，然后眩晕摇晃。 */
  private celebratePose(elapsed: number): GesturePose {
    const output = newGesturePose();
    this.celebrateWildActive = false;
    const activeElapsed = elapsed - 0.14;
    if (activeElapsed < 0) return output;
    const cycleIndex = Math.floor(activeElapsed / 6.2);
    if (cycleIndex !== this.celebrateCycle) {
      this.celebrateCycle = cycleIndex;
      this.turnDirection = Math.random() < 0.5 ? 1 : -1;
    }
    const cycle = activeElapsed % 6.2;
    if (cycle > 5.49) return output;
    this.celebrateWildActive = true;
    const turns = 9;
    const direction = this.turnDirection;
    const speed = (turns * 2 * Math.PI + 0.5) / (0.15 + 2 + 0.3125);
    let angle: number;
    if (cycle < 0.24) {
      angle = -0.25 * (1 - Math.cos((cycle / 0.24) * Math.PI));
    } else if (cycle < 0.54) {
      const time = cycle - 0.24;
      angle = -0.5 + (speed * time * time) / 0.6;
    } else if (cycle < 2.54) {
      angle = -0.5 + speed * (0.15 + cycle - 0.54);
    } else if (cycle < 3.79) {
      angle = -0.5 + speed * 2.15 + (1.25 * speed * (1 - Math.pow(1 - (cycle - 2.54) / 1.25, 4))) / 4;
    } else {
      angle = turns * 2 * Math.PI;
    }
    output.turn = angle * direction;
    let envelope = 0;
    if (cycle > 2.54) {
      const progress = Math.min((cycle - 2.54) / 1.25, 1);
      envelope = progress < 0.4 ? 0 : Math.pow((progress - 0.4) / 0.6, 2);
      if (cycle >= 3.79) envelope = Math.max(0, Math.pow(1 - (cycle - 3.79) / 1.7, 1.6));
    }
    const shakeTime = Math.max(cycle - 2.54, 0);
    output.rotation = (angle / (turns * 2 * Math.PI)) * 1080 * direction
      + 11 * Math.sin(9.2 * shakeTime) * direction * envelope;
    output.x = (Math.cos(9.2 * shakeTime) - 1) * 6 * direction * envelope;
    output.y = 2.6 * Math.sin(18.4 * shakeTime) * envelope;
    output.gazeX = 13 * Math.sin(11.5 * shakeTime) * direction * envelope;
    output.gazeY = (Math.cos(9 * shakeTime) - 1) * 3.5 * envelope;
    output.eyeOpen = 1.14 - 0.44 * envelope + 0.1 * Math.sin(16 * shakeTime) * envelope;
    output.eyeScale = 1.12 - 0.09 * envelope;
    return output;
  }

  /** 换体型本身就是事件：五种反应轮换，免得看起来像溶解。 */
  private triggerShapeChangeMotion(): void {
    this.shapeChangeCycle = (this.shapeChangeCycle + 1) % 5;
    switch (this.shapeChangeCycle) {
      case 0: this.startSpin(1); break;
      case 1: this.shapeChangeWide = this.startSpin(2); break;
      case 2: this.startGesture("spinBounce"); break;
      case 3: this.startGesture("spinDizzy"); break;
      default:
        this.startSpin(1);
        this.particles.burst(16, 0.95, 0.3);
        break;
    }
  }

  // MARK: - 体型解析

  private resolveShape(requested: string): ResolvedShape {
    const identifier = this.data.shapes[requested] ? requested : "blob";
    if (identifier !== this.shapeId) {
      const previous = shapeOf(this.data, this.shapeId);
      const currentAmount = cubicInOut(clamp(this.shapeBlend.value, 0, 1));
      this.shapeFromRing = currentAmount >= 1
        ? previous.ring
        : lerpRing(this.shapeFromRing, previous.ring, currentAmount);
      this.shapeFromFace = currentAmount >= 1
        ? previous.face
        : blendFace(this.shapeFromFace, previous.face, currentAmount);
      this.shapeFromTiltScale += (previous.tiltScale - this.shapeFromTiltScale) * currentAmount;
      this.shapeFromBeltRadius += (previous.beltRadius - this.shapeFromBeltRadius) * currentAmount;
      this.shapeId = identifier;
      this.shapeBlend.value = 0;
      this.shapeBlend.velocity = 0;
      this.shapeBlend.target = 1;
      this.triggerShapeChangeMotion();
    }
    const shape = shapeOf(this.data, this.shapeId);
    const amount = cubicInOut(clamp(this.shapeBlend.value, 0, 1));
    const transitioning = amount < 0.999;
    return {
      shape,
      identifier: this.shapeId,
      transitioning,
      ring: transitioning ? lerpRing(this.shapeFromRing, shape.ring, amount) : shape.ring,
      face: transitioning ? blendFace(this.shapeFromFace, shape.face, amount) : shape.face,
      tiltScale: transitioning
        ? this.shapeFromTiltScale + (shape.tiltScale - this.shapeFromTiltScale) * amount
        : shape.tiltScale,
      beltRadius: transitioning
        ? this.shapeFromBeltRadius + (shape.beltRadius - this.shapeFromBeltRadius) * amount
        : shape.beltRadius,
    };
  }

  // MARK: - 渲染

  private render(now: number, config: Config): BotFrame {
    const geometry = this.resolveShape(config.shape);
    const shape = geometry.shape;
    const c = this.headC;
    const top = geometry.transitioning ? Math.min(...geometry.ring.map(p => p[1])) : shape.top;
    const bottom = geometry.transitioning ? Math.max(...geometry.ring.map(p => p[1])) : shape.bottom;
    const spanSamples = geometry.transitioning ? null : shape.spanSamples;

    const morphAmount = clamp(this.morph.value, 0, 1);
    // loading 的旋涡把粒子带宽进来。
    this.currentBeltRadius = geometry.beltRadius
      + (this.state === "loading" ? (52 - geometry.beltRadius) * morphAmount : 0);
    const blend = clamp(this.morphBlend.value, 0, 1);
    const previous = blend < 0.999 ? this.previousMorphEffect : null;

    // morph 进场时角色转半圈，转体弹簧在动就算进 yaw。
    const morphIsTurning = this.morph.value > 0.001 || Math.abs(this.turn.target - this.turn.value) > 0.01;
    const turnAngle = (morphIsTurning ? this.turn.value : 0) + (this.spinSpring?.value ?? 0) + this.directTurn;
    const shapeRing = Math.abs(turnAngle) > 0.001 && !geometry.transitioning
      ? turnedShapeRing(shape, geometry.identifier, turnAngle, c)
      : geometry.ring;

    const activeMorphRing = morphTargetRing(this, this.morphEffect);
    const previousMorphRing = morphTargetRing(this, previous);
    const morphRing = previous != null
      ? lerpRing(previousMorphRing, activeMorphRing, cubicInOut(blend))
      : activeMorphRing;
    // 轮廓在 morph 的 0.62 处就完全到位，部件落在已安定的身体上。
    const morphPathAmount = clamp(morphAmount / 0.62, 0, 1);

    let headD: string;
    let headDStatic = false;
    if (morphPathAmount <= 0) {
      if (geometry.transitioning || (Math.abs(turnAngle) > 0.001 && (shape.solid != null || shape.sides > 0))) {
        headD = ringOutlineD(shapeRing);
      } else {
        headD = this.staticHead(geometry.identifier, shape);
        headDStatic = true;
      }
    } else {
      headD = ringOutlineD(lerpRing(shapeRing, morphRing, cubicInOut(morphPathAmount)));
    }

    const eyes = this.renderEyes(config, geometry.face, shapeRing, spanSamples, top, bottom,
      turnAngle, morphAmount);

    const activeMorphSize = this.morphEffect ? MORPH_SIZES[this.morphEffect] ?? 19 : 19;
    const previousMorphSize = previous ? MORPH_SIZES[previous] ?? activeMorphSize : activeMorphSize;
    const morphSize = activeMorphSize * blend + previousMorphSize * (1 - blend);
    const morphScale = morphSize / c;

    const shapes: MorphShape[] = [];
    const pose = renderMorphEffects(this, morphAmount, blend, previous, morphSize, now, this.delta, shapes);

    const normal = 1 - morphAmount;
    // **有界于 viewBox 的空间。** 盒子 259、身体 229，余量约 15 单位——
    // drowsy 点头 25、弹跳抛 48、dragging 滑 16，出界就裁掉。物理保持
    // 上游的，只把画出来的部分收进来；morph 姿势不动。
    const room = 12;
    const travelX = clamp((this.headX.value + this.directX) * normal, -room, room);
    const travelY = clamp((this.headY.value + this.directY) * normal, -room, room);
    const translateX = travelX + pose.x;
    const translateY = travelY + pose.y;
    const degrees = ((this.rotation.value * 180) / Math.PI) * geometry.tiltScale * normal
      + this.directRotation * normal + pose.rotation;
    const sx = 1 * normal + morphScale * pose.scale * morphAmount;
    const sy = this.scaleY.value * normal + morphScale * pose.scale * morphAmount;
    const headTransform = `translate(${(c + translateX).toFixed(2)},${(c + translateY).toFixed(2)})`
      + ` rotate(${degrees.toFixed(2)}) scale(${sx.toFixed(4)},${sy.toFixed(4)})`
      + ` translate(${(-c).toFixed(2)},${(-c).toFixed(2)})`;

    let badge: BotFrame["badge"] = null;
    const badgeAmount = clamp(this.notify.value, 0, 1.4);
    if (badgeAmount > 0.01) {
      const anchor = shapeRing[Math.round((7 * shapeRing.length) / 8) % shapeRing.length]!;
      badge = { x: anchor[0], y: anchor[1], r: 20 * badgeAmount, color: BADGE_COLOR };
    }

    const hummingAmount = clamp(this.humming.value, 0, 1);
    if (hummingAmount > 0.01) {
      for (let i = 0; i < 2; i++) {
        const angle = 0.85 * this.spinAngle + i * Math.PI;
        const radius = 1.3 * shape.radius;
        const depth = 0.55 + 0.45 * clamp((Math.cos(angle) + 1) / 2, 0, 1);
        const size = 7.5 * depth * hummingAmount;
        shapes.push({
          d: circleD(c + radius * Math.sin(angle), c - 0.38 * radius * Math.cos(angle) - 8, size),
          opacity: (0.3 + 0.7 * depth) * hummingAmount,
        });
      }
    }

    // viewBox 只在小画布上为 morph 张开：96pt 以上本来就有空间。
    const responsive = 1 - smoothstep(clamp((config.viewWidth - 44) / 90, 0, 1));
    const activeExpansion = this.morphEffect ? MORPH_VIEW_BOXES[this.morphEffect] ?? 1 : 1;
    const previousExpansion = previous ? MORPH_VIEW_BOXES[previous] ?? activeExpansion : activeExpansion;
    const expansion = activeExpansion * blend + previousExpansion * (1 - blend);
    const viewBoxRadius = 129.5 / (1 + (expansion - 1) * morphAmount * responsive);

    return {
      headD, headDStatic, headTransform,
      headOpacity: pose.opacity,
      eyes,
      badge,
      shapes,
      back: this.particles.back,
      front: this.particles.front,
      viewBoxRadius,
      morphAmount,
    };
  }

  private staticHead(identifier: string, shape: BotMarkShape): string {
    let d = this.staticHeadCache.get(identifier);
    if (!d) {
      d = pathOpsD(shape.path);
      this.staticHeadCache.set(identifier, d);
    }
    return d;
  }

  private renderEyes(config: Config, face: FaceTransform, shapeRing: Ring,
    spanSamples: [number, number][] | null, top: number, bottom: number,
    turnAngle: number, morphAmount: number): EyeFrame[] {
    const c = this.headC;
    const amount = clamp(this.expressionSpring.value, 0, 1);
    let eyeRings = [
      lerpRing(this.expressionFrom[0]!, this.expressionTo[0]!, amount),
      lerpRing(this.expressionFrom[1]!, this.expressionTo[1]!, amount),
    ];
    // **神情本来就画在"看着某处"。** 转身时整对眼睛也被镜像并逐点混合，
    // 关于头中心镜像并互换——朝右看的机器人的左眼，就是同一只眼看左边。
    const turn = clamp((1 - this.facingValue) / 2, 0, 1);
    if (turn > 0.001) {
      eyeRings = [0, 1].map(i =>
        lerpRing(eyeRings[i]!, reflected(eyeRings[1 - i]!, c), turn));
    }
    const centres = eyeRings.map(centroid);
    const pairOffset = (centres[0]![0] + centres[1]![0]) / 2 - c;
    let scanTop = top;
    let scanBottom = bottom;
    if (Math.abs(turnAngle) > 0.001) {
      scanTop = Math.min(...shapeRing.map(p => p[1]));
      scanBottom = Math.max(...shapeRing.map(p => p[1]));
    }
    let leftHalf = 0;
    let rightHalf = 0;
    for (const p of eyeRings[0]!) leftHalf = Math.max(leftHalf, Math.abs(p[0] - centres[0]![0]));
    for (const p of eyeRings[1]!) rightHalf = Math.max(rightHalf, Math.abs(p[0] - centres[1]![0]));
    const distance = Math.abs(centres[1]![0] - centres[0]![0]) * face.sx;
    const fit = leftHalf + rightHalf > 0.5
      ? clamp((distance - 5) / (leftHalf + rightHalf), 0.35, 4)
      : 4;

    // 帧率无关的输出数组。
    const output: EyeFrame[] = [];
    for (let index = 0; index < 2; index++) {
      const ring = eyeRings[index]!;
      const centre = centres[index]!;
      let localCentre = c + face.x;
      let offsetX = (centre[0] - c) * face.sx;
      let perspectiveX = 1;
      let visible = true;
      let perspectiveFade = 1;
      if (Math.abs(turnAngle) > 0.001) {
        const scanY = clamp(c + face.y + (centre[1] - c) * face.sy, scanTop + 2, scanBottom - 2);
        const span = spanAt(shapeRing, scanY, c);
        const radius = Math.max((span[1] - span[0]) / 2, 12);
        localCentre = (span[0] + span[1]) / 2;
        const initial = Math.asin(clamp(offsetX / radius, -1, 1));
        const turned = initial + turnAngle;
        const cosine = Math.cos(turned);
        const baseCosine = Math.max(Math.cos(initial), 0.02);
        visible = cosine > 0.02;
        perspectiveX = Math.max(cosine, 0.02) / baseCosine;
        offsetX = radius * Math.sin(turned);
        perspectiveFade = smoothstep(clamp(cosine / 0.5, 0, 1));
      }
      const pulse = 1 + 0.07 * Math.sin(amount * Math.PI);
      let driftX = 1.4 * Math.sin(0.00042 * this.clockTime + index) + 0.5 * Math.sin(0.001 * this.clockTime + 2 * index);
      let driftY = 0.9 * Math.sin(0.00058 * this.clockTime + index);
      // 视线划过去而不是跳过去：facing 是弹簧，缩放所有水平项。
      driftX = (driftX + this.aimX.value + this.directGazeX + config.gazeBias) * this.facingValue;
      const reach = this.data.eyeReach;
      driftX = clamp(pairOffset + driftX, -reach, reach) - pairOffset;
      driftY += this.aimY.value + this.directGazeY;
      const notification = clamp(this.notify.value, 0, 1);
      driftX -= 10 * notification;
      driftY += 7 * notification;

      const scaledEye = Math.min(clamp(this.eyeScaleS.value, 0.2, 2) * face.eye, fit / pulse);
      const scaleX = clamp(perspectiveX * scaledEye * pulse, 0.02, 2.4);
      let winkScale = 1;
      if (index === this.winkEye && this.clockTime < this.winkAt + 320) {
        const phase = (this.clockTime - this.winkAt) / 320;
        winkScale = Math.max(phase < 0.42 ? 1 - phase / 0.42 : (phase - 0.42) / 0.58, 0.04);
      }
      const scaleYValue = clamp(Math.max(this.eyeOpen.value * winkScale, 0.04) * scaledEye * pulse, 0.02, 2.4);
      const halfHeight = this.data.eyeHalf * scaleYValue + 2;
      const y = clamp(c + face.y + (centre[1] + driftY - c) * face.sy,
        scanTop + halfHeight, scanBottom - halfHeight);

      // 眼睛留在轮廓内：沿眼轮廓每隔一点采样身体宽度，钳到最紧处。
      let maxLeft = -Infinity;
      let minRight = Infinity;
      for (let pi = 0; pi < ring.length; pi += 2) {
        const scaledX = (ring[pi]![0] - centre[0]) * scaleX;
        const sampleY = y + (ring[pi]![1] - centre[1]) * scaleYValue;
        const span = Math.abs(turnAngle) > 0.001
          ? spanAt(shapeRing, sampleY, c)
          : shapeSpanAt(spanSamples, top, bottom, sampleY, c, shapeRing);
        maxLeft = Math.max(maxLeft, span[0] - scaledX);
        minRight = Math.min(minRight, span[1] - scaledX);
      }
      const desired = localCentre + offsetX + driftX * face.sx;
      const bounded = maxLeft <= minRight ? clamp(desired, maxLeft, minRight) : (maxLeft + minRight) / 2;
      let finalX = bounded + (desired - bounded) * (1 - perspectiveFade);
      let finalY = y;

      if (notification > 0.01) {
        // 通知时眼睛让开身上的徽章：不够远就沿径向推开。
        const anchor = shapeRing[Math.round((7 * shapeRing.length) / 8) % shapeRing.length]!;
        const dx = finalX - anchor[0];
        const dy = finalY - anchor[1];
        const length = Math.max(Math.hypot(dx, dy), 1);
        const dirX = dx / length;
        const dirY = dy / length;
        const eyeHalfW = index === 0 ? leftHalf : rightHalf;
        const needed = 20 * clamp(this.notify.value, 0, 1.4)
          + Math.hypot(eyeHalfW * scaleX * dirX, this.data.eyeHalf * scaleYValue * dirY) + 5;
        if (length < needed) {
          finalX += dirX * (needed - length);
          finalY += dirY * (needed - length);
        }
      }

      const transform = `translate(${finalX.toFixed(2)},${finalY.toFixed(2)})`
        + ` scale(${scaleX.toFixed(4)},${scaleYValue.toFixed(4)})`
        + ` translate(${(-centre[0]).toFixed(2)},${(-centre[1]).toFixed(2)})`;
      output.push({ d: ringPathD(ring), transform, visible: visible && morphAmount < 0.5 });
    }
    return output;
  }
}

function blendFace(from: FaceTransform, to: FaceTransform, amount: number): FaceTransform {
  return {
    x: mix(from.x, to.x, amount),
    y: mix(from.y, to.y, amount),
    sx: mix(from.sx, to.sx, amount),
    sy: mix(from.sy, to.sy, amount),
    eye: mix(from.eye, to.eye, amount),
  };
}

function circleD(x: number, y: number, r: number): string {
  const f = (v: number) => (Math.round(v * 10) / 10).toString();
  return `M${f(x - r)},${f(y)}A${f(r)},${f(r)} 0 1 1 ${f(x + r)},${f(y)}A${f(r)},${f(r)} 0 1 1 ${f(x - r)},${f(y)}Z`;
}

/** 圆角矩形（铅笔字形）。 */
function roundedRectD(x: number, y: number, w: number, h: number, r: number): string {
  const f = (v: number) => (Math.round(v * 10) / 10).toString();
  return `M${f(x + r)},${f(y)}H${f(x + w - r)}A${f(r)},${f(r)} 0 0 1 ${f(x + w)},${f(y + r)}`
    + `V${f(y + h - r)}A${f(r)},${f(r)} 0 0 1 ${f(x + w - r)},${f(y + h)}H${f(x + r)}`
    + `A${f(r)},${f(r)} 0 0 1 ${f(x)},${f(y + h - r)}V${f(y + r)}A${f(r)},${f(r)} 0 0 1 ${f(x + r)},${f(y)}Z`;
}

/** "！" 警示字形：圆顶 + 圆底，与上游 CGPath 一致（sweep 0：y 向下坐标系里逆时针）。 */
function alertGlyphD(c: number): string {
  const f = (v: number) => (Math.round(v * 10) / 10).toString();
  return `M${f(c - 15)},${f(c - 33)}A15,15 0 0 0 ${f(c + 15)},${f(c - 33)}`
    + `L${f(c + 8.5)},${f(c + 39.5)}A8.5,8.5 0 0 0 ${f(c - 8.5)},${f(c + 39.5)}Z`;
}
