import {useEffect,useRef,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {candles,compactTokens,formatActiveTime,heatmapColumns,type TrendMetrics} from "./trendMetrics";

// 5 档配色（level 0..4）：空档 → 最深 → 最亮，GitHub 贡献格风格。
const LEVEL_BG = ["bg-zinc-800", "bg-emerald-900", "bg-emerald-700", "bg-emerald-500", "bg-emerald-300"];

function MetricCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="p-3 bg-zinc-900/60 rounded-xl border border-white/5">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className="text-lg font-semibold text-zinc-100">{value}</p>
      {sub && <p className="text-[11px] text-zinc-500">{sub}</p>}
    </div>
  );
}

/** 7 天分桶 K 线（OHLC）：SVG 自绘，涨绿跌红；每桶悬停显示起止日期与四值。 */
function CandleChart({ buckets }: { buckets: ReturnType<typeof candles> }) {
  if (!buckets.length) return null;
  const W = 700, H = 160, pad = 18;
  const max = Math.max(...buckets.map(k => k.high), 1);
  const step = W / buckets.length;
  const y = (v: number) => H - pad - (v / max) * (H - pad * 2);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-40 mt-1" role="img" aria-label="7 天分桶 K 线">
      <line x1={0} x2={W} y1={H - pad} y2={H - pad} stroke="currentColor" className="text-zinc-700" strokeWidth={1} />
      {buckets.map((k, i) => {
        const cx = (i + 0.5) * step;
        const top = y(Math.max(k.open, k.close));
        const bottom = y(Math.min(k.open, k.close));
        const color = k.up ? "#34d399" : "#fb7185";
        const bodyW = Math.max(step * 0.5, 2);
        return (
          <g key={k.start} className="trend-candle" data-up={k.up ? "1" : "0"}>
            <title>{`${k.start} ~ ${k.end}：开 ${compactTokens(k.open)}，收 ${compactTokens(k.close)}，最高 ${compactTokens(k.high)}，最低 ${compactTokens(k.low)}`}</title>
            <line x1={cx} x2={cx} y1={y(k.high)} y2={y(k.low)} stroke={color} strokeWidth={1.5} />
            <rect x={cx - bodyW / 2} y={top} width={bodyW} height={Math.max(bottom - top, 2)} fill={color} rx={1} />
            {(i % 4 === 0 || i === buckets.length - 1) && (
              <text x={cx} y={H - 4} textAnchor="middle" className="fill-zinc-500" fontSize={10}>{k.start.slice(5)}</text>
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
      <p className="text-sm text-zinc-400">跨年趋势视图，以每日归档为主数据源（本地午夜切天，最多 370 天滚动窗口）。</p>
      <div className="flex gap-3">
        <button disabled={busy} className="bg-emerald-700 px-3 rounded disabled:opacity-40" onClick={() => void load()}>{busy ? "正在读取…" : "读取趋势"}</button>
        <button disabled={!days.length || exporting} className="bg-zinc-800 px-3 rounded disabled:opacity-40" onClick={() => void doExport()}>{exporting ? "正在导出…" : "导出趋势 JSON"}</button>
      </div>
      {error && <p className="text-amber-400">{error}</p>}
      {exported && <p className="text-xs text-emerald-400 break-all">已导出到 {exported}</p>}
      {!hasData && !busy && !error && <p className="text-sm text-zinc-500">暂无归档数据；先在「汇总」页签读取使用记录，归档会随后续扫描累积。</p>}
      {hasData && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <MetricCard label="活跃天数" value={`${metrics?.active_days ?? 0} 天`} sub={`窗口共 ${days.length} 天`} />
            <MetricCard label="活跃时间" value={formatActiveTime(metrics?.active_seconds ?? 0)} sub="跨来源不去重、并行累计" />
            <MetricCard label="当前连续" value={`${metrics?.current_streak ?? 0} 天`} sub="从今天回走" />
            <MetricCard label="最长连续" value={`${metrics?.longest_streak ?? 0} 天`} sub="历史最长连续段" />
            <MetricCard label="峰值单日" value={compactTokens(metrics?.peak_tokens ?? 0)} sub={metrics?.peak_day ?? "—"} />
            <MetricCard label="窗口总量" value={compactTokens(total)} sub="全部口径 tokens" />
          </div>
          <div className="p-4 bg-zinc-900/60 rounded-xl border border-white/5">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-zinc-200">每日消耗热力图</h3>
              <div className="flex items-center gap-1 text-[10px] text-zinc-500">少{LEVEL_BG.map(c => <span key={c} className={`w-3 h-3 rounded-[3px] ${c}`} data-level-legend />)}多</div>
            </div>
            <div className="overflow-x-auto pb-1">
              <div className="grid grid-flow-col gap-[3px]" style={{ gridTemplateRows: "repeat(7,12px)", gridAutoColumns: "12px" }}>
                {cols.map((col, ci) => col.map((cell, ri) => cell === null
                  ? <div key={`${ci}-${ri}`} />
                  : <div key={`${ci}-${ri}`} data-level={cell.level} title={`${cell.day}：${compactTokens(cell.tokens)} tokens`} className={`rounded-[3px] ${LEVEL_BG[cell.level]}`} />))}
              </div>
            </div>
          </div>
          <div className="p-4 bg-zinc-900/60 rounded-xl border border-white/5">
            <h3 className="text-sm font-semibold text-zinc-200">7 天分桶 K 线</h3>
            <CandleChart buckets={buckets} />
            <div className="flex justify-between text-[10px] text-zinc-500 mt-1">
              <span>每桶 7 天（开=桶首日，收=桶末日）</span>
              <span>峰值 {compactTokens(max)} tokens/日</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
