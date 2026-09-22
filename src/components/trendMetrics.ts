/** 趋势仪表盘纯函数：热力图 5 档分桶、7 天分桶 K 线（OHLC）、紧凑数值格式化。 */

export interface DailyTrend { day: string; tokens: number; per_source: Record<string, number> }
export interface TrendMetrics { days: DailyTrend[]; active_days: number; current_streak: number; longest_streak: number; peak_day: string | null; peak_tokens: number; active_seconds: number }

/** 活跃时长格式化：不足 1 小时显示分钟（mm），之后按时数+分钟显示（对齐 token-monitor 的 64h 50m）。 */
export function formatActiveTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0m";
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/** 热力图 5 档分桶（对标 token-monitor computeIntensities）：≥75%→4、≥50%→3、≥25%→2、>0→1、否则 0。 */
export function intensity(tokens: number, max: number): number {
  if (max <= 0 || tokens <= 0) return 0;
  const r = tokens / max;
  if (r >= 0.75) return 4;
  if (r >= 0.5) return 3;
  if (r >= 0.25) return 2;
  return 1;
}

export interface Candle { start: string; end: string; open: number; close: number; high: number; low: number; up: boolean }
/** K 线分桶（对标 usageCharts.js candleChart）：日序列按 bucketDays 一桶从最新往回分桶，
 *  open=桶首日 close=桶末日 high=max low=min up=close>=open；返回 oldest→newest，不足一桶的尾部（更早）单独成桶。 */
export function candles(days: DailyTrend[], bucketDays = 7): Candle[] {
  const out: Candle[] = [];
  for (let end = days.length; end > 0; end -= bucketDays) {
    const start = Math.max(0, end - bucketDays);
    const slice = days.slice(start, end);
    if (!slice.length) continue;
    const values = slice.map(d => d.tokens);
    const open = values[0], close = values[values.length - 1];
    out.push({ start: slice[0].day, end: slice[slice.length - 1].day, open, close, high: Math.max(...values), low: Math.min(...values), up: close >= open });
  }
  return out.reverse();
}

export interface HeatCell { day: string; tokens: number; level: number }
/** 热力图列（GitHub 风格，周日起头的 7 行周列）：首格按首日星期几前补 null。 */
export function heatmapColumns(days: DailyTrend[], max: number): (HeatCell | null)[][] {
  const lead = days.length ? new Date(days[0].day + "T00:00:00").getDay() : 0;
  const cells: (HeatCell | null)[] = Array.from({ length: lead }, (): HeatCell | null => null)
    .concat(days.map(d => ({ day: d.day, tokens: d.tokens, level: intensity(d.tokens, max) })));
  const cols: (HeatCell | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) cols.push(cells.slice(i, i + 7));
  return cols;
}

/** 紧凑数值（K/M/B）：1234→"1.2K"，12300000→"12.3M"，1200000000→"1.2B"，999→"999"。 */
export function compactTokens(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const sign = n < 0 ? "-" : "";
  const v = Math.abs(n);
  const fmt = (x: number, unit: string) => {
    let s = (Math.round(x * 10) / 10).toFixed(1);
    if (s.endsWith(".0")) s = s.slice(0, -2);
    return sign + s + unit;
  };
  if (v >= 1e9) return fmt(v / 1e9, "B");
  if (v >= 1e6) return fmt(v / 1e6, "M");
  if (v >= 1e3) return fmt(v / 1e3, "K");
  return sign + String(Math.round(v));
}
