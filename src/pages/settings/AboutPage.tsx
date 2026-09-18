import { Fragment, useEffect, useState } from "react";
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

export function AboutPage() {
  const [profile, setProfile] = useState<ProfileInfo | null>(null);
  const [msg, setMsg] = useState("");

  const refreshProfile = () => {
    invoke<ProfileInfo>("get_profile_info").then(setProfile).catch(() => {});
  };

  useEffect(() => {
    refreshProfile();
  }, []);

  const handleClearCreds = async () => {
    if (!window.confirm("确定要清除当前 Profile 在 Windows 凭据管理器中保存的全部凭据吗？")) return;
    try {
      await invoke("clear_profile_credentials");
      setMsg("已成功清除当前 Profile 关联的全部系统凭据。");
      refreshProfile();
    } catch (e) {
      setMsg(`清除失败: ${String(e)}`);
    }
  };

  const handleIsolateProfile = async () => {
    if (!window.confirm("确定要为当前数据目录重新生成独立的 Profile ID 吗？（此操作可用于克隆后的便携副本，使其拥有独立凭据空间）")) return;
    try {
      const newId = await invoke<string>("create_isolated_profile");
      setMsg(`已生成新配置身份: ${newId.slice(0, 12)}...`);
      refreshProfile();
    } catch (e) {
      setMsg(`操作失败: ${String(e)}`);
    }
  };

  const rows: [string, string][] = [
    ["版本", `v${__APP_VERSION__}`],
    ["构建", `${__GIT_COMMIT__} · ${__BUILD_TIME__}`],
    ["部署模式", profile?.mode === "portable" ? "便携版 (运行数据保存在 data/)" : profile?.mode === "custom_env" ? "自定义环境变量 (PULSE_DATA_DIR)" : "标准安装版 (数据保存在 AppData)"],
    ["配置身份", profile ? `${profile.profile_id.slice(0, 16)}...` : "正在读取..."],
    ["开源仓库", "https://github.com/CNDDVP/pulse-windows"],
    ["技术栈", "Tauri 2 · Rust · React 19 · Tailwind CSS"],
  ];

  return (
    <div className="space-y-5 max-w-2xl">
      <Section title="关于 Pulse for Windows" icon="ℹ️">
        <dl className="grid grid-cols-[6rem_1fr] gap-y-2 text-xs">
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
        <div className="flex flex-wrap gap-3">
          <button className={btnGhost} onClick={() => void handleClearCreds()}>
            清理本机关联凭据
          </button>
          <button className={btnGhost} onClick={() => void handleIsolateProfile()}>
            重新生成独立配置身份
          </button>
        </div>
        {msg && <p className="text-xs text-emerald-400 mt-2">{msg}</p>}
      </Section>

      <Section title="更新与开源" icon="⬆️" subtitle="本项目遵循 Apache-2.0 许可证公开开源。"
        aside={<a className={btnGhost} href="https://github.com/qunqin24/Pulse" target="_blank" rel="noreferrer">上游项目</a>}>
        <div className="text-xs text-zinc-400">当前版本 v{__APP_VERSION__} · 遵循零遥测、零数据回传隐私承诺</div>
      </Section>

      <Section title="开发者集成" icon="🧩" subtitle="供脚本与状态栏读取，不含任何凭据。">
        <pre className="bg-zinc-950 border border-white/5 rounded-xl px-3 py-2 text-[11px] font-mono text-zinc-300 select-text overflow-auto">pulse-windows.exe --json</pre>
        <p className="text-[11px] text-zinc-500">输出最近一次刷新的账号、服务商、套餐、各窗口用量与重置时间、读数来源与状态（JSON 数组）。</p>
      </Section>
    </div>
  );
}
