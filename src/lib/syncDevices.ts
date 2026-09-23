/**
 * 多设备同步（Round 6，docs/ROUND6_PLAN.md）前端纯合并逻辑：
 * 设备行（今日 tokens + 在线状态）与「本机 daily_archive + 远端设备日聚合」合并日序列。
 * 全部为纯函数，便于单测；数据形状与 src-tauri/src/sync_hub.rs 的线协议对齐
 * （SyncDayRow 四列 token 计数；DeviceRecord.last_active 由 hub 盖时间戳）。
 */
import type { DailyTrend } from "../components/trendMetrics";
import type { SyncDayRow, SyncDeviceRecord, SyncDevicesSnapshot } from "../types";

/** 在线判定窗口：客户端每 60s 一拍上推（POLL_SECS），3 拍无心跳即视为离线。 */
export const SYNC_ONLINE_WINDOW_MS = 180_000;

/** 与后端 types.rs valid_connect_url 同口径的最小结构校验（设置页「连接」地址输入用）：
 *  仅在合法时提交保存，避免每个按键触发一次会被整表拒绝的设置保存（同 usd_cny_rate 钳制思路）。 */
export function validConnectUrl(url: string): boolean {
  const t = url.trim();
  if (!t || t.length > 2048) return false;
  if (!t.startsWith("http://") && !t.startsWith("https://")) return false;
  if (/\s/.test(t)) return false;
  const host = t.split("://")[1] || "";
  return host.length > 0 && !host.startsWith("/");
}

/** 设备筛选值："all" 全部设备（合并视图）/"local" 仅本机/其余为远端 device_id。 */
export type DeviceFilter = "all" | "local" | string;

/** 本机日键（本地时区 YYYY-MM-DD，与后端 daily_archive 的归档日键同形）。 */
export function localTodayKey(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** YYYY-MM-DD加减 n 天（本地时区日期算术，用于连续天数回走）。 */
function shiftDay(key: string, days: number): string {
  const d = new Date(`${key}T00:00:00`);
  if (Number.isNaN(d.getTime())) return key;
  d.setDate(d.getDate() + days);
  return localTodayKey(d);
}

/** 单行四列 token 计数合计；指定 day 时只累计该日（day 缺省=全窗口）。 */
export function sumDayRows(rows: SyncDayRow[] | undefined | null, day?: string): number {
  if (!rows?.length) return 0;
  let total = 0;
  for (const r of rows) {
    if (day !== undefined && r.day !== day) continue;
    total += (r.input || 0) + (r.output || 0) + (r.cache_read || 0) + (r.cache_write || 0);
  }
  return total;
}

export interface DeviceRow {
  /** 远端为 device_id；本机为 profile id（未知时用哨兵 "local"，仅用于 key/筛选）。 */
  id: string;
  name: string;
  online: boolean;
  /** 今日 tokens（本机取本地账本当日聚合；远端取同步行中 day=今日的合计）。 */
  todayTokens: number;
  /** 同步窗口（最近 30 天）合计，仅远端有数据；本机恒 0（完整窗口看趋势图）。 */
  windowTokens: number;
  lastActive: string | null;
  isLocal: boolean;
}

/**
 * 设备行（趋势仪表盘筛选/汇总行的数据）。
 * - 本机行恒在（在线；今日 tokens 由调用方传本地账本数据，比同步回显更实时）；
 * - 快照中与本机 profile id 相同的自注册行跳过（统一由本机行代表，避免重复计数）；
 * - 远端行 last_active 无法解析或超出在线窗口 → 离线（不猜）。
 */
export function buildDeviceRows(opts: {
  snapshot: SyncDevicesSnapshot | null | undefined;
  profileId: string | null | undefined;
  localName: string;
  localTodayTokens: number;
  now: number;
}): DeviceRow[] {
  const today = localTodayKey(new Date(opts.now));
  const rows: DeviceRow[] = [{
    id: opts.profileId || "local",
    name: opts.localName,
    online: true,
    todayTokens: opts.localTodayTokens,
    windowTokens: 0,
    lastActive: null,
    isLocal: true,
  }];
  for (const d of opts.snapshot?.devices ?? []) {
    if (opts.profileId && d.device_id === opts.profileId) continue;
    const ts = Date.parse(d.last_active);
    rows.push({
      id: d.device_id,
      // 设备名缺失回退 device_id（hub 校验保证非空，防御异常快照）。
      name: d.device_name || d.device_id,
      online: Number.isFinite(ts) && opts.now - ts <= SYNC_ONLINE_WINDOW_MS,
      todayTokens: sumDayRows(d.days, today),
      windowTokens: sumDayRows(d.days),
      lastActive: d.last_active,
      isLocal: false,
    });
  }
  return rows;
}

/** 单设备 days 聚合成日序列（升序）。 */
function deviceSeries(device: SyncDeviceRecord): DailyTrend[] {
  const byDay = new Map<string, number>();
  for (const r of device.days ?? []) byDay.set(r.day, (byDay.get(r.day) || 0) + sumDayRows([r]));
  return Array.from(byDay.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([day, tokens]) => ({ day, tokens, per_source: {} }));
}

/**
 * 按筛选值产出仪表盘日序列：
 * - "local"：本机 daily_archive 原样（既有行为）；
 * - "all"：本机序列 + 各远端设备日聚合逐日相加（远端只含最近 30 天同步窗口，诚实口径）；
 * - 远端 device_id：仅该设备的同步序列。
 * 本机自注册行（device_id === profileId）不参与合并——本机以 daily_archive 为准。
 */
export function mergedDaySeries(
  local: DailyTrend[],
  snapshot: SyncDevicesSnapshot | null | undefined,
  profileId: string | null | undefined,
  filter: DeviceFilter,
): DailyTrend[] {
  if (filter === "local") return local;
  const remotes = (snapshot?.devices ?? []).filter(d => !profileId || d.device_id !== profileId);
  if (filter !== "all") {
    const target = remotes.find(d => d.device_id === filter);
    return target ? deviceSeries(target) : [];
  }
  if (!remotes.length) return local;
  const merged = new Map<string, DailyTrend>();
  for (const d of local) merged.set(d.day, { day: d.day, tokens: d.tokens, per_source: { ...d.per_source } });
  for (const dev of remotes) {
    for (const [day, tokens] of deviceSeries(dev).map(d => [d.day, d.tokens] as const)) {
      const cur = merged.get(day);
      if (cur) cur.tokens += tokens;
      else merged.set(day, { day, tokens, per_source: {} });
    }
  }
  return Array.from(merged.values()).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

export interface SeriesMetrics { activeDays: number; currentStreak: number; longestStreak: number; peakDay: string | null; peakTokens: number }

/**
 * 从日序列直接推导指标（用于合并/远端视图——后端 trend_metrics 只算本机）。
 * 连续天数与后端同口径：current 从今日回走（今日无数据即为 0）；longest 为窗口内最长连续段。
 * 活跃时长（active_seconds）不在同步载荷内，远端视图必须显示「—」而非 0。
 */
export function seriesMetrics(days: DailyTrend[], todayKey: string): SeriesMetrics {
  const byDay = new Map(days.map(d => [d.day, d.tokens]));
  let currentStreak = 0;
  for (let cur = todayKey; (byDay.get(cur) || 0) > 0; cur = shiftDay(cur, -1)) currentStreak++;
  const sorted = days.filter(d => d.tokens > 0).map(d => d.day).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let longestStreak = 0, run = 0, prev: string | null = null;
  for (const day of sorted) {
    run = prev !== null && shiftDay(prev, 1) === day ? run + 1 : 1;
    if (run > longestStreak) longestStreak = run;
    prev = day;
  }
  let peak: DailyTrend | null = null;
  for (const d of days) if (d.tokens > 0 && (!peak || d.tokens > peak.tokens)) peak = d;
  return {
    activeDays: sorted.length,
    currentStreak,
    longestStreak,
    peakDay: peak?.day ?? null,
    peakTokens: peak?.tokens ?? 0,
  };
}
