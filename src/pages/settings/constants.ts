import type { AppSettings, ProviderUsage } from "../../types";
import { t as moduleT, type TVars } from "../../lib/i18n";

/** 绑定语言的翻译函数；未传时退回模块级 t（默认 zh，兜底旧调用方）。 */
export type TFn = (key: string, vars?: TVars) => string;

export const PROVIDERS: [string, string][] = [
  ["kimi", "Kimi Code"], ["opencode", "OpenCode Go"], ["antigravity", "Antigravity"], ["claude", "Claude Code"],
  ["codex", "Codex"], ["cursor", "Cursor"], ["copilot", "GitHub Copilot"], ["deepseek", "DeepSeek"], ["grok", "Grok"],
  ["grok-bot", "Grok Bot"], ["ollama", "Ollama Cloud"], ["zai", "z.ai"], ["zhipu", "Zhipu (智谱)"], ["minimax", "MiniMax"],
  ["minimax-cn", "MiniMax CN"],  ["volcengine", "Volcengine (火山方舟)"], ["command-code", "Command Code"], ["devin", "Devin"],
  ["xiaomi", "小米 Coding Plan"], ["stepfun", "StepFun (阶跃星辰)"]
];

/** 服务商显示名：zh 词典是唯一事实来源（含中文名），en 提供纯英文名；未登记的 id 原样返回。 */
export const providerName = (id: string, T?: TFn) => {
  const name = PROVIDERS.find(p => p[0] === id)?.[1];
  if (!name) return id;
  return T ? T(`settings.provider.${id}`) : name;
};

/** Connection routes each provider really has; the credential UI only offers what exists.
 *  值为 i18n key（settings.route.*），展示方经 t() 翻译。 */
export const ROUTES: Record<string, { local?: string; manual?: string }> = {
  antigravity: { local: "settings.route.antigravity.local" },
  codex: { local: "settings.route.codex.local", manual: "settings.route.codex.manual" },
  claude: { local: "settings.route.claude.local", manual: "settings.route.claude.manual" },
  cursor: { local: "settings.route.cursor.local", manual: "settings.route.cursor.manual" },
  copilot: { local: "settings.route.copilot.local", manual: "settings.route.copilot.manual" },
  kimi: { local: "settings.route.kimi.local", manual: "settings.route.kimi.manual" },
  opencode: { local: "settings.route.opencode.local", manual: "settings.route.api_key" },
  deepseek: { manual: "settings.route.api_key_sk" },
  stepfun: { manual: "settings.route.stepfun.manual" },
  grok: { manual: "settings.route.xai_token" },
  "grok-bot": { local: "settings.route.cursor.local", manual: "settings.route.grokbot.manual" },
  ollama: { manual: "settings.route.ollama.manual" },
  zai: { manual: "settings.route.api_key" }, zhipu: { manual: "settings.route.api_key" },
  minimax: { manual: "settings.route.api_key" }, "minimax-cn": { manual: "settings.route.api_key" },
  volcengine: { local: "settings.route.volcengine.local", manual: "settings.route.volcengine.manual" },
  "command-code": { manual: "settings.route.api_key" },
  devin: { local: "settings.route.devin.local", manual: "settings.route.devin.manual" },
};

export const getPlaceholder = (pid: string, T: TFn = moduleT) => T(`settings.placeholder.${pid}`);

export const selectCls = "w-full bg-zinc-800/90 border border-zinc-700/80 rounded-xl px-3 py-2 text-xs text-zinc-200 focus:outline-none focus:border-emerald-500 transition-colors";
export const inputCls = "w-full bg-zinc-800/80 border border-zinc-700/70 rounded-xl px-3 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-emerald-500 transition-colors";
export const btnPrimary = "px-4 py-2 bg-emerald-600 hover:bg-emerald-500 active:scale-95 text-white rounded-xl text-xs font-medium transition-all shadow-md cursor-pointer disabled:opacity-40";
export const btnGhost = "px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 active:scale-95 text-zinc-200 rounded-xl text-xs font-medium transition-all cursor-pointer disabled:opacity-40";

/** 读取状态 → i18n key；未知状态原样展示（后端新状态不静默编造文案）。 */
export const STATE_KEYS: Record<string, string> = {
  live: "settings.state.live", stale: "settings.state.stale", unavailable: "settings.state.unavailable", error: "settings.state.error", loading: "settings.state.loading",
};
export const stateLabel = (T: TFn, state: string) => (state in STATE_KEYS ? T(STATE_KEYS[state]) : state);

export const timeText = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const t = Date.parse(iso); if (!Number.isFinite(t)) return "—";
  return new Date(t).toLocaleTimeString("zh-CN", { hour12: false });
};

export const ageText = (iso: string | null | undefined, T: TFn = moduleT, now = Date.now()) => {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return s < 60 ? T("settings.ago.sec", { n: s }) : s < 3600 ? T("settings.ago.min", { n: Math.floor(s / 60) }) : T("settings.ago.hour", { n: Math.floor(s / 3600) });
};

export function accountRows(u: ProviderUsage, cfg: AppSettings["providers"][string] | undefined, T: TFn = moduleT): [string, string][] {
  const cached = u.state === "stale";
  return [
    [T("settings.acctrow.state"), stateLabel(T, u.state)],
    [T("settings.acctrow.checked"), timeText(u.checked_at)],
    [T("settings.acctrow.last_success"), u.last_success_at ? `${timeText(u.last_success_at)}（${ageText(u.last_success_at, T)}）` : "—"],
    [T("settings.acctrow.source"), u.source || "—"],
    [T("settings.acctrow.cache"), cached ? T("settings.acctrow.cached_ago", { ago: ageText(u.last_success_at, T) }) : T("settings.acctrow.cache_no")],
    [T("settings.acctrow.duration"), u.duration_ms != null ? `${u.duration_ms} ms` : "—"],
    [T("settings.acctrow.last_error"), u.error_message ? `${u.error_message}${u.error_code ? `（${u.error_code}）` : ""}` : T("settings.common.none")],
    [T("settings.acctrow.credential"), cfg?.credential_configured ? T("settings.acctrow.cred_saved") : cfg?.use_local ? T("settings.acctrow.cred_local") : T("settings.acctrow.cred_none")],
  ];
}
