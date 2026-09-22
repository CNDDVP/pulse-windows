import {useEffect,useRef,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {formatUpdatedAt,indicatorColor,indicatorLabel,NO_PUBLIC_ENDPOINT,type ProviderStatusEntry} from '../lib/providerStatus';

// Round5B 项目三：供应商服务状态（Statuspage 系公开端点，走应用既有代理设置）。
// 诚实边界：只展示后端成功解析的状态；拉取/解析失败标「状态未知 + 原因」；
// 无公开状态 API 的供应商（StepFun / 智谱）原样注明，不编造状态。
// 手动刷新，不做自动轮询（避免常驻流量）。
export function ProviderStatus({ active = true }: { active?: boolean }) {
  const [entries, setEntries] = useState<ProviderStatusEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // 失活/卸载后的迟到回包不得覆盖状态。
  const stale = useRef(false);
  const refresh = async () => {
    setLoading(true);
    setError('');
    try {
      const r = await invoke<ProviderStatusEntry[]>('fetch_provider_status');
      if (!stale.current) setEntries(Array.isArray(r) ? r : []);
    } catch (e) {
      if (!stale.current) setError(String(e));
    } finally {
      if (!stale.current) setLoading(false);
    }
  };
  useEffect(() => {
    stale.current = false;
    // 无自动轮询：每次激活（切回汇总页/回到本页）自动取一次，激活期间仅手动刷新。
    if (active) void refresh();
    return () => { stale.current = true; };
    // refresh 只用 setter 与 ref，不随渲染变化；仅以 active 驱动。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
  if (!active) return null;
  const rows = entries ?? [];
  return <div className="space-y-2 pt-2">
    <div className="flex flex-wrap items-center gap-3">
      <h3 className="text-sm font-semibold text-zinc-200">供应商服务状态</h3>
      <button disabled={loading} className="bg-zinc-800 px-3 py-1 rounded text-sm disabled:opacity-40 cursor-pointer" onClick={() => void refresh()}>
        {loading ? '正在获取…' : '刷新状态'}
      </button>
      <span className="text-xs text-zinc-500">手动刷新，不做自动轮询；指示灯：绿=正常 / 黄=降级 / 红=故障 / 灰=未知。</span>
    </div>
    {error && <p className="text-amber-400 text-sm">{error}</p>}
    <ul className="text-sm space-y-1.5">
      {rows.map(e => (
        <li key={e.provider} className="flex flex-wrap items-center gap-x-2 gap-y-0.5" data-provider={e.provider}>
          <span aria-hidden className={`inline-block w-2.5 h-2.5 rounded-full ${indicatorColor(e.indicator)}`} />
          <span className="text-zinc-300 font-medium">{e.display_name}</span>
          <span className="text-zinc-400">{indicatorLabel(e.indicator)}</span>
          {e.description && <span className="text-xs text-zinc-500">{e.description}</span>}
          <span className="text-xs text-zinc-500">更新于 {formatUpdatedAt(e.updated_at)}</span>
        </li>
      ))}
      {NO_PUBLIC_ENDPOINT.map(([id, label]) => (
        <li key={id} className="flex flex-wrap items-center gap-x-2" data-provider={id}>
          <span aria-hidden className="inline-block w-2.5 h-2.5 rounded-full border border-zinc-600" />
          <span className="text-zinc-300 font-medium">{label}</span>
          <span className="text-xs text-zinc-500">该供应商无公开状态端点</span>
        </li>
      ))}
    </ul>
  </div>;
}
