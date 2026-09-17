import type { ReactNode } from "react";

export const PROVIDERS: [string, string][] = [
  ["kimi", "Kimi Code"], ["opencode", "OpenCode Go"], ["antigravity", "Antigravity"], ["claude", "Claude Code"],
  ["codex", "Codex"], ["cursor", "Cursor"], ["copilot", "GitHub Copilot"], ["deepseek", "DeepSeek"], ["grok", "Grok"],
  ["grok-bot", "Grok Bot"], ["ollama", "Ollama Cloud"], ["zai", "z.ai"], ["zhipu", "Zhipu (智谱)"], ["minimax", "MiniMax"],
  ["minimax-cn", "MiniMax CN"], ["volcengine", "Volcengine (火山方舟)"], ["command-code", "Command Code"], ["devin", "Devin"]
];
export const providerName = (id: string) => PROVIDERS.find(p => p[0] === id)?.[1] || id;

/** Connection routes each provider really has; the credential UI only offers what exists. */
export const ROUTES: Record<string, { local?: string; manual?: string }> = {
  antigravity: { local: "本地 language_server 进程（自动探测）" },
  codex: { local: "Codex CLI 登录（~/.codex/auth.json）", manual: "ChatGPT OAuth Token" },
  claude: { local: "Claude Code 登录（~/.claude）", manual: "OAuth Token" },
  cursor: { local: "Cursor 编辑器登录（state.vscdb）", manual: "Session Token" },
  copilot: { local: "GitHub CLI / VS Code 登录", manual: "GitHub Token" },
  kimi: { local: "Kimi Code CLI 登录", manual: "Bearer / Refresh Token" },
  opencode: { local: "OpenCode 本地登录", manual: "API Key" },
  deepseek: { manual: "API Key（sk-…）" },
  grok: { manual: "xAI Token" },
  "grok-bot": { local: "Cursor 编辑器登录（state.vscdb）", manual: "Cursor Session Token" },
  ollama: { manual: "Session Cookie（wos-session=…）" },
  zai: { manual: "API Key" }, zhipu: { manual: "API Key" },
  minimax: { manual: "API Key" }, "minimax-cn": { manual: "API Key" },
  volcengine: { local: "arkcli 命令行登录", manual: "AccessKeyID:SecretAccessKey" },
  "command-code": { manual: "API Key" },
  devin: { local: "Windsurf 本地状态库", manual: "API Token [组织ID]" },
};

export const getPlaceholder = (pid: string) => {
  switch (pid) {
    case "volcengine": return "AccessKeyID:SecretAccessKey 或留空使用 arkcli";
    case "ollama": return "Session Cookie (如 wos-session=...)";
    case "devin": return "API Token [组织ID] 或留空读取 Windsurf";
    case "deepseek": return "sk-... (DeepSeek API Key)";
    case "kimi": return "Bearer Token / Refresh Token";
    default: return "输入 API Key / Token 凭据";
  }
};

export const selectCls = "w-full bg-zinc-800/90 border border-zinc-700/80 rounded-xl px-3 py-2 text-xs text-zinc-200 focus:outline-none focus:border-emerald-500 transition-colors";
export const inputCls = "w-full bg-zinc-800/80 border border-zinc-700/70 rounded-xl px-3 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-emerald-500 transition-colors";
export const btnPrimary = "px-4 py-2 bg-emerald-600 hover:bg-emerald-500 active:scale-95 text-white rounded-xl text-xs font-medium transition-all shadow-md cursor-pointer disabled:opacity-40";
export const btnGhost = "px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 active:scale-95 text-zinc-200 rounded-xl text-xs font-medium transition-all cursor-pointer disabled:opacity-40";

export function Switch({ checked, onChange, disabled = false, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-emerald-500/50 ${checked ? "bg-emerald-500" : "bg-zinc-700"} ${disabled ? "opacity-40 cursor-not-allowed" : ""}`}
    >
      <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition duration-200 ease-in-out ${checked ? "translate-x-4" : "translate-x-0"}`} />
    </button>
  );
}

export function Section({ title, icon, subtitle, children, aside }: { title: string; icon?: string; subtitle?: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="p-5 bg-zinc-900/40 rounded-2xl border border-white/5 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-white flex items-center gap-2">{icon && <span>{icon}</span>}{title}</h3>
          {subtitle && <p className="text-[11px] text-zinc-400 mt-0.5">{subtitle}</p>}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** Title says what it is, subtitle says what it does; the control sits on the right. */
export function Row({ title, subtitle, children, disabled }: { title: string; subtitle?: string; children: ReactNode; disabled?: boolean }) {
  return (
    <div className={`flex items-start justify-between gap-4 ${disabled ? "opacity-50" : ""}`}>
      <div className="space-y-0.5 min-w-0">
        <strong className="text-xs text-zinc-200">{title}</strong>
        {subtitle && <p className="text-[11px] text-zinc-400">{subtitle}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-zinc-400">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-zinc-500">{hint}</span>}
    </label>
  );
}

export const timeText = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const t = Date.parse(iso); if (!Number.isFinite(t)) return "—";
  return new Date(t).toLocaleTimeString("zh-CN", { hour12: false });
};
export const ageText = (iso: string | null | undefined, now = Date.now()) => {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return s < 60 ? `${s} 秒前` : s < 3600 ? `${Math.floor(s / 60)} 分钟前` : `${Math.floor(s / 3600)} 小时前`;
};
