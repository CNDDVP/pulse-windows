import {useEffect,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {SPEND_SOURCES} from '../lib/spend';
import {
  EXTRA_PATHS_PER_SOURCE_LIMIT, countExtraPaths, extraDirInputError,
  extraPathSourceLabel, normalizedExtraPaths,
} from '../lib/scanPaths';

const inputCls = 'bg-zinc-800 p-1 rounded text-xs text-zinc-200 border border-white/10 focus:outline-none focus:border-emerald-500';

/** 路径当前形态（scan_path_kind 返回；仅作逐条提示，不阻断保存）。 */
type PathKind='missing'|'dir'|'other';

/**
 * 「扫描路径」面板（Round5A 项目四）：按来源增删本地审计的附加扫描目录。
 * 草稿由面板自持（订阅记录需要进导出所以上提，这里不参与导出）；读取与保存走
 * get/save_token_spend_extra_paths，模式与 SubscriptionPanel 相同：挂载读一次、
 * 保存交后端整表校验（非法报错不落盘）、成功后以后端返回为准，并经 onSaved 上抛——
 * 设置窗口据此同步自己的快照，否则下一次普通设置保存会把旧扫描路径整表写回去（A03 同类竞态）。
 */
export function ScanPathsPanel({onSaved}:{onSaved?:(paths:Record<string,string[]>)=>void}){
  const [open, setOpen] = useState(false);
  const [paths, setPaths] = useState<Record<string, string[]>>({});
  const [source, setSource] = useState(SPEND_SOURCES[0][0]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [addErr, setAddErr] = useState('');
  // 存在性提示（计划口径「存在性提示不阻断」）：只记录需要提示的路径（缺失 / 不是目录），
  // 查询失败静默无提示——提示是尽力而为，绝不拦保存。
  const [hints, setHints] = useState<Record<string, PathKind>>({});

  // 挂载即读一次（面板默认折叠，读取为纯内存查询）。
  useEffect(() => {
    let alive = true;
    invoke<Record<string, string[]>>('get_token_spend_extra_paths')
      .then(m => { if (alive && m && typeof m === 'object') setPaths(m); })
      .catch(e => { if (alive) setErr(String(e)); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const all = [...new Set(Object.values(paths).flat().map(d => d.trim()).filter(d => d !== ''))];
    void Promise.all(all.map(async p => [p, await invoke<PathKind>('scan_path_kind', {path: p}).catch(() => null)] as const))
      .then(rs => {
        if (!alive) return;
        const next: Record<string, PathKind> = {};
        for (const [p, k] of rs) { if (k === 'missing' || k === 'other') next[p] = k; }
        setHints(next);
      });
    return () => { alive = false; };
  }, [open, paths]);

  const label = extraPathSourceLabel(source);
  const list = paths[source] ?? [];

  const add = () => {
    setErr(''); setMsg(''); setAddErr('');
    const e = extraDirInputError(draft, list);
    if (e) { setAddErr(e); return; }
    const dir = draft.trim();
    setPaths({...paths, [source]: [...list, dir]});
    setDraft('');
  };

  const remove = (dir: string) => {
    setErr(''); setMsg(''); setAddErr('');
    const next = list.filter(d => d !== dir);
    const updated = {...paths};
    if (next.length) updated[source] = next; else delete updated[source];
    setPaths(updated);
  };

  const save = async () => {
    setBusy(true); setErr(''); setMsg(''); setAddErr('');
    try {
      // 保存整表替换（后端 settings.token_spend_extra_paths=paths）；
      // 未在面板中展示的来源键（valid_id 白名单内的非审计来源）原样保留。
      const payload = normalizedExtraPaths(paths);
      const saved = await invoke<Record<string, string[]>>('save_token_spend_extra_paths', {paths: payload});
      const adopted = saved && typeof saved === 'object' ? saved : {};
      setPaths(adopted);
      onSaved?.(adopted);
      setMsg('扫描路径已保存，下次「读取使用记录」生效');
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const total = countExtraPaths(paths);

  return <div className="bg-zinc-900/60 rounded-xl border border-white/5">
    <button type="button" aria-expanded={open} className="w-full flex items-center justify-between px-4 py-2.5 cursor-pointer text-left"
      onClick={() => setOpen(o => !o)}>
      <span className="text-sm font-semibold text-zinc-200">扫描路径{total > 0 ? `（已添加 ${total} 个目录）` : ''}</span>
      <span className="text-xs text-zinc-400">{open ? '收起 ▴' : '展开 ▾'}</span>
    </button>
    {open && <div className="px-4 pb-3 space-y-2">
      <p className="text-[11px] text-zinc-500">为各来源追加自定义扫描目录（绝对路径，每来源最多 {EXTRA_PATHS_PER_SOURCE_LIMIT} 条），保存后下次「读取使用记录」生效。目录可以不存在：缺失目录不阻断保存，扫描时按「来源未安装」静默跳过；列表逐条提示当前是否存在（不阻断）。</p>
      {/* 诚实口径（与 ledger.rs extra_scan_paths 注释、README 一致）：去重只按文件路径；
          嵌套不双计；稳定 id 来源的复制件按 (source,event_id) 折叠；路径命名空间 id 才会双计。 */}
      <p className="text-[11px] text-amber-500/90">注意：附加目录与默认扫描根只按文件路径去重。嵌套发现的同一文件不会重复计数；跨目录复制的文件对事件 id 稳定的来源（Claude / ZCode / Qwen / Codex / Gemini / OpenClaw / OpenCode）按 id 折叠、也不重复计数，但会重复解析并使文件计数翻倍；Cline / RooCode / KiloCode 等按路径命名空间生成事件 id 的来源，以及缺失 id 的事件，复制件会重复计入统计——为这些来源配置目录时应避免文件复制。</p>
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="选择来源" className={inputCls} value={source} onChange={e => { setSource(e.target.value); setAddErr(''); }}>
          {SPEND_SOURCES.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <input aria-label={`${label} 附加目录`} className={`${inputCls} flex-1 min-w-[16rem]`} placeholder={`如 D:\\ai-logs\\${source}`}
          value={draft} onChange={e => { setDraft(e.target.value); setAddErr(''); }}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
        <button type="button" className="bg-zinc-800 px-3 py-1 rounded text-xs border border-white/10 cursor-pointer" onClick={add}>添加</button>
        <span className="text-[11px] text-zinc-500">{list.length}/{EXTRA_PATHS_PER_SOURCE_LIMIT}</span>
      </div>
      {addErr && <p className="text-xs text-amber-400">{addErr}</p>}
      {list.length > 0 && <ul className="space-y-1">
        {list.map(dir => <li key={dir} className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-300 bg-zinc-800/40 rounded px-2 py-1">
          <span className="break-all">{dir}</span>
          {hints[dir.trim()]==='missing' && <span className="text-[11px] text-amber-500/90">目录不存在，扫描时静默跳过</span>}
          {hints[dir.trim()]==='other' && <span className="text-[11px] text-amber-500/90">不是目录（可能是文件），扫描时跳过</span>}
          <button type="button" aria-label={`删除 ${dir}`} className="text-zinc-500 hover:text-red-400 cursor-pointer shrink-0 ml-auto" onClick={() => remove(dir)}>删除</button>
        </li>)}
      </ul>}
      <div className="flex items-center gap-3">
        <button disabled={busy} className="bg-emerald-700 px-3 py-1 rounded text-xs disabled:opacity-40 cursor-pointer" onClick={() => void save()}>{busy ? '正在保存…' : '保存扫描路径'}</button>
        <span className="text-[11px] text-zinc-500">保存对本面板内全部来源的改动整体生效。</span>
      </div>
      {msg && <p className="text-xs text-emerald-400">{msg}</p>}
      {err && <p className="text-xs text-amber-400">{err}</p>}
    </div>}
  </div>;
}
