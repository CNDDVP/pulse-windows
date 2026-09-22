// Round4 项目二：多币种成本显示的纯函数层。
// 换算只发生在展示层——后端成本估算、入库与导出始终保持 USD 原值；
// 凡是经此处折算出的数字，界面必须就近标注「按固定汇率 X.XX 估算」。
// 汇率是纯本地设置（默认 7.2，可手改），绝不联网取汇。

import { getLang, translate } from "./i18n";
import type { Lang } from "./i18n";

export type DisplayCurrency = "USD" | "CNY";

export const USD_CNY_DEFAULT_RATE = 7.2;

/** 未知/缺省币种一律回落 USD（= 不折算，显示估算原值），绝不猜 CNY。 */
export function normalizeDisplayCurrency(v: unknown): DisplayCurrency {
  return v === "CNY" ? "CNY" : "USD";
}

/** 非有限 / 非正 / 超出后端校验界（0.01~10000）的汇率一律回落默认值，防手滑输入放大界面价格。 */
export function normalizeRate(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= 0.01 && n <= 10000 ? n : USD_CNY_DEFAULT_RATE;
}

/** USD 原值按显示币种折算。只支持 USD↔CNY；其他币种没有汇率口径，调用方必须显示「—」。 */
export function convertFromUsd(usd: number, to: DisplayCurrency, rate: number): number {
  return to === "CNY" ? usd * normalizeRate(rate) : usd;
}

export function currencySymbol(c: DisplayCurrency): string {
  return c === "CNY" ? "¥" : "$";
}

/** 两位小数金额，带币种符号（$12.34 / ¥88.81）；币种代码由调用方按版式补注。 */
export function formatMoney(amount: number, c: DisplayCurrency): string {
  return `${currencySymbol(c)}${amount.toFixed(2)}`;
}

/**
 * 换算口径标注：USD 显示估算原值，不需要标注；CNY 经固定汇率折算，必须就近标注。
 * lang 缺省回落模块级语言（zh 兜底）；已迁移的组件应显式传 useLang().lang，
 * 避免受控 Provider 切换语言的首帧取到旧语言。尚未迁移的调用方（detail 域
 * UsageDetailCard）暂走模块级默认——迁移时请同样显式传 lang。
 */
export function rateEstimateNote(c: DisplayCurrency, rate: number, lang: Lang = getLang()): string {
  return c === "CNY" ? translate(lang, "spend.rate_estimate_note", { rate: normalizeRate(rate).toFixed(2) }) : "";
}

/**
 * 详情卡余额折算（仅展示）：只折算 USD 余额到 CNY 显示。
 * 其余币种（CNY 原生余额、Credit 积分等）没有换算口径，返回 null = 不折算、原样显示。
 */
export function convertBalance(
  amount: number, balanceCurrency: string, to: DisplayCurrency, rate: number,
): number | null {
  if (to !== "CNY") return null;
  if (!Number.isFinite(amount)) return null;
  return balanceCurrency.toUpperCase() === "USD" ? amount * normalizeRate(rate) : null;
}

/**
 * 订阅倍数（Round4 项目三）= 本月估算成本(USD) ÷ 订阅价折算 USD。
 * 价格 ≤0（未登记）、成本缺失或币种无换算口径 → null（界面显示「—」，不得当作 0 或 1）。
 */
export function subscriptionMultiple(
  monthCostUsd: number | null | undefined,
  price: number,
  priceCurrency: string,
  rate: number,
): number | null {
  if (monthCostUsd == null || !Number.isFinite(monthCostUsd)) return null;
  if (!Number.isFinite(price) || price <= 0) return null;
  const cur = (priceCurrency || "USD").toUpperCase();
  const priceUsd = cur === "USD" ? price : cur === "CNY" ? price / normalizeRate(rate) : null;
  if (priceUsd == null || priceUsd <= 0) return null;
  return monthCostUsd / priceUsd;
}

/** 倍数展示：≥10 取整，其余保留 1 位小数；非有限值交给调用方按「—」处理。 */
export function formatMultiple(m: number): string {
  return `${m >= 10 ? Math.round(m) : Number(m.toFixed(1))}×`;
}
