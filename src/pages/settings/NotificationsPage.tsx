import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppSettings } from "../../types";
import { Section, Row, Switch, selectCls, btnGhost } from "./shared";

interface Status { system_toasts: boolean | null; permission: string }

export function NotificationsPage({ settings, update, toast }: {
  settings: AppSettings; update: (patch: Partial<AppSettings>) => void;
  toast: (type: "success" | "info" | "error", text: string) => void;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const load = () => void invoke<Status>("notification_status").then(setStatus).catch(() => setStatus(null));
  useEffect(load, []);
  const n = settings.notifications;
  const blocked = status?.system_toasts === false;

  return (
    <div className="space-y-5 max-w-2xl">
      <Section title="Windows 通知状态" icon="🔔" subtitle={blocked ? "Windows 已关闭通知：以下设置照常保存，但不会弹出任何横幅。" : undefined}
        aside={<button className={btnGhost} onClick={() => { load(); void invoke("test_notification").then(() => toast("info", "测试通知已发送")).catch(e => toast("error", String(e))); }}>发送测试通知</button>}>
        <div className={`text-xs rounded-xl border px-3 py-2 ${blocked ? "bg-amber-950/40 border-amber-800/50 text-amber-300" : "bg-emerald-950/30 border-emerald-800/40 text-emerald-300"}`}>
          {status === null ? "无法读取系统通知状态" : blocked ? "⚠ Windows 已关闭通知（设置 → 系统 → 通知）" : "✓ Windows 通知已允许"}
          {status && <span className="text-zinc-500"> · 插件权限：{status.permission}</span>}
        </div>
        <p className="text-[11px] text-zinc-500">专注助手/勿扰模式开启时横幅可能被压入通知中心而不弹出。</p>
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
