// Round5B 项目三：供应商服务状态的展示辅助（与组件分离，保持 fast-refresh 干净）。
// 诚实边界：只展示后端成功解析的状态；无公开状态 API 的供应商原样注明，不编造状态。

/** 后端 ProviderStatus 条目（snake_case 直传）。 */
export interface ProviderStatusEntry {
  provider: string; display_name: string; indicator: string; description: string;
  updated_at: string | null; state: string;
}

/** 无公开状态端点的供应商：与后端 STATUS_ENDPOINTS 互补，界面诚实注明。 */
export const NO_PUBLIC_ENDPOINT: readonly [string, string][] = [['stepfun', 'StepFun'], ['zhipu', 'Zhipu']];

/** 四色指示灯：绿=operational / 黄=degraded / 红=outage / 灰=unknown。 */
export function indicatorColor(indicator: string): string {
  switch (indicator) {
    case 'operational': return 'bg-emerald-500';
    case 'degraded': return 'bg-amber-400';
    case 'outage': return 'bg-red-500';
    default: return 'bg-zinc-500';
  }
}

export function indicatorLabel(indicator: string): string {
  switch (indicator) {
    case 'operational': return '服务正常';
    case 'degraded': return '服务降级';
    case 'outage': return '服务故障';
    default: return '状态未知';
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
