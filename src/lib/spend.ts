// Round4 项目三/四：TokenSpend 页表格与订阅面板共用的纯展示层计算。
// ledger 数据结构不动；这里的聚合与后端 scan 的按分组求和口径一致。
import type {SubscriptionRecord} from '../types';

export interface SpendRow {
  source: string; model: string; day: string; hour: string;
  input: number; output: number; cache_read: number; cache_write: number; partial: boolean;
}
export interface SpendCounts { input: number; output: number; cache_read: number; cache_write: number }

export type SpendGroup = "day" | "hour" | "model";

/** 本地审计覆盖的来源清单（ledger sources_with_cancel 同口径）；订阅入口只提供给这些来源，
 *  API 额度类供应商（不在本地审计的）不出现。 */
export const SPEND_SOURCES: [string, string][] = [
  ["claude", "Claude Code"], ["codex", "Codex"], ["gemini", "Gemini CLI"], ["cline", "Cline"],
  ["roocode", "Roo Code"], ["kilocode", "Kilo Code"], ["openclaw", "OpenClaw"], ["zcode", "ZCode"],
  ["qwen", "Qwen CLI"], ["opencode", "OpenCode"],
];

export function emptyCounts(): SpendCounts {
  return { input: 0, output: 0, cache_read: 0, cache_write: 0 };
}

/** 与 TokenSpend 页原内联聚合一致：按 天 / 天+小时 / 来源+模型 分组四分项求和。 */
export function groupSpendRows(rows: SpendRow[], group: SpendGroup): Map<string, SpendCounts> {
  const out = new Map<string, SpendCounts>();
  for (const r of rows) {
    const key = group === "model" ? `${r.source} / ${r.model}` : group === "hour" ? `${r.day} ${r.hour}` : r.day;
    const old = out.get(key) ?? emptyCounts();
    out.set(key, {
      input: old.input + r.input, output: old.output + r.output,
      cache_read: old.cache_read + r.cache_read, cache_write: old.cache_write + r.cache_write,
    });
  }
  return out;
}

export function sumCounts(list: SpendCounts[]): SpendCounts {
  return list.reduce((a, c) => ({
    input: a.input + c.input, output: a.output + c.output,
    cache_read: a.cache_read + c.cache_read, cache_write: a.cache_write + c.cache_write,
  }), emptyCounts());
}

/**
 * 缓存命中率 = cache_read / (input + cache_read + output)。
 * cache_write 不进分母（写入不是命中）；分母 0 或非有限 → null，调用方不显示命中率。
 */
export function cacheHitRate(c: Pick<SpendCounts, "input" | "output" | "cache_read">): number | null {
  const denom = c.input + c.cache_read + c.output;
  if (!Number.isFinite(denom) || denom <= 0) return null;
  return c.cache_read / denom;
}

/** 命中率展示文本；入参 null（分母 0）原样返回 null = 不显示。 */
export function formatHitRate(rate: number | null): string | null {
  if (rate == null || !Number.isFinite(rate)) return null;
  return `${(rate * 100).toFixed(1)}%`;
}

/** 本地日历月前缀（YYYY-MM），与后端 Summary.month_cost_by_source 的口径一致。 */
export function monthPrefix(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/** 与后端 SubscriptionRecord::validate 同界的起始日校验：空串放行，否则必须真实存在（拒绝 2026-02-31）。 */
function validStartDate(s: string): boolean {
  if (s === '') return true;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d;
}

/**
 * 「保存会接受」的订阅记录口径（Round4 项目三，与后端 save_subscriptions +
 * SubscriptionRecord::validate 同界）：价格 >0 视为已登记（先按保存路径归一化
 * price/cycle_days），其余字段须通过后端同界校验——币种三位大写、周期 1~366、
 * 起始日 YYYY-MM-DD 或空、备注 ≤500 字、来源键 valid_id 白名单字符。
 * 保存把整表交后端校验（非法报错不落盘）；导出则只携带这些记录，使
 * 「导出与保存同口径」的声明对周期等全部字段成立，被拒绝的草稿不进导出文件。
 */
export function savableSubscriptions(subs: Record<string, SubscriptionRecord>): Record<string, SubscriptionRecord> {
  const out: Record<string, SubscriptionRecord> = {};
  for (const [id, raw] of Object.entries(subs)) {
    // 与 SubscriptionPanel.save 同样的归一化；价格按保存口径取 >0 为已登记。
    const rec = {...raw, price: Number(raw.price), cycle_days: Math.round(Number(raw.cycle_days) || 0)};
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) continue; // 后端 valid_id 同界
    if (!Number.isFinite(rec.price) || !(rec.price > 0) || rec.price > 1_000_000) continue;
    if (!/^[A-Z]{3}$/.test(rec.currency)) continue;
    if (!Number.isInteger(rec.cycle_days) || rec.cycle_days < 1 || rec.cycle_days > 366) continue;
    if (!validStartDate(rec.start_date)) continue;
    if ([...rec.note].length > 500) continue;
    out[id] = rec;
  }
  return out;
}

/**
 * 订阅面板口径提示：读取窗口未覆盖本月 1 日时，"本月成本" 实际只统计窗口内天数，数值偏低。
 * 返回 null 表示窗口已覆盖整月，无需提示。
 */
export function monthCoverageNote(days: number, now = new Date()): string | null {
  if (!Number.isFinite(days) || days <= 0) return null;
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const windowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  if (windowStart <= first) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `读取窗口自 ${windowStart.getFullYear()}-${pad(windowStart.getMonth() + 1)}-${pad(windowStart.getDate())} 起，未覆盖月初，本月成本偏低。`;
}
