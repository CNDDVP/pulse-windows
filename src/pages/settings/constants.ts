import type { AppSettings, ProviderUsage } from "../../types";

export const PROVIDERS: [string, string][] = [
  ["kimi", "Kimi Code"], ["opencode", "OpenCode Go"], ["antigravity", "Antigravity"], ["claude", "Claude Code"],
  ["codex", "Codex"], ["cursor", "Cursor"], ["copilot", "GitHub Copilot"], ["deepseek", "DeepSeek"], ["grok", "Grok"],
  ["grok-bot", "Grok Bot"], ["ollama", "Ollama Cloud"], ["zai", "z.ai"], ["zhipu", "Zhipu (智谱)"], ["minimax", "MiniMax"],
  ["minimax-cn", "MiniMax CN"], ["volcengine", "Volcengine (火山方舟)"], ["command-code", "Command Code"], ["devin", "Devin"],
  ["xiaomi", "小米 Coding Plan"]
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

export const STATE_LABEL: Record<string, string> = { live: "正常", stale: "使用缓存", unavailable: "不可用", error: "错误", loading: "读取中" };

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

export function accountRows(u: ProviderUsage, cfg: AppSettings["providers"][string] | undefined): [string, string][] {
  const cached = u.state === "stale";
  return [
    ["状态", STATE_LABEL[u.state] ?? u.state],
    ["最近检查", timeText(u.checked_at)],
    ["最近成功读取", u.last_success_at ? `${timeText(u.last_success_at)}（${ageText(u.last_success_at)}）` : "—"],
    ["数据来源", u.source || "—"],
    ["缓存", cached ? `使用缓存 · ${ageText(u.last_success_at)}` : "未使用"],
    ["请求耗时", u.duration_ms != null ? `${u.duration_ms} ms` : "—"],
    ["最后错误", u.error_message ? `${u.error_message}${u.error_code ? `（${u.error_code}）` : ""}` : "无"],
    ["凭据", cfg?.credential_configured ? "已保存的凭据" : cfg?.use_local ? "本机工具登录" : "未配置"],
  ];
}
