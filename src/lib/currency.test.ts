import {describe,it,expect} from 'vitest';
import {
  normalizeDisplayCurrency, normalizeRate, convertFromUsd, formatMoney, rateEstimateNote,
  convertBalance, subscriptionMultiple, formatMultiple, USD_CNY_DEFAULT_RATE,
} from './currency';

describe('normalizeDisplayCurrency', () => {
  it('accepts CNY, falls back to USD for anything else (never guesses CNY)', () => {
    expect(normalizeDisplayCurrency('CNY')).toBe('CNY');
    expect(normalizeDisplayCurrency('USD')).toBe('USD');
    expect(normalizeDisplayCurrency(undefined)).toBe('USD');
    expect(normalizeDisplayCurrency('JPY')).toBe('USD');
    expect(normalizeDisplayCurrency('cny')).toBe('USD');
  });
});

describe('normalizeRate', () => {
  it('keeps finite rates inside the backend bounds and falls back to 7.2 otherwise', () => {
    expect(normalizeRate(7.25)).toBe(7.25);
    expect(normalizeRate(0.01)).toBe(0.01);
    expect(normalizeRate(10000)).toBe(10000);
    expect(normalizeRate(undefined)).toBe(USD_CNY_DEFAULT_RATE);
    expect(normalizeRate(0)).toBe(USD_CNY_DEFAULT_RATE);
    expect(normalizeRate(-1)).toBe(USD_CNY_DEFAULT_RATE);
    expect(normalizeRate(Number.NaN)).toBe(USD_CNY_DEFAULT_RATE);
    expect(normalizeRate(99999)).toBe(USD_CNY_DEFAULT_RATE);
  });
});

describe('convertFromUsd', () => {
  it('keeps USD as-is and multiplies CNY by the fixed rate', () => {
    expect(convertFromUsd(10, 'USD', 7.2)).toBe(10);
    expect(convertFromUsd(10, 'CNY', 7.2)).toBeCloseTo(72, 10);
    expect(convertFromUsd(10, 'CNY', Number.NaN)).toBeCloseTo(72, 10);
  });
});

describe('formatMoney / rateEstimateNote', () => {
  it('formats two decimals with the symbol and annotates only converted display', () => {
    expect(formatMoney(12.345, 'USD')).toBe('$12.35');
    expect(formatMoney(88.8, 'CNY')).toBe('¥88.80');
    expect(rateEstimateNote('USD', 7.2)).toBe('');
    expect(rateEstimateNote('CNY', 7.2)).toBe('按固定汇率 7.20 估算');
  });
});

describe('convertBalance', () => {
  it('converts only USD balances to CNY and returns null for every other case', () => {
    expect(convertBalance(5, 'USD', 'CNY', 7.2)).toBeCloseTo(36, 10);
    expect(convertBalance(5, 'usd', 'CNY', 7.2)).toBeCloseTo(36, 10);
    expect(convertBalance(5, 'CNY', 'CNY', 7.2)).toBeNull();
    expect(convertBalance(5, 'Credit', 'CNY', 7.2)).toBeNull();
    expect(convertBalance(5, 'USD', 'USD', 7.2)).toBeNull();
    expect(convertBalance(Number.NaN, 'USD', 'CNY', 7.2)).toBeNull();
  });
});

describe('subscriptionMultiple', () => {
  const rate = 7.2;
  it('divides monthly cost by the USD price', () => {
    expect(subscriptionMultiple(10, 20, 'USD', rate)).toBeCloseTo(0.5, 10);
    expect(subscriptionMultiple(40, 20, 'USD', rate)).toBeCloseTo(2, 10);
  });
  it('converts CNY prices to USD with the fixed rate before dividing', () => {
    // ¥72 ÷ 7.2 = $10 → 10/10 = 1×
    expect(subscriptionMultiple(10, 72, 'CNY', rate)).toBeCloseTo(1, 10);
  });
  it('returns null for missing cost, unset price, or unsupported currency (displayed as —)', () => {
    expect(subscriptionMultiple(null, 20, 'USD', rate)).toBeNull();
    expect(subscriptionMultiple(undefined, 20, 'USD', rate)).toBeNull();
    expect(subscriptionMultiple(10, 0, 'USD', rate)).toBeNull();
    expect(subscriptionMultiple(10, -1, 'USD', rate)).toBeNull();
    expect(subscriptionMultiple(10, 20, 'JPY', rate)).toBeNull();
    expect(subscriptionMultiple(Number.NaN, 20, 'USD', rate)).toBeNull();
  });
});

describe('formatMultiple', () => {
  it('keeps one decimal below 10 and rounds at 10 or above', () => {
    expect(formatMultiple(1.24)).toBe('1.2×');
    expect(formatMultiple(0.83)).toBe('0.8×');
    expect(formatMultiple(12.4)).toBe('12×');
  });
});
