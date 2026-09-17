import { Fragment } from "react";
import { Section, btnGhost } from "./shared";

declare const __APP_VERSION__: string;
declare const __GIT_COMMIT__: string;
declare const __BUILD_TIME__: string;

export function AboutPage() {
  const rows: [string, string][] = [
    ["版本", `v${__APP_VERSION__}`],
    ["构建", `${__GIT_COMMIT__} · ${__BUILD_TIME__}`],
    ["来源", "qunqin24/Pulse 的 Windows 移植版（Apache-2.0）"],
    ["技术栈", "Tauri 2 · Rust · React 19"],
  ];
  return (
    <div className="space-y-5 max-w-2xl">
      <Section title="关于 Pulse for Windows" icon="ℹ️">
        <dl className="grid grid-cols-[6rem_1fr] gap-y-2 text-xs">
          {rows.map(([k, v]) => <Fragment key={k}><dt className="text-zinc-500">{k}</dt><dd className="text-zinc-200 font-mono break-all">{v}</dd></Fragment>)}
        </dl>
        <p className="text-[11px] text-zinc-400">
          功能语义对齐上游 macOS 版 Pulse；凭据存储、开机启动、通知与快捷键均采用 Windows 原生实现。
        </p>
      </Section>
      <Section title="更新" icon="⬆️" subtitle="自动更新尚未接入：需要签名密钥与发布通道，当前请手动获取新构建。"
        aside={<a className={btnGhost} href="https://github.com/qunqin24/Pulse" target="_blank" rel="noreferrer">上游项目</a>}>
        <div className="text-xs text-zinc-400">当前版本 v{__APP_VERSION__} · 更新状态：未启用自动检查</div>
      </Section>
      <Section title="开发者集成" icon="🧩" subtitle="供脚本与状态栏读取，不含任何凭据。">
        <pre className="bg-zinc-950 border border-white/5 rounded-xl px-3 py-2 text-[11px] font-mono text-zinc-300 select-text overflow-auto">pulse-windows.exe --json</pre>
        <p className="text-[11px] text-zinc-500">输出最近一次刷新的账号、服务商、套餐、各窗口用量与重置时间、读数来源与状态（JSON 数组）。</p>
      </Section>
    </div>
  );
}
