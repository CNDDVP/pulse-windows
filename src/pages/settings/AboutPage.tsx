import { UpdateCenter } from "./UpdateCenter";
import { Fragment, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Section } from "./shared";
import { btnGhost } from "./constants";

declare const __APP_VERSION__: string;
declare const __GIT_COMMIT__: string;
declare const __BUILD_TIME__: string;

interface ProfileInfo {
  profile_id: string;
  created_at: string;
  mode: string;
}

interface RuntimeInfo {
  version: string;
  commit: string;
  build_time: string;
  mode: string;
  data_dir: string;
  exe_path: string;
  exe_sha256: string;
  profile_id: string;
}

interface ProfileStatus {
  profile_id: string;
  mode: string;
  created_at: string;
  last_known_exe_path: string | null;
  current_exe_path: string | null;
  is_copy: boolean;
  is_moved: boolean;
}

function sanitizePath(raw: string): string {
  return raw
    .replace(/[a-zA-Z]:\\[^"\s,;]+/g, "[PATH]")
    .replace(/\/(Users|home|etc)\/[^"\s,;]+/g, "[PATH]");
}

export function AboutPage({hasDraft}: {hasDraft: () => boolean}) {
  const [profile, setProfile] = useState<ProfileInfo | null>(null);
  const [profileStatus, setProfileStatus] = useState<ProfileStatus | null>(null);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [msg, setMsg] = useState("");
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

  useEffect(() => {
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    };
  }, []);

  const refreshProfile = () => {
    invoke<ProfileInfo>("get_profile_info").then(setProfile).catch(() => {});
    invoke<ProfileStatus>("check_profile_status").then(setProfileStatus).catch(() => {});
    invoke<RuntimeInfo>("get_runtime_info").then(setRuntime).catch(() => {});
  };

  useEffect(() => {
    refreshProfile();
  }, []);

  const handleClearCreds = async () => {
    if (confirmArmed !== "clear_creds") {
      armConfirm("clear_creds");
      return;
    }
    disarmConfirm();
    try {
      await invoke("clear_profile_credentials");
      setMsg("已成功清除当前 Profile 关联的全部系统凭据。");
      refreshProfile();
    } catch (e) {
      setMsg(`清除失败: ${String(e)}`);
    }
  };

  const handleIsolateProfile = async () => {
    if (confirmArmed !== "isolate_profile") {
      armConfirm("isolate_profile");
      return;
    }
    disarmConfirm();
    try {
      const newId = await invoke<string>("create_isolated_profile");
      setMsg(`已生成新配置身份: ${newId.slice(0, 12)}...`);
      refreshProfile();
    } catch (e) {
      setMsg(`操作失败: ${String(e)}`);
    }
  };

  const handleImportInstalled = async () => {
    if (confirmArmed !== "import_installed") {
      armConfirm("import_installed");
      return;
    }
    disarmConfirm();
    try {
      const imported = await invoke<any>("import_installed_config");
      setMsg(`已成功从安装版导入 ${Object.keys(imported.providers || {}).length} 个账号与凭据！`);
      refreshProfile();
    } catch (e) {
      setMsg(`导入失败: ${String(e)}`);
    }
  };

  const handleCopyDiagnostics = async () => {
    try {
      const rawDiag = await invoke<string>("diagnostics");
      const sanitizedExe = runtime?.exe_path ? sanitizePath(runtime.exe_path) : "[PATH]";
      const sanitizedDir = runtime?.data_dir ? sanitizePath(runtime.data_dir) : "[PATH]";
      const text = [
        "=== Pulse 运行与诊断信息 ===",
        `版本: v${runtime?.version || __APP_VERSION__}`,
        `构建: ${runtime?.commit || __GIT_COMMIT__} · ${runtime?.build_time || __BUILD_TIME__}`,
        `部署模式: ${runtime?.mode || "unknown"}`,
        `配置身份: ${runtime?.profile_id || "unknown"}`,
        `程序 SHA256: ${runtime?.exe_sha256 || "unknown"}`,
        `数据目录: ${sanitizedDir}`,
        `程序路径: ${sanitizedExe}`,
        "",
        "=== 连接与读数诊断 ===",
        rawDiag,
      ].join("\n");
      await navigator.clipboard.writeText(text);
      setMsg("已复制脱敏诊断信息至剪贴板，可直接粘贴提交 Issue。");
    } catch (e) {
      setMsg(`复制失败: ${String(e)}`);
    }
  };

  const rows: [string, string][] = [
    ["版本", `v${runtime?.version || __APP_VERSION__}`],
    ["构建", `${runtime?.commit || __GIT_COMMIT__} · ${runtime?.build_time || __BUILD_TIME__}`],
    ["部署模式", profile?.mode === "portable" ? "便携版 (运行数据保存在 data/)" : profile?.mode === "custom_env" ? "自定义环境变量 (PULSE_DATA_DIR)" : "默认数据目录 (AppData；安装形态见更新方式)"],
    ["配置身份", profile ? `${profile.profile_id.slice(0, 16)}...` : "正在读取..."],
    ["程序 SHA256", runtime?.exe_sha256 ? `${runtime.exe_sha256.slice(0, 16)}...${runtime.exe_sha256.slice(-16)}` : "正在计算..."],
    ["数据目录", runtime?.data_dir || "正在读取..."],
    ["程序路径", runtime?.exe_path || "正在读取..."],
    ["开源仓库", "https://github.com/CNDDVP/pulse-windows"],
    ["技术栈", "Tauri 2 · Rust · React 19 · Tailwind CSS"],
  ];

  return (
    <div className="space-y-5 max-w-2xl">
      <Section
        title="关于 Pulse for Windows"
        icon="ℹ️"
        aside={<button className={btnGhost} onClick={() => void handleCopyDiagnostics()}>📋 复制脱敏诊断</button>}
      >
        <dl className="grid grid-cols-[6.5rem_1fr] gap-y-2 text-xs">
          {rows.map(([k, v]) => (
            <Fragment key={k}>
              <dt className="text-zinc-500">{k}</dt>
              <dd className="text-zinc-200 font-mono break-all">{v}</dd>
            </Fragment>
          ))}
        </dl>
        <p className="text-[11px] text-zinc-400">
          功能语义对齐上游 macOS 版 Pulse；凭据存储、开机启动、通知与快捷键均采用 Windows 原生实现。
        </p>
      </Section>

      <Section title="配置与凭据隔离" icon="🛡️" subtitle="便携版与安装版凭据独立托管于系统凭据管理器。">
        {profileStatus?.is_copy && (
          <div className="p-3 bg-amber-950/40 border border-amber-500/30 rounded-xl text-amber-200 text-xs flex items-start gap-2.5 mb-3">
            <span className="text-base leading-none">⚠️</span>
            <div className="flex-1 space-y-1">
              <div className="font-medium text-amber-300">检测到便携目录已被复制（当前共享配置）</div>
              <div className="text-[11px] text-amber-200/80 leading-relaxed">
                当前便携程序运行于新路径，但原程序路径仍存在。两份程序目前共享相同的配置身份与 Windows 凭据，可能导致数据相互覆盖。
              </div>
              <div className="pt-1">
                <button
                  className="px-2.5 py-1 bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 border border-amber-500/40 rounded-lg text-xs font-medium transition cursor-pointer"
                  onClick={() => void handleIsolateProfile()}
                >
                  {confirmArmed === "isolate_profile" ? "再次点击以确认分离" : "一键创建独立配置副本"}
                </button>
              </div>
            </div>
          </div>
        )}
        <div className="flex flex-wrap gap-3">
          {profile?.mode === "portable" && (
            <button
              className={confirmArmed === "import_installed" ? "px-3 py-1.5 bg-emerald-950/50 text-emerald-300 border border-emerald-900/60 rounded-xl text-xs font-medium transition-all cursor-pointer" : btnGhost}
              onClick={() => void handleImportInstalled()}
            >
              {confirmArmed === "import_installed" ? "再次点击以确认从安装版导入" : "从本机安装版导入配置与凭据"}
            </button>
          )}
          <button
            className={confirmArmed === "clear_creds" ? "px-3 py-1.5 bg-red-950/50 text-red-300 border border-red-900/60 rounded-xl text-xs font-medium transition-all cursor-pointer" : btnGhost}
            onClick={() => void handleClearCreds()}
          >
            {confirmArmed === "clear_creds" ? "再次点击以确认清除凭据" : "清理本机关联凭据"}
          </button>
          <button
            className={confirmArmed === "isolate_profile" ? "px-3 py-1.5 bg-amber-950/50 text-amber-300 border border-amber-900/60 rounded-xl text-xs font-medium transition-all cursor-pointer" : btnGhost}
            onClick={() => void handleIsolateProfile()}
          >
            {confirmArmed === "isolate_profile" ? "再次点击以确认重新生成身份" : "重新生成独立配置身份"}
          </button>
        </div>
        {msg && <p className="text-xs text-emerald-400 mt-2">{msg}</p>}
      </Section>

      <Section title="更新与开源" icon="⬆️" subtitle="本项目遵循 Apache-2.0 许可证公开开源。"
        aside={
          <div className="flex gap-2">
            <a className={btnGhost} href="https://github.com/CNDDVP/pulse-windows" target="_blank" rel="noreferrer" onClick={e => { e.preventDefault(); void invoke("open_external_url", { url: "https://github.com/CNDDVP/pulse-windows" }).catch(console.error); }}>GitHub 仓库</a>
            <a className={btnGhost} href="https://github.com/qunqin24/Pulse" target="_blank" rel="noreferrer" onClick={e => { e.preventDefault(); void invoke("open_external_url", { url: "https://github.com/qunqin24/Pulse" }).catch(console.error); }}>上游项目</a>
          </div>
        }>
        <UpdateCenter hasDraft={hasDraft} />
        <div className="text-xs text-zinc-400">当前版本 v{runtime?.version || __APP_VERSION__} · 遵循零遥测、零数据回传隐私承诺</div>
      </Section>

      <Section title="开发者集成" icon="🧩" subtitle="供脚本与状态栏读取，不含任何凭据。">
        <pre className="bg-zinc-950 border border-white/5 rounded-xl px-3 py-2 text-[11px] font-mono text-zinc-300 select-text overflow-auto">pulse-windows.exe --json</pre>
        <p className="text-[11px] text-zinc-500">输出最近一次刷新的账号、服务商、套餐、各窗口用量与重置时间、读数来源与状态（JSON 数组）。</p>
      </Section>
    </div>
  );
}
