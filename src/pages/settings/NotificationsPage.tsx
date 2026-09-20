import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppSettings, NotificationFullStatus, NotificationSendResult } from "../../types";
import { Section, Row, Switch } from "./shared";
import { selectCls, btnGhost, btnPrimary } from "./constants";

export function NotificationsPage({ settings, update, toast }: {
  settings: AppSettings; update: (patch: Partial<AppSettings>) => void;
  toast: (type: "success" | "info" | "error", text: string) => void;
}) {
  const [status, setStatus] = useState<NotificationFullStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState(false);
  const [lastTest, setLastTest] = useState<NotificationSendResult | null>(null);
  const [userFeedback, setUserFeedback] = useState<"seen" | "not_seen" | null>(null);
  const [showTroubleshoot, setShowTroubleshoot] = useState(false);

  const loadStatus = async () => {
    try {
      setLoading(true);
      const res = await invoke<NotificationFullStatus>("get_notification_status");
      setStatus(res);
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadStatus();
  }, []);

  const handleRegister = async () => {
    try {
      setLoading(true);
      const res = await invoke<NotificationFullStatus>("register_notification_identity");
      setStatus(res);
      toast("success", "已成功注册 Windows 通知身份与开始菜单快捷方式！");
    } catch (e) {
      toast("error", `注册失败: ${String(e)}`);
    } finally {
      setLoading(false);
    }
  };

  const handleUnregister = async () => {
    try {
      setLoading(true);
      const res = await invoke<NotificationFullStatus>("unregister_notification_identity");
      setStatus(res);
      toast("info", "已清除开始菜单快捷方式与通知身份注册。");
    } catch (e) {
      toast("error", `清除失败: ${String(e)}`);
    } finally {
      setLoading(false);
    }
  };

  const handleTest = async () => {
    if (testing) return;
    setTesting(true);
    setUserFeedback(null);
    setShowTroubleshoot(false);
    try {
      const res = await invoke<NotificationSendResult>("test_notification");
      setLastTest(res);
      if (res.success) {
        toast("success", `测试通知已提交给 Windows (${res.test_id})，请检查横幅或操作中心`);
      } else {
        toast("error", `通知提交失败: ${res.error || "未知原因"}`);
      }
    } catch (e) {
      const failedRes: NotificationSendResult = {
        success: false,
        stage: "failed",
        setting: "unknown",
        test_id: "error",
        error: String(e),
        hint: null,
      };
      setLastTest(failedRes);
      toast("error", `测试通知发送失败: ${String(e)}`);
    } finally {
      setTesting(false);
      void loadStatus();
    }
  };

  const handleCopyDiagnostics = () => {
    const lines = [
      `=== Pulse Windows 通知诊断摘要 ===`,
      `时间: ${new Date().toISOString()}`,
      `应用身份状态: ${status?.identity_status ?? "未知"}`,
      `快捷方式路径: ${status?.shortcut_path ?? "无"}`,
      `快捷方式指向: ${status?.shortcut_target ?? "无"}`,
      `当前 EXE 路径: ${status?.current_exe ?? "未知"}`,
      `便携版模式: ${status?.is_portable ? "是" : "否"}`,
      `Windows 全局通知开关: ${status?.windows_toasts_enabled === null ? "未配置 (默认允许)" : status?.windows_toasts_enabled ? "开启" : "关闭"}`,
      `Pulse 系统应用授权: ${status?.app_notification_setting ?? "未知"}`,
      `插件底层权限: ${status?.plugin_permission ?? "未知"}`,
      `最近测试结果: ${lastTest ? `${lastTest.stage} (${lastTest.test_id})` : "尚未测试"}`,
      `最近测试错误: ${lastTest?.error ?? "无"}`,
    ];
    void navigator.clipboard.writeText(lines.join("\n"));
    toast("success", "已复制通知诊断摘要至剪贴板");
  };

  const n = settings.notifications;
  const isRegistered = status?.identity_status === "registered";
  const isMoved = status?.identity_status === "moved";
  const isGlobalBlocked = status?.windows_toasts_enabled === false;
  const isAppBlocked = status?.app_notification_setting === "disabled_for_app";

  return (
    <div className="space-y-5 max-w-2xl">
      <Section
        title="Windows 通知链路诊断"
        icon="🔔"
        subtitle="Windows 桌面非打包应用必须具备正确的开始菜单快捷方式与 AppUserModelID 属性，方可弹出横幅与推入操作中心。"
        aside={
          <div className="flex gap-2">
            <button
              className={btnGhost}
              disabled={loading || testing}
              onClick={() => void loadStatus()}
              title="重新检测当前系统状态"
            >
              ⟳ 刷新状态
            </button>
            <button
              className={btnPrimary}
              disabled={loading || testing}
              onClick={() => void handleTest()}
            >
              {testing ? "正在提交测试通知…" : "发送测试通知"}
            </button>
          </div>
        }
      >
        {/* 4 项细粒度状态卡片 */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          {/* 1. 应用通知身份 */}
          <div className={`p-3 rounded-xl border text-xs space-y-1 ${
            isRegistered ? "bg-emerald-950/30 border-emerald-800/40 text-emerald-200" :
            isMoved ? "bg-amber-950/40 border-amber-800/50 text-amber-200" :
            "bg-red-950/40 border-red-800/50 text-red-200"
          }`}>
            <div className="flex items-center justify-between">
              <span className="font-semibold flex items-center gap-1.5">
                <span>{isRegistered ? "✓" : isMoved ? "⚠️" : "✕"}</span>
                <span>应用通知身份</span>
              </span>
              <span className="text-[10px] px-1.5 py-0.5 rounded font-mono bg-black/30">
                {isRegistered ? "已注册" : isMoved ? "路径已变更" : "未注册"}
              </span>
            </div>
            <p className="text-[11px] text-zinc-400">
              {isRegistered ? "开始菜单快捷方式与 AUMID 已就绪" :
               isMoved ? "便携版移动了位置，快捷方式仍指向旧路径" :
               "未在开始菜单找到带有 AUMID 的 Pulse 快捷方式"}
            </p>
          </div>

          {/* 2. Windows 全局通知 */}
          <div className={`p-3 rounded-xl border text-xs space-y-1 ${
            isGlobalBlocked ? "bg-red-950/40 border-red-800/50 text-red-200" :
            status?.windows_toasts_enabled ? "bg-emerald-950/30 border-emerald-800/40 text-emerald-200" :
            "bg-zinc-900/60 border-zinc-700/50 text-zinc-300"
          }`}>
            <div className="flex items-center justify-between">
              <span className="font-semibold flex items-center gap-1.5">
                <span>{isGlobalBlocked ? "✕" : "✓"}</span>
                <span>Windows 全局通知</span>
              </span>
              <span className="text-[10px] px-1.5 py-0.5 rounded font-mono bg-black/30">
                {isGlobalBlocked ? "已关闭" : status?.windows_toasts_enabled ? "已允许" : "未配置 (默认开启)"}
              </span>
            </div>
            <p className="text-[11px] text-zinc-400">
              {isGlobalBlocked ? "在「Windows 设置 → 系统 → 通知」中被关闭" : "Windows 系统全局通知开关处于可用状态"}
            </p>
          </div>

          {/* 3. Pulse 应用授权 */}
          <div className={`p-3 rounded-xl border text-xs space-y-1 ${
            isAppBlocked ? "bg-red-950/40 border-red-800/50 text-red-200" :
            status?.app_notification_setting === "enabled" ? "bg-emerald-950/30 border-emerald-800/40 text-emerald-200" :
            "bg-zinc-900/60 border-zinc-700/50 text-zinc-300"
          }`}>
            <div className="flex items-center justify-between">
              <span className="font-semibold flex items-center gap-1.5">
                <span>{isAppBlocked ? "✕" : "ℹ"}</span>
                <span>Pulse 系统级授权</span>
              </span>
              <span className="text-[10px] px-1.5 py-0.5 rounded font-mono bg-black/30">
                {status?.app_notification_setting === "enabled" ? "已允许" :
                 isAppBlocked ? "系统设置中已禁用" :
                 status?.app_notification_setting === "disabled_by_manifest" ? "身份未识别" : "未知"}
              </span>
            </div>
            <p className="text-[11px] text-zinc-400">
              {isAppBlocked ? "用户在系统设置中关闭了 Pulse 的横幅/声音" :
               status?.app_notification_setting === "enabled" ? "系统允许 Pulse 弹出 Toast 横幅" :
               "需在首次弹出通知后在系统设置中可见"}
            </p>
          </div>

          {/* 4. 最近测试交付 */}
          <div className={`p-3 rounded-xl border text-xs space-y-1 ${
            lastTest?.success ? "bg-emerald-950/30 border-emerald-800/40 text-emerald-200" :
            lastTest ? "bg-red-950/40 border-red-800/50 text-red-200" :
            "bg-zinc-900/60 border-zinc-700/50 text-zinc-300"
          }`}>
            <div className="flex items-center justify-between">
              <span className="font-semibold flex items-center gap-1.5">
                <span>{lastTest?.success ? "✓" : lastTest ? "✕" : "⏱"}</span>
                <span>最近一次测试</span>
              </span>
              <span className="text-[10px] px-1.5 py-0.5 rounded font-mono bg-black/30">
                {lastTest?.success ? "已提交" : lastTest ? "提交失败" : "尚未测试"}
              </span>
            </div>
            <p className="text-[11px] text-zinc-400">
              {lastTest?.success ? `已于 ${lastTest.test_id} 成功提交给系统` :
               lastTest?.error ? lastTest.error :
               "点击右上角「发送测试通知」验证链路"}
            </p>
          </div>
        </div>

        {/* 注册管理与快捷操作栏 */}
        <div className="p-3 bg-zinc-950/60 rounded-xl border border-white/5 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="space-y-0.5 min-w-0">
            <div className="font-medium text-zinc-200">
              {isRegistered ? "通知身份正常关联" : isMoved ? "便携版目录已变更" : "便携版原生通知未初始化"}
            </div>
            <p className="text-[11px] text-zinc-500 truncate">
              {isRegistered ? `快捷方式：${status?.shortcut_path || "Pulse.lnk"}` :
               isMoved ? `旧路径：${status?.shortcut_target || "未知"} → 新路径：${status?.current_exe || ""}` :
               "便携版需要创建带有 AUMID 的当前用户开始菜单快捷方式，以允许 Windows 识别并弹出横幅。"}
            </p>
          </div>
          <div className="flex gap-2 shrink-0">
            {!isRegistered ? (
              <button
                disabled={loading}
                onClick={() => void handleRegister()}
                className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium cursor-pointer transition-colors shadow-sm"
              >
                {isMoved ? "修复通知路径" : "启用 Windows 通知"}
              </button>
            ) : (
              <button
                disabled={loading}
                onClick={() => void handleUnregister()}
                className="px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-red-950/40 hover:text-red-300 text-zinc-400 border border-zinc-700/60 cursor-pointer transition-colors"
                title="删除开始菜单快捷方式及注册表信息，恢复免注册纯便携状态"
              >
                移除本机通知注册
              </button>
            )}
          </div>
        </div>

        {/* 测试反馈与排查引导卡片 */}
        {lastTest && (
          <div className={`p-4 rounded-xl border space-y-3 ${
            lastTest.success ? "bg-zinc-900/90 border-emerald-800/40" : "bg-red-950/40 border-red-800/60"
          }`}>
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1">
                <div className="text-xs font-semibold flex items-center gap-2">
                  <span>{lastTest.success ? "📢" : "❌"}</span>
                  <span className={lastTest.success ? "text-emerald-300" : "text-red-300"}>
                    {lastTest.success ? `测试通知已成功提交至 Windows (${lastTest.test_id})` : "通知提交失败"}
                  </span>
                </div>
                <p className="text-[11px] text-zinc-400 leading-relaxed">
                  {lastTest.success
                    ? "系统已接收该通知。如果在屏幕右下角未看到弹出横幅，可能是横幅被 Windows 专注助手或免打扰模式直接收入了操作中心。"
                    : lastTest.error || "底层调用发生错误，请检查应用身份注册状态。"}
                </p>
                {lastTest.hint && (
                  <p className="text-[11px] text-amber-300/90 font-medium">
                    {lastTest.hint}
                  </p>
                )}
              </div>
            </div>

            {lastTest.success && (
              <div className="pt-2 border-t border-white/5 flex flex-wrap items-center justify-between gap-2">
                <span className="text-[11px] text-zinc-400">是否看到了右下角弹出的横幅？</span>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setUserFeedback("seen");
                      setShowTroubleshoot(false);
                      toast("success", "测试通过！Windows 原生通知横幅已成功显示。");
                    }}
                    className={`px-3 py-1 rounded-lg text-xs font-medium cursor-pointer transition-colors ${
                      userFeedback === "seen"
                        ? "bg-emerald-600 text-white"
                        : "bg-zinc-800 hover:bg-emerald-900/50 hover:text-emerald-200 text-zinc-300 border border-zinc-700/60"
                    }`}
                  >
                    ✓ 看到了横幅
                  </button>
                  <button
                    onClick={() => {
                      setUserFeedback("not_seen");
                      setShowTroubleshoot(true);
                    }}
                    className={`px-3 py-1 rounded-lg text-xs font-medium cursor-pointer transition-colors ${
                      userFeedback === "not_seen"
                        ? "bg-amber-700 text-white"
                        : "bg-zinc-800 hover:bg-amber-950/50 hover:text-amber-200 text-zinc-300 border border-zinc-700/60"
                    }`}
                  >
                    ✕ 没有看到
                  </button>
                </div>
              </div>
            )}

            {/* 展开的排查引导 */}
            {showTroubleshoot && (
              <div className="pt-3 border-t border-white/10 space-y-2.5 text-xs text-zinc-300 animate-in fade-in duration-150">
                <div className="font-semibold text-amber-300 flex items-center gap-1.5">
                  <span>🛠️</span>
                  <span>横幅未出现时的排查步骤：</span>
                </div>
                <ol className="space-y-2 text-[11px] list-decimal list-inside text-zinc-400 pl-1 leading-relaxed">
                  <li>
                    <strong className="text-zinc-200">检查 Windows 操作中心 (Win + N)：</strong>
                    按键盘快捷键 <kbd className="px-1.5 py-0.5 bg-zinc-800 border border-zinc-700 rounded text-zinc-300">Win</kbd> + <kbd className="px-1.5 py-0.5 bg-zinc-800 border border-zinc-700 rounded text-zinc-300">N</kbd> 查看通知列表。若其中能看到该条测试通知，说明通知已成功送达，仅桌面横幅因系统规则被压制。
                  </li>
                  <li>
                    <strong className="text-zinc-200">检查专注助手 / 勿扰模式：</strong>
                    Windows 在全屏应用、游戏、演示模式或设定的工作时段会自动压制横幅，直接转入通知中心。请检查屏幕右下角操作中心的「勿扰模式」图标是否高亮开启。
                  </li>
                  <li>
                    <strong className="text-zinc-200">检查 Pulse 应用通知设置：</strong>
                    在 Windows「设置 → 系统 → 通知」下找到 Pulse，确认「在通知中心显示横幅」和「播放声音」选项均处于开启状态。
                  </li>
                  <li>
                    <strong className="text-zinc-200">重新初始化注册：</strong>
                    如果快捷方式或注册表损坏，可先点击上方的「移除本机通知注册」，再点击「启用 Windows 通知」重新建立完整身份。
                  </li>
                </ol>
                <div className="pt-2 flex justify-end gap-2">
                  <button
                    onClick={handleCopyDiagnostics}
                    className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[11px] cursor-pointer"
                  >
                    复制通知诊断摘要
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </Section>

      <Section title="额度通知" icon="📈" subtitle="每条限额每个台阶只提醒一次；小幅回落不会重复提醒。">
        <Row title="接近上限时通知" subtitle="任一窗口已用比例达到所选台阶。">
          <select className={selectCls} value={n.threshold ?? ""} onChange={e => update({ notifications: { ...n, threshold: e.target.value ? Number(e.target.value) : null } })} aria-label="接近上限通知阈值">
            <option value="">关闭</option><option value={75}>达到 75%</option><option value={80}>达到 80%</option><option value={90}>达到 90%</option><option value={95}>达到 95%</option>
          </select>
        </Row>
        <Row title="额度用尽时通知" subtitle="服务商报告耗尽，或已用比例达到 100%。">
          <Switch checked={n.on_spent} onChange={v => update({ notifications: { ...n, on_spent: v } })} label="额度用尽时通知" />
        </Row>
        <Row title="额度重置后通知" subtitle="只针对提醒过的窗口：重置时间前移超过 1 分钟，或已用比例回落 40 点以上。" disabled={!n.threshold}>
          <Switch checked={n.on_reset} disabled={!n.threshold} onChange={v => update({ notifications: { ...n, on_reset: v } })} label="额度重置后通知" />
        </Row>
        <Row title="连续读取失败时通知" subtitle="连续 3 次网络级失败才提醒，一次故障只提醒一次；恢复即复位。">
          <Switch checked={n.on_failure} onChange={v => update({ notifications: { ...n, on_failure: v } })} label="连续读取失败时通知" />
        </Row>
      </Section>

      <Section title="低余额通知" icon="💰" subtitle="按账号设置，在 DeepSeek 等报告真实余额的账号页面里配置；只比较所选币种。">
        <p className="text-[11px] text-zinc-500">打开「账号 → 选择账号 → 通知」设置“余额低于某值时通知”。</p>
      </Section>
    </div>
  );
}

