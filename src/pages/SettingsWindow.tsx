import React, { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppSettings } from "../types";
import { ProviderIcon } from "../components/icons/ProviderIcons";
import { Check, Settings, Layers, RefreshCw } from "lucide-react";

interface SettingsWindowProps {
  initialSettings: AppSettings;
  onSaved: (newSettings: AppSettings) => void;
}

export const SettingsWindow: React.FC<SettingsWindowProps> = ({
  initialSettings,
  onSaved,
}) => {
  const [activeTab, setActiveTab] = useState<"general" | "providers">("general");
  const [settings, setSettings] = useState<AppSettings>(initialSettings);
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, string>>({});

  const handleSave = async () => {
    try {
      await invoke("update_settings", { newSettings: settings });
      onSaved(settings);
      setSavedSuccess(true);
      setTimeout(() => setSavedSuccess(false), 2000);
    } catch (e) {
      console.error(e);
    }
  };

  const toggleProvider = (id: string) => {
    setSettings((prev) => {
      const p = prev.providers[id] || { enabled: false, order: 99 };
      return {
        ...prev,
        providers: {
          ...prev.providers,
          [id]: { ...p, enabled: !p.enabled },
        },
      };
    });
  };

  const updateApiKey = (id: string, key: string) => {
    setSettings((prev) => {
      const p = prev.providers[id] || { enabled: true, order: 99 };
      return {
        ...prev,
        providers: {
          ...prev.providers,
          [id]: { ...p, api_key: key },
        },
      };
    });
  };

  const testProvider = async (id: string) => {
    setTestingId(id);
    try {
      await invoke("refresh_usages");
      setTestResult((prev) => ({ ...prev, [id]: "连接正常" }));
    } catch (e) {
      setTestResult((prev) => ({ ...prev, [id]: `错误: ${e}` }));
    } finally {
      setTestingId(null);
    }
  };

  const providerList = [
    { id: "antigravity", name: "Google Antigravity", desc: "自动探测本地 language_server.exe，免配密钥" },
    { id: "cursor", name: "Cursor", desc: "自动提取本地 SQLite 登录凭据，免密直连" },
    { id: "codex", name: "Codex / ChatGPT", desc: "自动读取 ~/.codex/auth.json 凭据" },
    { id: "claude", name: "Claude Code", desc: "自动读取 ~/.claude 或填入 OAuth Token", hasKey: true },
    { id: "kimi", name: "Kimi Code", desc: "Moonshot / Kimi 余额监控", hasKey: true },
    { id: "deepseek", name: "DeepSeek", desc: "DeepSeek 账户余额与用量", hasKey: true },
    { id: "copilot", name: "GitHub Copilot", desc: "检测本机 GitHub Copilot 凭据" },
    { id: "grok", name: "Grok / xAI", desc: "xAI 配额监控", hasKey: true },
    { id: "minimax", name: "MiniMax", desc: "MiniMax 账户余额", hasKey: true },
    { id: "devin", name: "Devin", desc: "Cognition Devin 配额", hasKey: true },
    { id: "opencode", name: "OpenCode Go", desc: "OpenCode 会话与额度", hasKey: true },
  ];

  return (
    <div className="w-screen h-screen flex flex-col bg-[#16161a] text-zinc-100 font-sans select-text">
      {/* Top Header */}
      <div className="h-14 border-b border-zinc-800 flex items-center justify-between px-6 bg-[#1a1a1f]">
        <div className="flex items-center space-x-3">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-emerald-400 to-teal-600 flex items-center justify-center font-bold text-zinc-950 shadow-md">
            P
          </div>
          <div>
            <h1 className="font-bold text-[15px] leading-tight">Pulse for Windows</h1>
            <p className="text-[11px] text-zinc-400">AI 编码配额与速率限制监视器</p>
          </div>
        </div>

        <button
          onClick={handleSave}
          className={`flex items-center space-x-1.5 px-4 py-1.5 rounded-lg text-[13px] font-semibold transition-all ${
            savedSuccess
              ? "bg-emerald-500 text-zinc-950"
              : "bg-zinc-100 text-zinc-900 hover:bg-white active:scale-95"
          }`}
        >
          {savedSuccess ? <Check size={16} /> : null}
          <span>{savedSuccess ? "已保存" : "保存设置"}</span>
        </button>
      </div>

      {/* Main Body with Sidebar */}
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar */}
        <div className="w-48 border-r border-zinc-800 p-3 space-y-1 bg-[#141417]">
          <button
            onClick={() => setActiveTab("general")}
            className={`w-full flex items-center space-x-2.5 px-3 py-2 rounded-xl text-[13px] font-medium transition-colors ${
              activeTab === "general"
                ? "bg-zinc-800/80 text-white font-semibold"
                : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40"
            }`}
          >
            <Settings size={16} />
            <span>通用设置</span>
          </button>
          <button
            onClick={() => setActiveTab("providers")}
            className={`w-full flex items-center space-x-2.5 px-3 py-2 rounded-xl text-[13px] font-medium transition-colors ${
              activeTab === "providers"
                ? "bg-zinc-800/80 text-white font-semibold"
                : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40"
            }`}
          >
            <Layers size={16} />
            <span>平台与密钥</span>
          </button>
        </div>

        {/* Tab Content */}
        <div className="flex-1 p-6 overflow-y-auto space-y-6">
          {activeTab === "general" ? (
            <div className="space-y-6 max-w-xl">
              {/* Dock Side */}
              <div className="bg-[#1f1f25] p-4 rounded-2xl border border-zinc-800/60 space-y-3">
                <label className="block text-[13px] font-semibold text-zinc-200">
                  屏幕贴靠位置
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => setSettings((s) => ({ ...s, dock_side: "right" }))}
                    className={`py-2 px-4 rounded-xl text-[13px] font-medium border transition-all ${
                      settings.dock_side === "right"
                        ? "border-emerald-500 bg-emerald-500/10 text-emerald-300"
                        : "border-zinc-700/60 bg-zinc-800/40 text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    屏幕右边缘 (推荐)
                  </button>
                  <button
                    onClick={() => setSettings((s) => ({ ...s, dock_side: "left" }))}
                    className={`py-2 px-4 rounded-xl text-[13px] font-medium border transition-all ${
                      settings.dock_side === "left"
                        ? "border-emerald-500 bg-emerald-500/10 text-emerald-300"
                        : "border-zinc-700/60 bg-zinc-800/40 text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    屏幕左边缘
                  </button>
                </div>
              </div>

              {/* Theme */}
              <div className="bg-[#1f1f25] p-4 rounded-2xl border border-zinc-800/60 space-y-3">
                <label className="block text-[13px] font-semibold text-zinc-200">
                  外观主题
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => setSettings((s) => ({ ...s, theme: "obsidian" }))}
                    className={`py-2 px-4 rounded-xl text-[13px] font-medium border transition-all ${
                      settings.theme === "obsidian"
                        ? "border-emerald-500 bg-emerald-500/10 text-emerald-300"
                        : "border-zinc-700/60 bg-zinc-800/40 text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    黑曜石深色 (Obsidian)
                  </button>
                  <button
                    onClick={() => setSettings((s) => ({ ...s, theme: "translucent" }))}
                    className={`py-2 px-4 rounded-xl text-[13px] font-medium border transition-all ${
                      settings.theme === "translucent"
                        ? "border-emerald-500 bg-emerald-500/10 text-emerald-300"
                        : "border-zinc-700/60 bg-zinc-800/40 text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    冰晶浅色 (Translucent)
                  </button>
                </div>
              </div>

              {/* Auto collapse delay */}
              <div className="bg-[#1f1f25] p-4 rounded-2xl border border-zinc-800/60 space-y-3">
                <div className="flex justify-between items-center">
                  <label className="text-[13px] font-semibold text-zinc-200">
                    闲时自动折叠延时
                  </label>
                  <span className="text-[12px] text-emerald-400 font-mono">
                    {settings.auto_collapse_seconds === 0 ? "从不折叠" : `${settings.auto_collapse_seconds} 秒`}
                  </span>
                </div>
                <div className="grid grid-cols-4 gap-2">
                  {[2, 3, 5, 0].map((sec) => (
                    <button
                      key={sec}
                      onClick={() => setSettings((s) => ({ ...s, auto_collapse_seconds: sec }))}
                      className={`py-1.5 rounded-lg text-[12px] font-medium border transition-all ${
                        settings.auto_collapse_seconds === sec
                          ? "border-emerald-500 bg-emerald-500/10 text-emerald-300"
                          : "border-zinc-700/60 bg-zinc-800/40 text-zinc-400 hover:text-zinc-200"
                      }`}
                    >
                      {sec === 0 ? "从不" : `${sec}秒`}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-4 max-w-2xl">
              <p className="text-[12px] text-zinc-400 mb-2">
                勾选需要常驻监控的平台。针对需要 API Key 的服务，直接输入密钥即可。
              </p>

              {providerList.map((p) => {
                const config = settings.providers[p.id] || { enabled: false, order: 99 };
                const isEnabled = config.enabled;

                return (
                  <div
                    key={p.id}
                    className={`p-4 rounded-2xl border transition-all ${
                      isEnabled
                        ? "bg-[#1f1f25] border-zinc-700/80 shadow-sm"
                        : "bg-[#18181c] border-zinc-800/40 opacity-70"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-3">
                        <div className="w-8 h-8 rounded-full bg-zinc-800 flex items-center justify-center text-zinc-200">
                          <ProviderIcon id={p.id} size={18} />
                        </div>
                        <div>
                          <div className="flex items-center space-x-2">
                            <span className="font-semibold text-[14px]">{p.name}</span>
                            {testResult[p.id] && (
                              <span className="text-[11px] text-emerald-400 font-medium">
                                {testResult[p.id]}
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] text-zinc-400">{p.desc}</p>
                        </div>
                      </div>

                      <div className="flex items-center space-x-2">
                        {isEnabled && (
                          <button
                            onClick={() => testProvider(p.id)}
                            disabled={testingId === p.id}
                            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
                            title="测试刷新"
                          >
                            <RefreshCw size={14} className={testingId === p.id ? "animate-spin text-emerald-400" : ""} />
                          </button>
                        )}
                        <input
                          type="checkbox"
                          checked={isEnabled}
                          onChange={() => toggleProvider(p.id)}
                          className="w-5 h-5 accent-emerald-500 rounded cursor-pointer"
                        />
                      </div>
                    </div>

                    {/* API Key Input if required */}
                    {isEnabled && p.hasKey && (
                      <div className="mt-3 pt-3 border-t border-zinc-800/60">
                        <label className="block text-[11px] text-zinc-400 mb-1">
                          API Key / Access Token
                        </label>
                        <input
                          type="password"
                          value={config.api_key || ""}
                          onChange={(e) => updateApiKey(p.id, e.target.value)}
                          placeholder="sk-..."
                          className="w-full bg-zinc-900 border border-zinc-700/60 rounded-xl px-3 py-1.5 text-[12px] font-mono text-zinc-200 focus:outline-none focus:border-emerald-500"
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
