import {balanceText,balanceLabel} from "../presentation";
import { connectCloseBridge, type CloseRequest } from "../closeBridge";
import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { AppSettings, HotkeySettings, MonitorOption, ProviderConfig, ProviderUsage, RefreshSummary } from "../types";
import { ProviderIcon } from "../components/icons/ProviderIcons";
import { UsageRing } from "../components/UsageRing";
const BOT_PERSONAS: [string,string][]=[["calm","沉稳"],["eager","热切"],["steady","踏实"],["curious","好奇"],["sleepy","瞌睡"],["playful","顽皮"],["stoic","淡漠"],["proud","骄傲"]];
const BOT_SHAPES: [string,string][]=[["blob","圆团"],["pebble","卵石"],["bean","豆子"],["egg","蛋"],["squircle","方圆"],["tablet","平板"],["capsule","胶囊"],["cylinder","圆柱"],["hex","六边"],["gem","宝石"],["crystal","晶体"],["wedge","楔形"],["shield","盾牌"],["dome","穹顶"],["arch","拱门"],["cloud","云朵"],["teardrop","泪滴"],["leaf","叶片"]];
const ANTIGRAVITY_DEFAULT_WINDOWS = [
  { id: "0-0", name: "Gemini 模型 · 每周限额" },
  { id: "0-1", name: "Gemini 模型 · 5小时限额" },
  { id: "1-0", name: "Claude 与 GPT 模型 · 每周限额" },
  { id: "1-1", name: "Claude 与 GPT 模型 · 5小时限额" },
];
import { TokenSpend } from "./TokenSpend";
import { resetText, pickElapsedWindow, timingWindows } from "../presentation";
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

export function SettingsWindow({ initialSettings, usages: externalUsages, onSaved }: { initialSettings: AppSettings; usages: ProviderUsage[]; onSaved: (s: AppSettings) => void }) {
  const [settings, setSettings] = useState<AppSettings>(initialSettings);
  const [localUsages, setLocalUsages] = useState<ProviderUsage[]>(externalUsages);
  useEffect(() => { setLocalUsages(externalUsages); }, [externalUsages]);
  const usages = localUsages;
  const [isPortable, setIsPortable] = useState(false);
  useEffect(() => {
    invoke<boolean>("is_portable_mode").then(setIsPortable).catch(() => {});
  }, []);
  const [view, setView] = useState<View>({ kind: "accounts" });
  useEffect(() => {
    invoke<ProviderUsage[]>("get_usages")
      .then(u => {
        if (u && u.length > 0) setLocalUsages(u);
      })
      .catch(() => {});
  }, [view]);
  const [search, setSearch] = useState("");
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
  const [stepfunCredentials, setStepfunCredentials] = useState<Record<string, { apiKey: string; oasisToken: string }>>({});
  const [showStepfunApiKey, setShowStepfunApiKey] = useState<Record<string, boolean>>({});
  const [showStepfunOasisToken, setShowStepfunOasisToken] = useState<Record<string, boolean>>({});
  const [showStepfunHelp, setShowStepfunHelp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [screens, setScreens] = useState<MonitorOption[]>([]);
  const [toast, setToast] = useState<{ type: ToastKind; text: string } | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [importable, setImportable] = useState<{ account_count: number; provider_names: string[]; installed_path: string } | null>(null);
  const [antigravityDetected, setAntigravityDetected] = useState(false);
  const [dismissedAntigravity, setDismissedAntigravity] = useState(false);
  const hasAntigravity = useMemo(() => Object.values(settings.providers).some(p => p.provider_id === "antigravity"), [settings.providers]);
  useEffect(() => {
    if (!hasAntigravity) {
      invoke<boolean>("check_local_antigravity").then(setAntigravityDetected).catch(() => {});
    }
  }, [hasAntigravity]);

  const handleQuickAddAntigravity = async () => {
    try {
      setBusy(true);
      const saved = await invoke<AppSettings>("quick_add_antigravity_account");
      markApplied(saved);
      setSettings(saved);
      onSaved(saved);
      showToast("success", "已成功接入本地 Antigravity 账号，正在获取最新配额！");
    } catch (e) {
      showToast("error", `接入失败: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const [wizardSelected, setWizardSelected] = useState<string[]>(() => {
    return (settings.authorized_providers && settings.authorized_providers.length > 0)
      ? settings.authorized_providers
      : ["claude", "codex", "antigravity", "kimi"];
  });
  useEffect(() => {
    invoke<{ account_count: number; provider_names: string[]; installed_path: string } | null>("check_importable_config")
      .then(res => { if (res && res.account_count > 0) setImportable(res); })
      .catch(() => {});
  }, []);

  const handleImportConfig = async () => {
    try {
      setBusy(true);
      const imported = await invoke<AppSettings>("import_installed_config", { mode: "append" });
      markApplied(imported);
      setSettings(imported);
      onSaved(imported);
      setImportable(null);
      showToast("success", `已成功从安装版导入 ${Object.keys(imported.providers).length} 个账号与凭据！`);
    } catch (e) {
      showToast("error", `导入失败: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };
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

  const persist = async (next: AppSettings, message: string, keepDraftProviders = false) => {
    setBusy(true);
    try {
      const updated = await invoke<AppSettings>("update_settings", { newSettings: next });
      markApplied(updated); setPendingRemote(null); onSaved(updated);
      // keepDraftProviders：普通设置自动保存只提交 providers 基线（A26），不打掉账号页正在编辑的草稿。
      setSettings(keepDraftProviders ? (cur => ({ ...updated, providers: cur.providers })) : updated);
      if (message) showToast("success", message);
      return updated;
    } catch (e) { showToast("error", `保存失败: ${String(e)}`); throw e; } finally { setBusy(false); }
  };
  /** Ordinary settings save on change; a rejected save (e.g. hotkey conflict) rolls the UI back. */
  const update = (patch: Partial<AppSettings>, message = "") => {
    const prev = settings, next = { ...settings, ...patch };
    // 提交时 providers 用已保存基线（A26）：账号草稿只在账号页显式保存时落盘。
    const persisted = { ...next, providers: appliedRef.current.providers };
    setSettings(next);
    persist(persisted, message, true).catch(() => setSettings(prev));
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
    // B21：顺序调整提交 providers 基线上的新顺序，不把账号页草稿一起带走。
    const persisted = { ...settings, providers: applyOrder(appliedRef.current.providers, ids) };
    const next = { ...persisted };
    setSettings(next);
    if (locked) { showToast("info", "顺序已调整；当前有测试在进行，稍后保存即可生效"); return; }
    persist(persisted, "悬浮栏顺序已保存并同步").catch(() => {});
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
    patch(id, { provider_id: pid, label: providerName(pid), enabled: true, order: Object.values(settings.providers).reduce((m, c) => Math.max(m, c.order), -1) + 1, use_local: !!ROUTES[pid]?.local, credential_configured: false, primary_window: null, elapsed_window: null, elapsed_period_days: null, ring_color: pid === "kimi" ? "#7AA5FF" : null, low_balance: null, low_balance_currency: null, mark_mode: null, bot_persona: null, bot_shape: null, bot_color: pid === "kimi" ? "#7AA5FF" : null, secondary_window: null, split_model_groups: false });
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
        // markApplied 同步 render 镜像（B13）：只写 ref 会让 applied 与基线漂移，
        // 随后的 anyDirty 可能一直提示未保存。
        markApplied(updated);
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
    const c = settings.providers[id];
    let secret = secrets[id];
    if (c?.provider_id === "stepfun") {
      const cred = stepfunCredentials[id];
      if (cred && (cred.apiKey.trim() || cred.oasisToken.trim())) {
        secret = JSON.stringify({
          api_key: cred.apiKey.trim() || undefined,
          oasis_token: cred.oasisToken.trim() || undefined,
        });
      }
    }
    if (!secret) return;
    setBusy(true);
    try {
      if (accountDirty(id) || !(id in appliedRef.current.providers)) await persist(settings, "");
      await invoke("set_credential", { accountId: id, secret });
      setSecrets(s => ({ ...s, [id]: "" }));
      if (c?.provider_id === "stepfun") {
        setStepfunCredentials(s => ({ ...s, [id]: { apiKey: "", oasisToken: "" } }));
      }
      showToast("success", "凭据已安全保存（未填写的 StepFun 凭据保留），正在获取最新读数…");
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
      const c = settings.providers[id];
      let secret = secrets[id];
      if (c?.provider_id === "stepfun") {
        const cred = stepfunCredentials[id];
        if (cred && (cred.apiKey.trim() || cred.oasisToken.trim())) {
          secret = JSON.stringify({
            api_key: cred.apiKey.trim() || undefined,
            oasis_token: cred.oasisToken.trim() || undefined,
          });
        }
      }
      // 若用户在输入框填写了新凭据，测试时自动一并保存，避免"先填后测却提示未发现可用凭据"
      if (secret) {
        await invoke("set_credential", { accountId: id, secret });
        setSecrets(s => ({ ...s, [id]: "" }));
        if (c?.provider_id === "stepfun") {
          setStepfunCredentials(s => ({ ...s, [id]: { apiKey: "", oasisToken: "" } }));
        }
      }
      if (accountDirty(id)) await persist(settings, "");
      const r = await invoke<ProviderUsage>("test_account", { accountId: id });
      setLocalUsages(prev => {
        const next = prev.filter(u => u.account_id !== id);
        return [r, ...next];
      });
      showToast(r.state === "live" ? "success" : "error", r.state === "live" ? `${r.display_name}: 连接成功，已获取最新读数` : `${r.display_name}: ${r.error_message || r.state}`);
    } catch (e) { showToast("error", `测试失败: ${String(e)}`); } finally { setTestingId(null); }
  };
  const refreshAll = async () => {
    const r = await invoke<RefreshSummary>("refresh_usages");
    if (r.initiated > 0) showToast("success", `已发起 ${r.initiated} 个账号刷新${r.skipped ? `（${r.skipped} 个冷却中跳过）` : ""}`);
    else showToast("info", `全部账号都在冷却或刷新中，本次未发起（${r.skipped} 个跳过）`);
  };

  const anyDirtyRef = useRef(anyDirty);
  useEffect(() => { anyDirtyRef.current = anyDirty; }, [anyDirty]);
  const secretsRef = useRef(secrets);
  useEffect(() => { secretsRef.current = secrets; }, [secrets]);
  const stepfunCredentialsRef = useRef(stepfunCredentials);
  useEffect(() => { stepfunCredentialsRef.current = stepfunCredentials; }, [stepfunCredentials]);
  const settingsRef2 = useRef(settings);
  useEffect(() => { settingsRef2.current = settings; }, [settings]);

  const [closeModal, setCloseModal] = useState<{ isOpen: boolean; requestId: number } | null>(null);

  const handleUserClose = async () => {
    try {
      await invoke("request_close_settings", { source: "button" });
    } catch (error) {
      showToast("error", `关闭请求失败，草稿已保留: ${String(error)}`);
    }
  };

  const handleModalSaveAndClose = async () => {
    if (!closeModal) return;
    setBusy(true);
    try {
      if (anyDirtyRef.current) {
        await persist(settingsRef2.current, "");
      }
      for (const [id, secret] of Object.entries(secretsRef.current)) {
        if (secret && secret.trim()) {
          await invoke("set_credential", { accountId: id, secret: secret.trim() });
        }
      }
      for (const [id, cred] of Object.entries(stepfunCredentialsRef.current)) {
        if (cred && (cred.apiKey.trim() || cred.oasisToken.trim())) {
          const secret = JSON.stringify({
            api_key: cred.apiKey.trim() || undefined,
            oasis_token: cred.oasisToken.trim() || undefined,
          });
          await invoke("set_credential", { accountId: id, secret });
        }
      }
      setSecrets({});
      setShowSecrets({});
      setStepfunCredentials({});
      await invoke("confirm_close_settings", { requestId: closeModal.requestId, action: "save_and_hide" });
      setCloseModal(null);
    } catch (e) {
      showToast("error", `保存失败，未关闭窗口: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleModalDiscardAndClose = async () => {
    if (!closeModal) return;
    setSettings(appliedRef.current);
    setSecrets({});
    setShowSecrets({});
    setStepfunCredentials({});
    await invoke("confirm_close_settings", { requestId: closeModal.requestId, action: "discard_and_hide" });
    setCloseModal(null);
  };

  const handleModalCancel = async () => {
    if (!closeModal) return;
    await invoke("confirm_close_settings", { requestId: closeModal.requestId, action: "cancel" });
    setCloseModal(null);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target instanceof HTMLInputElement)) {
        if (closeModal) {
          void handleModalCancel();
        } else {
          void invoke("request_close_settings", { source: "esc" });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeModal]);

  // Events are the fast path; IPC recovers missing delivery without losing drafts.
  useEffect(() => connectCloseBridge({
    listen: handler => getCurrentWebviewWindow().listen<CloseRequest>(
      "settings-close-requested", e => handler(e.payload)),
    ready: () => invoke("settings_window_ready"),
    pending: () => invoke<CloseRequest | null>("pending_settings_close"),
    handle: async ({ request_id: requestId }) => {
      const hasDraft = anyDirtyRef.current ||
        Object.values(secretsRef.current).some(s => s && s.trim().length > 0) ||
        Object.values(stepfunCredentialsRef.current).some(c => c && (c.apiKey.trim() || c.oasisToken.trim()));
      await invoke("acknowledge_close", { requestId, hasDraft });
      if (hasDraft) setCloseModal({ isOpen: true, requestId });
      else {
        await invoke("confirm_close_settings", { requestId, action: "hide" });
        setSecrets({});
        setShowSecrets({});
        setStepfunCredentials({});
      }
    },
    error: error => console.error("关闭通道异常:", error),
  }), []);

  // Search covers pages (title + keywords) and accounts (label + provider name/id).
  const q = search.trim().toLowerCase();
  const matchedPages = q ? PAGES.filter(p => `${p.title} ${p.keywords}`.toLowerCase().includes(q)) : PAGES;
  const matchedAccounts = q ? railOrder.filter(id => { const c = settings.providers[id]; return `${c.label} ${providerName(c.provider_id)} ${c.provider_id}`.toLowerCase().includes(q); }) : railOrder;
  const firstMatch = (): View | null => matchedPages[0] ? { kind: matchedPages[0].kind } : matchedAccounts[0] ? { kind: "account", id: matchedAccounts[0] } : null;

  const navItem = (active: boolean, onClick: () => void, children: React.ReactNode, key?: string) => (
    <button key={key} onClick={onClick} className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-left text-xs transition-colors cursor-pointer ${active ? "bg-zinc-800 text-white font-semibold" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"}`}>{children}</button>
  );
  const stateDot = (u?: ProviderUsage, enabled = true) => <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${!enabled ? "bg-zinc-700" : u?.state === "live" ? "bg-emerald-400" : u?.state === "stale" ? "bg-amber-400" : u ? "bg-red-400" : "bg-zinc-600"}`} />;
  const quotaCapsule = (u?: ProviderUsage, enabled = true) => {
    if (!enabled) {
      return (
        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono bg-zinc-800/80 text-zinc-500 border border-zinc-700/40 shrink-0">
          已停用
        </span>
      );
    }
    if (!u) {
      return (
        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono bg-zinc-800/60 text-zinc-500 border border-zinc-700/30 shrink-0">
          待读数
        </span>
      );
    }
    if (u.state === "error" || u.state === "unavailable") {
      return (
        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono bg-red-950/40 text-red-400 border border-red-800/50 shrink-0" title={u.error_message || "连接异常"}>
          异常
        </span>
      );
    }
    if (u.state === "loading") {
      return (
        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono bg-blue-950/40 text-blue-300 border border-blue-800/40 shrink-0 animate-pulse">
          刷新中
        </span>
      );
    }

    const pct = u.primary_percent != null ? Math.round(u.primary_percent) : null;
    const balances = u.balances.filter(b => Number.isFinite(b.amount) && b.currency.trim());
    if (pct == null && balances.length > 0 && (u.state === "live" || u.state === "stale")) {
      const stale = u.state === "stale";
      const amounts = balances.map(b => `${b.currency} ${b.amount.toFixed(2)}`);
      return (
        <span
          className={`inline-flex flex-col items-end px-1.5 py-0.5 rounded text-[10px] font-mono border shrink-0 max-w-[120px] ${stale ? "bg-amber-950/40 text-amber-300 border-amber-800/40" : "bg-emerald-950/40 text-emerald-300 border-emerald-800/40"}`}
          title={`${stale ? "上次余额（缓存，待刷新）" : "当前剩余余额"}: ${amounts.join("；")}`}
          aria-label={`${stale ? "缓存余额" : "剩余余额"}: ${amounts.join("；")}`}
        >
          {amounts.map((amount, index) => <span key={index} className="max-w-full truncate">{amount}{stale ? "*" : ""}</span>)}
        </span>
      );
    }
    if (pct == null) {
      return (
        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono bg-zinc-800/60 text-zinc-400 border border-zinc-700/40 shrink-0">
          待读数
        </span>
      );
    }

    const isStale = u.state === "stale";
    const colorCls = pct >= 85
      ? "bg-red-950/60 text-red-300 border-red-800/60"
      : pct >= 65
      ? "bg-amber-950/60 text-amber-300 border-amber-800/60"
      : "bg-emerald-950/60 text-emerald-300 border-emerald-800/60";
    const barCls = pct >= 85
      ? "bg-red-400"
      : pct >= 65
      ? "bg-amber-400"
      : "bg-emerald-400";

    return (
      <div className={`inline-flex flex-col justify-center px-1.5 py-0.5 rounded border text-[10px] font-mono ${colorCls} min-w-[44px] shrink-0`} title={isStale ? `缓存读数: ${pct}% (应用未运行)` : `当前用量: ${pct}%`}>
        <div className="flex items-center justify-between gap-1 leading-none">
          <span className="font-semibold">{pct}%{isStale ? "*" : ""}</span>
        </div>
        <div className="w-full bg-zinc-800/80 rounded-full h-[2px] mt-0.5 overflow-hidden">
          <div className={`h-full rounded-full ${barCls}`} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
        </div>
      </div>
    );
  };
  const current = view.kind === "account" ? settings.providers[view.id] : undefined;
  const dirtyHere = view.kind === "account" && (accountDirty(view.id) || !(view.id in applied.providers));

  return (
    <main className="h-screen flex flex-col bg-[#0f0f12] text-zinc-200 text-sm select-none font-sans overflow-hidden">
      {closeModal?.isOpen && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-6 animate-in fade-in duration-150">
          <div className="bg-zinc-900 border border-zinc-700/80 rounded-2xl p-6 max-w-md w-full shadow-2xl space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-amber-500/20 border border-amber-500/40 flex items-center justify-center text-amber-400 text-lg font-bold shrink-0">
                ⚠️
              </div>
              <div>
                <h3 className="text-sm font-bold text-white">有未保存的设置更改</h3>
                <p className="text-xs text-zinc-400 mt-0.5">当前存在未保存的账号设置或凭据草稿。请选择您想要进行的操作：</p>
              </div>
            </div>
            <div className="flex flex-col gap-2 pt-2">
              <button onClick={() => void handleModalSaveAndClose()} disabled={busy} className="w-full py-2.5 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold cursor-pointer transition-colors shadow-lg">
                {busy ? "正在保存…" : "保存更改并关闭"}
              </button>
              <button onClick={() => void handleModalDiscardAndClose()} disabled={busy} className="w-full py-2 px-4 rounded-xl bg-zinc-800 hover:bg-red-950/40 hover:text-red-300 text-zinc-300 border border-zinc-700/60 text-xs font-medium cursor-pointer transition-colors">
                放弃更改并关闭
              </button>
              <button onClick={() => void handleModalCancel()} disabled={busy} className="w-full py-2 px-4 rounded-xl text-zinc-400 hover:text-zinc-200 text-xs cursor-pointer transition-colors">
                取消
              </button>
            </div>
          </div>
        </div>
      )}
      {toast && (
        <div className={`fixed top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2.5 rounded-xl shadow-2xl border text-xs font-medium ${toast.type === "success" ? "bg-emerald-950/95 border-emerald-700/60 text-emerald-200" : toast.type === "error" ? "bg-red-950/95 border-red-700/60 text-red-200" : "bg-zinc-900/95 border-zinc-700 text-zinc-200"}`} role="status">
          <span className="font-bold">{toast.type === "success" ? "✓" : toast.type === "error" ? "✕" : "ℹ"}</span><span>{toast.text}</span>
          <button onClick={() => setToast(null)} className="ml-2 text-zinc-400 hover:text-white" aria-label="关闭提示">✕</button>
        </div>
      )}
      {importable && Object.keys(settings.providers).length === 0 && (
        <div className="shrink-0 flex items-center justify-between gap-3 px-5 py-2.5 bg-emerald-950/80 border-b border-emerald-800/60 text-xs text-emerald-200">
          <div className="flex items-center gap-2">
            <span className="text-sm">📦</span>
            <span>检测到本机已安装版的 Pulse 配置（含 {importable.account_count} 个账号：{importable.provider_names.join("、")}）。是否一键导入配置与凭据？</span>
          </div>
          <div className="flex gap-2 shrink-0">
            <button onClick={() => void handleImportConfig()} className="px-3 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium cursor-pointer">立即导入</button>
            <button onClick={() => setImportable(null)} className="px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 cursor-pointer">暂不导入</button>
          </div>
        </div>
      )}
      {antigravityDetected && !hasAntigravity && !dismissedAntigravity && (
        <div className="shrink-0 flex items-center justify-between gap-3 px-5 py-2.5 bg-indigo-950/80 border-b border-indigo-800/60 text-xs text-indigo-200">
          <div className="flex items-center gap-2">
            <span className="text-sm animate-pulse">✨</span>
            <span>检测到本机正在运行 Antigravity 本地服务，可一键完成接入与配额监控。</span>
          </div>
          <div className="flex gap-2 shrink-0">
            <button onClick={() => void handleQuickAddAntigravity()} disabled={busy} className="px-3 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium cursor-pointer transition-colors shadow-sm">
              {busy ? "正在添加…" : "一键接入"}
            </button>
            <button onClick={() => setDismissedAntigravity(true)} className="px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 cursor-pointer transition-colors">
              暂不添加
            </button>
          </div>
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
            <div className="flex items-center gap-2"><h1 className="text-sm font-bold text-white tracking-wide">Pulse</h1><span className="text-[10px] bg-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded font-mono border border-zinc-700/50">v{__APP_VERSION__}</span>{isPortable && <span className="text-[10px] bg-emerald-950 text-emerald-400 px-1.5 py-0.5 rounded font-mono border border-emerald-800/50">便携版</span>}</div>
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
          <button onClick={() => void handleUserClose()} className={`${btnGhost} flex items-center gap-1.5`} title="关闭设置窗口 (Esc)"><span>✕</span><span>关闭</span><kbd className="text-[10px] text-zinc-500 border border-zinc-700 rounded px-1">Esc</kbd></button>
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
                  {quotaCapsule(u, c.enabled)}
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
          <div className={view.kind === "spend" ? "" : "hidden"}><TokenSpend active={view.kind === "spend"} /></div>
          {view.kind === "notifications" && <NotificationsPage settings={settings} update={update} toast={showToast} />}
          {view.kind === "hotkeys" && <HotkeysPage settings={settings} save={saveHotkeys} onError={m => m && showToast("error", m)} />}
          {view.kind === "diagnostics" && <DiagnosticsPage usages={usages} settings={settings} busy={busy} setBusy={setBusy} toast={showToast} open={id => setView({ kind: "account", id })} />}
          {view.kind === "about" && <AboutPage hasDraft={() => anyDirtyRef.current || Object.values(secretsRef.current).some(s => !!s?.trim()) || Object.values(stepfunCredentialsRef.current).some(c => !!c && !!(c.apiKey.trim() || c.oasisToken.trim()))} />}

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
                      <button className="text-xs text-zinc-200 truncate hover:underline cursor-pointer text-left font-medium" onClick={() => setView({ kind: "account", id })}>{c.label}</button>
                      <span className="text-[11px] text-zinc-500 truncate">{providerName(c.provider_id)}</span>
                      <div className="ml-auto flex items-center gap-2 shrink-0">
                        {quotaCapsule(u, c.enabled)}
                        {stateDot(u, c.enabled)}
                        {!c.enabled && <span className="text-[10px] px-1.5 py-[2px] bg-zinc-800 text-zinc-400 rounded border border-zinc-700/60 shrink-0">不在悬浮栏</span>}
                        <div className="flex items-center gap-1 shrink-0 ml-1">
                          <button disabled={locked || index === 0} onClick={() => moveAccount(index, index - 1)} className="w-6 h-6 rounded-md text-zinc-400 hover:text-white hover:bg-zinc-800 disabled:opacity-30 cursor-pointer text-xs" aria-label={`上移 ${c.label}`}>▲</button>
                          <button disabled={locked || index === railOrder.length - 1} onClick={() => moveAccount(index, index + 1)} className="w-6 h-6 rounded-md text-zinc-400 hover:text-white hover:bg-zinc-800 disabled:opacity-30 cursor-pointer text-xs" aria-label={`下移 ${c.label}`}>▼</button>
                        </div>
                      </div>
                    </li>); })}
                  {railOrder.length === 0 && <p className="text-xs text-zinc-500">尚无账号。</p>}
                </ul>
              </Section>
            </div>
          )}

          {view.kind === "account" && current && (() => {
            const id = view.id, c = current, reading = usages.find(u => u.account_id === id), routes = ROUTES[c.provider_id] ?? {};
            const isTesting = testingId === id, timedWindows = reading ? timingWindows(reading,c).filter(w => w.window_seconds && w.resets_at) : [];
            const position = railOrder.indexOf(id) + 1;
            const effectivePrimaryWindow = c.primary_window || reading?.windows?.reduce((max, w) => (!max || w.used_percent > max.used_percent ? w : max), reading?.windows[0])?.id || null;
            const isDuplicateInner = !!(c.secondary_window && effectivePrimaryWindow && c.secondary_window === effectivePrimaryWindow);
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
                    c.provider_id === "stepfun" ? (
                      <div className="p-3.5 bg-zinc-950/60 rounded-xl border border-white/5 space-y-3">
                        <div className="flex justify-between items-center text-xs">
                          <span className={c.credential_configured ? "text-emerald-400 font-medium" : "text-zinc-400"}>
                            {c.credential_configured ? "🔒 凭据已安全保存（Windows 凭据管理器）" : "尚未配置 StepFun 凭据"}
                          </span>
                          <span className="text-[11px] text-zinc-500">双模式凭据（API Key / Oasis-Token）</span>
                        </div>
                        <div className="space-y-2.5">
                          <div>
                            <div className="flex justify-between text-xs text-zinc-300 mb-1">
                              <span>API Key（用于查询账户余额 ¥，留空保留已保存值）</span>
                              <span className="text-[11px] text-zinc-500">可选</span>
                            </div>
                            <div className="relative">
                              <input
                                type={showStepfunApiKey[id] ? "text" : "password"}
                                className={`${inputCls} pr-9`}
                                placeholder={c.credential_configured ? "输入新 API Key 以更新（留空则保留原配置）" : "Jbz085... 或默认 API Key"}
                                value={stepfunCredentials[id]?.apiKey || ""}
                                onChange={e => setStepfunCredentials(s => ({ ...s, [id]: { ...(s[id] || { apiKey: "", oasisToken: "" }), apiKey: e.target.value } }))}
                                autoComplete="off"
                                spellCheck={false}
                                aria-label="StepFun API Key"
                              />
                              <button
                                type="button"
                                onClick={() => setShowStepfunApiKey(s => ({ ...s, [id]: !s[id] }))}
                                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-200 text-xs cursor-pointer"
                              >
                                {showStepfunApiKey[id] ? "隐藏" : "显示"}
                              </button>
                            </div>
                          </div>

                          <div>
                            <div className="flex justify-between items-center text-xs text-zinc-300 mb-1">
                              <span>网页 Oasis-Token / Cookie（用于查询 Step Plan Credit 套餐与周期限额）</span>
                              <button
                                type="button"
                                onClick={() => setShowStepfunHelp(v => !v)}
                                className="text-[11px] text-emerald-400 hover:underline cursor-pointer flex items-center gap-1"
                              >
                                <span>💡 如何获取？</span>
                              </button>
                            </div>
                            <div className="relative">
                              <input
                                type={showStepfunOasisToken[id] ? "text" : "password"}
                                className={`${inputCls} pr-9`}
                                placeholder={c.credential_configured ? "输入新 Oasis-Token 以更新（留空则保留原配置）" : "Oasis-Token=... 或完整 Cookie"}
                                value={stepfunCredentials[id]?.oasisToken || ""}
                                onChange={e => setStepfunCredentials(s => ({ ...s, [id]: { ...(s[id] || { apiKey: "", oasisToken: "" }), oasisToken: e.target.value } }))}
                                autoComplete="off"
                                spellCheck={false}
                                aria-label="StepFun Oasis-Token"
                              />
                              <button
                                type="button"
                                onClick={() => setShowStepfunOasisToken(s => ({ ...s, [id]: !s[id] }))}
                                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-200 text-xs cursor-pointer"
                              >
                                {showStepfunOasisToken[id] ? "隐藏" : "显示"}
                              </button>
                            </div>
                          </div>

                          {showStepfunHelp && (
                            <div className="p-2.5 rounded-xl bg-zinc-900 border border-zinc-700/60 text-xs text-zinc-300 space-y-1.5 leading-relaxed">
                              <div className="font-semibold text-zinc-200">如何获取 Oasis-Token：</div>
                              <ol className="list-decimal list-inside space-y-1 text-zinc-400 text-[11px]">
                                <li>在电脑浏览器打开 <span className="text-zinc-200 font-mono">platform.stepfun.com</span> 并保持登录。</li>
                                <li>按 <kbd className="px-1 py-0.5 bg-zinc-800 rounded border border-zinc-700 font-mono">F12</kbd> 打开开发者工具，切换到 <span className="text-zinc-200">Console</span>（控制台）。</li>
                                <li>输入 <code className="text-emerald-400 font-mono">document.cookie</code> 并回车。</li>
                                <li>找到 <code className="text-zinc-200 font-mono">Oasis-Token=...</code>，将其值（或整串 cookie）复制并粘贴至上方输入框即可。</li>
                              </ol>
                            </div>
                          )}

                          <div className="flex gap-2 justify-end pt-1">
                            <button
                              disabled={locked || (!stepfunCredentials[id]?.apiKey && !stepfunCredentials[id]?.oasisToken)}
                              onClick={() => void handleSaveCredential(id)}
                              className={btnPrimary}
                            >
                              保存凭据
                            </button>
                            {c.credential_configured && (
                              <button
                                disabled={locked}
                                onClick={() => void handleDeleteCredential(id)}
                                className={confirmArmed === `cred:${id}` ? "px-3 py-1.5 bg-red-950/50 text-red-300 border border-red-900/60 rounded-xl text-xs font-medium transition-all disabled:opacity-40 cursor-pointer" : "px-3 py-1.5 bg-zinc-900 hover:bg-red-950/40 text-red-400 border border-zinc-800 hover:border-red-900/60 rounded-xl text-xs font-medium transition-all disabled:opacity-40 cursor-pointer"}
                              >
                                {confirmArmed === `cred:${id}` ? "确认移除？" : "删除凭据"}
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    ) : (
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
                    )
                  )}
                  <p className="text-[11px] text-zinc-500">数据来源：{reading?.source || "尚未获得读数"}</p>
                </Section>

                <Section title="悬浮栏" icon="◎" subtitle="保存后即刻生效。">
                  {(() => {
                    const previewSettings: AppSettings = {
                      ...settings,
                      providers: { ...settings.providers, [id]: c },
                    };
                    const previewUsage: ProviderUsage = reading ? {
                      ...reading,
                      display_name: c.label || providerName(c.provider_id),
                    } : {
                      account_id: id,
                      provider_id: c.provider_id,
                      display_name: c.label || providerName(c.provider_id),
                      state: "live",
                      checked_at: new Date().toISOString(),
                      last_success_at: new Date().toISOString(),
                      primary_percent: c.primary_window === "__balance__" ? null : 42,
                      plan_name: null,
                      is_active: false,
                      retry_after_seconds: null,
                      duration_ms: null,
                      windows: c.primary_window === "__balance__" ? [] : (c.provider_id === "antigravity" ? [
                        { id: "0-0", name: "Gemini 模型 · 每周限额", used_fraction: 0.25, used_percent: 25, resets_at: new Date(Date.now() + 86400000 * 5).toISOString(), window_seconds: 604800, exhausted: false },
                        { id: "0-1", name: "Gemini 模型 · 5小时限额", used_fraction: 0.42, used_percent: 42, resets_at: new Date(Date.now() + 3600000 * 3).toISOString(), window_seconds: 18000, exhausted: false },
                        { id: "1-0", name: "Claude 与 GPT 模型 · 每周限额", used_fraction: 0.1, used_percent: 10, resets_at: new Date(Date.now() + 86400000 * 6).toISOString(), window_seconds: 604800, exhausted: false },
                        { id: "1-1", name: "Claude 与 GPT 模型 · 5小时限额", used_fraction: 0.68, used_percent: 68, resets_at: new Date(Date.now() + 3600000 * 2).toISOString(), window_seconds: 18000, exhausted: false },
                      ] : [
                        { id: "primary", name: "主要限额", used_fraction: 0.35, used_percent: 35, resets_at: new Date(Date.now() + 3600000 * 4).toISOString(), window_seconds: 18000, exhausted: false },
                      ]),
                      balances: c.primary_window === "__balance__" || c.provider_id === "stepfun" ? [{ currency: "CNY", amount: 15.0 }] : [],
                      error_message: null,
                      error_code: null,
                      source: "预览模式",
                    };
                    return (
                      <div className="p-3 bg-zinc-950/50 rounded-xl border border-white/5 flex items-center justify-between gap-4">
                        <div className="space-y-0.5 min-w-0">
                          <div className="text-xs font-semibold text-zinc-300">悬浮栏效果实时预览</div>
                          <p className="text-[11px] text-zinc-500">即时预览主圆环、第二内环、时间外环与机器人外观设置</p>
                        </div>
                        <div className="p-1.5 bg-zinc-900/90 rounded-xl border border-zinc-800 shrink-0 flex items-center justify-center">
                          <UsageRing
                            usage={previewUsage}
                            settings={previewSettings}
                            onHover={() => {}}
                          />
                        </div>
                      </div>
                    );
                  })()}

                  <Field label="主圆环显示的额度" hint={c.primary_window === "__balance__" ? "纯余额模式：主圆环不绘制百分比圆弧，底部直接展示“余额”与实时账户数值。" : reading?.windows && reading.windows.length > 0 ? "圆环以该窗口的使用率与重置倒计时为准。" : c.provider_id === "antigravity" ? "支持选择 Antigravity 预设额度窗口；连接成功后将显示实时用量与重置倒计时。" : "尚未获取该账号的额度数据；配置凭据并连接成功后，可在此下拉指定具体的额度窗口。"}>
                    <select className={selectCls} value={c.primary_window || ""} onChange={e => patch(id, { primary_window: e.target.value || null })}>
                      <option value="">自动选择最高使用率（默认）</option>
                      {(c.provider_id === "stepfun" || (reading?.balances && reading.balances.length > 0) || c.primary_window === "__balance__") && (
                        <option value="__balance__">💰 纯余额模式 (不显示百分比圆环)</option>
                      )}
                      {c.primary_window && c.primary_window !== "__balance__" && !reading?.windows?.some(w => w.id === c.primary_window) && !ANTIGRAVITY_DEFAULT_WINDOWS.some(w => c.provider_id === "antigravity" && w.id === c.primary_window) && (
                        <option value={c.primary_window}>{c.primary_window}（已配置 · 等待读数）</option>
                      )}
                      {reading?.windows && reading.windows.length > 0
                        ? reading.windows.map(w => <option key={w.id} value={w.id}>{w.name} — 已使用 {w.used_percent.toFixed(1)}% ({resetText(w.resets_at)})</option>)
                        : c.provider_id === "antigravity"
                        ? ANTIGRAVITY_DEFAULT_WINDOWS.map(w => <option key={w.id} value={w.id}>{w.name}</option>)
                        : null}
                    </select>
                  </Field>

                  <Field label="时间外环周期长度" hint="自动优先使用数据源周期；StepFun 套餐缺少完整账期时按 30 天规则估算。重置时间始终来自接口。">
                    <select className={selectCls} value={c.elapsed_period_days==null?'auto':'custom'} onChange={e=>patch(id,{elapsed_period_days:e.target.value==='auto'?null:30})}>
                      <option value="auto">自动识别周期（默认）</option><option value="custom">自定义周期长度</option>
                    </select>
                    {c.elapsed_period_days!=null&&<label className="block text-xs text-zinc-400 mt-2">周期天数（支持小数，1 小时至 366 天）
                      <input aria-label="自定义周期天数" type="number" min={1/24} max={366} step="any" className={selectCls} value={c.elapsed_period_days} onChange={e=>{const n=e.target.valueAsNumber;if(Number.isFinite(n))patch(id,{elapsed_period_days:n})}}/>
                      <span>按自定义周期估算；仅用于时间外环，不改变服务商真实额度或自动充值。</span>
                    </label>}
                  </Field>
                  <Field label="此账号时间外环使用的周期" hint={reading?.windows && reading.windows.length > 0
                    ? timedWindows.length === 0
                      ? "该账号的额度窗口未报告周期长度，外圈暂不可用。"
                      : settings.show_elapsed ? "外圈细线表示所选周期已流逝的比例；默认跟随倒计时最短的周期。" : "外圈已在通用设置中关闭。"
                    : c.provider_id === "antigravity"
                    ? "支持选择 Antigravity 预设周期；连接成功后将自动对齐倒计时。"
                    : "尚未获取该账号的额度数据；连接成功后将自动识别周期长度。"}>
                    <select className={selectCls} disabled={timedWindows.length === 0 && !c.elapsed_window && c.provider_id !== "antigravity"} value={c.elapsed_window || ""} onChange={e => patch(id, { elapsed_window: e.target.value || null })}>
                      <option value="">自动选择倒计时最短的周期（默认）</option>
                      {c.elapsed_window && !timedWindows.some(w => w.id === c.elapsed_window) && !ANTIGRAVITY_DEFAULT_WINDOWS.some(w => c.provider_id === "antigravity" && w.id === c.elapsed_window) && (
                        <option value={c.elapsed_window}>{c.elapsed_window}（已配置 · 等待读数）</option>
                      )}
                      {timedWindows.length > 0
                        ? timedWindows.map(w => <option key={w.id} value={w.id}>{w.name} — {resetText(w.resets_at)} · {w.period_note}</option>)
                        : c.provider_id === "antigravity"
                        ? ANTIGRAVITY_DEFAULT_WINDOWS.map(w => <option key={w.id} value={w.id}>{w.name}</option>)
                        : null}
                    </select>
                  </Field>

                  {!settings.show_elapsed && (
                    <div className="p-2.5 rounded-xl bg-zinc-900/90 border border-zinc-700/60 text-xs text-zinc-300 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <span className="text-amber-400">ℹ️</span>
                        <span>时间外环目前在全局已关闭。开启后，所有账号均可显示倒计时进度环。</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => update({ show_elapsed: true }, "已开启全局时间外环")}
                        className="px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-medium cursor-pointer shrink-0"
                      >
                        开启时间外环（所有账号）
                      </button>
                    </div>
                  )}

                  <Row title="圆环颜色" subtitle="自定义颜色用于正常区间；达到琥珀/红色阈值或服务商报告耗尽时仍按预警色显示。">
                    <div className="flex items-center gap-2">
                      <select className={selectCls} value={c.ring_color ? "custom" : "auto"} onChange={e => patch(id, { ring_color: e.target.value === "custom" ? (c.ring_color ?? (c.provider_id === "kimi" ? "#7AA5FF" : "#10b981")) : null })} aria-label="圆环颜色模式"><option value="auto">自动（按用量压力）</option><option value="custom">自定义</option></select>
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
                        <select className={selectCls} value={c.bot_color ? "custom" : "auto"} onChange={e => patch(id, { bot_color: e.target.value === "custom" ? (c.bot_color ?? (c.provider_id === "kimi" ? "#7AA5FF" : "#10b981")) : null })} aria-label="机器人颜色模式"><option value="auto">跟随主题</option><option value="custom">自定义</option></select>
                        {c.bot_color && <input type="color" value={c.bot_color} onChange={e => patch(id, { bot_color: e.target.value })} className="w-9 h-8 rounded-lg bg-transparent border border-zinc-700 cursor-pointer" aria-label="选择机器人颜色" />}
                      </div></Field>
                    </div>
                  )}

                  <Field label="第二额度内环（可选）" hint={!reading || !reading.windows || reading.windows.length <= 1
                    ? c.provider_id === "antigravity"
                      ? "在主环内侧用细环显示所选额度（如 5小时与每周限额同时显示）。"
                      : "在主环内侧用细环显示所选额度；连接成功并获取多项额度后可在此开启双环显示。"
                    : "在主环内侧用细环显示所选额度；选择“关闭”即完全清除内环。"}>
                    <select className={selectCls} value={c.secondary_window || ""} onChange={e => patch(id, { secondary_window: e.target.value || null })}>
                      <option value="">关闭</option>
                      {c.secondary_window && !reading?.windows?.some(w => w.id === c.secondary_window) && !ANTIGRAVITY_DEFAULT_WINDOWS.some(w => c.provider_id === "antigravity" && w.id === c.secondary_window) && (
                        <option value={c.secondary_window}>{c.secondary_window}（已配置 · 等待读数）</option>
                      )}
                      {reading?.windows && reading.windows.length > 0
                        ? reading.windows.map(w => {
                            const isPrimary = w.id === effectivePrimaryWindow;
                            return (
                              <option key={w.id} value={w.id} disabled={isPrimary}>
                                {w.name} {isPrimary ? "（已被主环占用）" : `— 已使用 ${w.used_percent.toFixed(1)}%`}
                              </option>
                            );
                          })
                        : c.provider_id === "antigravity"
                        ? ANTIGRAVITY_DEFAULT_WINDOWS.map(w => {
                            const isPrimary = w.id === effectivePrimaryWindow;
                            return (
                              <option key={w.id} value={w.id} disabled={isPrimary}>
                                {w.name} {isPrimary ? "（已被主环占用）" : ""}
                              </option>
                            );
                          })
                        : null}
                    </select>
                  </Field>

                  {isDuplicateInner && (
                    <div className="p-2.5 rounded-xl bg-amber-950/60 border border-amber-800/60 text-xs text-amber-200 space-y-1.5">
                      <div className="flex items-center gap-2 font-medium">
                        <span>⚠️</span>
                        <span>第二内环与主圆环选择了相同额度，悬浮栏将自动隐藏重复内环。</span>
                      </div>
                      <p className="text-[11px] text-amber-300/80">
                        内环用于同时对比另一额度（例如同时观察“5小时”和“每周”限额）。
                      </p>
                      {c.provider_id === "antigravity" && (
                        <div className="flex items-center gap-2 pt-1">
                          <button
                            type="button"
                            onClick={() => {
                              const alt = effectivePrimaryWindow?.endsWith("-1")
                                ? effectivePrimaryWindow.replace("-1", "-0")
                                : effectivePrimaryWindow?.endsWith("-0")
                                ? effectivePrimaryWindow.replace("-0", "-1")
                                : "0-0";
                              patch(id, { secondary_window: alt });
                            }}
                            className="px-2.5 py-1 rounded bg-amber-800/80 hover:bg-amber-700 text-amber-100 text-[11px] cursor-pointer"
                          >
                            切换内环为另一个周期（如每周限额）
                          </button>
                          <button
                            type="button"
                            onClick={() => patch(id, { secondary_window: null })}
                            className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[11px] cursor-pointer"
                          >
                            关闭第二内环
                          </button>
                        </div>
                      )}
                    </div>
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
                    {reading.error_message && <p className="text-xs text-amber-400 mb-2">{reading.error_message}</p>}
                    <div className="space-y-2.5">
                      {reading.windows.map(w => {
                        const isPrimary = c.primary_window === w.id || (!c.primary_window && w.used_percent === reading.primary_percent);
                        const isTimed = pickElapsedWindow(timingWindows(reading,c), c.elapsed_window ?? null)?.id === w.id;
                        return (
                          <div key={w.id} className="space-y-1">
                            <div className="flex justify-between items-center text-xs">
                              <span className="flex items-center gap-1.5 text-zinc-300">{w.name}
                                {isPrimary && <span className="text-[10px] bg-emerald-950/80 text-emerald-400 px-1.5 py-[2px] rounded border border-emerald-800/40">主额度</span>}
                                {isTimed && settings.show_elapsed && <span className="text-[10px] bg-zinc-800 text-zinc-300 px-1.5 py-[2px] rounded border border-zinc-600/60">时间环</span>}
                              </span>
                              <span className="font-mono text-zinc-200">{Number(w.used_percent.toFixed(2))}% 已用</span>
                            </div>
                            <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden"><div className={`h-full rounded-full transition-all duration-500 ${w.exhausted || w.used_percent >= settings.warning_threshold ? "bg-red-500" : w.used_percent >= settings.warning_threshold - 15 ? "bg-amber-400" : "bg-emerald-500"}`} style={{ width: `${Math.min(100, Math.max(0, w.used_percent))}%` }} /></div>
                            <div className="text-[11px] text-zinc-500">{resetText(w.resets_at)}</div>
                          </div>
                        );
                      })}
                      {reading.balances.map(b => <div key={b.currency} className="flex justify-between text-xs"><span className="text-zinc-300">{balanceLabel(c.provider_id,b.currency)}</span><span className="font-mono text-zinc-200">{balanceText(b.currency,b.amount)}</span></div>)}
                    </div>
                  </Section>
                )}

                <Section title="诊断" icon="🩺" subtitle="来自最近一次刷新；报告文本不含账号名与凭据。"
                  aside={<div className="flex gap-2">
                    <button disabled={locked} onClick={() => void test(id)} className={btnGhost} title="重新同步当前账号">
                      {isTesting ? "同步中…" : "重新同步"}
                    </button>
                    <button disabled={locked} onClick={() => {
                      const summaryLines = [
                        `=== Pulse 账号诊断摘要 ===`,
                        `时间: ${new Date().toISOString()}`,
                        `服务商: ${c.provider_id}`,
                        `状态: ${reading?.state ?? "未连接"}`,
                        `凭据已配置: ${c.credential_configured ? "是" : "否"}`,
                        `本机工具读取: ${c.use_local ? "是" : "否"}`,
                        `主额度窗口: ${c.primary_window || "自动"}`,
                        `第二内环: ${c.secondary_window || "关闭"}`,
                        `时间外环: ${c.elapsed_window || "自动"} (全局开启: ${settings.show_elapsed ? "是" : "否"})`,
                        `数据源: ${reading?.source || "无"}`,
                        `耗时: ${reading?.duration_ms != null ? `${reading.duration_ms}ms` : "无"}`,
                        `错误分类: ${reading?.error_code || "无"}`,
                        `错误信息: ${reading?.error_message || "无"}`,
                        `额度窗口数量: ${reading?.windows?.length ?? 0}`,
                        ...(reading?.windows?.map(w => `  - [${w.id}] ${w.name}: ${w.used_percent.toFixed(1)}% (重置: ${w.resets_at || "无"})`) || []),
                        `余额数量: ${reading?.balances?.length ?? 0}`,
                        ...(reading?.balances?.map(b => `  - ${b.currency}: ${b.amount}`) || []),
                      ];
                      void navigator.clipboard.writeText(summaryLines.join("\n"));
                      showToast("success", "已复制安全诊断摘要至剪贴板");
                    }} className={btnGhost} title="复制不含敏感信息的诊断摘要">
                      复制诊断摘要
                    </button>
                  </div>}>
                  {reading ? (
                    <dl className="grid grid-cols-[7rem_1fr] gap-y-1.5 text-xs">
                      {accountRows(reading, c).map(([k, v]) => <div key={k} className="contents"><dt className="text-zinc-500">{k}</dt><dd className="text-zinc-200 break-all">{v}</dd></div>)}
                    </dl>
                  ) : <p className="text-xs text-zinc-500">{c.enabled ? "尚未获得读数，保存后等待下一次刷新或点击“保存并测试连接”。" : "账号已停用，不参与刷新。"}</p>}
                  {reading?.error_code === "auth" && <p className="text-[11px] text-amber-300">下一步：凭据已失效或过期——在上方重新输入并保存新凭据，或在对应本地客户端重新登录后再测试。</p>}
                  {reading?.error_code === "forbidden" && <p className="text-[11px] text-amber-300">下一步：访问被服务商拒绝 (403)——请检查 API Key 权限、账户账单状态、服务商区域限制或网络代理出口 IP。</p>}
                  {reading?.error_code === "proxy" && <p className="text-[11px] text-amber-300">下一步：网络代理连接失败——请在“通用设置”中检查网络代理配置，或开启“自动探测”。</p>}
                  {reading?.error_code === "dns" && <p className="text-[11px] text-amber-300">下一步：DNS 域名解析失败——请检查系统网络连接或 DNS 设置。</p>}
                  {reading?.error_code === "tls" && <p className="text-[11px] text-amber-300">下一步：TLS / HTTPS 安全握手失败——请检查系统根证书或代理抓包证书配置。</p>}
                  {reading?.error_code === "timeout" && <p className="text-[11px] text-amber-300">下一步：连接服务商超时——请检查网络延迟或代理连接状态。</p>}
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
      {!settings.monitoring_setup_completed && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-6">
          <div className="w-[28rem] max-h-[34rem] bg-zinc-900 border border-zinc-700/80 rounded-2xl shadow-2xl p-6 flex flex-col space-y-4">
            <div className="flex items-center gap-3">
              <span className="text-2xl">🛡️</span>
              <div>
                <h3 className="text-base font-semibold text-zinc-100">欢迎使用 Pulse</h3>
                <p className="text-xs text-zinc-400">首次启动：请配置您的服务商监控授权</p>
              </div>
            </div>
            <div className="text-xs text-zinc-300/90 leading-relaxed bg-zinc-950/60 p-3 rounded-xl border border-white/5">
              Pulse 承诺<b>零云端数据回传、零遥测</b>。所有凭据均保存在本机 Windows 凭据管理器中。请勾选您希望 Pulse 监控的服务商（未勾选的服务商将保持零连接、零后台扫描）：
            </div>
            <div className="flex-1 flex flex-col min-h-0 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-zinc-400">选择服务商 ({wizardSelected.length} / {PROVIDERS.length})：</span>
                <div className="flex gap-2">
                  <button className="text-emerald-400 hover:text-emerald-300 cursor-pointer" onClick={() => setWizardSelected(PROVIDERS.map(p => p[0]))}>全选</button>
                  <span className="text-zinc-600">·</span>
                  <button className="text-emerald-400 hover:text-emerald-300 cursor-pointer" onClick={() => setWizardSelected(["claude", "codex", "antigravity", "kimi"])}>常用</button>
                  <span className="text-zinc-600">·</span>
                  <button className="text-zinc-400 hover:text-zinc-300 cursor-pointer" onClick={() => setWizardSelected([])}>暂不监控</button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 overflow-y-auto p-2 bg-zinc-950/50 rounded-xl border border-white/5 flex-1">
                {PROVIDERS.map(([pid, name]) => (
                  <label key={pid} className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer hover:bg-white/5 p-1.5 rounded-lg">
                    <input
                      type="checkbox"
                      checked={wizardSelected.includes(pid)}
                      onChange={e => {
                        setWizardSelected(prev => e.target.checked ? [...prev, pid] : prev.filter(x => x !== pid));
                      }}
                      className="accent-emerald-500 rounded"
                    />
                    <span className="truncate">{name}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="pt-2 flex justify-end gap-3 border-t border-white/5">
              <button
                className={btnPrimary}
                onClick={async () => {
                  const updated: AppSettings = {
                    ...settings,
                    monitoring_setup_completed: true,
                    authorized_providers: wizardSelected,
                  };
                  setSettings(updated);
                  await persist(updated, `已完成授权！已授权 ${wizardSelected.length} 个服务商。`);
                }}
              >
                完成设置并开始使用
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
