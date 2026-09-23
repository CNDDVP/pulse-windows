// Round 6 多设备同步：前端合并逻辑纯函数单测（合成 fixture，不读真实数据）。
import {describe,expect,it} from 'vitest';
import {
  SYNC_ONLINE_WINDOW_MS,
  buildDeviceRows,
  localTodayKey,
  mergedDaySeries,
  seriesMetrics,
  sumDayRows,
} from './syncDevices';
import type {DailyTrend} from '../components/trendMetrics';
import type {SyncDeviceRecord,SyncDevicesSnapshot} from '../types';

const NOW = Date.parse('2026-09-23T12:00:00');
const TODAY = '2026-09-23';

const row = (day: string, input: number, output = 0, cache_read = 0, cache_write = 0) =>
  ({day, source: 'claude', model: 'm', input, output, cache_read, cache_write});

type DayRow = ReturnType<typeof row>;

const device = (id: string, name: string, lastActive: string, days: DayRow[]): SyncDeviceRecord =>
  ({device_id: id, device_name: name, app_version: '0.6.6', last_active: lastActive, days});

const snapshotWith = (...devices: SyncDeviceRecord[]): SyncDevicesSnapshot => ({version: 7, devices});

describe('localTodayKey / sumDayRows', () => {
  it('formats local date as YYYY-MM-DD with zero padding', () => {
    expect(localTodayKey(new Date(2026, 8, 3, 7, 5))).toBe('2026-09-03');
    expect(localTodayKey(new Date(2026, 11, 31))).toBe('2026-12-31');
  });
  it('sums the four token columns and filters by day', () => {
    const rows = [row(TODAY, 10, 2, 3, 5), row('2026-09-22', 100)];
    expect(sumDayRows(rows)).toBe(120);
    expect(sumDayRows(rows, TODAY)).toBe(20);
    expect(sumDayRows(undefined, TODAY)).toBe(0);
  });
});

describe('buildDeviceRows', () => {
  it('always renders the local row first with local ledger data, dedupes self-registration', () => {
    const snap = snapshotWith(
      device('self-id', 'DESKTOP-SELF', new Date(NOW).toISOString(), [row(TODAY, 999)]),
      device('remote-1', 'LivingPC', new Date(NOW).toISOString(), [row(TODAY, 11, 1)]),
    );
    const rows = buildDeviceRows({snapshot: snap, profileId: 'self-id', localName: '本机', localTodayTokens: 42, now: NOW});
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({id: 'self-id', name: '本机', online: true, todayTokens: 42, isLocal: true});
    // 自注册行（device_id === profileId）被本机行吸收，避免同机双计。
    expect(rows.some(r => r.name === 'DESKTOP-SELF')).toBe(false);
    expect(rows[1]).toMatchObject({id: 'remote-1', name: 'LivingPC', todayTokens: 12});
    expect(rows[1].windowTokens).toBe(12);
  });

  it('keeps the local row even without a snapshot (sync on, nothing pulled yet)', () => {
    const rows = buildDeviceRows({snapshot: null, profileId: null, localName: '本机', localTodayTokens: 5, now: NOW});
    expect(rows).toHaveLength(1);
    expect(rows[0].isLocal).toBe(true);
    expect(rows[0].todayTokens).toBe(5);
  });

  it('marks remote rows online within the window and offline after it', () => {
    const snap = snapshotWith(
      device('a', 'Fresh', new Date(NOW - 60_000).toISOString(), []),
      device('b', 'Stale', new Date(NOW - SYNC_ONLINE_WINDOW_MS - 1_000).toISOString(), []),
      device('c', 'Broken', 'not-a-date', []),
    );
    const rows = buildDeviceRows({snapshot: snap, profileId: null, localName: '本机', localTodayTokens: 0, now: NOW});
    const byId = new Map(rows.map(r => [r.id, r]));
    expect(byId.get('a')!.online).toBe(true);
    expect(byId.get('b')!.online).toBe(false);
    // last_active 无法解析 → 不猜在线。
    expect(byId.get('c')!.online).toBe(false);
  });

  it('counts remote today tokens only for the local-today key', () => {
    const snap = snapshotWith(device('r', 'PC', new Date(NOW).toISOString(), [row(TODAY, 7), row('2026-09-22', 500), row('2026-09-24', 999)]));
    const rows = buildDeviceRows({snapshot: snap, profileId: null, localName: '本机', localTodayTokens: 0, now: NOW});
    expect(rows[1].todayTokens).toBe(7);
    // 窗口合计含时区差一日的边缘行（今日 7 + 昨日 500 + 次日 999）。
    expect(rows[1].windowTokens).toBe(1506);
  });
});

describe('mergedDaySeries', () => {
  const local: DailyTrend[] = [
    {day: '2026-09-22', tokens: 100, per_source: {claude: 100}},
    {day: TODAY, tokens: 50, per_source: {}},
  ];
  const snap = snapshotWith(
    device('r1', 'PC1', new Date(NOW).toISOString(), [row('2026-09-22', 10), row(TODAY, 20)]),
    device('r2', 'PC2', new Date(NOW).toISOString(), [row('2026-09-20', 5)]),
  );

  it('"local" returns the local archive untouched', () => {
    expect(mergedDaySeries(local, snap, 'self', 'local')).toEqual(local);
  });

  it('"all" merges local and remote days per day without mutating the local input', () => {
    const merged = mergedDaySeries(local, snap, 'self', 'all');
    expect(merged.map(d => d.day)).toEqual(['2026-09-20', '2026-09-22', TODAY]);
    const at = (day: string) => merged.find(d => d.day === day)!.tokens;
    expect(at('2026-09-20')).toBe(5);
    expect(at('2026-09-22')).toBe(110);
    expect(at(TODAY)).toBe(70);
    // 本机输入不被原地修改。
    expect(local.find(d => d.day === '2026-09-22')!.tokens).toBe(100);
  });

  it('a remote filter returns only that device\u2019s series; unknown id yields empty', () => {
    expect(mergedDaySeries(local, snap, 'self', 'r1').map(d => d.tokens)).toEqual([10, 20]);
    expect(mergedDaySeries(local, snap, 'self', 'gone')).toEqual([]);
  });

  it('excludes the self-registered device from remote merges (local ledger is authoritative)', () => {
    const snap2 = snapshotWith(device('self', 'Self', new Date(NOW).toISOString(), [row(TODAY, 999)]));
    expect(mergedDaySeries(local, snap2, 'self', 'all')).toEqual(local);
  });

  it('without remotes "all" is the local view', () => {
    expect(mergedDaySeries(local, null, null, 'all')).toBe(local);
  });
});

describe('seriesMetrics', () => {
  it('computes active days, streaks and peak from a day series', () => {
    const days: DailyTrend[] = [
      {day: '2026-09-21', tokens: 10, per_source: {}},
      {day: '2026-09-22', tokens: 20, per_source: {}},
      {day: TODAY, tokens: 40, per_source: {}},
      {day: '2026-09-19', tokens: 5, per_source: {}},
    ];
    const m = seriesMetrics(days, TODAY);
    expect(m.activeDays).toBe(4);
    expect(m.currentStreak).toBe(3);
    expect(m.longestStreak).toBe(3);
    expect(m.peakDay).toBe(TODAY);
    expect(m.peakTokens).toBe(40);
  });

  it('current streak is zero when today has no data; longest still counts past runs', () => {
    const days: DailyTrend[] = [
      {day: '2026-09-21', tokens: 10, per_source: {}},
      {day: '2026-09-22', tokens: 20, per_source: {}},
    ];
    const m = seriesMetrics(days, TODAY);
    expect(m.currentStreak).toBe(0);
    expect(m.longestStreak).toBe(2);
    expect(m.activeDays).toBe(2);
    expect(m.peakDay).toBe('2026-09-22');
  });

  it('handles an all-zero/empty series without NaN or fake dates', () => {
    expect(seriesMetrics([], TODAY)).toEqual({activeDays: 0, currentStreak: 0, longestStreak: 0, peakDay: null, peakTokens: 0});
    const zero: DailyTrend[] = [{day: TODAY, tokens: 0, per_source: {}}];
    expect(seriesMetrics(zero, TODAY)).toEqual({activeDays: 0, currentStreak: 0, longestStreak: 0, peakDay: null, peakTokens: 0});
  });
});
