import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AppSettings, SyncHubStatusInfo } from "../../types";
import { validConnectUrl } from "../../lib/syncDevices";
import { useLang } from "../../lib/i18n";
import { Section, Row, Field } from "./shared";
import { btnGhost, inputCls, selectCls, timeText } from "./constants";

/**
 * 通用设置 ·「多设备同步」区块（Round 6，docs/ROUND6_PLAN.md）：
 * 模式三选（关/托管/连接）；托管态显示本机地址列表 + 访问密钥的一次性显示/复制/重置；
 * 连接态输入服务器地址 + 密钥；状态行诚实显示最近拉取/上推时间与失败原因。
 * 密钥永远不回读：后端只暴露「已配置」布尔与一次性返回的新密钥（sync_hub_reset_secret）。
 */

export function SyncSettings({ settings, update, toast }: {
  settings: AppSettings; update: (patch: Partial<AppSettings>) => void;
  toast: (type: "success" | "info" | "error", text: string) => void;
}) {
  const { t } = useLang();
  const mode = settings.sync_mode ?? "off";
  // 「连接」草稿态：地址未合法前不落设置（后端会整表拒绝 connect+无效地址），
  // 但先把连接面板亮出来让用户填地址；地址合法后连同模式一并保存。
  // 草稿态与已存模式无关（off/host 皆可进入）：host+无地址时选「连接」若不亮面板，
  // 用户会陷入死端（必须先绕道「关闭」再回来）。
  const [pendingConnect, setPendingConnect] = useState(false);
  const effectiveMode = pendingConnect ? "connect" : mode;
  const [status, setStatus] = useState<SyncHubStatusInfo | null>(null);
  const [lanUrls, setLanUrls] = useState<string[]>([]);
  const [shownSecret, setShownSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // connect 密钥输入缓冲：与「已保存」状态分离，未点保存不落凭据库。
  const [connectSecret, setConnectSecret] = useState("");

  const load = useCallback(() => {
    void invoke<SyncHubStatusInfo>("sync_hub_status").then(setStatus).catch(() => setStatus(null));
    void invoke<string[]>("sync_lan_urls").then(setLanUrls).catch(() => setLanUrls([]));
  }, []);
  useEffect(() => { load(); }, [load, mode]);
  // 后端 manager 线程在 hub 起停/换钥/绑定失败时广播 sync-hub-status（payload 为
  // Runtime 状态子集），据此把状态行保持为最新，不必等下一次手动刷新。
  useEffect(() => {
    const un = listen<Partial<SyncHubStatusInfo>>("sync-hub-status", e => {
      setStatus(cur => (cur ? { ...cur, ...e.payload } : cur));
    });
    return () => { void un.then(fn => fn()).catch(() => {}); };
  }, []);

  const changeMode = (v: string) => {
    if (v === effectiveMode) return;
    if (v === "connect" && !validConnectUrl(settings.sync_connect_url || "")) {
      // 后端会整表拒绝 connect + 无效地址；此处拦截并提示，不发起必然失败的保存，
      // 进入草稿态让用户先补齐地址。
      setPendingConnect(true);
      toast("error", t("settings.sync.connect_need_url"));
      return;
    }
    if (v !== "connect") setPendingConnect(false);
    setShownSecret(null);
    update({ sync_mode: v as AppSettings["sync_mode"] });
  };

  const regenerateSecret = async () => {
    setBusy(true);
    try {
      const secret = await invoke<string>("sync_hub_reset_secret");
      setShownSecret(secret);
      toast("success", t("settings.sync.secret_generated"));
      // hub_secret_configured 不在 sync-hub-status 事件载荷里：立即重查状态，
      // 让按钮从「生成密钥」翻转为「重置密钥」（不必等用户手动刷新/切模式）。
      load();
    } catch (e) {
      toast("error", String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveConnectSecret = async () => {
    setBusy(true);
    try {
      await invoke("sync_set_connect_secret", { secret: connectSecret });
      setConnectSecret("");
      toast("success", connectSecret.trim() ? t("settings.sync.secret_saved") : t("settings.sync.secret_cleared"));
      load();
    } catch (e) {
      toast("error", String(e));
    } finally {
      setBusy(false);
    }
  };

  // 复制必须等结果再报状态：剪贴板写入被拒/失败时谎报「已复制」会误导——尤其
  // 一次性访问密钥，关闭面板后永远无法再次显示（只能重置，且重置会作废旧钥）。
  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast("success", t("settings.common.copied"));
    } catch {
      toast("error", t("settings.sync.copy_failed"));
    }
  };

  const hubRunning = status?.hub_running ?? false;
  const hubError = status?.hub_error ?? null;
  const secretConfigured = status?.hub_secret_configured ?? false;
  const clientSecretConfigured = status?.client_secret_configured ?? false;
  const urlInvalid = effectiveMode === "connect" && !validConnectUrl(settings.sync_connect_url || "");

  const recordLine = (label: string, rec: { at: string; ok: boolean; error?: string | null; devices?: number | null } | null | undefined, kind: "poll" | "push") => {
    const time = rec ? timeText(rec.at) : "—";
    const detail = !rec
      ? t("settings.sync.no_record")
      : rec.ok
        ? kind === "poll"
          ? t("settings.sync.poll_ok", { devices: String(rec.devices ?? 0), time })
          : t("settings.sync.push_ok", { time })
        : kind === "poll"
          ? t("settings.sync.poll_fail", { time, err: rec.error || t("settings.common.none") })
          : t("settings.sync.push_fail", { time, err: rec.error || t("settings.common.none") });
    return (
      <div className="flex items-center justify-between text-xs">
        <span className="text-[var(--text-2)]">{label}</span>
        <span className={`font-mono ${rec && !rec.ok ? "text-[var(--danger)]" : rec ? "text-[var(--ok)]" : "text-[var(--text-3)]"}`}>{detail}</span>
      </div>
    );
  };

  return (
    <Section title={t("settings.sync.section")} icon="🔄" subtitle={t("settings.sync.section_sub")}
      aside={<button className={btnGhost} onClick={() => { load(); }} aria-label={t("settings.sync.refresh")}>{t("settings.sync.refresh")}</button>}>
      <Row title={t("settings.sync.mode")} subtitle={t("settings.sync.mode_sub")}>
        <select
          className={`${selectCls} w-auto min-w-56`}
          aria-label={t("settings.sync.mode")}
          value={effectiveMode}
          onChange={e => changeMode(e.target.value)}
        >
          <option value="off">{t("settings.sync.mode_off")}</option>
          <option value="host">{t("settings.sync.mode_host")}</option>
          <option value="connect">{t("settings.sync.mode_connect")}</option>
        </select>
      </Row>

      {effectiveMode === "off" && (
        <div className="space-y-1">
          <p className="text-[11px] text-[var(--text-3)]">{t("settings.sync.off_note")}</p>
          {/* 绑定失败回退 off 后 host 面板整体隐藏，错误必须仍可见
              （docs/ROUND6_PLAN.md：绑定失败 → 回退 off + 界面报错，不静默半开）。 */}
          {hubError && (
            <p className="text-[11px] text-[var(--danger)] font-mono">{t("settings.sync.hub_error_line", { err: hubError })}</p>
          )}
        </div>
      )}

      {mode === "host" && (
        <div className="space-y-3 pt-2 border-t border-[var(--border)]">
          {/* hub 实际状态：以 Runtime 状态为准（绑定失败→设置已回退 off，此处只读展示）。 */}
          <div className="flex items-center justify-between text-xs">
            <span className="text-[var(--text-2)]">{t("settings.sync.hub_label")}</span>
            {hubError ? (
              <span className="text-[var(--danger)] font-mono">{t("settings.sync.hub_error_line", { err: hubError })}</span>
            ) : hubRunning ? (
              <span className="text-[var(--ok)] font-mono">{t("settings.sync.hub_running", { port: String(status?.hub_port ?? "") })}</span>
            ) : secretConfigured ? (
              <span className="text-[var(--text-3)]">{t("settings.sync.hub_stopped")}</span>
            ) : (
              <span className="text-[var(--text-3)]">{t("settings.sync.hub_waiting")}</span>
            )}
          </div>
          <div className="space-y-1">
            <div className="text-xs text-[var(--text-2)]">{t("settings.sync.lan_urls")}</div>
            {lanUrls.length ? (
              <div className="space-y-1">
                {lanUrls.map(url => (
                  <div key={url} className="flex items-center justify-between gap-2 p-2 rounded-xl bg-[var(--surface)] border border-[var(--border)]">
                    <code className="text-[11px] font-mono text-[var(--text-1)] break-all">{url}</code>
                    <button className={btnGhost} onClick={() => void copyText(url)} aria-label={`${t("settings.sync.copy")} ${url}`}>{t("settings.sync.copy")}</button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[11px] text-[var(--text-3)]">{t("settings.sync.lan_empty")}</p>
            )}
          </div>
          <div className="space-y-1 p-2 rounded-xl bg-[var(--surface)] border border-[var(--border)]">
            <div className="flex items-center justify-between">
              <span className="text-xs text-[var(--text-1)] font-medium">{t("settings.sync.secret_title")}</span>
              <button className={btnGhost} disabled={busy} onClick={() => void regenerateSecret()}>
                {secretConfigured ? t("settings.sync.secret_reset") : t("settings.sync.secret_generate")}
              </button>
            </div>
            {shownSecret ? (
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <code className="text-[11px] font-mono text-[var(--warn)] break-all" data-testid="sync-secret">{shownSecret}</code>
                  <button className={btnGhost} onClick={() => void copyText(shownSecret)} aria-label={t("settings.sync.copy")}>{t("settings.sync.copy")}</button>
                </div>
                <p className="text-[11px] text-[var(--warn)]">{t("settings.sync.secret_shown_hint")}</p>
              </div>
            ) : (
              <p className="text-[11px] text-[var(--text-3)]">{secretConfigured ? t("settings.sync.secret_hidden") : t("settings.sync.secret_none")}</p>
            )}
          </div>
          {status && <p className="text-[11px] text-[var(--text-3)]">{t("settings.sync.device_count", { n: status.device_count })}</p>}
        </div>
      )}

      {effectiveMode === "connect" && (
        <div className="space-y-3 pt-2 border-t border-[var(--border)]">
          <Field label={t("settings.sync.connect_url")} hint={urlInvalid ? t("settings.sync.connect_url_invalid") : t("settings.sync.connect_url_hint")}>
            <input
              type="text"
              className={inputCls}
              placeholder="http://192.168.1.10:45539"
              aria-label={t("settings.sync.connect_url")}
              value={settings.sync_connect_url || ""}
              onChange={e => {
                const v = e.target.value.trim();
                // 仅在地址结构合法时提交（后端对 connect+无效地址会整表拒绝保存）。
                // 草稿态下地址首次合法时，连同模式一并保存（用户 intent 已明确）——
                // 草稿态可从 off/host 任意模式进入，host+无地址不再死端。
                if (validConnectUrl(v)) {
                  if (pendingConnect) {
                    setPendingConnect(false);
                    update({ sync_mode: "connect", sync_connect_url: v });
                  } else {
                    update({ sync_connect_url: v });
                  }
                }
              }}
            />
          </Field>
          <Field label={t("settings.sync.connect_secret")} hint={t("settings.sync.connect_secret_hint")}>
            <div className="flex items-center gap-2">
              <input
                type="password"
                className={inputCls}
                aria-label={t("settings.sync.connect_secret")}
                value={connectSecret}
                onChange={e => setConnectSecret(e.target.value)}
              />
              <button className={btnGhost} disabled={busy} onClick={() => void saveConnectSecret()}>{t("settings.sync.save_secret")}</button>
            </div>
          </Field>
          <div className="flex items-center justify-between text-xs">
            <span className="text-[var(--text-2)]">{t("settings.sync.connect_secret")}</span>
            <span className={clientSecretConfigured ? "text-[var(--ok)]" : "text-[var(--text-3)]"}>
              {clientSecretConfigured ? t("settings.sync.connect_secret_saved") : t("settings.sync.connect_secret_none")}
            </span>
          </div>
        </div>
      )}

      {/* 状态行（诚实降级）：最近拉取/上推的时间与结果；无记录/失败原样可见，不美化。 */}
      <div className="space-y-1 pt-2 border-t border-[var(--border)]" data-testid="sync-status-line">
        {recordLine(t("settings.sync.status_poll"), status?.last_poll, "poll")}
        {recordLine(t("settings.sync.status_push"), status?.last_push, "push")}
      </div>
    </Section>
  );
}
