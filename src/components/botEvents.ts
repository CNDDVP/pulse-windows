/**
 * 机器人事件检测：从数据跳变里读"刚刚发生的事"，供动画机器人播一次性
 * 庆祝/兴奋/醒来动画。按槽位 key 记忆上一帧的关键值。
 */
import type {ProviderUsage} from "../types";
import {eventDuration, type BotEvent, type BotEventKind, type Mood} from "./bot/mood";

/** 每个槽位上一帧的关键值。 */
interface BotHistory {
  /** 主窗口已用百分比；null 表示上一帧没有读数。 */
  used: number | null;
  reset: string | null;
  valid: boolean;
  winId: string | null;
  isActive: boolean;
  mood: Mood | null;
  /** 当前在播的事件与持有截止时刻。 */
  live: { event: BotEvent; until: number } | null;
}

const history = new Map<string, BotHistory>();
let eventSeq = 0;

/** 仅供测试。 */
export function resetBotHistory(): void {
  history.clear();
  eventSeq = 0;
}

/** 同一选中窗口周期推进且用量骤降 ≥20 点 = 额度重置；is_active 下降沿 = 一轮干活结束；
 * 从无读数/离线恢复 = 醒来。事件按住一小段时间——引擎靠 seq 去重，
 * 报告式传入不会重播。 */
export function detectEvent(key: string, usage: ProviderUsage, mood: Mood, selectedWindow?: string | null): BotEvent | null {
  let prev = history.get(key);
  const now = Date.now();
  if (!prev) {
    prev = { reset: null, valid: false, used: null, winId: null, isActive: false, mood: null, live: null };
    history.set(key, prev);
  }
  const primary = selectedWindow ? usage.windows.find(w=>w.id===selectedWindow) ?? null
    : usage.windows.reduce<ProviderUsage['windows'][number] | null>((best,w)=>!best||w.used_percent>best.used_percent?w:best,null);
  const used = primary?.used_percent ?? null;
  const valid=usage.state==='live';
  const reset=primary?.resets_at??null;
  const rolled=valid&&prev.valid&&prev.reset!==null&&reset!==null&&Date.parse(reset)>Date.parse(prev.reset);


  // 持有期内继续报告同一事件（seq 不变，引擎不会重播）。
  if (prev.live && now < prev.live.until) {
    prev.reset=reset; prev.valid=valid;
    prev.used = used;
    prev.winId = primary?.id ?? null;
    prev.isActive = usage.is_active;
    prev.mood = mood;
    return prev.live.event;
  }
  if (prev.live && now >= prev.live.until) prev.live = null;

  let kind: BotEventKind | null = null;
  if (prev.used !== null && used !== null && prev.winId !== null && primary
      && rolled && primary.id === prev.winId && prev.used - used >= 20) {
    kind = "limitReset";
  } else if (valid && prev.isActive && !usage.is_active) {
    kind = "workFinished";
  } else if ((prev.mood === "asleep" || prev.mood === "unavailable")
    && mood !== "asleep" && mood !== "unavailable") {
    kind = "woke";
  }
  prev.reset=reset; prev.valid=valid;
  prev.used = used;
  prev.winId = primary?.id ?? null;
  prev.isActive = usage.is_active;
  prev.mood = mood;
  if (!kind) return null;
  const event: BotEvent = { kind, seq: ++eventSeq };
  prev.live = { event, until: now + eventDuration(kind) + 1200 };
  return event;
}
