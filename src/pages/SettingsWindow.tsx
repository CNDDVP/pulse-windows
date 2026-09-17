import { useEffect, useState, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { AppSettings, ProviderUsage, ProviderConfig } from "../types";
import { ProviderIcon } from "../components/icons/ProviderIcons";
import { TokenSpend } from "./TokenSpend";
import { resetText } from "../presentation";

const PROVIDERS: [string, string][] = [
  ["kimi", "Kimi Code"],
  ["opencode", "OpenCode Go"],
  ["antigravity", "Antigravity"],
  ["claude", "Claude Code"],
  ["codex", "Codex"],
  ["cursor", "Cursor"],
  ["copilot", "GitHub Copilot"],
  ["deepseek", "DeepSeek"],
  ["grok", "Grok"],
  ["grok-bot", "Grok Bot"],
  ["ollama", "Ollama Cloud"],
  ["zai", "z.ai"],
  ["zhipu", "Zhipu (智谱)"],
  ["minimax", "MiniMax"],
  ["minimax-cn", "MiniMax CN"],
  ["volcengine", "Volcengine (火山方舟)"],
  ["command-code", "Command Code"],
  ["devin", "Devin"]
];

const PENDING_PROVIDERS: string[] = [];

const getPlaceholder = (pid: string) => {
  switch (pid) {
    case "volcengine": return "AccessKeyID:SecretAccessKey 或留空使用 arkcli";
    case "ollama": return "Session Cookie (如 wos-session=...)";
    case "devin": return "API Token [组织ID] 或留空读取 Windsurf";
    case "deepseek": return "sk-... (DeepSeek API Key)";
    case "kimi": return "Bearer Token / Refresh Token";
    default: return "输入 API Key / Token 凭据";
  }
};

function Switch({
  checked,
  onChange,
  disabled = false,
  label
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      aria-label={label}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-emerald-500/50 ${
        checked ? "bg-emerald-500" : "bg-zinc-700"
      } ${disabled ? "opacity-40 cursor-not-allowed" : ""}`}
    >
      <span
        className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition duration-200 ease-in-out ${
          checked ? "translate-x-4" : "translate-x-0"
        }`}
      />
    </button>
  );
}

export function SettingsWindow({
  initialSettings,
  usages,
  onSaved
}: {
  initialSettings: AppSettings;
  usages: ProviderUsage[];
  onSaved: (s: AppSettings) => void;
}) {
  const [settings, setSettings] = useState<AppSettings>(initialSettings);
  const [tab, setTab] = useState<"general" | "accounts" | "spend" | "diagnostics">("accounts");
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [diagnostic, setDiagnostic] = useState("");
  const [newProvider, setNewProvider] = useState("kimi");
  const [screens, setScreens] = useState<string[]>([]);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ type: "success" | "info" | "error"; text: string } | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The last settings snapshot this window applied or saved itself. An incoming
  // `settings-updated` that matches it is our own echo; one that differs while the
  // form has edits must not silently discard them.
  const appliedRef = useRef<AppSettings>(initialSettings);
  const settingsRef = useRef<AppSettings>(settings);
  useEffect(() => { settingsRef.current = settings; }, [settings]);
  const [pendingRemote, setPendingRemote] = useState<AppSettings | null>(null);

  const showToast = (type: "success" | "info" | "error", text: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ type, text });
    toastTimerRef.current = setTimeout(() => setToast(null), 3500);
  };

  const hasUnsaved = useMemo(() => {
    return JSON.stringify(settings) !== JSON.stringify(initialSettings);
  }, [settings, initialSettings]);

  useEffect(() => {
    void invoke<string[]>("monitors").then(setScreens).catch(() => setScreens([]));
  }, []);

  useEffect(() => {
    const incoming = JSON.stringify(initialSettings);
    const applied = JSON.stringify(appliedRef.current);
    if (incoming === applied) return;
    if (JSON.stringify(settingsRef.current) !== applied) {
      setPendingRemote(initialSettings);
      return;
    }
    appliedRef.current = initialSettings;
    setSettings(initialSettings);
  }, [initialSettings]);

  const adoptRemote = () => {
    if (!pendingRemote) return;
    appliedRef.current = pendingRemote;
    setSettings(pendingRemote);
    setPendingRemote(null);
  };

  const closeWindow = async () => {
    try {
      await invoke("close_settings_window");
    } catch {
      try {
        await getCurrentWebviewWindow().hide();
      } catch {}
    }
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        void closeWindow();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const patch = (id: string, value: Partial<ProviderConfig>) => {
    setSettings(s => ({
      ...s,
      providers: {
        ...s.providers,
        [id]: { ...s.providers[id], ...value }
      }
    }));
  };

  const save = async () => {
    setBusy(true);
    try {
      const updated = await invoke<AppSettings>("update_settings", { newSettings: settings });
      appliedRef.current = updated;
      setPendingRemote(null);
      onSaved(updated);
      setSettings(updated);
      showToast("success", "设置已保存并同步至悬浮栏");
      return updated;
    } catch (e) {
      showToast("error", `保存失败: ${String(e)}`);
      throw e;
    } finally {
      setBusy(false);
    }
  };

  const test = async (id: string) => {
    setTestingId(id);
    try {
      await save();
      const result = await invoke<ProviderUsage>("test_account", { accountId: id });
      if (result.state === "live") {
        showToast("success", `${result.display_name}: 连接成功，已获取最新配额读数`);
      } else {
        showToast("error", `${result.display_name}: ${result.error_message || result.state}`);
      }
    } catch (e) {
      showToast("error", `测试失败: ${String(e)}`);
    } finally {
      setTestingId(null);
    }
  };

  const handleAddAccount = () => {
    const id = crypto.randomUUID();
    const providerName = PROVIDERS.find(p => p[0] === newProvider)?.[1] || newProvider;
    patch(id, {
      provider_id: newProvider,
      label: providerName,
      enabled: true,
      // Next free slot, not the count: deleting an account would otherwise hand
      // the new one a duplicate order and make the rail sort unstable.
      order: Object.values(settings.providers).reduce((max, c) => Math.max(max, c.order), -1) + 1,
      use_local: false,
      credential_configured: false,
      primary_window: null
    });
    setHighlightedId(id);
    showToast("success", `已添加 ${providerName} 账号，已为您定位到配置卡片`);
    setTimeout(() => {
      const el = document.getElementById(`account-card-${id}`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }, 120);
    setTimeout(() => setHighlightedId(null), 3000);
  };

  const remove = (id: string) => {
    const label = settings.providers[id]?.label || "该账号";
    setSettings(s => {
      const next = { ...s.providers };
      delete next[id];
      return { ...s, providers: next };
    });
    showToast("info", `已删除 ${label}（记得点击右上角“保存更改”生效）`);
  };

  const cleanDrafts = () => {
    const drafts = Object.entries(settings.providers)
      .filter(([id, c]) => !c.enabled && !c.credential_configured && !c.use_local && !secrets[id])
      .map(([id]) => id);
    if (drafts.length === 0) {
      showToast("info", "未发现无凭据的未启用草稿账号");
      return;
    }
    setSettings(s => {
      const next = { ...s.providers };
      for (const id of drafts) delete next[id];
      return { ...s, providers: next };
    });
    showToast("info", `已清理 ${drafts.length} 个未配置的草稿账号`);
  };

  const handleSaveCredential = async (id: string) => {
    const secret = secrets[id];
    if (!secret) return;
    setBusy(true);
    try {
      await save();
      await invoke("set_credential", { accountId: id, secret });
      setSecrets(s => ({ ...s, [id]: "" }));
      showToast("success", "凭据已安全存入 Windows 凭据管理器");
    } catch (e) {
      showToast("error", `凭据保存失败: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteCredential = async (id: string) => {
    setBusy(true);
    try {
      await invoke("delete_credential", { accountId: id });
      showToast("info", "凭据已从 Windows 凭据管理器中移除");
    } catch (e) {
      showToast("error", `凭据删除失败: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  // A running "save and test" already holds the backend refresh gate; letting
  // other cards or the header save fire meanwhile only scrambles the toasts.
  const locked = busy || testingId !== null;
  const totalAccounts = Object.keys(settings.providers).length;
  const enabledAccounts = Object.values(settings.providers).filter(p => p.enabled).length;
  const draftAccountsCount = Object.values(settings.providers).filter(
    c => !c.enabled && !c.credential_configured && !c.use_local
  ).length;

  return (
    <main className="h-screen flex flex-col bg-[#0f0f12] text-zinc-200 text-sm select-none font-sans overflow-hidden">
      {/* Toast Notification */}
      {toast && (
        <div className={`fixed top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2.5 rounded-xl shadow-2xl border text-xs font-medium transition-all animate-in fade-in slide-in-from-top-3 ${
          toast.type === "success" ? "bg-emerald-950/95 border-emerald-700/60 text-emerald-200" :
          toast.type === "error" ? "bg-red-950/95 border-red-700/60 text-red-200" :
          "bg-zinc-900/95 border-zinc-700 text-zinc-200"
        }`}>
          <span className="text-sm leading-none font-bold">
            {toast.type === "success" ? "✓" : toast.type === "error" ? "✕" : "ℹ"}
          </span>
          <span>{toast.text}</span>
          <button onClick={() => setToast(null)} className="ml-2 text-zinc-400 hover:text-white">✕</button>
        </div>
      )}

      {pendingRemote && (
        <div className="shrink-0 flex items-center justify-between gap-3 px-5 py-2 bg-amber-950/70 border-b border-amber-800/50 text-xs text-amber-200">
          <span>设置已在别处更新；当前表单有未保存的修改，已为你保留。</span>
          <div className="flex gap-2 shrink-0">
            <button onClick={adoptRemote} className="px-2.5 py-1 rounded bg-amber-700 hover:bg-amber-600 text-white cursor-pointer">放弃本地修改并加载</button>
            <button onClick={() => setPendingRemote(null)} className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 cursor-pointer">保留本地修改</button>
          </div>
        </div>
      )}

      {/* Header */}
      <header className="h-14 shrink-0 flex justify-between items-center px-5 border-b border-white/5 bg-zinc-950/80 backdrop-blur-md">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-emerald-600 to-teal-500 flex items-center justify-center shadow-lg shadow-emerald-950/50">
            <svg className="w-4 h-4 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
            </svg>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-sm font-bold text-white tracking-wide">Pulse</h1>
              <span className="text-[10px] bg-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded font-mono border border-zinc-700/50">v0.2.0</span>
            </div>
            <p className="text-[11px] text-zinc-400">AI 配额监控 · 本地使用审计</p>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            disabled={locked}
            onClick={() => void save()}
            className={`relative flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer shadow-sm ${
              hasUnsaved
                ? "bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-950/60 ring-1 ring-emerald-400/50 active:scale-95"
                : "bg-zinc-800 hover:bg-zinc-700 text-zinc-300 active:scale-95"
            } disabled:opacity-40`}
          >
            {hasUnsaved && <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" title="有未保存的更改" />}
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
              <polyline points="17 21 17 13 7 13 7 21" />
              <polyline points="7 3 7 8 15 8" />
            </svg>
            <span>{busy ? "正在保存..." : hasUnsaved ? "保存更改" : "已是最新"}</span>
          </button>

          <button
            onClick={() => void closeWindow()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 active:bg-zinc-700 text-zinc-300 hover:text-white border border-zinc-800 transition-all cursor-pointer text-xs group"
            title="关闭设置窗口 (Esc)"
          >
            <svg className="w-3.5 h-3.5 text-zinc-400 group-hover:text-white transition-colors" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
            <span>关闭</span>
            <kbd className="text-[10px] bg-zinc-950 text-zinc-500 px-1 py-0.5 rounded border border-zinc-800 font-mono">Esc</kbd>
          </button>
        </div>
      </header>

      {/* Main Body */}
      <div className="flex flex-1 min-h-0">
        {/* Navigation Sidebar */}
        <nav className="w-44 shrink-0 p-3 border-r border-white/5 bg-zinc-950/40 flex flex-col justify-between">
          <div className="space-y-1">
            {[
              { id: "accounts", name: "账号与凭据", icon: "👤", badge: `${enabledAccounts}/${totalAccounts}` },
              { id: "general", name: "通用设置", icon: "⚙️" },
              { id: "spend", name: "Token 消耗", icon: "📊" },
              { id: "diagnostics", name: "连接诊断", icon: "🩺" }
            ].map(item => {
              const active = tab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setTab(item.id as typeof tab)}
                  className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs font-medium transition-all text-left cursor-pointer ${
                    active
                      ? "bg-zinc-800/90 text-white shadow-sm border border-white/5"
                      : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900/60"
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <span>{item.icon}</span>
                    <span>{item.name}</span>
                  </span>
                  {item.badge && (
                    <span className={`text-[10px] px-1.5 py-[2px] rounded-full font-mono ${
                      active ? "bg-emerald-950/80 text-emerald-400 border border-emerald-800/40" : "bg-zinc-900 text-zinc-500"
                    }`}>
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="p-2 bg-zinc-900/40 rounded-xl border border-white/5 text-[11px] text-zinc-500 space-y-1">
            <p className="flex items-center gap-1 text-zinc-400 font-medium">
              <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block"></span>
              实时守护中
            </p>
            <p>更改配置后请点击右上角保存。</p>
          </div>
        </nav>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* ================= ACCOUNTS TAB ================= */}
          {tab === "accounts" && (
            <div className="space-y-5 max-w-3xl">
              {/* Account Top Action Bar */}
              <div className="p-4 bg-zinc-900/60 rounded-2xl border border-white/5 space-y-3">
                <div className="flex justify-between items-center">
                  <div>
                    <h2 className="text-sm font-semibold text-white">添加服务商账号</h2>
                    <p className="text-xs text-zinc-400 mt-0.5">支持多个服务商与同服务商多账号并行监控</p>
                  </div>
                  {draftAccountsCount > 0 && (
                    <button
                      onClick={cleanDrafts}
                      className="text-xs text-amber-400/90 hover:text-amber-300 bg-amber-950/30 hover:bg-amber-950/60 border border-amber-800/40 rounded-lg px-2.5 py-1.5 transition-all flex items-center gap-1 cursor-pointer"
                    >
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                      <span>清理 {draftAccountsCount} 个空白草稿</span>
                    </button>
                  )}
                </div>

                <div className="flex gap-2 items-center pt-1">
                  <select
                    value={newProvider}
                    onChange={e => setNewProvider(e.target.value)}
                    className="flex-1 bg-zinc-800/90 hover:bg-zinc-800 border border-zinc-700/80 rounded-xl px-3 py-2 text-xs text-zinc-200 focus:outline-none focus:border-emerald-500 transition-colors cursor-pointer"
                  >
                    {PROVIDERS.map(([id, name]) => (
                      <option key={id} value={id}>
                        {name} {PENDING_PROVIDERS.includes(id) ? "(待实现)" : ""}
                      </option>
                    ))}
                  </select>

                  <button
                    onClick={handleAddAccount}
                    className="bg-emerald-600 hover:bg-emerald-500 active:scale-95 text-white text-xs font-semibold px-4 py-2 rounded-xl transition-all flex items-center gap-1.5 shadow-md shadow-emerald-950 cursor-pointer shrink-0"
                  >
                    <span className="text-base font-bold leading-none">+</span>
                    <span>添加账号</span>
                  </button>
                </div>
              </div>

              {/* Accounts List */}
              <div className="space-y-4">
                {Object.entries(settings.providers)
                  .sort((a, b) => a[1].order - b[1].order)
                  .map(([id, c]) => {
                    const reading = usages.find(u => u.account_id === id);
                    const isHighlighted = highlightedId === id;
                    const isTesting = testingId === id;

                    return (
                      <section
                        key={id}
                        id={`account-card-${id}`}
                        className={`p-5 rounded-2xl bg-zinc-900/40 border transition-all duration-300 space-y-4 ${
                          isHighlighted
                            ? "ring-2 ring-emerald-500 border-emerald-500/80 shadow-xl shadow-emerald-950/40"
                            : c.enabled
                            ? "border-white/10 hover:border-white/20"
                            : "border-white/5 opacity-70 hover:opacity-100"
                        }`}
                      >
                        {/* Card Header */}
                        <div className="flex justify-between items-center border-b border-white/5 pb-3">
                          <div className="flex items-center gap-3">
                            <div className="w-9 h-9 rounded-xl bg-zinc-800/90 border border-zinc-700/50 flex items-center justify-center text-zinc-200">
                              <ProviderIcon id={c.provider_id} size={20} />
                            </div>
                            <div>
                              <div className="flex items-center gap-2">
                                <strong className="text-sm font-semibold text-white">
                                  {PROVIDERS.find(p => p[0] === c.provider_id)?.[1] || c.provider_id}
                                </strong>
                                <span className="text-xs text-zinc-400 font-normal">({c.label})</span>
                                {PENDING_PROVIDERS.includes(c.provider_id) && (
                                  <span className="text-[10px] px-1.5 py-[2px] bg-amber-950 text-amber-400 border border-amber-800/50 rounded">
                                    数据路线待实现
                                  </span>
                                )}
                              </div>
                              <div className="flex items-center gap-2 mt-1">
                                {!c.enabled ? (
                                  <span className="text-[11px] text-zinc-500 flex items-center gap-1">
                                    <span className="w-1.5 h-1.5 rounded-full bg-zinc-600"></span>已禁用
                                  </span>
                                ) : reading?.state === "live" ? (
                                  <span className="text-[11px] text-emerald-400 flex items-center gap-1 font-medium">
                                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                                    连接正常 · 实时读数
                                  </span>
                                ) : reading?.state === "stale" ? (
                                  <span className="text-[11px] text-amber-400 flex items-center gap-1 font-medium">
                                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400"></span>
                                    使用缓存 · 待刷新
                                  </span>
                                ) : reading?.error_message ? (
                                  <span className="text-[11px] text-red-400 flex items-center gap-1 font-medium" title={reading.error_message}>
                                    <span className="w-1.5 h-1.5 rounded-full bg-red-400"></span>
                                    {reading.error_message}
                                  </span>
                                ) : (
                                  <span className="text-[11px] text-zinc-500">尚未查询读数</span>
                                )}
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center gap-3">
                            <label className="flex items-center gap-2 text-xs text-zinc-400 cursor-pointer">
                              <span>启用</span>
                              <Switch
                                checked={c.enabled}
                                onChange={v => patch(id, { enabled: v })}
                                label="启用账号"
                              />
                            </label>

                            <button
                              className="text-zinc-500 hover:text-red-400 hover:bg-red-950/30 p-1.5 rounded-lg transition-colors cursor-pointer"
                              onClick={() => remove(id)}
                              title="删除此账号"
                            >
                              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <polyline points="3 6 5 6 21 6" />
                                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                              </svg>
                            </button>
                          </div>
                        </div>

                        {/* Card Form */}
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                          <label className="block md:col-span-2 space-y-1">
                            <span className="text-xs text-zinc-400">账号备注名</span>
                            <input
                              className="w-full bg-zinc-800/80 border border-zinc-700/70 rounded-xl px-3 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-emerald-500 transition-colors"
                              value={c.label}
                              onChange={e => patch(id, { label: e.target.value })}
                            />
                          </label>

                          <label className="block space-y-1">
                            <span className="text-xs text-zinc-400">悬浮栏排序</span>
                            <input
                              className="w-full bg-zinc-800/80 border border-zinc-700/70 rounded-xl px-3 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-emerald-500 transition-colors"
                              type="number"
                              min={0}
                              value={c.order}
                              onChange={e => patch(id, { order: Math.max(0, Number(e.target.value)) })}
                            />
                          </label>
                        </div>

                        {/* Credential Store Box */}
                        <div className="p-3.5 bg-zinc-950/60 rounded-xl border border-white/5 space-y-3">
                          <div className="flex justify-between items-center text-xs">
                            <div className="flex items-center gap-2">
                              {c.credential_configured ? (
                                <span className="flex items-center gap-1.5 text-emerald-400 font-medium">
                                  <svg className="w-4 h-4 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                                  </svg>
                                  已安全存储在 Windows 凭据管理器
                                </span>
                              ) : (
                                <span className="flex items-center gap-1.5 text-zinc-400">
                                  <svg className="w-4 h-4 text-zinc-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <circle cx="12" cy="12" r="10" />
                                    <line x1="12" y1="8" x2="12" y2="12" />
                                    <line x1="12" y1="16" x2="12.01" y2="16" />
                                  </svg>
                                  尚未配置手动凭据
                                </span>
                              )}
                            </div>
                            <span className="text-[11px] text-zinc-500">本机登录与手动凭据互不覆盖</span>
                          </div>

                          {!PENDING_PROVIDERS.includes(c.provider_id) && c.provider_id !== "antigravity" && (
                            <div className="flex gap-2 items-center">
                              <div className="relative flex-1">
                                <input
                                  className="w-full bg-zinc-800/90 border border-zinc-700/80 rounded-xl pl-3 pr-9 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-emerald-500 transition-colors"
                                  type={showSecrets[id] ? "text" : "password"}
                                  autoComplete="off"
                                  value={secrets[id] || ""}
                                  placeholder={getPlaceholder(c.provider_id)}
                                  onChange={e => setSecrets({ ...secrets, [id]: e.target.value })}
                                />
                                <button
                                  type="button"
                                  onClick={() => setShowSecrets(s => ({ ...s, [id]: !s[id] }))}
                                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-200 cursor-pointer"
                                  title={showSecrets[id] ? "隐藏" : "显示"}
                                >
                                  {showSecrets[id] ? (
                                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                                      <line x1="1" y1="1" x2="23" y2="23" />
                                    </svg>
                                  ) : (
                                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                                      <circle cx="12" cy="12" r="3" />
                                    </svg>
                                  )}
                                </button>
                              </div>

                              <button
                                disabled={locked || !secrets[id]}
                                onClick={() => void handleSaveCredential(id)}
                                className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 active:scale-95 text-zinc-200 rounded-xl text-xs font-medium transition-all disabled:opacity-40 cursor-pointer"
                              >
                                保存凭据
                              </button>

                              {c.credential_configured && (
                                <button
                                  disabled={locked}
                                  onClick={() => void handleDeleteCredential(id)}
                                  className="px-3 py-1.5 bg-zinc-900 hover:bg-red-950/40 text-red-400 border border-zinc-800 hover:border-red-900/60 rounded-xl text-xs font-medium transition-all disabled:opacity-40 cursor-pointer"
                                >
                                  删除凭据
                                </button>
                              )}
                            </div>
                          )}

                          <label className="flex items-center gap-2 text-xs text-zinc-400 cursor-pointer">
                            <input
                              type="checkbox"
                              className="rounded bg-zinc-800 border-zinc-700 text-emerald-500 focus:ring-emerald-500"
                              checked={c.use_local}
                              onChange={e => patch(id, { use_local: e.target.checked })}
                            />
                            <span>未保存凭据时读取本机工具登录（额外独立账号建议关闭）</span>
                          </label>
                        </div>

                        {/* Primary Quota Selection */}
                        {reading?.windows && reading.windows.length > 0 && (
                          <div className="p-3.5 bg-zinc-950/40 rounded-xl border border-white/5 space-y-2">
                            <div className="flex justify-between items-center">
                              <span className="text-xs font-semibold text-zinc-300">悬浮栏主额度指标优先展示</span>
                              <span className="text-[11px] text-zinc-500">保存后即刻在悬浮栏生效</span>
                            </div>
                            <select
                              className="w-full bg-zinc-800/90 border border-zinc-700/80 rounded-xl px-3 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-emerald-500 transition-colors cursor-pointer"
                              value={c.primary_window || ""}
                              onChange={e => patch(id, { primary_window: e.target.value || null })}
                            >
                              <option value="">自动选择最高使用率（默认）</option>
                              {reading.windows.map(w => (
                                <option key={w.id} value={w.id}>
                                  {w.name} — 已使用 {w.used_percent.toFixed(1)}% ({resetText(w.resets_at)})
                                </option>
                              ))}
                            </select>
                            <p className="text-[11px] text-zinc-400">
                              指定悬浮栏圆环上优先展示哪项额度指标。例如勾选 5 小时限额时，圆环将以 5 小时使用率和重置倒计时为准。
                            </p>
                          </div>
                        )}

                        {/* Test Connection & Live Quota Bars */}
                        <div className="flex justify-between items-center pt-2">
                          <button
                            disabled={locked || !c.enabled}
                            onClick={() => void test(id)}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 active:scale-95 text-zinc-200 rounded-xl text-xs font-medium transition-all disabled:opacity-40 cursor-pointer"
                          >
                            {isTesting ? (
                              <span className="w-3.5 h-3.5 border-2 border-zinc-400 border-t-white rounded-full animate-spin"></span>
                            ) : (
                              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M23 4v6h-6" />
                                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                              </svg>
                            )}
                            <span>{isTesting ? "测试中..." : "保存并测试连接"}</span>
                          </button>

                          <span className="text-[11px] text-zinc-500">
                            {reading?.source ? `数据来源: ${reading.source}` : "尚未获得读数"}
                          </span>
                        </div>

                        {/* Live Reading Breakdown */}
                        {reading && (reading.windows.length > 0 || reading.balances.length > 0) && (
                          <div className="pt-2 border-t border-white/5 space-y-2.5">
                            {reading.windows.map(w => {
                              const isPrimary = c.primary_window === w.id || (!c.primary_window && w.used_percent === reading.primary_percent);
                              return (
                                <div key={w.id} className="space-y-1">
                                  <div className="flex justify-between items-center text-xs">
                                    <span className="flex items-center gap-1.5 text-zinc-300">
                                      {w.name}
                                      {isPrimary && (
                                        <span className="text-[10px] bg-emerald-950/80 text-emerald-400 px-1.5 py-[2px] rounded border border-emerald-800/40">
                                          主额度
                                        </span>
                                      )}
                                    </span>
                                    <span className="font-mono text-zinc-200">
                                      {w.used_percent.toFixed(1)}% 已用
                                    </span>
                                  </div>
                                  <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                                    <div
                                      className={`h-full rounded-full transition-all duration-500 ${
                                        w.used_percent >= 90 ? "bg-red-500" :
                                        w.used_percent >= 75 ? "bg-orange-500" :
                                        w.used_percent >= 50 ? "bg-amber-400" :
                                        "bg-emerald-500"
                                      }`}
                                      style={{ width: `${Math.min(100, Math.max(2, w.used_percent))}%` }}
                                    />
                                  </div>
                                  <div className="flex justify-between text-[11px] text-zinc-500">
                                    <span>{resetText(w.resets_at)}</span>
                                  </div>
                                </div>
                              );
                            })}

                            {reading.balances.map((b, i) => (
                              <div key={i} className="flex justify-between items-center text-xs text-zinc-300 pt-1">
                                <span>账户余额</span>
                                <span className="font-semibold text-emerald-400 font-mono">
                                  {b.currency} {b.amount.toFixed(2)}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </section>
                    );
                  })}
              </div>
            </div>
          )}

          {/* ================= GENERAL TAB ================= */}
          {tab === "general" && (
            <div className="space-y-5 max-w-2xl">
              {/* Group 1: Display & Docking */}
              <section className="p-5 bg-zinc-900/40 rounded-2xl border border-white/5 space-y-4">
                <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                  <span>🖥️</span> 屏幕与贴靠位置
                </h3>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <label className="block space-y-1">
                    <span className="text-xs text-zinc-400">显示器</span>
                    <select
                      className="w-full bg-zinc-800/90 border border-zinc-700/80 rounded-xl px-3 py-2 text-xs text-zinc-200 focus:outline-none focus:border-emerald-500 transition-colors"
                      value={settings.follow_active_display ? "__active__" : settings.monitor_name || ""}
                      onChange={e => {
                        const val = e.target.value;
                        if (val === "__active__") {
                          setSettings({ ...settings, follow_active_display: true, monitor_name: null });
                        } else {
                          setSettings({ ...settings, follow_active_display: false, monitor_name: val || null });
                        }
                      }}
                    >
                      <option value="__active__">当前活动屏幕（跟随鼠标焦点）</option>
                      {screens.map(n => (
                        <option key={n} value={n}>{n}</option>
                      ))}
                    </select>
                  </label>

                  <label className="block space-y-1">
                    <span className="text-xs text-zinc-400">贴靠屏幕边缘</span>
                    <select
                      className="w-full bg-zinc-800/90 border border-zinc-700/80 rounded-xl px-3 py-2 text-xs text-zinc-200 focus:outline-none focus:border-emerald-500 transition-colors"
                      value={settings.dock_side}
                      onChange={e => setSettings({ ...settings, dock_side: e.target.value as AppSettings["dock_side"] })}
                    >
                      <option value="right">屏幕右侧（默认推荐）</option>
                      <option value="left">屏幕左侧</option>
                      <option value="top">屏幕顶部</option>
                      <option value="free">自由浮动位置</option>
                    </select>
                  </label>
                </div>

                {settings.dock_side === "free" && (
                  <div className="pt-2 border-t border-white/5 space-y-3">
                    <label className="block space-y-1">
                      <div className="flex justify-between text-xs text-zinc-400">
                        <span>横向位置 (X)</span>
                        <span className="font-mono">{Math.round(settings.free_x * 100)}%</span>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.01"
                        value={settings.free_x}
                        onChange={e => setSettings({ ...settings, free_x: Number(e.target.value) })}
                        className="w-full accent-emerald-500"
                      />
                    </label>

                    <label className="block space-y-1">
                      <div className="flex justify-between text-xs text-zinc-400">
                        <span>纵向位置 (Y)</span>
                        <span className="font-mono">{Math.round(settings.free_y * 100)}%</span>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.01"
                        value={settings.free_y}
                        onChange={e => setSettings({ ...settings, free_y: Number(e.target.value) })}
                        className="w-full accent-emerald-500"
                      />
                    </label>
                  </div>
                )}
              </section>

              {/* Group 2: Appearance & Visuals */}
              <section className="p-5 bg-zinc-900/40 rounded-2xl border border-white/5 space-y-4">
                <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                  <span>🎨</span> 外观与指标视觉
                </h3>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <label className="block space-y-1">
                    <span className="text-xs text-zinc-400">主题外观</span>
                    <select
                      className="w-full bg-zinc-800/90 border border-zinc-700/80 rounded-xl px-3 py-2 text-xs text-zinc-200 focus:outline-none focus:border-emerald-500 transition-colors"
                      value={settings.theme}
                      onChange={e => setSettings({ ...settings, theme: e.target.value as AppSettings["theme"] })}
                    >
                      <option value="obsidian">暗夜黑 (Obsidian)</option>
                      <option value="translucent">半透明磨砂 (Translucent)</option>
                    </select>
                  </label>

                  <label className="block space-y-1">
                    <span className="text-xs text-zinc-400">额度百分比数值形式</span>
                    <select
                      className="w-full bg-zinc-800/90 border border-zinc-700/80 rounded-xl px-3 py-2 text-xs text-zinc-200 focus:outline-none focus:border-emerald-500 transition-colors"
                      value={settings.display_mode}
                      onChange={e => setSettings({ ...settings, display_mode: e.target.value as AppSettings["display_mode"] })}
                    >
                      <option value="used">展示已使用百分比（如 20% 已用）</option>
                      <option value="remaining">展示剩余百分比（如 80% 剩余）</option>
                    </select>
                  </label>
                </div>

                <div className="pt-2 border-t border-white/5 space-y-3">
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-0.5">
                      <strong className="text-xs text-zinc-200">显示额度窗口已过时间（外圈细白环）</strong>
                      <p className="text-[11px] text-zinc-400">
                        在圆环外层显示一圈白色细线，代表当前限额周期已消耗的时间百分比（例如 7 天周期已过去 80% 则细线占 80%）。可直观对比用量消耗与时间流逝速率。若不需要可关闭。
                      </p>
                    </div>
                    <Switch
                      checked={settings.show_elapsed}
                      onChange={v => setSettings({ ...settings, show_elapsed: v })}
                      label="显示额度窗口已过时间"
                    />
                  </div>

                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-0.5">
                      <strong className="text-xs text-zinc-200">显示平均消耗耗尽预测</strong>
                      <p className="text-[11px] text-zinc-400">
                        根据当前周期的平均消耗速度，估算配额是否会在周期结束前提前耗尽。
                      </p>
                    </div>
                    <Switch
                      checked={settings.forecast}
                      onChange={v => setSettings({ ...settings, forecast: v })}
                      label="显示平均消耗预测"
                    />
                  </div>
                </div>
              </section>

              {/* Group 3: Automation & Timing */}
              <section className="p-5 bg-zinc-900/40 rounded-2xl border border-white/5 space-y-4">
                <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                  <span>⚡</span> 行为与刷新频率
                </h3>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <label className="block space-y-1">
                    <span className="text-xs text-zinc-400">鼠标移开后自动折叠</span>
                    <select
                      className="w-full bg-zinc-800/90 border border-zinc-700/80 rounded-xl px-3 py-2 text-xs text-zinc-200 focus:outline-none focus:border-emerald-500 transition-colors"
                      value={settings.auto_collapse_seconds}
                      onChange={e => setSettings({ ...settings, auto_collapse_seconds: Number(e.target.value) })}
                    >
                      <option value={0}>从不折叠（始终展示图标）</option>
                      <option value={2}>2 秒后收起为小白条</option>
                      <option value={3}>3 秒后收起为小白条</option>
                      <option value={5}>5 秒后收起为小白条</option>
                      <option value={10}>10 秒后收起为小白条</option>
                    </select>
                  </label>

                  <label className="block space-y-1">
                    <span className="text-xs text-zinc-400">自动刷新配额间隔 (秒)</span>
                    <input
                      type="number"
                      min={30}
                      max={3600}
                      value={settings.refresh_interval_seconds}
                      onChange={e => setSettings({ ...settings, refresh_interval_seconds: Math.min(3600, Math.max(30, Number(e.target.value) || 30)) })}
                      className="w-full bg-zinc-800/90 border border-zinc-700/80 rounded-xl px-3 py-2 text-xs text-zinc-200 focus:outline-none focus:border-emerald-500 transition-colors"
                    />
                  </label>
                </div>

                <div className="pt-2 border-t border-white/5">
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-0.5">
                      <strong className="text-xs text-zinc-200">全屏应用/游戏运行时自动隐藏</strong>
                      <p className="text-[11px] text-zinc-400">检测到前台正在全屏运行游戏或视频时，自动隐藏悬浮栏避免干扰。</p>
                    </div>
                    <Switch
                      checked={settings.hide_fullscreen}
                      onChange={v => setSettings({ ...settings, hide_fullscreen: v })}
                      label="全屏应用前台运行时隐藏"
                    />
                  </div>
                </div>
              </section>
            </div>
          )}

          {/* ================= SPEND TAB ================= */}
          {tab === "spend" && <TokenSpend />}

          {/* ================= DIAGNOSTICS TAB ================= */}
          {tab === "diagnostics" && (
            <div className="space-y-4 max-w-3xl">
              <div className="p-4 bg-zinc-900/60 rounded-2xl border border-white/5 space-y-2">
                <h3 className="text-sm font-semibold text-white">连接诊断报告</h3>
                <p className="text-xs text-zinc-400">
                  诊断报告仅包含服务商状态、响应时间和错误分类，绝对不会包含您的账号名称、API Key 或本地路径。
                </p>
                <div className="pt-2 flex gap-2">
                  <button
                    disabled={busy}
                    onClick={() => void (async () => {
                      setBusy(true);
                      try {
                        const d = await invoke<string>("diagnostics");
                        setDiagnostic(d);
                        showToast("success", "诊断报告生成成功");
                      } catch (e) {
                        showToast("error", `生成诊断失败: ${String(e)}`);
                      } finally {
                        setBusy(false);
                      }
                    })()}
                    className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 active:scale-95 text-white rounded-xl text-xs font-medium transition-all shadow-md cursor-pointer"
                  >
                    生成即时诊断报告
                  </button>

                  {diagnostic && (
                    <button
                      onClick={() => {
                        void navigator.clipboard.writeText(diagnostic);
                        showToast("success", "已复制诊断报告至剪贴板");
                      }}
                      className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 active:scale-95 text-zinc-200 rounded-xl text-xs font-medium transition-all cursor-pointer"
                    >
                      复制诊断文本
                    </button>
                  )}
                </div>
              </div>

              {diagnostic && (
                <pre className="w-full h-96 bg-zinc-950 p-4 font-mono text-xs text-zinc-300 rounded-2xl border border-white/5 overflow-auto select-text">
                  {diagnostic}
                </pre>
              )}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
