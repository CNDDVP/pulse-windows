import {useEffect,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {SPEND_SOURCES} from '../lib/spend';
import {useLang} from '../lib/i18n';
import {
  EXTRA_PATHS_PER_SOURCE_LIMIT, countExtraPaths, extraDirInputError,
  extraPathSourceLabel, normalizedExtraPaths,
} from '../lib/scanPaths';

const inputCls = 'bg-[var(--surface-3)] p-1 rounded text-xs text-[var(--text-1)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)]';

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
  // Round 5c：面板内全部用户可见文案走 t()（未包 Provider 时回落 zh，与旧测试一致）。
  const {t,lang} = useLang();

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
    const e = extraDirInputError(draft, list, lang);
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
      setMsg('spend.scan_paths.saved');
    } catch (e) {
      // TODO(EN-backend)：后端整表校验错误原样展示，不翻译。
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const total = countExtraPaths(paths);

  return <div className="bg-[var(--surface-2)] rounded-xl border border-[var(--border)]">
    <button type="button" aria-expanded={open} className="w-full flex items-center justify-between px-4 py-2.5 cursor-pointer text-left"
      onClick={() => setOpen(o => !o)}>
      <span className="text-sm font-semibold text-[var(--text-1)]">{t('spend.scan_paths.title')}{total > 0 ? t('spend.scan_paths.added_count', {count: total}) : ''}</span>
      <span className="text-xs text-[var(--text-2)]">{open ? t('spend.collapse') : t('spend.expand')}</span>
    </button>
    {open && <div className="px-4 pb-3 space-y-2">
      <p className="text-[11px] text-[var(--text-3)]">{t('spend.scan_paths.description', {limit: EXTRA_PATHS_PER_SOURCE_LIMIT, scan: t('spend.scan')})}</p>
      {/* 诚实口径（与 ledger.rs extra_scan_paths 注释、README 一致）：去重只按文件路径；
          嵌套不双计；稳定 id 来源的复制件按 (source,event_id) 折叠；路径命名空间 id 才会双计。 */}
      <p className="text-[11px] text-[var(--warn)]">{t('spend.scan_paths.dedup_note')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label={t('spend.scan_paths.aria_source')} className={inputCls} value={source} onChange={e => { setSource(e.target.value); setAddErr(''); }}>
          {SPEND_SOURCES.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <input aria-label={t('spend.scan_paths.aria_dir', {label})} className={`${inputCls} flex-1 min-w-[16rem]`} placeholder={t('spend.scan_paths.placeholder', {source})}
          value={draft} onChange={e => { setDraft(e.target.value); setAddErr(''); }}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
        <button type="button" className="bg-[var(--surface-3)] px-3 py-1 rounded text-xs border border-[var(--border)] cursor-pointer" onClick={add}>{t('spend.add')}</button>
        <span className="text-[11px] text-[var(--text-3)]">{list.length}/{EXTRA_PATHS_PER_SOURCE_LIMIT}</span>
      </div>
      {addErr && <p className="text-xs text-[var(--warn)]">{addErr}</p>}
      {list.length > 0 && <ul className="space-y-1">
        {list.map(dir => <li key={dir} className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--text-1)] bg-[var(--surface-3)] rounded px-2 py-1">
          <span className="break-all">{dir}</span>
          {hints[dir.trim()]==='missing' && <span className="text-[11px] text-[var(--warn)]">{t('spend.scan_paths.hint_missing')}</span>}
          {hints[dir.trim()]==='other' && <span className="text-[11px] text-[var(--warn)]">{t('spend.scan_paths.hint_other')}</span>}
          <button type="button" aria-label={t('spend.scan_paths.aria_delete', {dir})} className="text-[var(--text-3)] hover:text-[var(--danger)] cursor-pointer shrink-0 ml-auto" onClick={() => remove(dir)}>{t('spend.delete')}</button>
        </li>)}
      </ul>}
      <div className="flex items-center gap-3">
        <button disabled={busy} className="bg-[var(--accent-solid)] text-[var(--on-solid)] px-3 py-1 rounded text-xs disabled:opacity-40 cursor-pointer" onClick={() => void save()}>{busy ? t('spend.saving') : t('spend.scan_paths.save')}</button>
        <span className="text-[11px] text-[var(--text-3)]">{t('spend.scan_paths.save_scope')}</span>
      </div>
      {msg && <p className="text-xs text-[var(--ok)]">{t(msg)}</p>}
      {/* TODO(EN-backend)：err 为 Rust 侧消息，原样展示不翻译 */}
      {err && <p className="text-xs text-[var(--warn)]">{err}</p>}
    </div>}
  </div>;
}
