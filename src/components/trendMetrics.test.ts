import {it,expect} from 'vitest';
import {candles,compactTokens,heatmapColumns,intensity,type DailyTrend} from './trendMetrics';

const d=(day:string,tokens:number,per:Record<string,number>={}):DailyTrend=>({day,tokens,per_source:per});

it('heatmap intensity buckets into five levels at 25/50/75% thresholds',()=>{
  expect(intensity(0,100)).toBe(0);
  expect(intensity(1,100)).toBe(1); // >0 且 <25% 为 1 档
  expect(intensity(24,100)).toBe(1);
  expect(intensity(25,100)).toBe(2); // 恰 25% → 2 档
  expect(intensity(49,100)).toBe(2);
  expect(intensity(50,100)).toBe(3); // 恰 50% → 3 档
  expect(intensity(74,100)).toBe(3);
  expect(intensity(75,100)).toBe(4); // 恰 75% → 4 档
  expect(intensity(100,100)).toBe(4);
  // 全空窗口（max=0）恒为 0 档。
  expect(intensity(10,0)).toBe(0);
});

it('candles bucket 7 days from newest backwards and report OHLC direction',()=>{
  const days=Array.from({length:20},(_,i)=>d(`2026-09-${String(i+1).padStart(2,'0')}`,i+1));
  const ks=candles(days,7);
  // 从最新往回分桶：09-14..09-20、09-07..09-13、09-01..09-06（6 天尾桶）；输出 oldest→newest。
  expect(ks.map(k=>k.end)).toEqual(['2026-09-06','2026-09-13','2026-09-20']);
  expect(ks.map(k=>k.start)).toEqual(['2026-09-01','2026-09-07','2026-09-14']);
  const first=ks[0];
  expect([first.open,first.close,first.high,first.low,first.up]).toEqual([1,6,6,1,true]);
  expect(ks[1].open).toBe(7);expect(ks[1].close).toBe(13);
  // 桶内递减 → 阴线（up=false）。
  const down=candles([d('2026-09-01',50),d('2026-09-02',30),d('2026-09-03',10)],7);
  expect([down[0].open,down[0].close,down[0].high,down[0].low,down[0].up]).toEqual([50,10,50,10,false]);
  // 桶内恒定 → open==close 算阳线。
  const flat=candles([d('2026-09-01',5),d('2026-09-02',5)],7);
  expect(flat[0].up).toBe(true);expect(flat[0].high).toBe(5);expect(flat[0].low).toBe(5);
  // 空序列无桶。
  expect(candles([],7)).toEqual([]);
});

it('compactTokens formats with K/M/B units',()=>{
  expect(compactTokens(0)).toBe('0');
  expect(compactTokens(999)).toBe('999');
  expect(compactTokens(1000)).toBe('1K');
  expect(compactTokens(1234)).toBe('1.2K');
  expect(compactTokens(12345)).toBe('12.3K');
  expect(compactTokens(12_300_000)).toBe('12.3M');
  expect(compactTokens(1_200_000_000)).toBe('1.2B');
  expect(compactTokens(2_500_000_000)).toBe('2.5B');
});

it('heatmapColumns aligns weeks from Sunday and carries levels',()=>{
  // 2026-01-04 是周日：首列无前补。
  const sun=heatmapColumns([d('2026-01-04',10),d('2026-01-05',100),d('2026-01-06',0)],100);
  expect(sun.length).toBe(1);
  expect(sun[0].map(c=>c===null?null:c.day)).toEqual(['2026-01-04','2026-01-05','2026-01-06']);
  expect(sun[0].map(c=>c===null?-1:c.level)).toEqual([1,4,0]);
  // 2026-01-05 是周一：首列按周日前补 1 个 null。
  const mon=heatmapColumns([d('2026-01-05',25)],100);
  expect(mon.length).toBe(1);
  expect(mon[0][0]).toBeNull();
  expect(mon[0][1]).toEqual({day:'2026-01-05',tokens:25,level:2});
  // 空数据无列。
  expect(heatmapColumns([],0)).toEqual([]);
});
