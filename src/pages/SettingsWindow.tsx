import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { AppSettings, HotkeySettings, MonitorOption, ProviderConfig, ProviderUsage } from "../types";
import { ProviderIcon } from "../components/icons/ProviderIcons";
const BOT_PERSONAS: [string,string][]=[["calm","沉稳"],["eager","热切"],["steady","踏实"],["curious","好奇"],["sleepy","瞌睡"],["playful","顽皮"],["stoic","淡漠"],["proud","骄傲"]];
const BOT_SHAPES: [string,string][]=[["blob","圆团"],["pebble","卵石"],["bean","豆子"],["egg","蛋"],["squircle","方圆"],["tablet","平板"],["capsule","胶囊"],["cylinder","圆柱"],["hex","六边"],["gem","宝石"],["crystal","晶体"],["wedge","楔形"],["shield","盾牌"],["dome","穹顶"],["arch","拱门"],["cloud","云朵"],["teardrop","泪滴"],["leaf","叶片"]];
import { TokenSpend } from "./TokenSpend";
import { resetText, pickElapsedWindow } from "../presentation";
import { orderedIds, moveItem, applyOrder } from "../ordering";
import { Switch, Section, Row, Field } from "./settings/shared";
import { PROVIDERS, ROUTES, providerName, getPlaceholder, selectCls, inputCls, btnPrimary, btnGhost, ageText, accountRows } from "./settings/constants";
import { GeneralPage } from "./settings/GeneralPage";
import { NotificationsPage } from "./settings/NotificationsPage";
import { HotkeysPage } from "./settings/HotkeysPage";
import { AboutPage } from "./settings/AboutPage";
import { DiagnosticsPage } from "./settings/DiagnosticsPage";

declare const __APP_VERSION__: string;

type View = { kind: "general" | "spend" | "accounts" | "notifications" | "hotkeys" | "diagnostics" | "about" } | { kind: "account"; id: string };
type ToastKind = "success" | "info" | "error";

const PAGES: { kind: Exclude<View, { kind: "account" }>["kind"]; title: string; icon: string; group: "pulse" | "app"; keywords: string }[] = [
  { kind: "general", title: "通用设置", icon: "⚙️", group: "pulse", keywords: "显示器 屏幕 贴靠 折叠 主题 外观 百分比 阈值 变红 刷新 间隔 启动 开机 全屏 跟随" },
  { kind: "spend", title: "Token 消耗", icon: "📊", group: "pulse", keywords: "token 用量 统计 消耗 记录 日志" },
  { kind: "notifications", title: "通知", icon: "🔔", group: "app", keywords: "通知 提醒 预警 耗尽 重置 失败 余额 toast" },
  { kind: "hotkeys", title: "快捷键", icon: "⌨", group: "app", keywords: "快捷键 热键 shortcut 键盘" },
  { kind: "diagnostics", title: "连接诊断", icon: "🩺", group: "app", keywords: "诊断 报告 路由 错误 缓存 耗时" },
  { kind: "about", title: "关于 Pulse", icon: "ℹ️", group: "app", keywords: "关于 版本 更新 开发者 json 集成" },
];

export function SettingsWindow({ initialSettings, usages, onSaved }: { initialSettings: AppSettings; usages: ProviderUsage[]; onSaved: (s: AppSettings) => void }) {
  const [settings, setSettings] = useState<AppSettings>(initialSettings);
  const [view, setView] = useState<View>({ kind: "accounts" });
  const [search, setSearch] = useState("");
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [screens, setScreens] = useState<MonitorOption[]>([]);
  const [toast, setToast] = useState<{ type: ToastKind; text: string } | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Pointer-based reorder: WebView2's OLE drag layer never starts an HTML5 drag here, and
  // pointer events also work for touch and pen.
  const [drag, setDrag] = useState<{ id: string; from: number; over: number } | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (drag) {
      document.body.style.cursor = "grabbing";
      return () => { document.body.style.cursor = ""; };
    }
  }, [drag]);
  // Last snapshot this window applied or saved itself: an incoming `settings-updated` equal to it
  // is our own echo; one that differs while the form has edits must not discard them silently.
  const appliedRef = useRef<AppSettings>(initialSettings);
  const settingsRef = useRef<AppSettings>(settings);
  useEffect(() => { settingsRef.current = settings; }, [settings]);
  const [pendingRemote, setPendingRemote] = useState<AppSettings | null>(null);
  // Render-safe mirror of appliedRef (refs must not be read during render).
  const [applied, setApplied] = useState<AppSettings>(initialSettings);
  const markApplied = (s: AppSettings) => { appliedRef.current = s; setApplied(s); };

  const showToast = (type: ToastKind, text: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ type, text });
    toastTimerRef.current = setTimeout(() => setToast(null), 3500);
  };
  // 破坏性操作的非阻塞确认（替代 window.confirm——WebView2 的模态对话框会挂起渲染线程）：
  // 第一次点击进入 armed 态（按钮变确认文案），3 秒未确认自动解除。
  const [confirmArmed, setConfirmArmed] = useState<string | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armConfirm = (key: string) => {
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    setConfirmArmed(key);
    confirmTimerRef.current = setTimeout(() => setConfirmArmed(null), 3000);
  };
  const disarmConfirm = () => {
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    setConfirmArmed(null);
  };
  const locked = busy || testingId !== null;

  useEffect(() => { void invoke<MonitorOption[]>("monitors").then(setScreens).catch(() => setScreens([])); }, []);
  useEffect(() => {
    const incoming = JSON.stringify(initialSettings), applied = JSON.stringify(appliedRef.current);
    if (incoming === applied) return;
    if (JSON.stringify(settingsRef.current) !== applied) { setPendingRemote(initialSettings); return; }
    markApplied(initialSettings); setSettings(initialSettings);
  }, [initialSettings]);

  const persist = async (next: AppSettings, message: string) => {
    setBusy(true);
    try {
      const updated = await invoke<AppSettings>("update_settings", { newSettings: next });
      markApplied(updated); setPendingRemote(null); onSaved(updated); setSettings(updated);
      if (message) showToast("success", message);
      return updated;
    } catch (e) { showToast("error", `保存失败: ${String(e)}`); throw e; } finally { setBusy(false); }
  };
  /** Ordinary settings save on change; a rejected save (e.g. hotkey conflict) rolls the UI back. */
  const update = (patch: Partial<AppSettings>, message = "") => {
    const prev = settings, next = { ...settings, ...patch };
    setSettings(next);
    persist(next, message).catch(() => setSettings(prev));
  };
  const saveHotkeys = (hk: HotkeySettings) => update({ hotkeys: hk }, "快捷键已生效");
  const patch = (id: string, value: Partial<ProviderConfig>) => setSettings(s => ({ ...s, providers: { ...s.providers, [id]: { ...s.providers[id], ...value } } }));

  // Account pages keep an explicit save because credentials and labels are typed, not toggled.
  const accountDirty = (id: string) => JSON.stringify(settings.providers[id]) !== JSON.stringify(applied.providers[id]);
  const anyDirty = Object.keys(settings.providers).some(accountDirty) || Object.keys(applied.providers).some(id => !(id in settings.providers));
  const saveAccounts = () => persist(settings, "账号设置已保存并同步至悬浮栏").catch(() => {});
  const discardAccount = (id: string) => {
    const base = appliedRef.current.providers[id];
    setSettings(s => { const providers = { ...s.providers }; if (base) providers[id] = base; else delete providers[id]; return { ...s, providers }; });
    if (!base) setView({ kind: "accounts" });
  };

  const railOrder = useMemo(() => orderedIds(settings.providers), [settings.providers]);
  const commitOrder = (ids: string[]) => {
    const next = { ...settings, providers: applyOrder(settings.providers, ids) };
    setSettings(next);
    if (locked) { showToast("info", "顺序已调整；当前有测试在进行，稍后保存即可生效"); return; }
    persist(next, "悬浮栏顺序已保存并同步").catch(() => {});
  };
  const moveAccount = (from: number, to: number) => commitOrder(moveItem(railOrder, from, to));
  const startDrag = (e: React.PointerEvent, id: string, from: number) => {
    if (locked) return;
    e.preventDefault();
    const list = listRef.current; if (!list) return;
    const rows = () => Array.from(list.children).filter(el => el.tagName === "LI") as HTMLElement[];
    const indexAt = (y: number) => {
      const rs = rows(); const i = rs.findIndex(r => { const rc = r.getBoundingClientRect(); return y >= rc.top && y <= rc.bottom; });
      if (i >= 0) return i; const first = rs[0]?.getBoundingClientRect(); return first && y < first.top ? 0 : rs.length - 1;
    };
    let over = from; const order = railOrder;
    setDrag({ id, from, over });
    const move = (ev: PointerEvent) => { const i = indexAt(ev.clientY); if (i !== over) { over = i; setDrag({ id, from, over }); } };
    const up = () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", up);
      setDrag(null);
      if (over !== from) commitOrder(moveItem(order, from, over));
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); window.addEventListener("pointercancel", up);
  };
  const defaultOrder = useMemo(() => [...railOrder].sort((a, b) => providerName(settings.providers[a].provider_id).localeCompare(providerName(settings.providers[b].provider_id), "zh") || a.localeCompare(b)), [railOrder, settings.providers]);
  const isDefaultOrder = railOrder.every((id, i) => id === defaultOrder[i]);

  const handleAddAccount = (pid: string) => {
    const id = crypto.randomUUID();
    patch(id, { provider_id: pid, label: providerName(pid), enabled: true, order: Object.values(settings.providers).reduce((m, c) => Math.max(m, c.order), -1) + 1, use_local: !!ROUTES[pid]?.local, credential_configured: false, primary_window: null, elapsed_window: null, ring_color: null, low_balance: null, low_balance_currency: null, mark_mode: null, bot_persona: null, bot_shape: null, bot_color: null, secondary_window: null, split_model_groups: false });
    setPickerOpen(false); setPickerQuery("");
    setView({ kind: "account", id });
    showToast("info", `已添加 ${providerName(pid)} 账号，完成配置后点击“保存”`);
  };
  const remove = (id: string) => {
    const label = settings.providers[id]?.label || "该账号";
    const key = `del:${id}`;
    if (confirmArmed !== key) { armConfirm(key); showToast("info", `再次点击删除以确认移除「${label}」`); return; }
    disarmConfirm();
    setBusy(true);
    void (async () => {
      try {
        const updated = await invoke<AppSettings>("delete_account", { accountId: id });
        appliedRef.current = updated;
        setSettings(updated);
        setView({ kind: "accounts" });
        showToast("info", `已删除 ${label}`);
      } catch (e) {
        showToast("error", `删除失败: ${String(e)}`);
      } finally {
        setBusy(false);
      }
    })();
  };
  const handleSaveCredential = async (id: string) => {
    const secret = secrets[id]; if (!secret) return;
    setBusy(true);
    try {
      if (accountDirty(id) || !(id in appliedRef.current.providers)) await persist(settings, "");
      await invoke("set_credential", { accountId: id, secret });
      setSecrets(s => ({ ...s, [id]: "" }));
      showToast("success", "凭据已安全存入 Windows 凭据管理器");
    } catch (e) { showToast("error", `凭据保存失败: ${String(e)}`); } finally { setBusy(false); }
  };
  const handleDeleteCredential = async (id: string) => {
    const key = `cred:${id}`;
    if (confirmArmed !== key) { armConfirm(key); showToast("info", "再次点击以确认移除凭据"); return; }
    disarmConfirm();
    setBusy(true);
    try { await invoke("delete_credential", { accountId: id }); showToast("info", "凭据已从 Windows 凭据管理器移除"); }
    catch (e) { showToast("error", `凭据删除失败: ${String(e)}`); } finally { setBusy(false); }
  };
  const test = async (id: string) => {
    setTestingId(id);
    try {
      if (accountDirty(id)) await persist(settings, "");
      const r = await invoke<ProviderUsage>("test_account", { accountId: id });
      showToast(r.state === "live" ? "success" : "error", r.state === "live" ? `${r.display_name}: 连接成功，已获取最新读数` : `${r.display_name}: ${r.error_message || r.state}`);
    } catch (e) { showToast("error", `测试失败: ${String(e)}`); } finally { setTestingId(null); }
  };
  const refreshAll = async () => { await invoke("refresh_usages"); };

  const closeWindow = async () => {
    if (anyDirty && confirmArmed !== "close") { armConfirm("close"); showToast("info", "有未保存的更改——再次点击关闭将放弃它们"); return; }
    disarmConfirm();
    if (anyDirty) { setSettings(appliedRef.current); }
    setSecrets({});
    setShowSecrets({});
    try { await invoke("close_settings_window"); } catch { try { await getCurrentWebviewWindow().hide(); } catch { /* nothing left to do */ } }
  };
  useEffect(() => {
    return () => {
      setSecrets({});
      setShowSecrets({});
    };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !(e.target instanceof HTMLInputElement)) void closeWindow(); };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  });
  // 原生 X / Alt+F4：后端拦下 CloseRequested 转发此事件，走与按钮/Esc 相同的
  // closeWindow 流程（未保存更改需二次确认），不再直接 hide 绕过确认。
  useEffect(() => {
    let alive = true;
    const stop = listen("settings-close-requested", () => { if (alive) void closeWindow(); });
    return () => { alive = false; void stop.then(f => f()); };
  });

  // Search covers pages (title + keywords) and accounts (label + provider name/id).
  const q = search.trim().toLowerCase();
  const matchedPages = q ? PAGES.filter(p => `${p.title} ${p.keywords}`.toLowerCase().includes(q)) : PAGES;
  const matchedAccounts = q ? railOrder.filter(id => { const c = settings.providers[id]; return `${c.label} ${providerName(c.provider_id)} ${c.provider_id}`.toLowerCase().includes(q); }) : railOrder;
  const firstMatch = (): View | null => matchedPages[0] ? { kind: matchedPages[0].kind } : matchedAccounts[0] ? { kind: "account", id: matchedAccounts[0] } : null;

  const navItem = (active: boolean, onClick: () => void, children: React.ReactNode, key?: string) => (
    <button key={key} onClick={onClick} className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-left text-xs transition-colors cursor-pointer ${active ? "bg-zinc-800 text-white font-semibold" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"}`}>{children}</button>
  );
  const stateDot = (u?: ProviderUsage, enabled = true) => <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${!enabled ? "bg-zinc-700" : u?.state === "live" ? "bg-emerald-400" : u?.state === "stale" ? "bg-amber-400" : u ? "bg-red-400" : "bg-zinc-600"}`} />;
  const current = view.kind === "account" ? settings.providers[view.id] : undefined;
  const dirtyHere = view.kind === "account" && (accountDirty(view.id) || !(view.id in applied.providers));

  return (
    <main className="h-screen flex flex-col bg-[#0f0f12] text-zinc-200 text-sm select-none font-sans overflow-hidden">
      {toast && (
        <div className={`fixed top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2.5 rounded-xl shadow-2xl border text-xs font-medium ${toast.type === "success" ? "bg-emerald-950/95 border-emerald-700/60 text-emerald-200" : toast.type === "error" ? "bg-red-950/95 border-red-700/60 text-red-200" : "bg-zinc-900/95 border-zinc-700 text-zinc-200"}`} role="status">
          <span className="font-bold">{toast.type === "success" ? "✓" : toast.type === "error" ? "✕" : "ℹ"}</span><span>{toast.text}</span>
          <button onClick={() => setToast(null)} className="ml-2 text-zinc-400 hover:text-white" aria-label="关闭提示">✕</button>
        </div>
      )}
      {pendingRemote && (
        <div className="shrink-0 flex items-center justify-between gap-3 px-5 py-2 bg-amber-950/70 border-b border-amber-800/50 text-xs text-amber-200">
          <span>设置已在别处更新；当前有未保存的修改，已为你保留。</span>
          <div className="flex gap-2 shrink-0">
            <button onClick={() => { markApplied(pendingRemote); setSettings(pendingRemote); setPendingRemote(null); }} className="px-2.5 py-1 rounded bg-amber-700 hover:bg-amber-600 text-white cursor-pointer">放弃本地修改并加载</button>
            <button onClick={() => setPendingRemote(null)} className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 cursor-pointer">保留本地修改</button>
          </div>
        </div>
      )}

      <header className="h-14 shrink-0 flex justify-between items-center px-5 border-b border-white/5 bg-zinc-950/80 backdrop-blur-md">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-emerald-600 to-teal-500 flex items-center justify-center shadow-lg shadow-emerald-950/50">
            <svg className="w-4 h-4 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12" /></svg>
          </div>
          <div>
            <div className="flex items-center gap-2"><h1 className="text-sm font-bold text-white tracking-wide">Pulse</h1><span className="text-[10px] bg-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded font-mono border border-zinc-700/50">v{__APP_VERSION__}</span></div>
            <p className="text-[11px] text-zinc-400">AI 配额监控 · 本地使用审计</p>
          </div>
        </div>
        <div className="flex items-center gap-2.5">
          {dirtyHere && view.kind === "account" && (
            <>
              <span className="text-[11px] text-amber-300 flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />有未保存的更改</span>
              <button className={btnGhost} disabled={locked} onClick={() => discardAccount(view.id)}>放弃</button>
              <button className={btnPrimary} disabled={locked} onClick={() => void saveAccounts()}>{busy ? "正在保存…" : "保存"}</button>
            </>
          )}
          {confirmArmed === "close"
          ? <button onClick={() => void closeWindow()} className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-red-950/40 text-red-300 border border-red-900/60 text-sm font-medium"><span>✕</span><span>放弃更改并关闭</span></button>
          : <button onClick={() => void closeWindow()} className={`${btnGhost} flex items-center gap-1.5`} title="关闭设置窗口 (Esc)"><span>✕</span><span>关闭</span><kbd className="text-[10px] text-zinc-500 border border-zinc-700 rounded px-1">Esc</kbd></button>}
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        <nav className="w-60 shrink-0 border-r border-white/5 bg-zinc-950/40 flex flex-col">
          <div className="p-3">
            <input value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { const v = firstMatch(); if (v) { setView(v); setSearch(""); } } if (e.key === "Escape") setSearch(""); }}
              placeholder="🔍 搜索设置或账号" aria-label="搜索设置或账号" className={inputCls} />
          </div>
          <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-4">
            {(!q || matchedPages.some(p => p.group === "pulse")) && (
              <div className="space-y-0.5">
                <div className="px-3 text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Pulse</div>
                {matchedPages.filter(p => p.group === "pulse").map(p => navItem(view.kind === p.kind, () => setView({ kind: p.kind }), <><span>{p.icon}</span><span>{p.title}</span></>, p.kind))}
              </div>
            )}
            {(!q || matchedAccounts.length > 0) && (
              <div className="space-y-0.5">
                <div className="px-3 text-[10px] uppercase tracking-wider text-zinc-500 mb-1 flex justify-between"><span>账号</span><span>{railOrder.length}</span></div>
                {!q && navItem(view.kind === "accounts", () => setView({ kind: "accounts" }), <><span>☰</span><span>账号总览与排序</span></>)}
                {matchedAccounts.map(id => { const c = settings.providers[id]; const u = usages.find(x => x.account_id === id); return navItem(view.kind === "account" && view.id === id, () => setView({ kind: "account", id }), <>
                  <span className="w-6 h-6 rounded-lg bg-zinc-800/90 border border-zinc-700/50 flex items-center justify-center text-zinc-200 shrink-0"><ProviderIcon id={c.provider_id} size={13} /></span>
                  <span className="min-w-0 flex-1"><span className="block truncate">{c.label || providerName(c.provider_id)}</span>{c.label && c.label !== providerName(c.provider_id) && <span className="block text-[10px] text-zinc-500 truncate">{providerName(c.provider_id)}</span>}</span>
                  {stateDot(u, c.enabled)}
                </>, id); })}
                {!q && <button onClick={() => setPickerOpen(true)} className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-left text-xs text-emerald-400 hover:bg-emerald-950/40 cursor-pointer"><span className="font-bold">+</span><span>添加账号</span></button>}
              </div>
            )}
            {(!q || matchedPages.some(p => p.group === "app")) && (
              <div className="space-y-0.5">
                <div className="px-3 text-[10px] uppercase tracking-wider text-zinc-500 mb-1">应用</div>
                {matchedPages.filter(p => p.group === "app").map(p => navItem(view.kind === p.kind, () => setView({ kind: p.kind }), <><span>{p.icon}</span><span>{p.title}</span></>, p.kind))}
              </div>
            )}
            {q && matchedPages.length === 0 && matchedAccounts.length === 0 && <p className="px-3 text-xs text-zinc-500">没有匹配「{search}」的设置或账号</p>}
          </div>
          <div className="p-3 border-t border-white/5 text-[11px] text-zinc-500">
            <div className="flex items-center gap-1.5 text-emerald-400"><span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />实时守护中</div>
            <div className="mt-1">通用与应用设置修改即保存；账号页需点“保存”。</div>
          </div>
        </nav>

        <div className="flex-1 overflow-y-auto p-6">
          {view.kind === "general" && <GeneralPage settings={settings} update={update} screens={screens} usages={usages} busy={busy} onRefreshAll={refreshAll} toast={showToast} />}
          <div className={view.kind === "spend" ? "" : "hidden"}><TokenSpend /></div>
          {view.kind === "notifications" && <NotificationsPage settings={settings} update={update} toast={showToast} />}
          {view.kind === "hotkeys" && <HotkeysPage settings={settings} save={saveHotkeys} onError={m => m && showToast("error", m)} />}
          {view.kind === "diagnostics" && <DiagnosticsPage usages={usages} settings={settings} busy={busy} setBusy={setBusy} toast={showToast} open={id => setView({ kind: "account", id })} />}
          {view.kind === "about" && <AboutPage />}

          {view.kind === "accounts" && (
            <div className="space-y-5 max-w-3xl">
              <Section title="添加服务商账号" icon="➕" subtitle="先选择服务商，再创建账号；同一服务商可添加多个账号，各自独立凭据、排序、颜色与通知。">
                <button onClick={() => setPickerOpen(true)} className={btnPrimary}>+ 选择服务商并添加账号</button>
              </Section>
              <Section title="悬浮栏显示顺序" icon="☰" subtitle="拖动 ☰ 或用箭头调整，松手即保存并同步到悬浮栏；排序单位是账号。"
                aside={<button className={btnGhost} disabled={locked || isDefaultOrder} onClick={() => commitOrder(defaultOrder)} title="按服务商名称排序">恢复默认顺序</button>}>
                <ul ref={listRef} className="space-y-1.5">
                  {railOrder.map((id, index) => { const c = settings.providers[id]; const u = usages.find(x => x.account_id === id); return (
                    <li key={id} className={`flex items-center gap-3 px-3 py-2 rounded-xl border transition-colors ${drag && drag.over === index && drag.id !== id ? "border-emerald-500/70 bg-emerald-950/30" : "border-white/5 bg-zinc-950/40 hover:border-white/15"} ${drag?.id === id ? "opacity-40" : ""} ${!c.enabled ? "opacity-60" : ""}`}>
                      <span onPointerDown={e => startDrag(e, id, index)} className={`text-zinc-500 select-none touch-none text-base leading-none px-1 ${locked ? "" : "cursor-grab active:cursor-grabbing"}`} title="拖动排序" aria-hidden>☰</span>
                      <span className="w-5 text-[11px] font-mono text-zinc-500 text-right">{index + 1}</span>
                      <span className="w-6 h-6 rounded-lg bg-zinc-800/90 border border-zinc-700/50 flex items-center justify-center text-zinc-200 shrink-0"><ProviderIcon id={c.provider_id} size={14} /></span>
                      <button className="text-xs text-zinc-200 truncate hover:underline cursor-pointer text-left" onClick={() => setView({ kind: "account", id })}>{c.label}</button>
                      <span className="text-[11px] text-zinc-500 truncate">{providerName(c.provider_id)}</span>
                      {stateDot(u, c.enabled)}
                      {!c.enabled && <span className="text-[10px] px-1.5 py-[2px] bg-zinc-800 text-zinc-400 rounded border border-zinc-700/60 shrink-0">不在悬浮栏</span>}
                      <span className="ml-auto flex items-center gap-1 shrink-0">
                        <button disabled={locked || index === 0} onClick={() => moveAccount(index, index - 1)} className="w-6 h-6 rounded-md text-zinc-400 hover:text-white hover:bg-zinc-800 disabled:opacity-30 cursor-pointer text-xs" aria-label={`上移 ${c.label}`}>▲</button>
                        <button disabled={locked || index === railOrder.length - 1} onClick={() => moveAccount(index, index + 1)} className="w-6 h-6 rounded-md text-zinc-400 hover:text-white hover:bg-zinc-800 disabled:opacity-30 cursor-pointer text-xs" aria-label={`下移 ${c.label}`}>▼</button>
                      </span>
                    </li>); })}
                  {railOrder.length === 0 && <p className="text-xs text-zinc-500">尚无账号。</p>}
                </ul>
              </Section>
            </div>
          )}

          {view.kind === "account" && current && (() => {
            const id = view.id, c = current, reading = usages.find(u => u.account_id === id), routes = ROUTES[c.provider_id] ?? {};
            const isTesting = testingId === id, timedWindows = reading?.windows.filter(w => w.window_seconds && w.resets_at) ?? [];
            const position = railOrder.indexOf(id) + 1;
            return (
              <div className="space-y-5 max-w-3xl">
                <section className="p-5 rounded-2xl bg-zinc-900/40 border border-white/10 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-11 h-11 rounded-xl bg-zinc-800/90 border border-zinc-700/50 flex items-center justify-center text-zinc-200" style={c.ring_color ? { color: c.ring_color } : undefined}><ProviderIcon id={c.provider_id} size={22} /></div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2"><strong className="text-base font-semibold text-white truncate">{c.label || providerName(c.provider_id)}</strong><span className="text-xs text-zinc-500">{providerName(c.provider_id)}</span></div>
                      <div className="flex items-center gap-2 mt-1 text-[11px]">
                        {stateDot(reading, c.enabled)}
                        <span className={!c.enabled ? "text-zinc-500" : reading?.state === "live" ? "text-emerald-400" : reading?.state === "stale" ? "text-amber-400" : reading?.error_message ? "text-red-400" : "text-zinc-500"}>
                          {!c.enabled ? "已停用，不在悬浮栏显示" : reading?.state === "live" ? `连接正常 · ${ageText(reading.checked_at)}更新` : reading?.state === "stale" ? `使用缓存 · 最近成功 ${ageText(reading.last_success_at)}` : reading?.error_message ?? "尚未查询读数"}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 shrink-0">
                    <label className="flex items-center gap-2 text-xs text-zinc-400"><span>显示在悬浮栏</span><Switch checked={c.enabled} onChange={v => patch(id, { enabled: v })} label="显示在悬浮栏" /></label>
                    <button className={confirmArmed === `del:${id}` ? "text-red-300 bg-red-950/50 p-1.5 rounded-lg transition-colors cursor-pointer" : "text-zinc-500 hover:text-red-400 hover:bg-red-950/30 p-1.5 rounded-lg transition-colors cursor-pointer"} onClick={() => remove(id)} title={confirmArmed === `del:${id}` ? "再次点击确认删除" : "删除此账号"} aria-label="删除此账号">
                      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
                    </button>
                  </div>
                </section>

                <Section title="账号" icon="👤">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div className="md:col-span-2"><Field label="账号备注名"><input className={inputCls} value={c.label} onChange={e => patch(id, { label: e.target.value })} /></Field></div>
                    <Field label="悬浮栏位置"><div className={`${inputCls} text-zinc-300`}>第 {position} 位 <button className="text-emerald-400 hover:underline cursor-pointer" onClick={() => setView({ kind: "accounts" })}>去排序</button></div></Field>
                  </div>
                </Section>

                <Section title="连接" icon="🔌" subtitle={`可用方式：${[routes.local && `本地登录（${routes.local}）`, routes.manual && `手动凭据（${routes.manual}）`].filter(Boolean).join("；") || "自动"}`}
                  aside={<button disabled={locked || !c.enabled} onClick={() => void test(id)} className={`${btnGhost} flex items-center gap-1.5`}>{isTesting ? <span className="w-3.5 h-3.5 border-2 border-zinc-400 border-t-white rounded-full animate-spin" /> : <span>⟳</span>}<span>{isTesting ? "测试中…" : "保存并测试连接"}</span></button>}>
                  {routes.local && (
                    <Row title="未保存凭据时读取本机工具登录" subtitle={routes.local}><Switch checked={c.use_local} onChange={v => patch(id, { use_local: v })} label="读取本机工具登录" /></Row>
                  )}
                  {routes.manual && (
                    <div className="p-3.5 bg-zinc-950/60 rounded-xl border border-white/5 space-y-3">
                      <div className="flex justify-between items-center text-xs">
                        <span className={c.credential_configured ? "text-emerald-400 font-medium" : "text-zinc-400"}>{c.credential_configured ? "🔒 凭据已安全保存（Windows 凭据管理器）" : "尚未配置手动凭据"}</span>
                        <span className="text-[11px] text-zinc-500">{routes.manual}</span>
                      </div>
                      <div className="flex gap-2">
                        <div className="relative flex-1">
                          <input type={showSecrets[id] ? "text" : "password"} className={`${inputCls} pr-9`} placeholder={c.credential_configured ? "输入新凭据以替换" : getPlaceholder(c.provider_id)} value={secrets[id] || ""} onChange={e => setSecrets(s => ({ ...s, [id]: e.target.value }))} autoComplete="off" spellCheck={false} aria-label="凭据" />
                          <button type="button" onClick={() => setShowSecrets(s => ({ ...s, [id]: !s[id] }))} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-200 text-xs cursor-pointer" aria-label={showSecrets[id] ? "隐藏凭据" : "显示凭据"}>{showSecrets[id] ? "隐藏" : "显示"}</button>
                        </div>
                        <button disabled={locked || !secrets[id]} onClick={() => void handleSaveCredential(id)} className={btnPrimary}>保存凭据</button>
                        {c.credential_configured && <button disabled={locked} onClick={() => void handleDeleteCredential(id)} className={confirmArmed === `cred:${id}` ? "px-3 py-1.5 bg-red-950/50 text-red-300 border border-red-900/60 rounded-xl text-xs font-medium transition-all disabled:opacity-40 cursor-pointer" : "px-3 py-1.5 bg-zinc-900 hover:bg-red-950/40 text-red-400 border border-zinc-800 hover:border-red-900/60 rounded-xl text-xs font-medium transition-all disabled:opacity-40 cursor-pointer"}>{confirmArmed === `cred:${id}` ? "确认移除？" : "删除凭据"}</button>}
                      </div>
                    </div>
                  )}
                  <p className="text-[11px] text-zinc-500">数据来源：{reading?.source || "尚未获得读数"}</p>
                </Section>

                <Section title="悬浮栏" icon="◎" subtitle="保存后即刻生效。">
                  {reading?.windows && reading.windows.length > 0 && (
                    <Field label="主圆环显示的额度" hint="圆环以该窗口的使用率与重置倒计时为准。">
                      <select className={selectCls} value={c.primary_window || ""} onChange={e => patch(id, { primary_window: e.target.value || null })}>
                        <option value="">自动选择最高使用率（默认）</option>
                        {reading.windows.map(w => <option key={w.id} value={w.id}>{w.name} — 已使用 {w.used_percent.toFixed(1)}% ({resetText(w.resets_at)})</option>)}
                      </select>
                    </Field>
                  )}
                  {(
                    <Field label="外圈时间环跟随的周期" hint={timedWindows.length === 0
                      ? "该账号的额度窗口未报告周期长度，外圈暂不可用。"
                      : settings.show_elapsed ? "外圈细线表示所选周期已流逝的比例；默认跟随倒计时最短的周期。" : "外圈已在通用设置中关闭。"}>
                      <select className={selectCls} disabled={timedWindows.length === 0} value={c.elapsed_window || ""} onChange={e => patch(id, { elapsed_window: e.target.value || null })}>
                        <option value="">自动选择倒计时最短的周期（默认）</option>
                        {timedWindows.map(w => <option key={w.id} value={w.id}>{w.name} — {resetText(w.resets_at)}</option>)}
                      </select>
                    </Field>
                  )}
                  <Row title="圆环颜色" subtitle="自定义颜色用于正常区间；达到琥珀/红色阈值或服务商报告耗尽时仍按预警色显示。">
                    <div className="flex items-center gap-2">
                      <select className={selectCls} value={c.ring_color ? "custom" : "auto"} onChange={e => patch(id, { ring_color: e.target.value === "custom" ? (c.ring_color ?? "#10b981") : null })} aria-label="圆环颜色模式"><option value="auto">自动（按用量压力）</option><option value="custom">自定义</option></select>
                      {c.ring_color && <input type="color" value={c.ring_color} onChange={e => patch(id, { ring_color: e.target.value })} className="w-9 h-8 rounded-lg bg-transparent border border-zinc-700 cursor-pointer" aria-label="选择圆环颜色" />}
                    </div>
                  </Row>
                  <Row title="动画机器人" subtitle="用一个会反应账号状态的小机器人替代服务商图标；个性、形状、颜色可调。">
                    <Switch checked={c.mark_mode === "bot"} onChange={v => patch(id, { mark_mode: v ? "bot" : "icon" })} label="动画机器人" />
                  </Row>
                  {c.mark_mode === "bot" && (
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-1">
                      <Field label="个性"><select className={selectCls} value={c.bot_persona ?? ""} onChange={e => patch(id, { bot_persona: e.target.value || null })}><option value="">自动（沉稳）</option>{BOT_PERSONAS.map(p => <option key={p[0]} value={p[0]}>{p[1]}</option>)}</select></Field>
                      <Field label="形状"><select className={selectCls} value={c.bot_shape ?? ""} onChange={e => patch(id, { bot_shape: e.target.value || null })}><option value="">自动（圆团）</option>{BOT_SHAPES.map(p => <option key={p[0]} value={p[0]}>{p[1]}</option>)}</select></Field>
                      <Field label="颜色"><div className="flex items-center gap-2">
                        <select className={selectCls} value={c.bot_color ? "custom" : "auto"} onChange={e => patch(id, { bot_color: e.target.value === "custom" ? (c.bot_color ?? "#10b981") : null })} aria-label="机器人颜色模式"><option value="auto">跟随主题</option><option value="custom">自定义</option></select>
                        {c.bot_color && <input type="color" value={c.bot_color} onChange={e => patch(id, { bot_color: e.target.value })} className="w-9 h-8 rounded-lg bg-transparent border border-zinc-700 cursor-pointer" aria-label="选择机器人颜色" />}
                      </div></Field>
                    </div>
                  )}
                  {reading?.windows && reading.windows.length > 1 && (
                    <Field label="第二额度内环（可选）" hint="在主环内侧用细环显示所选额度；选择“关闭”即完全清除内环。">
                      <select className={selectCls} value={c.secondary_window || ""} onChange={e => patch(id, { secondary_window: e.target.value || null })}>
                        <option value="">关闭</option>
                        {reading.windows.map(w => <option key={w.id} value={w.id}>{w.name} — 已使用 {w.used_percent.toFixed(1)}%</option>)}
                      </select>
                    </Field>
                  )}
                  {c.provider_id === "antigravity" && (
                    <Row title="按模型组拆分展示" subtitle="Gemini 与 Claude/GPT 各占一个悬浮栏位置；点击任一项仍刷新同一账号。">
                      <Switch checked={c.split_model_groups} onChange={v => patch(id, { split_model_groups: v })} label="按模型组拆分展示" />
                    </Row>
                  )}
                </Section>

                {reading && reading.balances.length > 0 && (
                  <Section title="通知" icon="🔔" subtitle="余额低于所设金额时提醒一次；回升后再次低于会再提醒。只比较所选币种。">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <Field label="余额低于此值时通知"><input type="number" min={0} step="0.01" className={inputCls} value={c.low_balance ?? ""} placeholder="不提醒" onChange={e => patch(id, { low_balance: e.target.value === "" ? null : Math.max(0, Number(e.target.value)), low_balance_currency: c.low_balance_currency ?? reading.balances[0].currency })} /></Field>
                      <Field label="币种"><select className={selectCls} value={c.low_balance_currency ?? reading.balances[0].currency} onChange={e => patch(id, { low_balance_currency: e.target.value })}>{reading.balances.map(b => <option key={b.currency} value={b.currency}>{b.currency}（当前 {b.amount.toFixed(2)}）</option>)}</select></Field>
                    </div>
                  </Section>
                )}

                {reading && (reading.windows.length > 0 || reading.balances.length > 0) && (
                  <Section title="用量" icon="📈">
                    <div className="space-y-2.5">
                      {reading.windows.map(w => {
                        const isPrimary = c.primary_window === w.id || (!c.primary_window && w.used_percent === reading.primary_percent);
                        const isTimed = pickElapsedWindow(reading.windows, c.elapsed_window ?? null)?.id === w.id;
                        return (
                          <div key={w.id} className="space-y-1">
                            <div className="flex justify-between items-center text-xs">
                              <span className="flex items-center gap-1.5 text-zinc-300">{w.name}
                                {isPrimary && <span className="text-[10px] bg-emerald-950/80 text-emerald-400 px-1.5 py-[2px] rounded border border-emerald-800/40">主额度</span>}
                                {isTimed && settings.show_elapsed && <span className="text-[10px] bg-zinc-800 text-zinc-300 px-1.5 py-[2px] rounded border border-zinc-600/60">时间环</span>}
                              </span>
                              <span className="font-mono text-zinc-200">{w.used_percent.toFixed(1)}% 已用</span>
                            </div>
                            <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden"><div className={`h-full rounded-full transition-all duration-500 ${w.exhausted || w.used_percent >= settings.warning_threshold ? "bg-red-500" : w.used_percent >= settings.warning_threshold - 15 ? "bg-amber-400" : "bg-emerald-500"}`} style={{ width: `${Math.min(100, Math.max(0, w.used_percent))}%` }} /></div>
                            <div className="text-[11px] text-zinc-500">{resetText(w.resets_at)}</div>
                          </div>
                        );
                      })}
                      {reading.balances.map(b => <div key={b.currency} className="flex justify-between text-xs"><span className="text-zinc-300">余额 · {b.currency}</span><span className="font-mono text-zinc-200">{b.amount.toFixed(2)}</span></div>)}
                    </div>
                  </Section>
                )}

                <Section title="诊断" icon="🩺" subtitle="来自最近一次刷新；报告文本不含账号名与凭据。">
                  {reading ? (
                    <dl className="grid grid-cols-[7rem_1fr] gap-y-1.5 text-xs">
                      {accountRows(reading, c).map(([k, v]) => <div key={k} className="contents"><dt className="text-zinc-500">{k}</dt><dd className="text-zinc-200 break-all">{v}</dd></div>)}
                    </dl>
                  ) : <p className="text-xs text-zinc-500">{c.enabled ? "尚未获得读数，保存后等待下一次刷新或点击“保存并测试连接”。" : "账号已停用，不参与刷新。"}</p>}
                  {reading?.error_code === "auth" && <p className="text-[11px] text-amber-300">下一步：凭据已失效——在上方“连接”重新保存凭据，或在本机工具中重新登录后再测试。</p>}
                  {reading?.error_code === "missing_credentials" && <p className="text-[11px] text-amber-300">下一步：未找到可用凭据——保存手动凭据，或登录对应的本机工具并开启“读取本机工具登录”。</p>}
                </Section>
              </div>
            );
          })()}
          {view.kind === "account" && !current && <p className="text-xs text-zinc-500">该账号已不存在。</p>}
        </div>
      </div>
      {pickerOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-8" onClick={() => { setPickerOpen(false); setPickerQuery(""); }}>
          <div className="w-[26rem] max-h-[32rem] bg-zinc-900 border border-white/10 rounded-2xl shadow-2xl flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="p-4 border-b border-white/5 space-y-3">
              <div className="flex justify-between items-center"><h3 className="text-sm font-semibold text-white">添加账号 · 选择服务商</h3>
                <button className="text-zinc-400 hover:text-white cursor-pointer" onClick={() => { setPickerOpen(false); setPickerQuery(""); }} aria-label="取消">✕</button></div>
              <input autoFocus value={pickerQuery} onChange={e => setPickerQuery(e.target.value)} onKeyDown={e => { if (e.key === "Escape") { setPickerOpen(false); setPickerQuery(""); } }} placeholder="🔍 搜索服务商" aria-label="搜索服务商" className={inputCls} />
            </div>
            <ul className="flex-1 overflow-y-auto p-2 space-y-1">
              {PROVIDERS.filter(p => `${p[1]} ${p[0]}`.toLowerCase().includes(pickerQuery.trim().toLowerCase())).map(([pid, name]) => {
                const existing = railOrder.filter(id => settings.providers[id].provider_id === pid).length;
                const addable = !!ROUTES[pid]?.manual;
                return (
                  <li key={pid}>
                    <button disabled={!addable} onClick={() => handleAddAccount(pid)} className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl text-left text-xs cursor-pointer ${addable ? "hover:bg-zinc-800 text-zinc-200" : "opacity-40 cursor-not-allowed"}`}>
                      <span className="w-7 h-7 rounded-lg bg-zinc-800/90 border border-zinc-700/50 flex items-center justify-center text-zinc-200 shrink-0"><ProviderIcon id={pid} size={15} /></span>
                      <span className="flex-1 min-w-0"><span className="block truncate">{name}</span>
                        <span className="block text-[11px] text-zinc-500">{existing > 0 ? `已存在 ${existing} 个账号 · 支持多账号` : ROUTES[pid]?.local ? `支持本机登录与手动凭据` : `手动凭据`}</span>
                      </span>
                      {!addable && <span className="text-[10px] text-zinc-500 shrink-0">本机唯一服务，无法添加</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
            <p className="px-4 py-2 border-t border-white/5 text-[11px] text-zinc-500">取消不会创建空账号，也不会影响现有排序。</p>
          </div>
        </div>
      )}
    </main>
  );
}
