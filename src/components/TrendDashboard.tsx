import {useCallback,useEffect,useRef,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {candles,compactTokens,formatActiveTime,heatmapColumns,type DailyTrend,type TrendMetrics} from "./trendMetrics";
import {buildDeviceRows,localTodayKey,mergedDaySeries,seriesMetrics,type DeviceFilter} from "../lib/syncDevices";
import {ageText} from "../pages/settings/constants";
import type {SyncDevicesSnapshot,SyncHubStatusInfo} from "../types";
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

// 相对时间（设备最后活跃）：复用 settings/constants.ts 的 ageText（含畸形
// 时间戳 → "—" 守卫与 settings.ago.* 词典），不再本地重复实现。

/**
 * 跨年趋势仪表盘：370 天热力图（5 档）+ 7 天分桶 K 线 + 指标卡。数据来自 daily_archive。
 * Round 6：上方新增「设备」筛选/汇总行——每设备今日 tokens + 在线状态；
 * 筛选决定仪表盘数据源：「全部设备」为本机 daily_archive + 远端设备同步聚合的合并视图
 * （远端仅最近 30 天，诚实标注），「本机」保持既有行为，单个远端设备仅显示其同步窗口。
 */
export function TrendDashboard({ active = true }: { active?: boolean }) {
  const [metrics, setMetrics] = useState<TrendMetrics | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [exported, setExported] = useState("");
  const [exporting, setExporting] = useState(false);
  // Round 6 设备行：同步模式（off 时整行不显示）、合并快照、本机 profile id、当前筛选。
  const [syncMode, setSyncMode] = useState<string>("off");
  const [snapshot, setSnapshot] = useState<SyncDevicesSnapshot | null>(null);
  const [devicesError, setDevicesError] = useState("");
  const [profileId, setProfileId] = useState<string | null>(null);
  const [deviceFilter, setDeviceFilter] = useState<DeviceFilter>("all");
  const [nowMs, setNowMs] = useState(() => Date.now());
  // Round 5c：仪表盘全部用户可见文案走 t()（未包 Provider 时回落 zh，与旧测试一致）。
  const { t } = useLang();
  // 与 TokenSpend 同款请求序号：切走页签后到达的旧回包不得覆盖新状态。
  // 趋势域（load/export）与设备域（loadDevices）各持独立计数器——共用会让任一域
  // 的刷新把另一域的在途回包整批作废（设备行最长陈旧 60s）。
  const request = useRef(0);
  const deviceRequest = useRef(0);

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

  // 设备行数据源（Round 6）：快照 + 同步模式 + 本机 profile id。任一失败诚实降级：
  // 快照读不到 → 仅本机行 + 降级文案；状态读不到 → 按关闭处理（整行隐藏）。
  // 独立序号（deviceRequest）：借用趋势域计数器会让「加载趋势/导出」顺手丢弃
  // 在途设备响应。
  const loadDevices = useCallback(() => {
    const seq = ++deviceRequest.current;
    void invoke<SyncDevicesSnapshot | null>("sync_devices_snapshot")
      .then(s => { if (seq === request.current) { setSnapshot(s ?? null); setDevicesError(""); } })
      .catch(e => { if (seq === request.current) { setSnapshot(null); setDevicesError(String(e)); } });
    void invoke<SyncHubStatusInfo>("sync_hub_status")
      .then(s => { if (seq === request.current) setSyncMode(s?.mode ?? "off"); })
      .catch(() => { if (seq === request.current) setSyncMode("off"); });
    void invoke<{ profile_id: string }>("get_profile_info")
      .then(p => { if (seq === request.current) setProfileId(p?.profile_id ?? null); })
      .catch(() => { if (seq === request.current) setProfileId(null); });
    setNowMs(Date.now());
  }, []);

  useEffect(() => {
    if (active) {
      void load();
      loadDevices();
      // 设备在线状态依赖 60s 轮询心跳：active 期间每 60s 刷新一次快照。
      const timer = window.setInterval(loadDevices, 60_000);
      return () => window.clearInterval(timer);
    }
    request.current++;
    deviceRequest.current++;
    setBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
  useEffect(() => () => { request.current++; deviceRequest.current++; }, []);

  const doExport = async () => {
    // 与 TokenSpend 导出同款在途防抖：一次导出未完成时连点不再重复派发（避免生成多个重复文件）。
    if (!days.length || busy || exporting) return;
    const seq = ++request.current;
    setExporting(true);
    try {
      const path = await invoke<string>("export_trend", { metrics: exportMetrics });
      if (seq === request.current) setExported(path);
    } catch (e) {
      if (seq === request.current) setError(String(e));
    } finally {
      setExporting(false);
    }
  };

  // ---------------------------------------------------------------------------
  // 合并视图（Round 6）：本机 daily_archive + 远端设备同步聚合
  // ---------------------------------------------------------------------------
  const localDays = metrics?.days ?? [];
  const todayKey = localTodayKey(new Date(nowMs));
  const localTodayTokens = localDays.find(d => d.day === todayKey)?.tokens ?? 0;
  const deviceRows = buildDeviceRows({
    snapshot: syncMode !== "off" ? snapshot : null,
    profileId,
    localName: t("spend.trend.device_local"),
    localTodayTokens,
    now: nowMs,
  });
  const hasRemotes = deviceRows.length > 1;
  // 筛选兜底："all"/"local" 恒有效；所选远端设备已从快照消失（被 hub 剔除/清库）时回退「全部」。
  const filter: DeviceFilter = deviceFilter === "all" || deviceFilter === "local"
    || (hasRemotes && deviceRows.some(r => r.id === deviceFilter)) ? deviceFilter : "all";
  // 同步关闭时不显示设备行（快照不再刷新，展示即误导）；同步开启但尚无其他设备时
  // 显示本机行 + 引导文案。
  const showDeviceRow = syncMode === "host" || syncMode === "connect";
  // showDeviceRow 为真即 syncMode ∈ {host, connect}（TS 经此常量收窄），快照直接参与合并。
  const effectiveDays: DailyTrend[] = showDeviceRow
    ? mergedDaySeries(localDays, snapshot, profileId, filter)
    : localDays;
  const remoteContributing = showDeviceRow && filter === "all" ? hasRemotes : showDeviceRow && filter !== "local";
  const viewIsLocalOnly = !remoteContributing;

  const days = effectiveDays;
  // 「有无数据」看当前视图窗口内是否存在非零日，而非 days.length——空库/全零窗口
  // 不得渲染「峰值 0 + 369 天前日期」的误导指标卡（Round 6 起按合并视图口径判定）。
  const hasData = days.some(d => d.tokens > 0);
  const max = days.reduce((m, d) => Math.max(m, d.tokens), 0);
  const cols = heatmapColumns(days, max);
  const buckets = candles(days, 7);
  const total = days.reduce((s, d) => s + d.tokens, 0);

  // 指标卡数据源：本机视图用后端 trend_metrics 原值（含活跃时长）；含远端的视图
  // 由合并日序列推导，且活跃时长诚实显示「—」（同步载荷不含 active_seconds）。
  const series = viewIsLocalOnly ? null : seriesMetrics(days, todayKey);
  const card = {
    activeDays: series ? series.activeDays : metrics?.active_days ?? 0,
    activeSeconds: series ? null : metrics?.active_seconds ?? 0,
    currentStreak: series ? series.currentStreak : metrics?.current_streak ?? 0,
    longestStreak: series ? series.longestStreak : metrics?.longest_streak ?? 0,
    peakDay: series ? series.peakDay : metrics?.peak_day ?? null,
    peakTokens: series ? series.peakTokens : metrics?.peak_tokens ?? 0,
  };

  // 导出随当前视图：本机视图导出后端原值；合并/远端视图导出该视图的合并序列
  // （active_seconds 为 0——同步载荷不含活跃时长，导出文件同样如实为 0）。
  const exportMetrics: TrendMetrics = viewIsLocalOnly && metrics
    ? metrics
    : {
        days,
        active_days: card.activeDays,
        current_streak: card.currentStreak,
        longest_streak: card.longestStreak,
        peak_day: card.peakDay,
        peak_tokens: card.peakTokens,
        active_seconds: 0,
      };

  const scopeNote = !showDeviceRow
    ? ""
    : filter === "local" || (filter === "all" && !hasRemotes)
      ? t("spend.trend.scope_note_local")
      : filter === "all"
        ? t("spend.trend.scope_note_all")
        : t("spend.trend.scope_note_remote");

  return (
    <div className="space-y-4">
      <p className="text-sm text-[var(--text-2)]">{t("spend.trend.description")}</p>
      <div className="flex gap-3">
        <button disabled={busy} className="bg-[var(--accent-solid)] text-[var(--on-solid)] px-3 rounded disabled:opacity-40" onClick={() => void load()}>{busy ? t("spend.scanning") : t("spend.trend.load")}</button>
        <button disabled={!days.length || exporting} className="bg-[var(--surface-3)] px-3 rounded disabled:opacity-40" onClick={() => void doExport()}>{exporting ? t("spend.exporting") : t("spend.trend.export")}</button>
      </div>
      {/* Round 6：设备筛选/汇总行（每设备今日 tokens + 在线状态，数据为本机+远端合并）。 */}
      {showDeviceRow && (
        <div className="p-4 bg-[var(--surface-2)] rounded-xl border border-[var(--border)] space-y-2" data-testid="device-summary-row">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-[var(--text-1)]">{t("spend.trend.devices_title")}</h3>
            {/* TODO(EN-backend)：快照读取失败为 Rust 侧消息，原样展示不翻译 */}
            {devicesError && <span className="text-[11px] text-[var(--warn)]">{devicesError}</span>}
          </div>
          <div className="flex flex-wrap gap-2">
            {hasRemotes && (
              <button
                onClick={() => setDeviceFilter("all")}
                aria-pressed={filter === "all"}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border text-xs transition-colors ${filter === "all" ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--text-1)]" : "border-[var(--border)] bg-[var(--surface)] text-[var(--text-2)] hover:bg-[var(--hover)]"}`}
              >
                <span>{t("spend.trend.device_all")}</span>
                <span className="font-mono">{compactTokens(deviceRows.reduce((s, r) => s + r.todayTokens, 0))}</span>
              </button>
            )}
            {deviceRows.map(row => (
              <button
                key={row.id}
                onClick={() => setDeviceFilter(row.isLocal ? "local" : row.id)}
                aria-pressed={filter === (row.isLocal ? "local" : row.id)}
                title={row.isLocal ? undefined : t("spend.trend.device_last_active", { ago: ageText(row.lastActive, t, nowMs) })}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border text-xs transition-colors ${filter === (row.isLocal ? "local" : row.id) ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--text-1)]" : "border-[var(--border)] bg-[var(--surface)] text-[var(--text-2)] hover:bg-[var(--hover)]"}`}
              >
                {/* 在线判定：本机恒在线；远端 3 个轮询拍（180s）无心跳即离线。 */}
                <span
                  data-testid={`device-dot-${row.isLocal ? "local" : row.id}`}
                  title={row.online ? t("spend.trend.device_online") : t("spend.trend.device_offline")}
                  className={`w-2 h-2 rounded-full ${row.online ? "bg-[var(--ok)]" : "bg-[var(--text-3)] opacity-60"}`}
                />
                <span className="max-w-40 truncate">{row.name}</span>
                <span className="font-mono">{compactTokens(row.todayTokens)}</span>
                <span className="text-[10px] text-[var(--text-3)]">{row.online ? t("spend.trend.device_online") : t("spend.trend.device_offline")}</span>
              </button>
            ))}
          </div>
          {!hasRemotes && <p className="text-[11px] text-[var(--text-3)]">{t("spend.trend.device_none")}</p>}
          <p className="text-[11px] text-[var(--text-3)]">{scopeNote}</p>
        </div>
      )}
      {/* TODO(EN-backend)：error 为 Rust 侧消息，原样展示不翻译 */}
      {error && <p className="text-[var(--warn)]">{error}</p>}
      {exported && <p className="text-xs text-[var(--ok)] break-all">{t("spend.exported_to", { path: exported })}</p>}
      {!hasData && !busy && !error && <p className="text-sm text-[var(--text-3)]">{t("spend.trend.empty", { summary: t("spend.tab.summary") })}</p>}
      {hasData && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <MetricCard label={t("spend.trend.metric.active_days")} value={t("spend.trend.unit_days", { count: card.activeDays })} sub={t("spend.trend.sub.window_days", { count: days.length })} />
            <MetricCard label={t("spend.trend.metric.active_time")} value={card.activeSeconds === null ? "—" : formatActiveTime(card.activeSeconds)} sub={card.activeSeconds === null ? t("spend.trend.remote_no_active_time") : t("spend.trend.sub.active_time")} />
            <MetricCard label={t("spend.trend.metric.current_streak")} value={t("spend.trend.unit_days", { count: card.currentStreak })} sub={t("spend.trend.sub.current_streak")} />
            <MetricCard label={t("spend.trend.metric.longest_streak")} value={t("spend.trend.unit_days", { count: card.longestStreak })} sub={t("spend.trend.sub.longest_streak")} />
            <MetricCard label={t("spend.trend.metric.peak_day")} value={compactTokens(card.peakTokens)} sub={card.peakDay ?? "—"} />
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
