import {useEffect,useRef,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {candles,compactTokens,formatActiveTime,heatmapColumns,type TrendMetrics} from "./trendMetrics";
import {useLang} from "../lib/i18n";

// 5 档配色（level 0..4）：空档 → 最浅 → 最深，GitHub 贡献格风格。
// Round5d 项目一：档位色在 index.css 用强调令牌混出（.heat-0..4），深浅主题各自成立。
const LEVEL_BG = ["heat-0", "heat-1", "heat-2", "heat-3", "heat-4"];

function MetricCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="p-3 bg-[var(--surface-2)] rounded-xl border border-[var(--border)]">
      <p className="text-xs text-[var(--text-3)]">{label}</p>
      <p className="text-lg font-semibold text-[var(--text-1)]">{value}</p>
      {sub && <p className="text-[11px] text-[var(--text-3)]">{sub}</p>}
    </div>
  );
}

/** 7 天分桶 K 线（OHLC）：SVG 自绘，涨绿跌红；每桶悬停显示起止日期与四值。 */
function CandleChart({ buckets }: { buckets: ReturnType<typeof candles> }) {
  // Round 5c：aria 与悬停 title 走 t()（未包 Provider 时回落 zh，与旧测试一致）。
  const { t } = useLang();
  if (!buckets.length) return null;
  const W = 700, H = 160, pad = 18;
  const max = Math.max(...buckets.map(k => k.high), 1);
  const step = W / buckets.length;
  const y = (v: number) => H - pad - (v / max) * (H - pad * 2);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-40 mt-1" role="img" aria-label={t("spend.trend.candles_title")}>
      <line x1={0} x2={W} y1={H - pad} y2={H - pad} stroke="currentColor" className="text-[var(--text-1)]" strokeWidth={1} />
      {buckets.map((k, i) => {
        const cx = (i + 0.5) * step;
        const top = y(Math.max(k.open, k.close));
        const bottom = y(Math.min(k.open, k.close));
        const color = k.up ? "#34d399" : "#fb7185";
        const bodyW = Math.max(step * 0.5, 2);
        return (
          <g key={k.start} className="trend-candle" data-up={k.up ? "1" : "0"}>
            <title>{t("spend.trend.candle_title", { start: k.start, end: k.end, open: compactTokens(k.open), close: compactTokens(k.close), high: compactTokens(k.high), low: compactTokens(k.low) })}</title>
            <line x1={cx} x2={cx} y1={y(k.high)} y2={y(k.low)} stroke={color} strokeWidth={1.5} />
            <rect x={cx - bodyW / 2} y={top} width={bodyW} height={Math.max(bottom - top, 2)} fill={color} rx={1} />
            {(i % 4 === 0 || i === buckets.length - 1) && (
              <text x={cx} y={H - 4} textAnchor="middle" className="fill-[var(--text-3)]" fontSize={10}>{k.start.slice(5)}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** 跨年趋势仪表盘：370 天热力图（5 档）+ 7 天分桶 K 线 + 指标卡。数据来自 daily_archive。 */
export function TrendDashboard({ active = true }: { active?: boolean }) {
  const [metrics, setMetrics] = useState<TrendMetrics | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [exported, setExported] = useState("");
  const [exporting, setExporting] = useState(false);
  // Round 5c：仪表盘全部用户可见文案走 t()（未包 Provider 时回落 zh，与旧测试一致）。
  const { t } = useLang();
  // 与 TokenSpend 同款请求序号：切走页签后到达的旧回包不得覆盖新状态。
  const request = useRef(0);

  const load = async () => {
    const seq = ++request.current;
    setBusy(true); setError(""); setExported("");
    try {
      const m = await invoke<TrendMetrics>("trend_metrics");
      if (seq === request.current) setMetrics(m);
    } catch (e) {
      const s = String(e);
      // 「已取消」为后端哨兵；TODO(EN-backend)：Rust 侧消息原样展示，不翻译。
      if (seq === request.current && s !== "已取消" && !s.includes("已取消")) setError(s);
    } finally {
      if (seq === request.current) setBusy(false);
    }
  };

  useEffect(() => {
    if (active) {
      void load();
    } else {
      request.current++;
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
  useEffect(() => () => { request.current++; }, []);

  const doExport = async () => {
    // 与 TokenSpend 导出同款在途防抖：一次导出未完成时连点不再重复派发（避免生成多个重复文件）。
    if (!metrics?.days.length || busy || exporting) return;
    const seq = ++request.current;
    setExporting(true);
    try {
      const path = await invoke<string>("export_trend", { metrics });
      if (seq === request.current) setExported(path);
    } catch (e) {
      if (seq === request.current) setError(String(e));
    } finally {
      setExporting(false);
    }
  };

  const days = metrics?.days ?? [];
  // 后端恒补零填满 370 天窗口（热力图/K 线需要连续日轴），「有无数据」看窗口内是否存在非零日，
  // 而非 days.length——否则空库也会渲染「峰值 0 + 369 天前日期」的误导指标卡，空态文案永不可达。
  const hasData = days.some(d => d.tokens > 0);
  const max = days.reduce((m, d) => Math.max(m, d.tokens), 0);
  const cols = heatmapColumns(days, max);
  const buckets = candles(days, 7);
  const total = days.reduce((s, d) => s + d.tokens, 0);

  return (
    <div className="space-y-4">
      <p className="text-sm text-[var(--text-2)]">{t("spend.trend.description")}</p>
      <div className="flex gap-3">
        <button disabled={busy} className="bg-[var(--accent-solid)] text-[var(--on-solid)] px-3 rounded disabled:opacity-40" onClick={() => void load()}>{busy ? t("spend.scanning") : t("spend.trend.load")}</button>
        <button disabled={!days.length || exporting} className="bg-[var(--surface-3)] px-3 rounded disabled:opacity-40" onClick={() => void doExport()}>{exporting ? t("spend.exporting") : t("spend.trend.export")}</button>
      </div>
      {/* TODO(EN-backend)：error 为 Rust 侧消息，原样展示不翻译 */}
      {error && <p className="text-[var(--warn)]">{error}</p>}
      {exported && <p className="text-xs text-[var(--ok)] break-all">{t("spend.exported_to", { path: exported })}</p>}
      {!hasData && !busy && !error && <p className="text-sm text-[var(--text-3)]">{t("spend.trend.empty", { summary: t("spend.tab.summary") })}</p>}
      {hasData && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <MetricCard label={t("spend.trend.metric.active_days")} value={t("spend.trend.unit_days", { count: metrics?.active_days ?? 0 })} sub={t("spend.trend.sub.window_days", { count: days.length })} />
            <MetricCard label={t("spend.trend.metric.active_time")} value={formatActiveTime(metrics?.active_seconds ?? 0)} sub={t("spend.trend.sub.active_time")} />
            <MetricCard label={t("spend.trend.metric.current_streak")} value={t("spend.trend.unit_days", { count: metrics?.current_streak ?? 0 })} sub={t("spend.trend.sub.current_streak")} />
            <MetricCard label={t("spend.trend.metric.longest_streak")} value={t("spend.trend.unit_days", { count: metrics?.longest_streak ?? 0 })} sub={t("spend.trend.sub.longest_streak")} />
            <MetricCard label={t("spend.trend.metric.peak_day")} value={compactTokens(metrics?.peak_tokens ?? 0)} sub={metrics?.peak_day ?? "—"} />
            <MetricCard label={t("spend.trend.metric.window_total")} value={compactTokens(total)} sub={t("spend.trend.sub.window_total")} />
          </div>
          <div className="p-4 bg-[var(--surface-2)] rounded-xl border border-[var(--border)]">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-[var(--text-1)]">{t("spend.trend.heatmap_title")}</h3>
              <div className="flex items-center gap-1 text-[10px] text-[var(--text-3)]">{t("spend.trend.legend_less")}{LEVEL_BG.map(c => <span key={c} className={`w-3 h-3 rounded-[3px] ${c}`} data-level-legend />)}{t("spend.trend.legend_more")}</div>
            </div>
            <div className="overflow-x-auto pb-1">
              <div className="grid grid-flow-col gap-[3px]" style={{ gridTemplateRows: "repeat(7,12px)", gridAutoColumns: "12px" }}>
                {cols.map((col, ci) => col.map((cell, ri) => cell === null
                  ? <div key={`${ci}-${ri}`} />
                  : <div key={`${ci}-${ri}`} data-level={cell.level} title={t("spend.trend.cell_title", { day: cell.day, tokens: compactTokens(cell.tokens) })} className={`rounded-[3px] ${LEVEL_BG[cell.level]}`} />))}
              </div>
            </div>
          </div>
          <div className="p-4 bg-[var(--surface-2)] rounded-xl border border-[var(--border)]">
            <h3 className="text-sm font-semibold text-[var(--text-1)]">{t("spend.trend.candles_title")}</h3>
            <CandleChart buckets={buckets} />
            <div className="flex justify-between text-[10px] text-[var(--text-3)] mt-1">
              <span>{t("spend.trend.bucket_note")}</span>
              <span>{t("spend.trend.peak_per_day", { tokens: compactTokens(max) })}</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
