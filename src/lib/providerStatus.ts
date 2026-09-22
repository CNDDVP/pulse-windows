// Round5B 项目三：供应商服务状态的展示辅助（与组件分离，保持 fast-refresh 干净）。
// 诚实边界：只展示后端成功解析的状态；无公开状态 API 的供应商原样注明，不编造状态。
import {getLang, translate} from './i18n';
import type {Lang} from './i18n';

/** 后端 ProviderStatus 条目（snake_case 直传）。 */
export interface ProviderStatusEntry {
  provider: string; display_name: string; indicator: string; description: string;
  updated_at: string | null; state: string;
}

/** 无公开状态端点的供应商：与后端 STATUS_ENDPOINTS 互补，界面诚实注明。 */
export const NO_PUBLIC_ENDPOINT: readonly [string, string][] = [['stepfun', 'StepFun'], ['zhipu', 'Zhipu']];

/** 四色指示灯：绿=operational / 黄=degraded / 红=outage / 灰=unknown。
 *  Round5d 项目一：走 index.css 语义令牌（--ok/--warn/--danger/--text-3），随主题取色；
 *  浅色下四色对窗口底/白卡均 ≥3:1（WCAG 1.4.11 非文字图形），旧硬编码 amber-400 对白卡仅 1.67:1。 */
export function indicatorColor(indicator: string): string {
  switch (indicator) {
    case 'operational': return 'bg-[var(--ok)]';
    case 'degraded': return 'bg-[var(--warn)]';
    case 'outage': return 'bg-[var(--danger)]';
    default: return 'bg-[var(--text-3)]';
  }
}

/** lang 缺省回落模块级语言（zh 兜底）；调用方（ProviderStatus）显式传 useLang().lang。 */
export function indicatorLabel(indicator: string, lang: Lang = getLang()): string {
  switch (indicator) {
    case 'operational': return translate(lang, 'spend.provider_status.indicator_operational');
    case 'degraded': return translate(lang, 'spend.provider_status.indicator_degraded');
    case 'outage': return translate(lang, 'spend.provider_status.indicator_outage');
    default: return translate(lang, 'spend.provider_status.indicator_unknown');
  }
}

const pad = (n: number) => String(n).padStart(2, '0');
/** 状态页自身更新时间（ISO → 本地 YYYY-MM-DD HH:mm）；缺失/无法解析时显示 —（不编造）。 */
export function formatUpdatedAt(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '—';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
