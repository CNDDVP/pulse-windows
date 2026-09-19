import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppSettings, MonitorOption, ProviderUsage } from "../../types";
import { Section, Row, Field, Switch } from "./shared";
import { selectCls, btnGhost, timeText } from "./constants";

export function GeneralPage({ settings, update, screens, usages, busy, onRefreshAll, toast }: {
  settings: AppSettings; update: (patch: Partial<AppSettings>) => void; screens: MonitorOption[];
  usages: ProviderUsage[]; busy: boolean; onRefreshAll: () => Promise<void>;
  toast: (type: "success" | "info" | "error", text: string) => void;
}) {
  const [startup, setStartup] = useState<boolean | null>(null);
  const [isPortable, setIsPortable] = useState(false);
  useEffect(() => { void invoke<boolean>("startup_enabled").then(setStartup).catch(() => setStartup(null)); }, []);
  useEffect(() => { void invoke<boolean>("is_portable").then(setIsPortable).catch(() => {}); }, []);
  const lastSuccess = usages.map(u => u.last_success_at).filter((s): s is string => !!s).sort().at(-1) ?? null;

  return (
    <div className="space-y-5 max-w-2xl">
      <Section title="悬浮栏" icon="🖥️" subtitle="修改即保存，立即生效。">
        <Row title="显示悬浮栏" subtitle="关闭后 Pulse 仍在托盘运行并继续刷新。">
          <Switch checked={settings.show_rail} onChange={v => update({ show_rail: v })} label="显示悬浮栏" />
        </Row>
        <Row title="跟随当前活动显示器" subtitle="鼠标在哪块屏，悬浮栏就贴到哪块屏。">
          <Switch checked={settings.follow_active_display} onChange={v => update({ follow_active_display: v, ...(v ? { monitor_name: null } : {}) })} label="跟随当前活动显示器" />
        </Row>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="固定显示器" hint={settings.follow_active_display ? "已跟随活动显示器，此项不生效" : undefined}>
            <select className={selectCls} disabled={settings.follow_active_display} value={settings.monitor_name || ""} onChange={e => update({ monitor_name: e.target.value || null })}>
              <option value="">自动（当前显示器）</option>
              {screens.map(m => <option key={m.name} value={m.name}>{m.label}</option>)}
              {settings.monitor_name && !screens.some(m => m.name === settings.monitor_name) && <option value={settings.monitor_name}>{settings.monitor_name}（当前未连接）</option>}
            </select>
          </Field>
          <Field label="贴靠位置">
            <select className={selectCls} value={settings.dock_side} onChange={e => update({ dock_side: e.target.value as AppSettings["dock_side"] })}>
              <option value="right">屏幕右侧</option><option value="left">屏幕左侧</option><option value="top">屏幕顶部</option><option value="free">自由浮动</option>
            </select>
          </Field>
        </div>
        {settings.dock_side === "free" && (
          <div className="pt-2 border-t border-white/5 grid grid-cols-2 gap-4">
            {(["free_x", "free_y"] as const).map(k => (
              <label key={k} className="block space-y-1">
                <div className="flex justify-between text-xs text-zinc-400"><span>{k === "free_x" ? "横向位置" : "纵向位置"}</span><span className="font-mono">{Math.round(settings[k] * 100)}%</span></div>
                <input type="range" min={0} max={1} step={0.01} value={settings[k]} aria-label={k === "free_x" ? "横向位置" : "纵向位置"} onChange={e => update({ [k]: Number(e.target.value) } as Partial<AppSettings>)} className="w-full accent-emerald-500" />
              </label>
            ))}
          </div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2 border-t border-white/5">
          <Field label="鼠标移开后自动折叠" hint={settings.dock_side === "free" ? "自由浮动模式下不会自动折叠。" : "折叠后只留一条 4px 的边缘细线，与悬浮栏等高。"}>
            <select disabled={settings.dock_side === "free"} className={selectCls} value={settings.auto_collapse_seconds} onChange={e => update({ auto_collapse_seconds: Number(e.target.value) })}>
              <option value={0}>不折叠</option><option value={1}>1 秒</option><option value={2}>2 秒</option><option value={3}>3 秒</option><option value={5}>5 秒</option><option value={10}>10 秒</option>
            </select>
          </Field>
          <Row title="全屏应用运行时隐藏" subtitle="前台全屏游戏或视频时自动隐藏。">
            <Switch checked={settings.hide_fullscreen} onChange={v => update({ hide_fullscreen: v })} label="全屏应用运行时隐藏" />
          </Row>
        </div>
      </Section>

      <Section title="外观与指标" icon="🎨">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="主题">
            <select className={selectCls} value={settings.theme} onChange={e => update({ theme: e.target.value as AppSettings["theme"] })}>
              <option value="obsidian">暗夜黑 (Obsidian)</option><option value="translucent">半透明磨砂 (Translucent)</option>
            </select>
          </Field>
          <Field label="百分比含义">
            <select className={selectCls} value={settings.display_mode} onChange={e => update({ display_mode: e.target.value as AppSettings["display_mode"] })}>
              <option value="used">已使用（如 20% 已用）</option><option value="remaining">剩余（如 80% 剩余）</option>
            </select>
          </Field>
          <Field label="变红阈值" hint="只改变琥珀→红的视觉分界；服务商报告耗尽时始终为红。">
            <select className={selectCls} value={settings.warning_threshold} onChange={e => update({ warning_threshold: Number(e.target.value) })}>
              {[60, 70, 75, 80, 85, 90, 95].map(v => <option key={v} value={v}>{v}% 时变红</option>)}
            </select>
          </Field>
        </div>
        <div className="pt-2 border-t border-white/5 space-y-3">
          <Row title="显示额度周期已过时间（外圈细线）" subtitle="外圈表示所选周期已流逝的比例，可与用量对比；每个账号可在其页面选择跟随的周期。">
            <Switch checked={settings.show_elapsed} onChange={v => update({ show_elapsed: v })} label="显示额度周期已过时间" />
          </Row>
          <Row title="显示耗尽预测" subtitle="按周期平均速度估算是否会在重置前用满。">
            <Switch checked={settings.forecast} onChange={v => update({ forecast: v })} label="显示耗尽预测" />
          </Row>
          <Row title="减少动态效果" subtitle="动画机器人等连续动画改为静态表情；系统开启“减少动态”时同样生效。">
            <Switch checked={settings.reduce_motion} onChange={v => update({ reduce_motion: v })} label="减少动态效果" />
          </Row>
        </div>
      </Section>

      <Section title="刷新" icon="⚡" aside={<button className={btnGhost} disabled={busy} onClick={() => void onRefreshAll().catch(e => toast("error", `刷新失败: ${String(e)}`))}>立即刷新全部</button>}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="自动刷新间隔" hint="读取失败时按退避自动拉长；服务商返回 Retry-After 时以其为准。">
            <select className={selectCls} value={settings.refresh_interval_seconds} onChange={e => update({ refresh_interval_seconds: Number(e.target.value) })}>
              {[[30, "30 秒"], [60, "1 分钟"], [120, "2 分钟"], [300, "5 分钟"], [600, "10 分钟"], [900, "15 分钟"], [1800, "30 分钟"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              {![30, 60, 120, 300, 600, 900, 1800].includes(settings.refresh_interval_seconds) && <option value={settings.refresh_interval_seconds}>{settings.refresh_interval_seconds} 秒</option>}
            </select>
          </Field>
          <Field label="上次成功刷新">
            <div className={`${selectCls} font-mono`}>{lastSuccess ? timeText(lastSuccess) : "尚无成功读数"}</div>
          </Field>
        </div>
      </Section>

      <Section title="启动" icon="🚀">
        <Row
          title="登录 Windows 时启动 Pulse"
          subtitle={isPortable ? "便携版开机自启将指向当前 EXE 路径；移动文件夹后首次手动运行将自动修复路径。" : startup === null ? "无法读取系统启动项状态" : "写入当前用户的注册表 Run 项，状态直接读自系统。"}
          disabled={startup === null}
        >
          <Switch
            checked={!!startup}
            disabled={startup === null}
            label="登录 Windows 时启动 Pulse"
            onChange={v => void invoke<boolean>("set_startup", { enable: v }).then(s => { setStartup(s); toast("success", s ? "已加入开机启动" : "已移除开机启动"); }).catch(e => toast("error", String(e)))}
          />
        </Row>
        <Field label="启动后">
          <select className={selectCls} value={settings.start_behavior} onChange={e => update({ start_behavior: e.target.value })}>
            <option value="rail">显示悬浮栏</option><option value="settings">打开设置</option><option value="tray">仅驻留托盘（悬浮栏隐藏）</option>
          </select>
        </Field>
      </Section>
    </div>
  );
}
