import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppSettings, MonitorOption, ProviderUsage, ProxyDetection, NetworkTestResult } from "../../types";
import { Section, Row, Field, Switch } from "./shared";
import { selectCls, inputCls, btnGhost, timeText, PROVIDERS } from "./constants";

export function GeneralPage({ settings, update, screens, usages, busy, onRefreshAll, toast }: {
  settings: AppSettings; update: (patch: Partial<AppSettings>) => void; screens: MonitorOption[];
  usages: ProviderUsage[]; busy: boolean; onRefreshAll: () => Promise<void>;
  toast: (type: "success" | "info" | "error", text: string) => void;
}) {
  const [startup, setStartup] = useState<boolean | null>(null);
  const [isPortable, setIsPortable] = useState(false);
  const [proxyInfo, setProxyInfo] = useState<ProxyDetection | null>(null);
  const [testingProxy, setTestingProxy] = useState(false);
  const [testResult, setTestResult] = useState<NetworkTestResult | null>(null);

  const fetchProxyInfo = () => {
    void invoke<ProxyDetection>("detect_network_proxy").then(setProxyInfo).catch(() => setProxyInfo(null));
  };
  useEffect(() => { fetchProxyInfo(); }, [settings.network_proxy]);

  const handleTestProxy = async () => {
    setTestingProxy(true);
    setTestResult(null);
    try {
      const res = await invoke<NetworkTestResult>("test_network_connection", { target: null });
      setTestResult(res);
      if (res.ok) {
        toast("success", `连接成功 (${res.duration_ms}ms)`);
      } else {
        toast("error", `连接测试失败: ${res.error || "未知错误"}`);
      }
    } catch (e) {
      toast("error", `测试失败: ${String(e)}`);
    } finally {
      setTestingProxy(false);
    }
  };

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
          <Field label="鼠标移开后自动折叠" hint={settings.dock_side === "free" ? "自由浮动模式下不会自动折叠。" : "折叠后贴边收缩为呼吸细线，悬停展开。"}>
            <select disabled={settings.dock_side === "free"} className={selectCls} value={settings.auto_collapse_seconds} onChange={e => update({ auto_collapse_seconds: Number(e.target.value) })}>
              <option value={0}>不折叠</option><option value={1}>1 秒</option><option value={2}>2 秒</option><option value={3}>3 秒</option><option value={5}>5 秒</option><option value={10}>10 秒</option>
            </select>
          </Field>
          <Row title="全屏应用运行时隐藏" subtitle="前台全屏游戏或视频时自动隐藏。">
            <Switch checked={settings.hide_fullscreen} onChange={v => update({ hide_fullscreen: v })} label="全屏应用运行时隐藏" />
          </Row>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2 border-t border-white/5">
          <Field label="收纳条颜色模式" hint="自定义折叠贴边细线的发光与颜色。">
            <select
              className={selectCls}
              value={settings.collapsed_bar_color_mode || "auto"}
              onChange={e => update({ collapsed_bar_color_mode: e.target.value as "auto" | "rainbow" | "custom" })}
            >
              <option value="auto">自动（按额度健康度：绿/黄/红）</option>
              <option value="rainbow">🌈 炫彩幻光（五颜六色自动缓慢循环）</option>
              <option value="custom">🎨 自定义颜色</option>
            </select>
          </Field>
          {settings.collapsed_bar_color_mode === "custom" && (
            <Field label="自定义颜色" hint="支持选择预设或输入 Hex 颜色代码。">
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={settings.collapsed_bar_color || "#7AA5FF"}
                  onChange={e => update({ collapsed_bar_color: e.target.value })}
                  className="w-8 h-8 rounded-lg cursor-pointer border border-zinc-700 bg-transparent shrink-0"
                  aria-label="选择颜色"
                />
                <input
                  type="text"
                  value={settings.collapsed_bar_color || "#7AA5FF"}
                  onChange={e => update({ collapsed_bar_color: e.target.value })}
                  className={`${inputCls} font-mono uppercase w-24`}
                  placeholder="#7AA5FF"
                  maxLength={7}
                  aria-label="十六进制颜色代码"
                />
                <div className="flex items-center gap-1.5 shrink-0 ml-auto">
                  {[
                    { color: "#7AA5FF", title: "Kimi 蓝" },
                    { color: "#10B981", title: "翡翠绿" },
                    { color: "#8B5CF6", title: "极光紫" },
                    { color: "#EC4899", title: "樱花粉" },
                    { color: "#F97316", title: "活力橙" },
                    { color: "#38BDF8", title: "冰川蓝" },
                  ].map(p => (
                    <button
                      key={p.color}
                      type="button"
                      onClick={() => update({ collapsed_bar_color: p.color })}
                      style={{ backgroundColor: p.color }}
                      title={p.title}
                      className={`w-5 h-5 rounded-full border border-white/20 transition-transform cursor-pointer ${
                        settings.collapsed_bar_color === p.color ? "scale-125 ring-2 ring-white" : "hover:scale-110"
                      }`}
                      aria-label={`选择${p.title}`}
                    />
                  ))}
                </div>
              </div>
            </Field>
          )}
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
          <Row title="显示时间外环（所有账号）" subtitle="在主圆环外侧显示白色细线，表示所选周期已流逝的比例（不代表额度使用率）；每个账号可在其设置页指定跟随的周期。">
            <Switch checked={settings.show_elapsed} onChange={v => update({ show_elapsed: v })} label="显示时间外环（所有账号）" />
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

      <Section title="监控授权与数据隐私" icon="🛡️" subtitle="零云端上传、零遥测。未授权的服务商不会进行任何网络连接与本地日志监控。">
        <Row title="Token 消耗统计" subtitle="启用本地 Token 消耗扫描与历史记录分析。">
          <Switch checked={settings.token_spend_enabled} onChange={v => update({ token_spend_enabled: v })} label="Token 消耗统计" />
        </Row>
        <div className="pt-2 border-t border-white/5 space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-xs text-zinc-300 font-medium">已授权服务商 ({settings.authorized_providers?.length || 0} / {PROVIDERS.length})</div>
            <div className="flex items-center gap-2">
              <button
                className="text-[11px] text-emerald-400 hover:text-emerald-300 cursor-pointer"
                onClick={() => update({ authorized_providers: PROVIDERS.map(p => p[0]) })}
              >
                全选
              </button>
              <span className="text-zinc-600">·</span>
              <button
                className="text-[11px] text-emerald-400 hover:text-emerald-300 cursor-pointer"
                onClick={() => update({ authorized_providers: ["claude", "codex", "antigravity", "kimi"] })}
              >
                常用
              </button>
              <span className="text-zinc-600">·</span>
              <button
                className="text-[11px] text-zinc-400 hover:text-zinc-300 cursor-pointer"
                onClick={() => update({ authorized_providers: [] })}
              >
                取消全部
              </button>
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-48 overflow-y-auto p-1 bg-zinc-950/40 rounded-xl border border-white/5">
            {PROVIDERS.map(([pid, name]) => {
              const checked = settings.authorized_providers?.includes(pid) ?? false;
              return (
                <label key={pid} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-white/5 cursor-pointer text-xs text-zinc-300">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={e => {
                      const cur = new Set(settings.authorized_providers || []);
                      if (e.target.checked) cur.add(pid);
                      else cur.delete(pid);
                      update({ authorized_providers: Array.from(cur) });
                    }}
                    className="accent-emerald-500 rounded"
                  />
                  <span className="truncate">{name}</span>
                </label>
              );
            })}
          </div>
        </div>
      </Section>

      <Section title="网络代理" icon="🌐" subtitle="配置请求各服务商 Quota API 时使用的网络代理。Antigravity 本地服务始终走回环直连。">
        <Row title="代理模式" subtitle="支持自动跟随系统/环境变量、手动 HTTP/HTTPS 或手动 SOCKS5 代理。">
          <select
            className={selectCls}
            value={settings.network_proxy?.mode || "auto"}
            onChange={e => update({
              network_proxy: {
                ...(settings.network_proxy || { host: "127.0.0.1", port: 7890 }),
                mode: e.target.value as "auto" | "manual_http" | "manual_socks5"
              }
            })}
          >
            <option value="auto">自动探测（系统代理 / 环境变量）</option>
            <option value="manual_http">手动 HTTP / HTTPS 代理</option>
            <option value="manual_socks5">手动 SOCKS5 代理</option>
          </select>
        </Row>
        {settings.network_proxy?.mode !== "auto" && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2 border-t border-white/5">
            <div className="sm:col-span-2">
              <Field label="代理主机 (Host)">
                <input
                  type="text"
                  className={selectCls}
                  placeholder="127.0.0.1"
                  value={settings.network_proxy?.host || ""}
                  onChange={e => update({
                    network_proxy: {
                      ...(settings.network_proxy || { mode: "manual_http", port: 7890 }),
                      host: e.target.value.trim()
                    }
                  })}
                />
              </Field>
            </div>
            <div>
              <Field label="端口 (Port)">
                <input
                  type="number"
                  min={1}
                  max={65535}
                  className={selectCls}
                  placeholder="7890"
                  value={settings.network_proxy?.port || 7890}
                  onChange={e => update({
                    network_proxy: {
                      ...(settings.network_proxy || { mode: "manual_http", host: "127.0.0.1" }),
                      port: Math.max(1, Math.min(65535, parseInt(e.target.value) || 7890))
                    }
                  })}
                />
              </Field>
            </div>
          </div>
        )}
        <div className="pt-2 border-t border-white/5 space-y-2">
          <div className="flex items-center justify-between p-2.5 rounded-xl bg-zinc-950/60 border border-white/5 text-xs">
            <div className="space-y-0.5">
              <span className="text-zinc-400">检测结果：</span>
              <span className="text-zinc-200 font-mono font-medium ml-1">{proxyInfo?.detail || "正在检测…"}</span>
            </div>
            <div className="flex gap-2 shrink-0">
              <button className={btnGhost} onClick={fetchProxyInfo}>重新检测</button>
              <button className={btnGhost} disabled={testingProxy} onClick={() => void handleTestProxy()}>
                {testingProxy ? "测试中…" : "检测连接"}
              </button>
            </div>
          </div>
          {testResult && (
            <div className={`p-2.5 rounded-xl border text-xs font-mono ${testResult.ok ? "bg-emerald-950/30 border-emerald-500/40 text-emerald-300" : "bg-red-950/30 border-red-500/40 text-red-300"}`}>
              {testResult.ok ? `✓ 连接成功 (${testResult.duration_ms}ms) · 目标 ${testResult.target}` : `✗ 连接失败 · ${testResult.error || "未知错误"}`}
            </div>
          )}
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
