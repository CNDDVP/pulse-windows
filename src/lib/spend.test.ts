import {describe,it,expect} from 'vitest';
import {
  groupSpendRows, sumCounts, cacheHitRate, formatHitRate, monthPrefix, monthCoverageNote, savableSubscriptions, SPEND_SOURCES,
} from './spend';
import type {SpendRow} from './spend';
import type {SubscriptionRecord} from '../types';

const row = (over: Partial<SpendRow>): SpendRow => ({
  source: 'claude', model: 'glm-5', day: '2026-09-23', hour: '08:00',
  input: 1, output: 2, cache_read: 3, cache_write: 4, partial: false, ...over,
});

describe('groupSpendRows', () => {
  const rows = [
    row({}),
    row({ model: 'claude-opus', hour: '09:00', input: 10, output: 20, cache_read: 30, cache_write: 40 }),
    row({ source: 'codex', day: '2026-09-22', hour: '23:00' }),
  ];

  it('groups by day and sums the four counts', () => {
    const m = groupSpendRows(rows, 'day');
    expect([...m.keys()].sort()).toEqual(['2026-09-22', '2026-09-23']);
    expect(m.get('2026-09-23')).toEqual({input: 11, output: 22, cache_read: 33, cache_write: 44});
  });

  it('groups by day+hour', () => {
    const m = groupSpendRows(rows, 'hour');
    expect(m.get('2026-09-23 08:00')).toEqual({input: 1, output: 2, cache_read: 3, cache_write: 4});
    expect(m.get('2026-09-23 09:00')).toEqual({input: 10, output: 20, cache_read: 30, cache_write: 40});
  });

  it('labels the model group as "source / model"', () => {
    const m = groupSpendRows(rows, 'model');
    expect(m.get('claude / glm-5')).toEqual({input: 1, output: 2, cache_read: 3, cache_write: 4});
    expect(m.get('claude / claude-opus')).toEqual({input: 10, output: 20, cache_read: 30, cache_write: 40});
    expect(m.get('codex / glm-5')).toEqual({input: 1, output: 2, cache_read: 3, cache_write: 4});
  });

  it('returns an empty map for empty rows', () => {
    expect(groupSpendRows([], 'model').size).toBe(0);
  });
});

describe('sumCounts', () => {
  it('totals across groups for the summary row', () => {
    const total = sumCounts([
      {input: 1, output: 2, cache_read: 3, cache_write: 4},
      {input: 10, output: 20, cache_read: 30, cache_write: 40},
    ]);
    expect(total).toEqual({input: 11, output: 22, cache_read: 33, cache_write: 44});
    expect(sumCounts([])).toEqual({input: 0, output: 0, cache_read: 0, cache_write: 0});
  });
});

describe('cacheHitRate', () => {
  it('divides cache_read by input + cache_read + output', () => {
    expect(cacheHitRate({input: 60, output: 10, cache_read: 30})).toBeCloseTo(0.3, 12);
    expect(cacheHitRate({input: 0, output: 0, cache_read: 5})).toBe(1);
  });
  it('denominator is exactly input + cache_read + output', () => {
    // cache_write 不进分母：函数签名只收 input/output/cache_read，写入不是命中。
    expect(cacheHitRate({input: 10, output: 5, cache_read: 5})).toBeCloseTo(0.25, 12);
  });
  it('returns null when the denominator is 0 (rate not shown)', () => {
    expect(cacheHitRate({input: 0, output: 0, cache_read: 0})).toBeNull();
  });
});

describe('formatHitRate', () => {
  it('formats one decimal percent and passes null through', () => {
    expect(formatHitRate(0.3)).toBe('30.0%');
    expect(formatHitRate(1)).toBe('100.0%');
    expect(formatHitRate(null)).toBeNull();
    expect(formatHitRate(Number.NaN)).toBeNull();
  });
});

describe('monthPrefix', () => {
  it('formats the local calendar month as YYYY-MM', () => {
    expect(monthPrefix(new Date(2026, 8, 23))).toBe('2026-09');
    expect(monthPrefix(new Date(2026, 0, 1))).toBe('2026-01');
    expect(monthPrefix(new Date(2026, 11, 31))).toBe('2026-12');
  });
});

describe('monthCoverageNote', () => {
  it('warns when the scan window starts after the 1st of the month', () => {
    const now = new Date(2026, 8, 23);
    expect(monthCoverageNote(7, now)).toContain('2026-09-17');
    expect(monthCoverageNote(7, now)).toContain('未覆盖月初');
    expect(monthCoverageNote(30, now)).toBeNull();
    expect(monthCoverageNote(90, now)).toBeNull();
  });
  it('is exact on the boundary and ignores invalid windows', () => {
    expect(monthCoverageNote(23, new Date(2026, 8, 23))).toBeNull();
    expect(monthCoverageNote(0, new Date(2026, 8, 23))).toBeNull();
  });
});

describe('SPEND_SOURCES', () => {
  it('matches the plan source list for subscription entries', () => {
    expect(SPEND_SOURCES.map(([id]) => id)).toEqual(
      ['claude', 'codex', 'gemini', 'cline', 'roocode', 'kilocode', 'openclaw', 'zcode'],
    );
  });
});

describe('savableSubscriptions', () => {
  const rec = (over: Partial<SubscriptionRecord>): SubscriptionRecord =>
    ({price: 20, currency: 'USD', cycle_days: 30, start_date: '', note: '', ...over});

  it('keeps exactly the records a successful save would persist', () => {
    const out = savableSubscriptions({claude: rec({}), codex: rec({price: 0})});
    expect(Object.keys(out)).toEqual(['claude']);
    expect(out.claude).toMatchObject({price: 20, cycle_days: 30});
  });

  it('drops drafts the backend would reject: cycle 0/367, bad currency, bad date, oversized note', () => {
    const out = savableSubscriptions({
      a: rec({cycle_days: 0}),
      b: rec({cycle_days: 367}),
      c: rec({currency: 'usd'}),
      d: rec({start_date: '2026/09/01'}),
      e: rec({start_date: '2026-02-31'}),
      f: rec({note: 'x'.repeat(501)}),
      g: rec({price: Number.NaN}),
      ok: rec({}),
    });
    expect(Object.keys(out)).toEqual(['ok']);
  });

  it('normalizes price/cycle_days like the save path before applying the criteria', () => {
    const out = savableSubscriptions({claude: rec({price: 12.5, cycle_days: 30.4})});
    expect(out.claude).toMatchObject({price: 12.5, cycle_days: 30});
  });
});
