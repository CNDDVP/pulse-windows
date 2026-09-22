import {balanceText,balanceLabel} from "../presentation";
import { connectCloseBridge, type CloseRequest } from "../closeBridge";
import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { AppSettings, HotkeySettings, MonitorOption, ProviderConfig, ProviderUsage, RefreshSummary } from "../types";
import { ProviderIcon } from "../components/icons/ProviderIcons";
import { UsageRing } from "../components/UsageRing";
// 机器人个性/形状只存 id；显示名经 t() 查词典（settings.bot.*）。
const BOT_PERSONAS: string[]=["calm","eager","steady","curious","sleepy","playful","stoic","proud"];
const BOT_SHAPES: string[]=["blob","pebble","bean","egg","squircle","tablet","capsule","cylinder","hex","gem","crystal","wedge","shield","dome","arch","cloud","teardrop","leaf"];
// Antigravity 预设额度窗口：name 为 i18n key（settings.aggrwin.*）。
const ANTIGRAVITY_DEFAULT_WINDOWS = [
  { id: "0-0", name: "settings.aggrwin.0-0" },
  { id: "0-1", name: "settings.aggrwin.0-1" },
  { id: "1-0", name: "settings.aggrwin.1-0" },
  { id: "1-1", name: "settings.aggrwin.1-1" },
];
import { TokenSpend } from "./TokenSpend";
import { resetText, pickElapsedWindow, timingWindows } from "../presentation";
import { orderedIds, moveItem, applyOrder } from "../ordering";
import { Switch, Section, Row, Field } from "./settings/shared";
import { PROVIDERS, ROUTES, providerName, getPlaceholder, selectCls, inputCls, btnPrimary, btnGhost, ageText, accountRows } from "./settings/constants";
import { useLang } from "../lib/i18n";
import { GeneralPage } from "./settings/GeneralPage";
import { NotificationsPage } from "./settings/NotificationsPage";
import { HotkeysPage } from "./settings/HotkeysPage";
import { AboutPage } from "./settings/AboutPage";
import { DiagnosticsPage } from "./settings/DiagnosticsPage";

declare const __APP_VERSION__: string;

type View = { kind: "general" | "spend" | "accounts" | "notifications" | "hotkeys" | "diagnostics" | "about" } | { kind: "account"; id: string };
type ToastKind = "success" | "info" | "error";

// title/keywords 存 i18n key；渲染与搜索时经 t() 取当前语言的标题与搜索关键词。
const PAGES: { kind: Exclude<View, { kind: "account" }>["kind"]; title: string; icon: string; group: "pulse" | "app"; keywords: string }[] = [
  { kind: "general", title: "settings.page.general", icon: "⚙️", group: "pulse", keywords: "settings.page.general.kw" },
  { kind: "spend", title: "spend.title", icon: "📊", group: "pulse", keywords: "settings.page.spend.kw" },
  { kind: "notifications", title: "settings.page.notifications", icon: "🔔", group: "app", keywords: "settings.page.notifications.kw" },
  { kind: "hotkeys", title: "settings.page.hotkeys", icon: "⌨", group: "app", keywords: "settings.page.hotkeys.kw" },
  { kind: "diagnostics", title: "settings.page.diagnostics", icon: "🩺", group: "app", keywords: "settings.page.diagnostics.kw" },
  { kind: "about", title: "settings.page.about", icon: "ℹ️", group: "app", keywords: "settings.page.about.kw" },
];

export function SettingsWindow({ initialSettings, usages: externalUsages, onSaved }: { initialSettings: AppSettings; usages: ProviderUsage[]; onSaved: (s: AppSettings) => void }) {
  const { t, lang } = useLang();
  const [settings, setSettings] = useState<AppSettings>(initialSettings);
  const [localUsages, setLocalUsages] = useState<ProviderUsage[]>(externalUsages);
  useEffect(() => { setLocalUsages(externalUsages); }, [externalUsages]);
  const usages = localUsages;
  const [isPortable, setIsPortable] = useState(false);
  useEffect(() => {
    invoke<boolean>("is_portable").then(setIsPortable).catch(() => {});
  }, []);
  const [view, setView] = useState<View>({ kind: "accounts" });

  const [search, setSearch] = useState("");
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
  const [stepfunCredentials, setStepfunCredentials] = useState<Record<string, { apiKey: string; oasisToken: string }>>({});
  const [showStepfunApiKey, setShowStepfunApiKey] = useState<Record<string, boolean>>({});
  const [showStepfunOasisToken, setShowStepfunOasisToken] = useState<Record<string, boolean>>({});
  const [showStepfunHelp, setShowStepfunHelp] = useState(false);
  const [webLoginLoading, setWebLoginLoading] = useState<Record<string, boolean>>({});
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
      showToast("success", t("settings.toast.antigravity_added"));
    } catch (e) {
      showToast("error", t("settings.toast.antigravity_fail", { err: String(e) }));
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
      showToast("success", t("settings.toast.imported", { count: Object.keys(imported.providers).length }));
    } catch (e) {
      showToast("error", t("settings.toast.import_fail", { err: String(e) }));
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
  useEffect(() => {
    const unlistenSuccess = listen<{ account_id: string }>("stepfun-login-success", event => {
      const aid = event.payload.account_id;
      setWebLoginLoading(s => ({ ...s, [aid]: false }));
      // stepfun-login-error / 后端其他 emit 文案原样展示。TODO(EN-backend)
      showToast("success", t("settings.toast.stepfun_login_ok"));
      // The settings-updated bridge below reconciles remote changes with drafts.
      // Do not erase unsaved API Key / account edits when a web login completes.

    });

    const unlistenError = listen<string>("stepfun-login-error", event => {setWebLoginLoading({});showToast("error", event.payload);});
    const unlistenClosed = listen("stepfun-login-closed", () => {
      setWebLoginLoading({});
    });

    return () => {
      unlistenSuccess.then(fn => fn()).catch(() => {});
      unlistenClosed.then(fn => fn()).catch(() => {});
      unlistenError.then(fn => fn()).catch(() => {});
    };
  }, [onSaved]);
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
    } catch (e) { showToast("error", t("settings.common.save_fail", { err: String(e) })); throw e; } finally { setBusy(false); }
  };
  /** Ordinary settings save on change; a rejected save (e.g. hotkey conflict) rolls the UI back. */
  const update = (patch: Partial<AppSettings>, message = "") => {
    const prev = settings, next = { ...settings, ...patch };
    // 提交时 providers 用已保存基线（A26）：账号草稿只在账号页显式保存时落盘。
    const persisted = { ...next, providers: appliedRef.current.providers };
    setSettings(next);
    persist(persisted, message, true).catch(() => setSettings(prev));
  };
  const saveHotkeys = (hk: HotkeySettings) => update({ hotkeys: hk }, t("settings.toast.hotkeys_saved"));
  // Token 消耗页的订阅记录走独立命令（save_subscriptions）落盘；这里同步本窗口的
  // 设置快照，否则下一次普通设置保存会把旧 subscriptions 整表写回去（A03 同类竞态）。
  const applySubscriptions = (subs: AppSettings["subscriptions"]) => {
    if (!subs) return;
    const merged = { ...appliedRef.current, subscriptions: subs };
    appliedRef.current = merged;
    setApplied(merged);
    setSettings(cur => ({ ...cur, subscriptions: subs }));
  };
  // Token 消耗页的扫描路径走独立命令（save_token_spend_extra_paths）落盘；与订阅记录同理
  // （A03 同类竞态）：面板保存后若不同步本窗口快照，下一次普通设置保存会把旧的
  // token_spend_extra_paths 整表写回去，静默丢掉刚保存的扫描路径。
  const applyScanPaths = (paths: AppSettings["token_spend_extra_paths"]) => {
    if (!paths) return;
    const merged = { ...appliedRef.current, token_spend_extra_paths: paths };
    appliedRef.current = merged;
    setApplied(merged);
    setSettings(cur => ({ ...cur, token_spend_extra_paths: paths }));
  };
  const patch = (id: string, value: Partial<ProviderConfig>) => setSettings(s => ({ ...s, providers: { ...s.providers, [id]: { ...s.providers[id], ...value } } }));

  // Account pages keep an explicit save because credentials and labels are typed, not toggled.
  const accountDirty = (id: string) => JSON.stringify(settings.providers[id]) !== JSON.stringify(applied.providers[id]);
  const anyDirty = Object.keys(settings.providers).some(accountDirty) || Object.keys(applied.providers).some(id => !(id in settings.providers));
  const saveAccounts = () => persist(settings, t("settings.toast.accounts_saved")).catch(() => {});
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
    if (locked) { showToast("info", t("settings.toast.order_deferred")); return; }
    persist(persisted, t("settings.toast.order_saved")).catch(() => {});
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
    patch(id, { provider_id: pid, label: providerName(pid, t), enabled: true, order: Object.values(settings.providers).reduce((m, c) => Math.max(m, c.order), -1) + 1, use_local: !!ROUTES[pid]?.local, credential_configured: false, primary_window: null, elapsed_window: null, elapsed_period_days: null, ring_color: pid === "kimi" ? "#7AA5FF" : null, low_balance: null, low_balance_currency: null, mark_mode: null, bot_persona: null, bot_shape: null, bot_color: pid === "kimi" ? "#7AA5FF" : null, secondary_window: null, split_model_groups: false });
    setPickerOpen(false); setPickerQuery("");
    setView({ kind: "account", id });
    showToast("info", t("settings.toast.account_added", { name: providerName(pid, t) }));
  };
  const remove = (id: string) => {
    const label = settings.providers[id]?.label || t("settings.common.this_account");
    const key = `del:${id}`;
    if (confirmArmed !== key) { armConfirm(key); showToast("info", t("settings.toast.delete_confirm", { label })); return; }
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
        showToast("info", t("settings.toast.deleted", { label }));
      } catch (e) {
        showToast("error", t("settings.toast.delete_fail", { err: String(e) }));
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
      showToast("success", t("settings.toast.cred_saved_stepfun"));
    } catch (e) { showToast("error", t("settings.toast.cred_save_fail", { err: String(e) })); } finally { setBusy(false); }
  };
  const handleDeleteCredential = async (id: string) => {
    const key = `cred:${id}`;
    if (confirmArmed !== key) { armConfirm(key); showToast("info", t("settings.toast.cred_delete_confirm")); return; }
    disarmConfirm();
    setBusy(true);
    try { await invoke("delete_credential", { accountId: id }); showToast("info", t("settings.toast.cred_removed")); }
    catch (e) { showToast("error", t("settings.toast.cred_delete_fail", { err: String(e) })); } finally { setBusy(false); }
  };
  const handleStepfunWebLogin = async (accountId: string) => {
    try {
      setWebLoginLoading(s => ({ ...s, [accountId]: true }));
      await invoke("open_stepfun_login", { accountId });
    } catch (err) {
      setWebLoginLoading(s => ({ ...s, [accountId]: false }));
      showToast("error", t("settings.toast.login_open_fail", { err: String(err) }));
    }
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
      // TODO(EN-backend)：r.error_message/r.state 来自 Rust test_account，原样拼接展示不翻译。
      showToast(r.state === "live" ? "success" : "error", r.state === "live" ? t("settings.toast.test_ok", { name: r.display_name }) : `${r.display_name}: ${r.error_message || r.state}`);
    } catch (e) { showToast("error", t("settings.toast.test_fail", { err: String(e) })); } finally { setTestingId(null); }
  };
  const refreshAll = async () => {
    const r = await invoke<RefreshSummary>("refresh_usages");
    if (r.initiated > 0) showToast("success", `${t("settings.toast.refresh_started", { count: r.initiated })}${r.skipped ? t("settings.toast.refresh_skipped_suffix", { count: r.skipped }) : ""}`);
    else showToast("info", t("settings.toast.refresh_all_cooling", { count: r.skipped }));
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
      showToast("error", t("settings.toast.close_fail", { err: String(error) }));
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
      showToast("error", t("settings.toast.close_save_fail", { err: String(e) }));
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

  // Search covers pages (title + keywords, both localized via t()) and accounts (label + provider name/id).
  const q = search.trim().toLowerCase();
  const matchedPages = q ? PAGES.filter(p => `${t(p.title)} ${t(p.keywords)}`.toLowerCase().includes(q)) : PAGES;
  const matchedAccounts = q ? railOrder.filter(id => { const c = settings.providers[id]; return `${c.label} ${providerName(c.provider_id, t)} ${c.provider_id}`.toLowerCase().includes(q); }) : railOrder;
  const firstMatch = (): View | null => matchedPages[0] ? { kind: matchedPages[0].kind } : matchedAccounts[0] ? { kind: "account", id: matchedAccounts[0] } : null;

  const navItem = (active: boolean, onClick: () => void, children: React.ReactNode, key?: string) => (
    <button key={key} onClick={onClick} className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-left text-xs transition-colors cursor-pointer ${active ? "bg-zinc-800 text-white font-semibold" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"}`}>{children}</button>
  );
  const stateDot = (u?: ProviderUsage, enabled = true) => <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${!enabled ? "bg-zinc-700" : u?.state === "live" ? "bg-emerald-400" : u?.state === "stale" ? "bg-amber-400" : u ? "bg-red-400" : "bg-zinc-600"}`} />;
  const quotaCapsule = (u?: ProviderUsage, enabled = true) => {
    if (!enabled) {
      return (
        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono bg-zinc-800/80 text-zinc-500 border border-zinc-700/40 shrink-0">
          {t("settings.state.disabled")}
        </span>
      );
    }
    if (!u) {
      return (
        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono bg-zinc-800/60 text-zinc-500 border border-zinc-700/30 shrink-0">
          {t("settings.state.pending")}
        </span>
      );
    }
    if (u.state === "error" || u.state === "unavailable") {
      return (
        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono bg-red-950/40 text-red-400 border border-red-800/50 shrink-0" title={u.error_message || t("settings.state.bad_title")}>
          {t("settings.state.bad")}
        </span>
      );
    }
    if (u.state === "loading") {
      return (
        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono bg-blue-950/40 text-blue-300 border border-blue-800/40 shrink-0 animate-pulse">
          {t("settings.state.refreshing")}
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
          title={`${stale ? t("settings.bal.cached_title") : t("settings.bal.current_title")}: ${amounts.join("；")}`}
          aria-label={`${stale ? t("settings.bal.cached_aria") : t("settings.bal.aria")}: ${amounts.join("；")}`}
        >
          {amounts.map((amount, index) => <span key={index} className="max-w-full truncate">{amount}{stale ? "*" : ""}</span>)}
        </span>
      );
    }
    if (pct == null) {
      return (
        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono bg-zinc-800/60 text-zinc-400 border border-zinc-700/40 shrink-0">
          {t("settings.state.pending")}
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
      <div className={`inline-flex flex-col justify-center px-1.5 py-0.5 rounded border text-[10px] font-mono ${colorCls} min-w-[44px] shrink-0`} title={isStale ? t("settings.ring.cached_title", { pct }) : t("settings.ring.usage_title", { pct })}>
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
                <h3 className="text-sm font-bold text-white">{t("settings.close.title")}</h3>
                <p className="text-xs text-zinc-400 mt-0.5">{t("settings.close.body")}</p>
              </div>
            </div>
            <div className="flex flex-col gap-2 pt-2">
              <button onClick={() => void handleModalSaveAndClose()} disabled={busy} className="w-full py-2.5 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold cursor-pointer transition-colors shadow-lg">
                {busy ? t("settings.common.saving") : t("settings.close.save")}
              </button>
              <button onClick={() => void handleModalDiscardAndClose()} disabled={busy} className="w-full py-2 px-4 rounded-xl bg-zinc-800 hover:bg-red-950/40 hover:text-red-300 text-zinc-300 border border-zinc-700/60 text-xs font-medium cursor-pointer transition-colors">
                {t("settings.close.discard")}
              </button>
              <button onClick={() => void handleModalCancel()} disabled={busy} className="w-full py-2 px-4 rounded-xl text-zinc-400 hover:text-zinc-200 text-xs cursor-pointer transition-colors">
                {t("settings.common.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}
      {toast && (
        <div className={`fixed top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2.5 rounded-xl shadow-2xl border text-xs font-medium ${toast.type === "success" ? "bg-emerald-950/95 border-emerald-700/60 text-emerald-200" : toast.type === "error" ? "bg-red-950/95 border-red-700/60 text-red-200" : "bg-zinc-900/95 border-zinc-700 text-zinc-200"}`} role="status">
          <span className="font-bold">{toast.type === "success" ? "✓" : toast.type === "error" ? "✕" : "ℹ"}</span><span>{toast.text}</span>
          <button onClick={() => setToast(null)} className="ml-2 text-zinc-400 hover:text-white" aria-label={t("settings.common.dismiss_toast")}>✕</button>
        </div>
      )}
      {importable && Object.keys(settings.providers).length === 0 && (
        <div className="shrink-0 flex items-center justify-between gap-3 px-5 py-2.5 bg-emerald-950/80 border-b border-emerald-800/60 text-xs text-emerald-200">
          <div className="flex items-center gap-2">
            <span className="text-sm">📦</span>
            <span>{t("settings.import.banner", { count: importable.account_count, names: importable.provider_names.join("、") })}</span>
          </div>
          <div className="flex gap-2 shrink-0">
            <button onClick={() => void handleImportConfig()} className="px-3 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium cursor-pointer">{t("settings.import.now")}</button>
            <button onClick={() => setImportable(null)} className="px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 cursor-pointer">{t("settings.import.later")}</button>
          </div>
        </div>
      )}
      {antigravityDetected && !hasAntigravity && !dismissedAntigravity && (
        <div className="shrink-0 flex items-center justify-between gap-3 px-5 py-2.5 bg-indigo-950/80 border-b border-indigo-800/60 text-xs text-indigo-200">
          <div className="flex items-center gap-2">
            <span className="text-sm animate-pulse">✨</span>
            <span>{t("settings.aggr.banner")}</span>
          </div>
          <div className="flex gap-2 shrink-0">
            <button onClick={() => void handleQuickAddAntigravity()} disabled={busy} className="px-3 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium cursor-pointer transition-colors shadow-sm">
              {busy ? t("settings.aggr.adding") : t("settings.aggr.add")}
            </button>
            <button onClick={() => setDismissedAntigravity(true)} className="px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 cursor-pointer transition-colors">
              {t("settings.aggr.later")}
            </button>
          </div>
        </div>
      )}
      {pendingRemote && (
        <div className="shrink-0 flex items-center justify-between gap-3 px-5 py-2 bg-amber-950/70 border-b border-amber-800/50 text-xs text-amber-200">
          <span>{t("settings.remote.banner")}</span>
          <div className="flex gap-2 shrink-0">
            <button onClick={() => { markApplied(pendingRemote); setSettings(pendingRemote); setPendingRemote(null); }} className="px-2.5 py-1 rounded bg-amber-700 hover:bg-amber-600 text-white cursor-pointer">{t("settings.remote.discard")}</button>
            <button onClick={() => setPendingRemote(null)} className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 cursor-pointer">{t("settings.remote.keep")}</button>
          </div>
        </div>
      )}

      <header className="h-14 shrink-0 flex justify-between items-center px-5 border-b border-white/5 bg-zinc-950/80 backdrop-blur-md">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-emerald-600 to-teal-500 flex items-center justify-center shadow-lg shadow-emerald-950/50">
            <svg className="w-4 h-4 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12" /></svg>
          </div>
          <div>
            <div className="flex items-center gap-2"><h1 className="text-sm font-bold text-white tracking-wide">Pulse</h1><span className="text-[10px] bg-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded font-mono border border-zinc-700/50">v{__APP_VERSION__}</span>{isPortable && <span className="text-[10px] bg-emerald-950 text-emerald-400 px-1.5 py-0.5 rounded font-mono border border-emerald-800/50">{t("settings.header.portable")}</span>}</div>
            <p className="text-[11px] text-zinc-400">{t("settings.header.tagline")}</p>
          </div>
        </div>
        <div className="flex items-center gap-2.5">
          {dirtyHere && view.kind === "account" && (
            <>
              <span className="text-[11px] text-amber-300 flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />{t("settings.header.dirty")}</span>
              <button className={btnGhost} disabled={locked} onClick={() => discardAccount(view.id)}>{t("settings.header.discard")}</button>
              <button className={btnPrimary} disabled={locked} onClick={() => void saveAccounts()}>{busy ? t("settings.common.saving") : t("settings.common.save")}</button>
            </>
          )}
          <button onClick={() => void handleUserClose()} className={`${btnGhost} flex items-center gap-1.5`} title={t("settings.header.close_title")}><span>✕</span><span>{t("settings.header.close")}</span><kbd className="text-[10px] text-zinc-500 border border-zinc-700 rounded px-1">Esc</kbd></button>
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        <nav className="w-60 shrink-0 border-r border-white/5 bg-zinc-950/40 flex flex-col">
          <div className="p-3">
            <input value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { const v = firstMatch(); if (v) { setView(v); setSearch(""); } } if (e.key === "Escape") setSearch(""); }}
              placeholder={t("settings.nav.search_ph")} aria-label={t("settings.nav.search_ph")} className={inputCls} />
          </div>
          <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-4">
            {(!q || matchedPages.some(p => p.group === "pulse")) && (
              <div className="space-y-0.5">
                <div className="px-3 text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Pulse</div>
                {matchedPages.filter(p => p.group === "pulse").map(p => navItem(view.kind === p.kind, () => setView({ kind: p.kind }), <><span>{p.icon}</span><span>{t(p.title)}</span></>, p.kind))}
              </div>
            )}
            {(!q || matchedAccounts.length > 0) && (
              <div className="space-y-0.5">
                <div className="px-3 text-[10px] uppercase tracking-wider text-zinc-500 mb-1 flex justify-between"><span>{t("settings.nav.accounts")}</span><span>{railOrder.length}</span></div>
                {!q && navItem(view.kind === "accounts", () => setView({ kind: "accounts" }), <><span>☰</span><span>{t("settings.nav.overview")}</span></>)}
                {matchedAccounts.map(id => { const c = settings.providers[id]; const u = usages.find(x => x.account_id === id); return navItem(view.kind === "account" && view.id === id, () => setView({ kind: "account", id }), <>
                  <span className="w-6 h-6 rounded-lg bg-zinc-800/90 border border-zinc-700/50 flex items-center justify-center text-zinc-200 shrink-0"><ProviderIcon id={c.provider_id} size={13} /></span>
                  <span className="min-w-0 flex-1"><span className="block truncate">{c.label || providerName(c.provider_id, t)}</span>{c.label && c.label !== providerName(c.provider_id, t) && <span className="block text-[10px] text-zinc-500 truncate">{providerName(c.provider_id, t)}</span>}</span>
                  {quotaCapsule(u, c.enabled)}
                  {stateDot(u, c.enabled)}
                </>, id); })}
                {!q && <button onClick={() => setPickerOpen(true)} className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-left text-xs text-emerald-400 hover:bg-emerald-950/40 cursor-pointer"><span className="font-bold">+</span><span>{t("settings.nav.add")}</span></button>}
              </div>
            )}
            {(!q || matchedPages.some(p => p.group === "app")) && (
              <div className="space-y-0.5">
                <div className="px-3 text-[10px] uppercase tracking-wider text-zinc-500 mb-1">{t("settings.nav.app_group")}</div>
                {matchedPages.filter(p => p.group === "app").map(p => navItem(view.kind === p.kind, () => setView({ kind: p.kind }), <><span>{p.icon}</span><span>{t(p.title)}</span></>, p.kind))}
              </div>
            )}
            {q && matchedPages.length === 0 && matchedAccounts.length === 0 && <p className="px-3 text-xs text-zinc-500">{t("settings.nav.no_match", { query: search })}</p>}
          </div>
          <div className="p-3 border-t border-white/5 text-[11px] text-zinc-500">
            <div className="flex items-center gap-1.5 text-emerald-400"><span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />{t("settings.nav.watching")}</div>
            <div className="mt-1">{t("settings.nav.footer_hint")}</div>
          </div>
        </nav>

        <div className="flex-1 overflow-y-auto p-6">
          {view.kind === "general" && <GeneralPage settings={settings} update={update} screens={screens} usages={usages} busy={busy} onRefreshAll={refreshAll} toast={showToast} />}
          <div className={view.kind === "spend" ? "" : "hidden"}><TokenSpend active={view.kind === "spend"} settings={settings} onSubscriptionsSaved={applySubscriptions} onScanPathsSaved={applyScanPaths} /></div>
          {view.kind === "notifications" && <NotificationsPage settings={settings} update={update} toast={showToast} />}
          {view.kind === "hotkeys" && <HotkeysPage settings={settings} save={saveHotkeys} onError={m => m && showToast("error", m)} />}
          {view.kind === "diagnostics" && <DiagnosticsPage usages={usages} settings={settings} busy={busy} setBusy={setBusy} toast={showToast} open={id => setView({ kind: "account", id })} />}
          {view.kind === "about" && <AboutPage hasDraft={() => anyDirtyRef.current || Object.values(secretsRef.current).some(s => !!s?.trim()) || Object.values(stepfunCredentialsRef.current).some(c => !!c && !!(c.apiKey.trim() || c.oasisToken.trim()))} />}

          {view.kind === "accounts" && (
            <div className="space-y-5 max-w-3xl">
              <Section title={t("settings.accounts.add_title")} icon="➕" subtitle={t("settings.accounts.add_sub")}>
                <button onClick={() => setPickerOpen(true)} className={btnPrimary}>{t("settings.accounts.add_btn")}</button>
              </Section>
              <Section title={t("settings.accounts.order_title")} icon="☰" subtitle={t("settings.accounts.order_sub")}
                aside={<button className={btnGhost} disabled={locked || isDefaultOrder} onClick={() => commitOrder(defaultOrder)} title={t("settings.accounts.default_order_title")}>{t("settings.accounts.default_order")}</button>}>
                <ul ref={listRef} className="space-y-1.5">
                  {railOrder.map((id, index) => { const c = settings.providers[id]; const u = usages.find(x => x.account_id === id); return (
                    <li key={id} className={`flex items-center gap-3 px-3 py-2 rounded-xl border transition-colors ${drag && drag.over === index && drag.id !== id ? "border-emerald-500/70 bg-emerald-950/30" : "border-white/5 bg-zinc-950/40 hover:border-white/15"} ${drag?.id === id ? "opacity-40" : ""} ${!c.enabled ? "opacity-60" : ""}`}>
                      <span onPointerDown={e => startDrag(e, id, index)} className={`text-zinc-500 select-none touch-none text-base leading-none px-1 ${locked ? "" : "cursor-grab active:cursor-grabbing"}`} title={t("settings.accounts.drag")} aria-hidden>☰</span>
                      <span className="w-5 text-[11px] font-mono text-zinc-500 text-right">{index + 1}</span>
                      <span className="w-6 h-6 rounded-lg bg-zinc-800/90 border border-zinc-700/50 flex items-center justify-center text-zinc-200 shrink-0"><ProviderIcon id={c.provider_id} size={14} /></span>
                      <button className="text-xs text-zinc-200 truncate hover:underline cursor-pointer text-left font-medium" onClick={() => setView({ kind: "account", id })}>{c.label}</button>
                      <span className="text-[11px] text-zinc-500 truncate">{providerName(c.provider_id, t)}</span>
                      <div className="ml-auto flex items-center gap-2 shrink-0">
                        {quotaCapsule(u, c.enabled)}
                        {stateDot(u, c.enabled)}
                        {!c.enabled && <span className="text-[10px] px-1.5 py-[2px] bg-zinc-800 text-zinc-400 rounded border border-zinc-700/60 shrink-0">{t("settings.accounts.not_on_rail")}</span>}
                        <div className="flex items-center gap-1 shrink-0 ml-1">
                          <button disabled={locked || index === 0} onClick={() => moveAccount(index, index - 1)} className="w-6 h-6 rounded-md text-zinc-400 hover:text-white hover:bg-zinc-800 disabled:opacity-30 cursor-pointer text-xs" aria-label={t("settings.accounts.move_up", { label: c.label })}>▲</button>
                          <button disabled={locked || index === railOrder.length - 1} onClick={() => moveAccount(index, index + 1)} className="w-6 h-6 rounded-md text-zinc-400 hover:text-white hover:bg-zinc-800 disabled:opacity-30 cursor-pointer text-xs" aria-label={t("settings.accounts.move_down", { label: c.label })}>▼</button>
                        </div>
                      </div>
                    </li>); })}
                  {railOrder.length === 0 && <p className="text-xs text-zinc-500">{t("settings.accounts.empty")}</p>}
                </ul>
              </Section>
            </div>
          )}

          {view.kind === "account" && current && (() => {
            const id = view.id, c = current, reading = usages.find(u => u.account_id === id), routes = ROUTES[c.provider_id] ?? {};
            const isTesting = testingId === id, timedWindows = reading ? timingWindows(reading,c,lang).filter(w => w.window_seconds && w.resets_at) : [];
            const position = railOrder.indexOf(id) + 1;
            const effectivePrimaryWindow = c.primary_window || reading?.windows?.reduce((max, w) => (!max || w.used_percent > max.used_percent ? w : max), reading?.windows[0])?.id || null;
            const isDuplicateInner = !!(c.secondary_window && effectivePrimaryWindow && c.secondary_window === effectivePrimaryWindow);
            return (
              <div className="space-y-5 max-w-3xl">
                <section className="p-5 rounded-2xl bg-zinc-900/40 border border-white/10 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-11 h-11 rounded-xl bg-zinc-800/90 border border-zinc-700/50 flex items-center justify-center text-zinc-200" style={c.ring_color ? { color: c.ring_color } : undefined}><ProviderIcon id={c.provider_id} size={22} /></div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2"><strong className="text-base font-semibold text-white truncate">{c.label || providerName(c.provider_id, t)}</strong><span className="text-xs text-zinc-500">{providerName(c.provider_id, t)}</span></div>
                      <div className="flex items-center gap-2 mt-1 text-[11px]">
                        {stateDot(reading, c.enabled)}
                        <span className={!c.enabled ? "text-zinc-500" : reading?.state === "live" ? "text-emerald-400" : reading?.state === "stale" ? "text-amber-400" : reading?.error_message ? "text-red-400" : "text-zinc-500"}>
                          {!c.enabled ? t("settings.acct.disabled_line") : reading?.state === "live" ? t("settings.acct.live_line", { ago: ageText(reading.checked_at, t) }) : reading?.state === "stale" ? t("settings.acct.stale_line", { ago: ageText(reading.last_success_at, t) }) : reading?.error_message ?? t("settings.acct.no_reading")}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 shrink-0">
                    <label className="flex items-center gap-2 text-xs text-zinc-400"><span>{t("settings.acct.show_on_rail")}</span><Switch checked={c.enabled} onChange={v => patch(id, { enabled: v })} label={t("settings.acct.show_on_rail")} /></label>
                    <button className={confirmArmed === `del:${id}` ? "text-red-300 bg-red-950/50 p-1.5 rounded-lg transition-colors cursor-pointer" : "text-zinc-500 hover:text-red-400 hover:bg-red-950/30 p-1.5 rounded-lg transition-colors cursor-pointer"} onClick={() => remove(id)} title={confirmArmed === `del:${id}` ? t("settings.acct.delete_armed") : t("settings.acct.delete")} aria-label={t("settings.acct.delete")}>
                      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
                    </button>
                  </div>
                </section>

                <Section title={t("settings.acct.section")} icon="👤">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div className="md:col-span-2"><Field label={t("settings.acct.label")}><input className={inputCls} value={c.label} onChange={e => patch(id, { label: e.target.value })} /></Field></div>
                    <Field label={t("settings.acct.position")}><div className={`${inputCls} text-zinc-300`}>{t("settings.acct.position_value", { pos: position })} <button className="text-emerald-400 hover:underline cursor-pointer" onClick={() => setView({ kind: "accounts" })}>{t("settings.acct.go_order")}</button></div></Field>
                  </div>
                </Section>

                <Section title={t("settings.acct.conn")} icon="🔌" subtitle={(() => {
                  const parts = [
                    routes.local && t("settings.acct.route_local", { routes: t(routes.local) }),
                    routes.manual && t("settings.acct.route_manual", { routes: t(routes.manual) }),
                  ].filter(Boolean) as string[];
                  return parts.length ? t("settings.acct.conn_avail", { routes: parts.join(t("settings.common.list_sep")) }) : t("settings.acct.conn_auto");
                })()}
                  aside={<button disabled={locked || !c.enabled} onClick={() => void test(id)} className={`${btnGhost} flex items-center gap-1.5`}>{isTesting ? <span className="w-3.5 h-3.5 border-2 border-zinc-400 border-t-white rounded-full animate-spin" /> : <span>⟳</span>}<span>{isTesting ? t("settings.acct.testing") : t("settings.acct.save_test")}</span></button>}>
                  {routes.local && (
                    <Row title={t("settings.acct.use_local")} subtitle={t(routes.local)}><Switch checked={c.use_local} onChange={v => patch(id, { use_local: v })} label={t("settings.acct.use_local_switch")} /></Row>
                  )}
                  {routes.manual && (
                    c.provider_id === "stepfun" ? (
                      <div className="p-3.5 bg-zinc-950/60 rounded-xl border border-white/5 space-y-3">
                        <div className="flex justify-between items-center text-xs">
                          <span className={c.credential_configured ? "text-emerald-400 font-medium" : "text-zinc-400"}>
                            {c.credential_configured ? t("settings.acct.cred_saved_win") : t("settings.acct.stepfun_cred_none")}
                          </span>
                          <span className="text-[11px] text-zinc-500">{t("settings.acct.dual_cred")}</span>
                        </div>
                        <div className="space-y-2.5">
                          <div>
                            <div className="flex justify-between text-xs text-zinc-300 mb-1">
                              <span>{t("settings.acct.apikey_label")}</span>
                              <span className="text-[11px] text-zinc-500">{t("settings.common.optional")}</span>
                            </div>
                            <div className="relative">
                              <input
                                type={showStepfunApiKey[id] ? "text" : "password"}
                                className={`${inputCls} pr-9`}
                                placeholder={c.credential_configured ? t("settings.acct.apikey_ph_new") : t("settings.acct.apikey_ph")}
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
                                {showStepfunApiKey[id] ? t("settings.common.hide") : t("settings.common.show")}
                              </button>
                            </div>
                          </div>

                          <div>
                            <div className="flex justify-between items-center text-xs text-zinc-300 mb-1">
                              <span>{t("settings.acct.oasis_label")}</span>
                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => void handleStepfunWebLogin(id)}
                                  disabled={locked || webLoginLoading[id]}
                                  className="text-[11px] text-emerald-400 hover:text-emerald-300 hover:underline cursor-pointer flex items-center gap-1 font-medium disabled:opacity-40"
                                  title={t("settings.acct.weblogin_title")}
                                >
                                  <span>{webLoginLoading[id] ? t("settings.acct.waiting_login") : t("settings.acct.weblogin")}</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setShowStepfunHelp(v => !v)}
                                  className="text-[11px] text-zinc-400 hover:text-zinc-200 hover:underline cursor-pointer flex items-center gap-1"
                                >
                                  <span>💡 {t("settings.acct.manual_get")}</span>
                                </button>
                              </div>
                            </div>
                            <div className="relative">
                              <input
                                type={showStepfunOasisToken[id] ? "text" : "password"}
                                className={`${inputCls} pr-9`}
                                placeholder={c.credential_configured ? t("settings.acct.oasis_ph_new") : t("settings.acct.oasis_ph")}
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
                                {showStepfunOasisToken[id] ? t("settings.common.hide") : t("settings.common.show")}
                              </button>
                            </div>
                          </div>

                          {showStepfunHelp && (
                            <div className="p-2.5 rounded-xl bg-zinc-900 border border-zinc-700/60 text-xs text-zinc-300 space-y-1.5 leading-relaxed">
                              <div className="font-semibold text-zinc-200">{t("settings.acct.help_title")}</div>
                              <ol className="list-decimal list-inside space-y-1 text-zinc-400 text-[11px]">
                                <li>{t("settings.acct.help_1_pre")} <span className="text-zinc-200 font-mono">platform.stepfun.com</span>{t("settings.acct.help_1_post")}</li>
                                <li>{t("settings.acct.help_2_pre")} <kbd className="px-1 py-0.5 bg-zinc-800 rounded border border-zinc-700 font-mono">F12</kbd>{t("settings.acct.help_2_mid")} <span className="text-zinc-200">Console</span>{t("settings.acct.help_2_post")}</li>
                                <li>{t("settings.acct.help_3_pre")} <code className="text-emerald-400 font-mono">document.cookie</code>{t("settings.acct.help_3_post")}</li>
                                <li>{t("settings.acct.help_4_pre")} <code className="text-zinc-200 font-mono">Oasis-Token=...</code>{t("settings.acct.help_4_post")}</li>
                              </ol>
                            </div>
                          )}

                          <div className="flex gap-2 justify-end pt-1">
                            <button
                              disabled={locked || (!stepfunCredentials[id]?.apiKey && !stepfunCredentials[id]?.oasisToken)}
                              onClick={() => void handleSaveCredential(id)}
                              className={btnPrimary}
                            >
                              {t("settings.acct.save_cred")}
                            </button>
                            {c.credential_configured && (
                              <button
                                disabled={locked}
                                onClick={() => void handleDeleteCredential(id)}
                                className={confirmArmed === `cred:${id}` ? "px-3 py-1.5 bg-red-950/50 text-red-300 border border-red-900/60 rounded-xl text-xs font-medium transition-all disabled:opacity-40 cursor-pointer" : "px-3 py-1.5 bg-zinc-900 hover:bg-red-950/40 text-red-400 border border-zinc-800 hover:border-red-900/60 rounded-xl text-xs font-medium transition-all disabled:opacity-40 cursor-pointer"}
                              >
                                {confirmArmed === `cred:${id}` ? t("settings.acct.remove_q") : t("settings.acct.del_cred")}
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="p-3.5 bg-zinc-950/60 rounded-xl border border-white/5 space-y-3">
                        <div className="flex justify-between items-center text-xs">
                          <span className={c.credential_configured ? "text-emerald-400 font-medium" : "text-zinc-400"}>{c.credential_configured ? t("settings.acct.cred_saved_win") : t("settings.acct.manual_cred_none")}</span>
                          <span className="text-[11px] text-zinc-500">{routes.manual ? t(routes.manual) : ""}</span>
                        </div>
                        <div className="flex gap-2">
                          <div className="relative flex-1">
                            <input type={showSecrets[id] ? "text" : "password"} className={`${inputCls} pr-9`} placeholder={c.credential_configured ? t("settings.acct.cred_ph_new") : getPlaceholder(c.provider_id, t)} value={secrets[id] || ""} onChange={e => setSecrets(s => ({ ...s, [id]: e.target.value }))} autoComplete="off" spellCheck={false} aria-label={t("settings.acct.cred_aria")} />
                            <button type="button" onClick={() => setShowSecrets(s => ({ ...s, [id]: !s[id] }))} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-200 text-xs cursor-pointer" aria-label={showSecrets[id] ? t("settings.acct.hide_cred") : t("settings.acct.show_cred")}>{showSecrets[id] ? t("settings.common.hide") : t("settings.common.show")}</button>
                          </div>
                          <button disabled={locked || !secrets[id]} onClick={() => void handleSaveCredential(id)} className={btnPrimary}>{t("settings.acct.save_cred")}</button>
                          {c.credential_configured && <button disabled={locked} onClick={() => void handleDeleteCredential(id)} className={confirmArmed === `cred:${id}` ? "px-3 py-1.5 bg-red-950/50 text-red-300 border border-red-900/60 rounded-xl text-xs font-medium transition-all disabled:opacity-40 cursor-pointer" : "px-3 py-1.5 bg-zinc-900 hover:bg-red-950/40 text-red-400 border border-zinc-800 hover:border-red-900/60 rounded-xl text-xs font-medium transition-all disabled:opacity-40 cursor-pointer"}>{confirmArmed === `cred:${id}` ? t("settings.acct.remove_q") : t("settings.acct.del_cred")}</button>}
                        </div>
                      </div>
                    )
                  )}
                  {/* reading.source / error_message 来自后端，原样展示。TODO(EN-backend) */}
                  <p className="text-[11px] text-zinc-500">{t("settings.acct.source", { source: reading?.source || t("settings.acct.no_reading_yet") })}</p>
                </Section>

                <Section title={t("settings.acct.rail_section")} icon="◎" subtitle={t("settings.acct.rail_sub")}>
                  {(() => {
                    const previewSettings: AppSettings = {
                      ...settings,
                      providers: { ...settings.providers, [id]: c },
                    };
                    const previewUsage: ProviderUsage = reading ? {
                      ...reading,
                      display_name: c.label || providerName(c.provider_id, t),
                    } : {
                      account_id: id,
                      provider_id: c.provider_id,
                      display_name: c.label || providerName(c.provider_id, t),
                      state: "live",
                      checked_at: new Date().toISOString(),
                      last_success_at: new Date().toISOString(),
                      primary_percent: c.primary_window === "__balance__" ? null : 42,
                      plan_name: null,
                      is_active: false,
                      retry_after_seconds: null,
                      duration_ms: null,
                      windows: c.primary_window === "__balance__" ? [] : (c.provider_id === "antigravity" ? [
                        { id: "0-0", name: t(ANTIGRAVITY_DEFAULT_WINDOWS[0].name), used_fraction: 0.25, used_percent: 25, resets_at: new Date(Date.now() + 86400000 * 5).toISOString(), window_seconds: 604800, exhausted: false },
                        { id: "0-1", name: t(ANTIGRAVITY_DEFAULT_WINDOWS[1].name), used_fraction: 0.42, used_percent: 42, resets_at: new Date(Date.now() + 3600000 * 3).toISOString(), window_seconds: 18000, exhausted: false },
                        { id: "1-0", name: t(ANTIGRAVITY_DEFAULT_WINDOWS[2].name), used_fraction: 0.1, used_percent: 10, resets_at: new Date(Date.now() + 86400000 * 6).toISOString(), window_seconds: 604800, exhausted: false },
                        { id: "1-1", name: t(ANTIGRAVITY_DEFAULT_WINDOWS[3].name), used_fraction: 0.68, used_percent: 68, resets_at: new Date(Date.now() + 3600000 * 2).toISOString(), window_seconds: 18000, exhausted: false },
                      ] : [
                        { id: "primary", name: t("settings.preview.primary_window"), used_fraction: 0.35, used_percent: 35, resets_at: new Date(Date.now() + 3600000 * 4).toISOString(), window_seconds: 18000, exhausted: false },
                      ]),
                      balances: c.primary_window === "__balance__" || c.provider_id === "stepfun" ? [{ currency: "CNY", amount: 15.0 }] : [],
                      error_message: null,
                      error_code: null,
                      source: t("settings.preview.source"),
                    };
                    return (
                      <div className="p-3 bg-zinc-950/50 rounded-xl border border-white/5 flex items-center justify-between gap-4">
                        <div className="space-y-0.5 min-w-0">
                          <div className="text-xs font-semibold text-zinc-300">{t("settings.preview.title")}</div>
                          <p className="text-[11px] text-zinc-500">{t("settings.preview.sub")}</p>
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

                  <Field label={t("settings.acct.primary_ring")} hint={c.primary_window === "__balance__" ? t("settings.acct.primary_hint_balance") : reading?.windows && reading.windows.length > 0 ? t("settings.acct.primary_hint_windows") : c.provider_id === "antigravity" ? t("settings.acct.primary_hint_aggr") : t("settings.acct.primary_hint_none")}>
                    <select className={selectCls} value={c.primary_window || ""} onChange={e => patch(id, { primary_window: e.target.value || null })}>
                      <option value="">{t("settings.acct.auto_highest")}</option>
                      {(c.provider_id === "stepfun" || (reading?.balances && reading.balances.length > 0) || c.primary_window === "__balance__") && (
                        <option value="__balance__">{t("settings.acct.balance_mode")}</option>
                      )}
                      {c.primary_window && c.primary_window !== "__balance__" && !reading?.windows?.some(w => w.id === c.primary_window) && !ANTIGRAVITY_DEFAULT_WINDOWS.some(w => c.provider_id === "antigravity" && w.id === c.primary_window) && (
                        <option value={c.primary_window}>{c.primary_window}{t("settings.acct.waiting_suffix")}</option>
                      )}
                      {reading?.windows && reading.windows.length > 0
                        ? reading.windows.map(w => <option key={w.id} value={w.id}>{t("settings.acct.used_of", { name: w.name, pct: w.used_percent.toFixed(1), reset: resetText(w.resets_at, Date.now(), lang) })}</option>)
                        : c.provider_id === "antigravity"
                        ? ANTIGRAVITY_DEFAULT_WINDOWS.map(w => <option key={w.id} value={w.id}>{t(w.name)}</option>)
                        : null}
                    </select>
                  </Field>

                  <Field label={t("settings.acct.elapsed_period")} hint={t("settings.acct.elapsed_period_hint")}>
                    <select className={selectCls} value={c.elapsed_period_days==null?'auto':'custom'} onChange={e=>patch(id,{elapsed_period_days:e.target.value==='auto'?null:30})}>
                      <option value="auto">{t("settings.acct.period_auto")}</option><option value="custom">{t("settings.acct.period_custom")}</option>
                    </select>
                    {c.elapsed_period_days!=null&&<label className="block text-xs text-zinc-400 mt-2">{t("settings.acct.period_days_label")}
                      <input aria-label={t("settings.acct.period_days_aria")} type="number" min={1/24} max={366} step="any" className={selectCls} value={c.elapsed_period_days} onChange={e=>{const n=e.target.valueAsNumber;if(Number.isFinite(n))patch(id,{elapsed_period_days:n})}}/>
                      <span>{t("settings.acct.period_days_note")}</span>
                    </label>}
                  </Field>
                  <Field label={t("settings.acct.elapsed_window_label")} hint={reading?.windows && reading.windows.length > 0
                    ? timedWindows.length === 0
                      ? t("settings.acct.elw_hint_no_period")
                      : settings.show_elapsed ? t("settings.acct.elw_hint_on") : t("settings.acct.elw_hint_off")
                    : c.provider_id === "antigravity"
                    ? t("settings.acct.elw_hint_aggr")
                    : t("settings.acct.elw_hint_none")}>
                    <select className={selectCls} disabled={timedWindows.length === 0 && !c.elapsed_window && c.provider_id !== "antigravity"} value={c.elapsed_window || ""} onChange={e => patch(id, { elapsed_window: e.target.value || null })}>
                      <option value="">{t("settings.acct.elw_auto")}</option>
                      {c.elapsed_window && !timedWindows.some(w => w.id === c.elapsed_window) && !ANTIGRAVITY_DEFAULT_WINDOWS.some(w => c.provider_id === "antigravity" && w.id === c.elapsed_window) && (
                        <option value={c.elapsed_window}>{c.elapsed_window}{t("settings.acct.waiting_suffix")}</option>
                      )}
                      {timedWindows.length > 0
                        ? timedWindows.map(w => <option key={w.id} value={w.id}>{w.name} — {resetText(w.resets_at, Date.now(), lang)} · {w.period_note}</option>)
                        : c.provider_id === "antigravity"
                        ? ANTIGRAVITY_DEFAULT_WINDOWS.map(w => <option key={w.id} value={w.id}>{w.name}</option>)
                        : null}
                    </select>
                  </Field>

                  {!settings.show_elapsed && (
                    <div className="p-2.5 rounded-xl bg-zinc-900/90 border border-zinc-700/60 text-xs text-zinc-300 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <span className="text-amber-400">ℹ️</span>
                        <span>{t("settings.acct.elapsed_off_note")}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => update({ show_elapsed: true }, t("settings.toast.elapsed_enabled"))}
                        className="px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-medium cursor-pointer shrink-0"
                      >
                        {t("settings.acct.enable_elapsed")}
                      </button>
                    </div>
                  )}

                  <Row title={t("settings.acct.ring_color")} subtitle={t("settings.acct.ring_color_sub")}>
                    <div className="flex items-center gap-2">
                      <select className={selectCls} value={c.ring_color ? "custom" : "auto"} onChange={e => patch(id, { ring_color: e.target.value === "custom" ? (c.ring_color ?? (c.provider_id === "kimi" ? "#7AA5FF" : "#10b981")) : null })} aria-label={t("settings.acct.ring_color_mode_aria")}><option value="auto">{t("settings.acct.color_auto")}</option><option value="custom">{t("settings.common.custom")}</option></select>
                      {c.ring_color && <input type="color" value={c.ring_color} onChange={e => patch(id, { ring_color: e.target.value })} className="w-9 h-8 rounded-lg bg-transparent border border-zinc-700 cursor-pointer" aria-label={t("settings.acct.pick_color")} />}
                    </div>
                  </Row>
                  <Row title={t("settings.acct.bot")} subtitle={t("settings.acct.bot_sub")}>
                    <Switch checked={c.mark_mode === "bot"} onChange={v => patch(id, { mark_mode: v ? "bot" : "icon" })} label={t("settings.acct.bot")} />
                  </Row>
                  {c.mark_mode === "bot" && (
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-1">
                      <Field label={t("settings.acct.persona")}><select className={selectCls} value={c.bot_persona ?? ""} onChange={e => patch(id, { bot_persona: e.target.value || null })}><option value="">{t("settings.bot.persona.auto")}</option>{BOT_PERSONAS.map(p => <option key={p} value={p}>{t(`settings.bot.persona.${p}`)}</option>)}</select></Field>
                      <Field label={t("settings.acct.shape")}><select className={selectCls} value={c.bot_shape ?? ""} onChange={e => patch(id, { bot_shape: e.target.value || null })}><option value="">{t("settings.bot.shape.auto")}</option>{BOT_SHAPES.map(p => <option key={p} value={p}>{t(`settings.bot.shape.${p}`)}</option>)}</select></Field>
                      <Field label={t("settings.acct.color")}><div className="flex items-center gap-2">
                        <select className={selectCls} value={c.bot_color ? "custom" : "auto"} onChange={e => patch(id, { bot_color: e.target.value === "custom" ? (c.bot_color ?? (c.provider_id === "kimi" ? "#7AA5FF" : "#10b981")) : null })} aria-label={t("settings.acct.bot_color_mode_aria")}><option value="auto">{t("settings.acct.follow_theme")}</option><option value="custom">{t("settings.common.custom")}</option></select>
                        {c.bot_color && <input type="color" value={c.bot_color} onChange={e => patch(id, { bot_color: e.target.value })} className="w-9 h-8 rounded-lg bg-transparent border border-zinc-700 cursor-pointer" aria-label={t("settings.acct.pick_bot_color")} />}
                      </div></Field>
                    </div>
                  )}

                  <Field label={t("settings.acct.secondary")} hint={!reading || !reading.windows || reading.windows.length <= 1
                    ? c.provider_id === "antigravity"
                      ? t("settings.acct.secondary_hint_aggr")
                      : t("settings.acct.secondary_hint_none")
                    : t("settings.acct.secondary_hint")}>
                    <select className={selectCls} value={c.secondary_window || ""} onChange={e => patch(id, { secondary_window: e.target.value || null })}>
                      <option value="">{t("settings.common.off")}</option>
                      {c.secondary_window && !reading?.windows?.some(w => w.id === c.secondary_window) && !ANTIGRAVITY_DEFAULT_WINDOWS.some(w => c.provider_id === "antigravity" && w.id === c.secondary_window) && (
                        <option value={c.secondary_window}>{c.secondary_window}{t("settings.acct.waiting_suffix")}</option>
                      )}
                      {reading?.windows && reading.windows.length > 0
                        ? reading.windows.map(w => {
                            const isPrimary = w.id === effectivePrimaryWindow;
                            return (
                              <option key={w.id} value={w.id} disabled={isPrimary}>
                                {w.name} {isPrimary ? t("settings.acct.taken") : t("settings.acct.used_pct", { pct: w.used_percent.toFixed(1) })}
                              </option>
                            );
                          })
                        : c.provider_id === "antigravity"
                        ? ANTIGRAVITY_DEFAULT_WINDOWS.map(w => {
                            const isPrimary = w.id === effectivePrimaryWindow;
                            return (
                              <option key={w.id} value={w.id} disabled={isPrimary}>
                                {t(w.name)} {isPrimary ? t("settings.acct.taken") : ""}
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
                        <span>{t("settings.acct.dup_warn")}</span>
                      </div>
                      <p className="text-[11px] text-amber-300/80">
                        {t("settings.acct.dup_note")}
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
                            {t("settings.acct.switch_alt")}
                          </button>
                          <button
                            type="button"
                            onClick={() => patch(id, { secondary_window: null })}
                            className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[11px] cursor-pointer"
                          >
                            {t("settings.acct.close_secondary")}
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  {c.provider_id === "antigravity" && (
                    <Row title={t("settings.acct.split")} subtitle={t("settings.acct.split_sub")}>
                      <Switch checked={c.split_model_groups} onChange={v => patch(id, { split_model_groups: v })} label={t("settings.acct.split")} />
                    </Row>
                  )}
                </Section>

                {reading && reading.balances.length > 0 && (
                  <Section title={t("settings.acct.notif_section")} icon="🔔" subtitle={t("settings.acct.notif_sub")}>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <Field label={t("settings.acct.low_balance")}><input type="number" min={0} step="0.01" className={inputCls} value={c.low_balance ?? ""} placeholder={t("settings.acct.no_notify")} onChange={e => patch(id, { low_balance: e.target.value === "" ? null : Math.max(0, Number(e.target.value)), low_balance_currency: c.low_balance_currency ?? reading.balances[0].currency })} /></Field>
                      <Field label={t("settings.acct.currency")}><select className={selectCls} value={c.low_balance_currency ?? reading.balances[0].currency} onChange={e => patch(id, { low_balance_currency: e.target.value })}>{reading.balances.map(b => <option key={b.currency} value={b.currency}>{t("settings.acct.currency_opt", { currency: b.currency, amount: b.amount.toFixed(2) })}</option>)}</select></Field>
                    </div>
                  </Section>
                )}

                {reading && (reading.windows.length > 0 || reading.balances.length > 0) && (
                  <Section title={t("settings.acct.usage")} icon="📈">
                    {/* reading.error_message 来自后端，原样展示。TODO(EN-backend) */}
                    {reading.error_message && <p className="text-xs text-amber-400 mb-2">{reading.error_message}</p>}
                    <div className="space-y-2.5">
                      {reading.windows.map(w => {
                        const isPrimary = c.primary_window === w.id || (!c.primary_window && w.used_percent === reading.primary_percent);
                        const isTimed = pickElapsedWindow(timingWindows(reading,c), c.elapsed_window ?? null)?.id === w.id;
                        return (
                          <div key={w.id} className="space-y-1">
                            <div className="flex justify-between items-center text-xs">
                              <span className="flex items-center gap-1.5 text-zinc-300">{w.name}
                                {isPrimary && <span className="text-[10px] bg-emerald-950/80 text-emerald-400 px-1.5 py-[2px] rounded border border-emerald-800/40">{t("settings.acct.primary_badge")}</span>}
                                {isTimed && settings.show_elapsed && <span className="text-[10px] bg-zinc-800 text-zinc-300 px-1.5 py-[2px] rounded border border-zinc-600/60">{t("settings.acct.timed_badge")}</span>}
                              </span>
                              <span className="font-mono text-zinc-200">{t("settings.acct.used_badge", { pct: Number(w.used_percent.toFixed(2)) })}</span>
                            </div>
                            <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden"><div className={`h-full rounded-full transition-all duration-500 ${w.exhausted || w.used_percent >= settings.warning_threshold ? "bg-red-500" : w.used_percent >= settings.warning_threshold - 15 ? "bg-amber-400" : "bg-emerald-500"}`} style={{ width: `${Math.min(100, Math.max(0, w.used_percent))}%` }} /></div>
                            <div className="text-[11px] text-zinc-500">{resetText(w.resets_at, Date.now(), lang)}</div>
                          </div>
                        );
                      })}
                      {reading.balances.map(b => <div key={b.currency} className="flex justify-between text-xs"><span className="text-zinc-300">{balanceLabel(c.provider_id,b.currency,lang)}</span><span className="font-mono text-zinc-200">{balanceText(b.currency,b.amount,lang)}</span></div>)}
                    </div>
                  </Section>
                )}

                <Section title={t("settings.acct.diag_section")} icon="🩺" subtitle={t("settings.acct.diag_sub")}
                  aside={<div className="flex gap-2">
                    <button disabled={locked} onClick={() => void test(id)} className={btnGhost} title={t("settings.acct.resync_title")}>
                      {isTesting ? t("settings.acct.syncing") : t("settings.acct.resync")}
                    </button>
                    <button disabled={locked} onClick={() => {
                      const summaryLines = [
                        t("settings.summary.title"),
                        t("settings.summary.time", { v: new Date().toISOString() }),
                        t("settings.summary.provider", { v: c.provider_id }),
                        t("settings.summary.state", { v: reading?.state ?? t("settings.summary.not_connected") }),
                        t("settings.summary.cred", { v: c.credential_configured ? t("settings.common.yes") : t("settings.common.no") }),
                        t("settings.summary.local", { v: c.use_local ? t("settings.common.yes") : t("settings.common.no") }),
                        t("settings.summary.primary", { v: c.primary_window || t("settings.common.auto") }),
                        t("settings.summary.secondary", { v: c.secondary_window || t("settings.common.off") }),
                        t("settings.summary.elapsed", { v: c.elapsed_window || t("settings.common.auto"), v2: settings.show_elapsed ? t("settings.common.yes") : t("settings.common.no") }),
                        t("settings.summary.source", { v: reading?.source || t("settings.common.none") }),
                        t("settings.summary.duration", { v: reading?.duration_ms != null ? `${reading.duration_ms}ms` : t("settings.common.none") }),
                        t("settings.summary.errcode", { v: reading?.error_code || t("settings.common.none") }),
                        t("settings.summary.errmsg", { v: reading?.error_message || t("settings.common.none") }),
                        t("settings.summary.window_count", { v: reading?.windows?.length ?? 0 }),
                        ...(reading?.windows?.map(w => t("settings.summary.window_line", { id: w.id, name: w.name, pct: w.used_percent.toFixed(1), reset: w.resets_at || t("settings.common.none") })) || []),
                        t("settings.summary.balance_count", { v: reading?.balances?.length ?? 0 }),
                        ...(reading?.balances?.map(b => `  - ${b.currency}: ${b.amount}`) || []),
                      ];
                      void navigator.clipboard.writeText(summaryLines.join("\n"));
                      showToast("success", t("settings.toast.summary_copied"));
                    }} className={btnGhost} title={t("settings.acct.copy_summary_title")}>
                      {t("settings.acct.copy_summary")}
                    </button>
                  </div>}>
                  {reading ? (
                    <dl className="grid grid-cols-[7rem_1fr] gap-y-1.5 text-xs">
                      {accountRows(reading, c, t).map(([k, v]) => <div key={k} className="contents"><dt className="text-zinc-500">{k}</dt><dd className="text-zinc-200 break-all">{v}</dd></div>)}
                    </dl>
                  ) : <p className="text-xs text-zinc-500">{c.enabled ? t("settings.acct.diag_none") : t("settings.acct.diag_disabled")}</p>}
                  {/* error_message 为后端原文。TODO(EN-backend) */}
                  {reading?.error_code === "auth" && <p className="text-[11px] text-amber-300">{t("settings.next.auth")}</p>}
                  {reading?.error_code === "forbidden" && <p className="text-[11px] text-amber-300">{t("settings.next.forbidden")}</p>}
                  {reading?.error_code === "proxy" && <p className="text-[11px] text-amber-300">{t("settings.next.proxy")}</p>}
                  {reading?.error_code === "dns" && <p className="text-[11px] text-amber-300">{t("settings.next.dns")}</p>}
                  {reading?.error_code === "tls" && <p className="text-[11px] text-amber-300">{t("settings.next.tls")}</p>}
                  {reading?.error_code === "timeout" && <p className="text-[11px] text-amber-300">{t("settings.next.timeout")}</p>}
                  {reading?.error_code === "missing_credentials" && <p className="text-[11px] text-amber-300">{t("settings.next.missing_credentials")}</p>}
                </Section>
              </div>
            );
          })()}
          {view.kind === "account" && !current && <p className="text-xs text-zinc-500">{t("settings.acct.gone")}</p>}
        </div>
      </div>
      {pickerOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-8" onClick={() => { setPickerOpen(false); setPickerQuery(""); }}>
          <div className="w-[26rem] max-h-[32rem] bg-zinc-900 border border-white/10 rounded-2xl shadow-2xl flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="p-4 border-b border-white/5 space-y-3">
              <div className="flex justify-between items-center"><h3 className="text-sm font-semibold text-white">{t("settings.picker.title")}</h3>
                <button className="text-zinc-400 hover:text-white cursor-pointer" onClick={() => { setPickerOpen(false); setPickerQuery(""); }} aria-label={t("settings.common.cancel")}>✕</button></div>
              <input autoFocus value={pickerQuery} onChange={e => setPickerQuery(e.target.value)} onKeyDown={e => { if (e.key === "Escape") { setPickerOpen(false); setPickerQuery(""); } }} placeholder={t("settings.picker.search_ph")} aria-label={t("settings.picker.search_ph")} className={inputCls} />
            </div>
            <ul className="flex-1 overflow-y-auto p-2 space-y-1">
              {PROVIDERS.filter(p => `${providerName(p[0], t)} ${p[0]}`.toLowerCase().includes(pickerQuery.trim().toLowerCase())).map(([pid]) => {
                const existing = railOrder.filter(id => settings.providers[id].provider_id === pid).length;
                const addable = !!ROUTES[pid]?.manual;
                return (
                  <li key={pid}>
                    <button disabled={!addable} onClick={() => handleAddAccount(pid)} className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl text-left text-xs cursor-pointer ${addable ? "hover:bg-zinc-800 text-zinc-200" : "opacity-40 cursor-not-allowed"}`}>
                      <span className="w-7 h-7 rounded-lg bg-zinc-800/90 border border-zinc-700/50 flex items-center justify-center text-zinc-200 shrink-0"><ProviderIcon id={pid} size={15} /></span>
                      <span className="flex-1 min-w-0"><span className="block truncate">{t(`settings.provider.${pid}`)}</span>
                        <span className="block text-[11px] text-zinc-500">{existing > 0 ? t("settings.picker.exists", { count: existing }) : ROUTES[pid]?.local ? t("settings.picker.local_manual") : t("settings.picker.manual")}</span>
                      </span>
                      {!addable && <span className="text-[10px] text-zinc-500 shrink-0">{t("settings.picker.unique")}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
            <p className="px-4 py-2 border-t border-white/5 text-[11px] text-zinc-500">{t("settings.picker.footer")}</p>
          </div>
        </div>
      )}
      {!settings.monitoring_setup_completed && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-6">
          <div className="w-[28rem] max-h-[34rem] bg-zinc-900 border border-zinc-700/80 rounded-2xl shadow-2xl p-6 flex flex-col space-y-4">
            <div className="flex items-center gap-3">
              <span className="text-2xl">🛡️</span>
              <div>
                <h3 className="text-base font-semibold text-zinc-100">{t("settings.wizard.title")}</h3>
                <p className="text-xs text-zinc-400">{t("settings.wizard.sub")}</p>
              </div>
            </div>
            <div className="text-xs text-zinc-300/90 leading-relaxed bg-zinc-950/60 p-3 rounded-xl border border-white/5">
              {t("settings.wizard.body_pre")}<b>{t("settings.wizard.body_bold")}</b>{t("settings.wizard.body_post")}
            </div>
            <div className="flex-1 flex flex-col min-h-0 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-zinc-400">{t("settings.wizard.selected", { n: wizardSelected.length, total: PROVIDERS.length })}</span>
                <div className="flex gap-2">
                  <button className="text-emerald-400 hover:text-emerald-300 cursor-pointer" onClick={() => setWizardSelected(PROVIDERS.map(p => p[0]))}>{t("settings.wizard.all")}</button>
                  <span className="text-zinc-600">·</span>
                  <button className="text-emerald-400 hover:text-emerald-300 cursor-pointer" onClick={() => setWizardSelected(["claude", "codex", "antigravity", "kimi"])}>{t("settings.wizard.common")}</button>
                  <span className="text-zinc-600">·</span>
                  <button className="text-zinc-400 hover:text-zinc-300 cursor-pointer" onClick={() => setWizardSelected([])}>{t("settings.wizard.none")}</button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 overflow-y-auto p-2 bg-zinc-950/50 rounded-xl border border-white/5 flex-1">
                {PROVIDERS.map(([pid]) => (
                  <label key={pid} className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer hover:bg-white/5 p-1.5 rounded-lg">
                    <input
                      type="checkbox"
                      checked={wizardSelected.includes(pid)}
                      onChange={e => {
                        setWizardSelected(prev => e.target.checked ? [...prev, pid] : prev.filter(x => x !== pid));
                      }}
                      className="accent-emerald-500 rounded"
                    />
                    <span className="truncate">{t(`settings.provider.${pid}`)}</span>
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
                  await persist(updated, t("settings.toast.authorized", { count: wizardSelected.length }));
                }}
              >
                {t("settings.wizard.finish")}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
