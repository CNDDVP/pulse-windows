/**
 * 上游 BotMarkMood / BotMarkPersona / BotMarkProgramme / BotMarkEvent /
 * BotMarkGaze / BotMarkHours 的移植。
 *
 * 这里是唯一把应用事实翻译成机器人状态的地方：五个心情各自对应一个
 * 上游状态，个性只改变"怎么说"，不改变"说什么"。
 */

export type Mood = "idle" | "working" | "fetching" | "spent" | "asleep" | "unavailable";

export const PERSONAS = ["calm", "eager", "steady", "curious", "sleepy", "playful", "stoic", "proud"] as const;
export type Persona = (typeof PERSONAS)[number];

/** 心情 → 上游基础状态。 */
export function moodState(mood: Mood): string {
  switch (mood) {
    case "idle": return "idle";
    case "working": return "working";
    case "fetching": return "searching";
    case "spent": return "sad";
    case "asleep":
    case "unavailable": return "sleeping";
  }
}

/** 只有"是事件"的心情才夸大旋转：空闲应当安静——那是读数本身。 */
export function rotationEmphasis(mood: Mood): number {
  switch (mood) {
    case "working": return 2.4;
    case "fetching": return 1.6;
    default: return 1;
  }
}

/** 身体呼吸的力度。 */
export function squashEmphasis(mood: Mood): number {
  switch (mood) {
    case "working": return 3;
    case "fetching": return 2;
    default: return 1;
  }
}

/** 所有等待的倍率。越小越忙（上游用它乘间隙）。 */
export function tempoEmphasis(mood: Mood): number {
  switch (mood) {
    case "working": return 0.5;
    case "fetching": return 0.7;
    default: return 1;
  }
}

/** 从环已有的同一批事实读出心情。忙压过耗尽：耗尽是世界的状态，
 * 一分钟后依然如此；正在干活是当下正在发生的事。 */
export function resolveMood(isBusy: boolean, isRefreshing: boolean, isSpent: boolean, hasReading: boolean): Mood {
  if (isBusy) return "working";
  if (isRefreshing) return "fetching";
  if (isSpent) return "spent";
  if (!hasReading) return "asleep";
  return "idle";
}

// MARK: 个性

/** 心情怎么演。命名的每个状态都与它代表的心情同义——差别只是气质。 */
export function personaState(persona: Persona, mood: Mood): string {
  switch (mood) {
    case "working":
      switch (persona) {
        case "eager":
        case "playful": return "excited";
        case "curious": return "searching";
        default: return "working";
      }
    case "fetching":
      switch (persona) {
        case "curious":
        case "eager": return "curious";
        case "sleepy":
        case "steady": return "listening";
        default: return "searching";
      }
    case "spent":
      switch (persona) {
        case "sleepy": return "drowsy";
        case "stoic":
        case "steady": return "bored";
        default: return "sad";
      }
    case "asleep":
    case "unavailable":
      switch (persona) {
        case "stoic": return "powering-down";
        case "sleepy": return "drowsy";
        default: return "sleeping";
      }
    case "idle":
      switch (persona) {
        case "eager": return "curious";
        case "steady": return "humming";
        case "sleepy": return "bored";
        case "playful": return "playful";
        case "proud": return "proud";
        default: return "idle";
      }
  }
}

const distinct = (states: string[]) => [...new Set(states)];

/** 干活的机器人轮换的状态——工作不是单一状态，单一状态循环
 * 一秒半就读成屏保了。加班时加入 angry。 */
export function workingStates(persona: Persona, overtime: boolean, alerting: boolean): string[] {
  let states: string[];
  switch (persona) {
    case "calm": states = ["working", "spawning", "writing"]; break;
    case "eager": states = ["excited", "spawning", "working"]; break;
    case "steady": states = ["working", "writing", "spawning"]; break;
    case "curious": states = ["searching", "spawning", "working"]; break;
    case "sleepy": states = ["working", "writing", "searching"]; break;
    case "playful": states = ["excited", "writing", "spawning"]; break;
    case "stoic": states = ["working", "writing", "thinking"]; break;
    case "proud": states = ["working", "spawning", "excited"]; break;
  }
  if (overtime) states.push("angry");
  if (alerting) states.push("alerting");
  return distinct(states);
}

/** 空闲机器人轮换的状态。alerting：用量进入警戒区时偶尔亮出"！"，
 * 这正是 GIF 里顶部机器人的样子。 */
export function idleStates(persona: Persona, alerting: boolean): string[] {
  const resting = personaState(persona, "idle");
  return alerting ? distinct([resting, "alerting"]) : [resting];
}

/** 等待倍率：越大越慢。 */
export function personaTempo(persona: Persona): number {
  switch (persona) {
    case "playful":
    case "eager": return 0.85;
    case "sleepy": return 1.5;
    case "stoic": return 1.25;
    default: return 1;
  }
}

export function personaMotion(persona: Persona): number {
  switch (persona) {
    case "playful": return 1.15;
    case "eager": return 1.1;
    case "sleepy": return 0.8;
    case "stoic": return 0.6;
    default: return 1;
  }
}

export function personaGaze(persona: Persona): number {
  switch (persona) {
    case "curious":
    case "eager": return 1.2;
    case "stoic": return 0.5;
    case "sleepy": return 0.7;
    default: return 1;
  }
}

export function personaEye(persona: Persona): number {
  switch (persona) {
    case "eager":
    case "curious": return 1.06;
    case "stoic": return 0.94;
    default: return 1;
  }
}

/** 9:00–21:00、周一到五之外算加班——写在一处，方便改。 */
export function isOvertime(now = new Date()): boolean {
  const day = now.getDay();
  const weekend = day === 0 || day === 6;
  const hour = now.getHours();
  return weekend || hour < 9 || hour >= 21;
}

// MARK: 事件

export type BotEventKind = "limitReset" | "workFinished" | "woke";

export interface BotEvent {
  kind: BotEventKind;
  /** 递增序号：引擎靠它区分"同一件事的持续报告"和"新事件"。 */
  seq: number;
}

export const eventState = (kind: BotEventKind): string => {
  switch (kind) {
    case "limitReset": return "celebrate";
    case "workFinished": return "excited";
    case "woke": return "waking";
  }
};

/** 一次性事件按住机器人的时长（毫秒）。庆祝循环上游 6.2s，
 * 半途截断会显得没收尾；完工只是一拍。 */
export const eventDuration = (kind: BotEventKind): number => {
  switch (kind) {
    case "limitReset": return 6400;
    case "workFinished": return 2600;
    case "woke": return 2200;
  }
};

// MARK: 朝向

export interface Gaze {
  /** 常驻水平偏倚，引擎空间恒为正，facing 决定它落在屏幕哪边。 */
  bias: number;
  /** 是否反向。只有朝左需要：引擎自己的偏倚本来就朝右。 */
  mirrored: boolean;
}

/** 上游 BotMarkGaze：停靠右侧看左，停靠左侧看右，顶部/自由看前方。 */
export function gazeFromLookX(lookX: number): Gaze {
  if (lookX < 0) return { bias: 7, mirrored: true };
  if (lookX > 0) return { bias: 7, mirrored: false };
  return { bias: 0, mirrored: false };
}

// MARK: 节目单

export interface Programme {
  /** 依次轮换的状态；一个就按住不动。 */
  states: string[];
  hold: [number, number];
  event: BotEvent | null;
  mood: Mood;
  shape: string;
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
