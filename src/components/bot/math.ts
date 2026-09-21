/**
 * 上游 BotMarkMath.swift 的移植（源自 grokbot-animation 的 math.js）。
 * 所有运动都由定步长阻尼弹簧驱动，没有任何关键帧——状态中途切换时，
 * 运动从它实际所在的位置继续，而不是跳回起点。
 */

/** 单个弹簧阻尼值，定步长积分。 */
export class BotSpring {
  value: number;
  velocity = 0;
  target: number;

  constructor(value: number) {
    this.value = value;
    this.target = value;
  }

  /** frequency 越大越急；damping 1 为临界阻尼，小于 1 会过冲再回落。 */
  step(frequency: number, damping: number, delta: number): void {
    this.velocity += (-2 * damping * frequency * this.velocity
      - frequency * frequency * (this.value - this.target)) * delta;
    this.value += this.velocity * delta;
    if (!Number.isFinite(this.value) || !Number.isFinite(this.velocity)) {
      this.value = this.target;
      this.velocity = 0;
    }
  }
}

/** 物理子步长：帧时间切成不超过它的步，弹簧在 30fps 与 120fps 下行为一致。 */
export const FIXED_STEP = 1 / 120;

export const clamp = (v: number, low: number, high: number) => Math.min(high, Math.max(low, v));
export const mix = (from: number, to: number, amount: number) => from + (to - from) * amount;
export const random = (low: number, high: number) => (low >= high ? low : low + Math.random() * (high - low));

export const cubicInOut = (v: number) => (v < 0.5 ? 4 * v * v * v : 1 - Math.pow(-2 * v + 2, 3) / 2);
export const cubicOut = (v: number) => 1 - Math.pow(1 - v, 3);
export const backOut = (v: number) => 1 + 2.70158 * Math.pow(v - 1, 3) + 1.70158 * Math.pow(v - 1, 2);
export const smoothstep = (v: number) => v * v * (3 - 2 * v);

/** JavaScript 的 ((v % 1) + 1) % 1：恒在 0..<1。 */
export const unitRemainder = (v: number) => {
  const r = v % 1;
  return r < 0 ? r + 1 : r;
};
