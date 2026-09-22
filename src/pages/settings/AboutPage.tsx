import { UpdateCenter } from "./UpdateCenter";
import { Fragment, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useLang } from "../../lib/i18n";
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
  const { t } = useLang();
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
      setMsg(t("settings.about.creds_cleared"));
      refreshProfile();
    } catch (e) {
      setMsg(t("settings.about.clear_fail", { err: String(e) }));
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
      setMsg(t("settings.about.profile_created", { id: newId.slice(0, 12) }));
      refreshProfile();
    } catch (e) {
      setMsg(t("settings.about.op_fail", { err: String(e) }));
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
      setMsg(t("settings.about.imported", { count: Object.keys(imported.providers || {}).length }));
      refreshProfile();
    } catch (e) {
      setMsg(t("settings.about.import_fail", { err: String(e) }));
    }
  };

  const handleCopyDiagnostics = async () => {
    try {
      const rawDiag = await invoke<string>("diagnostics");
      const sanitizedExe = runtime?.exe_path ? sanitizePath(runtime.exe_path) : "[PATH]";
      const sanitizedDir = runtime?.data_dir ? sanitizePath(runtime.data_dir) : "[PATH]";
      const text = [
        t("settings.about.copydiag.title"),
        t("settings.about.copydiag.version", { v: `v${runtime?.version || __APP_VERSION__}` }),
        t("settings.about.copydiag.build", { v: `${runtime?.commit || __GIT_COMMIT__} · ${runtime?.build_time || __BUILD_TIME__}` }),
        t("settings.about.copydiag.mode", { v: runtime?.mode || "unknown" }),
        t("settings.about.copydiag.profile", { v: runtime?.profile_id || "unknown" }),
        t("settings.about.copydiag.sha", { v: runtime?.exe_sha256 || "unknown" }),
        t("settings.about.copydiag.data_dir", { v: sanitizedDir }),
        t("settings.about.copydiag.exe_path", { v: sanitizedExe }),
        "",
        t("settings.about.copydiag.conn_title"),
        // rawDiag 为 Rust `diagnostics` 输出，原样拼入。TODO(EN-backend)
        rawDiag,
      ].join("\n");
      await navigator.clipboard.writeText(text);
      setMsg(t("settings.about.copydiag.copied"));
    } catch (e) {
      setMsg(t("settings.about.copy_fail", { err: String(e) }));
    }
  };

  const rows: [string, string][] = [
    [t("settings.about.row.version"), `v${runtime?.version || __APP_VERSION__}`],
    [t("settings.about.row.build"), `${runtime?.commit || __GIT_COMMIT__} · ${runtime?.build_time || __BUILD_TIME__}`],
    [t("settings.about.row.mode"), profile?.mode === "portable" ? t("settings.about.mode.portable") : profile?.mode === "custom_env" ? t("settings.about.mode.custom_env") : t("settings.about.mode.default")],
    [t("settings.about.row.profile"), profile ? `${profile.profile_id.slice(0, 16)}...` : t("settings.about.reading")],
    [t("settings.about.row.sha"), runtime?.exe_sha256 ? `${runtime.exe_sha256.slice(0, 16)}...${runtime.exe_sha256.slice(-16)}` : t("settings.about.hashing")],
    [t("settings.about.row.data_dir"), runtime?.data_dir || t("settings.about.reading")],
    [t("settings.about.row.exe_path"), runtime?.exe_path || t("settings.about.reading")],
    [t("settings.about.row.repo"), "https://github.com/CNDDVP/pulse-windows"],
    [t("settings.about.row.stack"), "Tauri 2 · Rust · React 19 · Tailwind CSS"],
  ];

  return (
    <div className="space-y-5 max-w-2xl">
      <Section
        title={t("settings.about.title")}
        icon="ℹ️"
        aside={<button className={btnGhost} onClick={() => void handleCopyDiagnostics()}>{t("settings.about.copy_diag_btn")}</button>}
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
          {t("settings.about.alignment_note")}
        </p>
      </Section>

      <Section title={t("settings.about.isolation_title")} icon="🛡️" subtitle={t("settings.about.isolation_sub")}>
        {profileStatus?.is_copy && (
          <div className="p-3 bg-amber-950/40 border border-amber-500/30 rounded-xl text-amber-200 text-xs flex items-start gap-2.5 mb-3">
            <span className="text-base leading-none">⚠️</span>
            <div className="flex-1 space-y-1">
              <div className="font-medium text-amber-300">{t("settings.about.copy_detected")}</div>
              <div className="text-[11px] text-amber-200/80 leading-relaxed">
                {t("settings.about.copy_note")}
              </div>
              <div className="pt-1">
                <button
                  className="px-2.5 py-1 bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 border border-amber-500/40 rounded-lg text-xs font-medium transition cursor-pointer"
                  onClick={() => void handleIsolateProfile()}
                >
                  {confirmArmed === "isolate_profile" ? t("settings.about.isolate_confirm") : t("settings.about.isolate_btn")}
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
              {confirmArmed === "import_installed" ? t("settings.about.import_confirm") : t("settings.about.import_btn")}
            </button>
          )}
          <button
            className={confirmArmed === "clear_creds" ? "px-3 py-1.5 bg-red-950/50 text-red-300 border border-red-900/60 rounded-xl text-xs font-medium transition-all cursor-pointer" : btnGhost}
            onClick={() => void handleClearCreds()}
          >
            {confirmArmed === "clear_creds" ? t("settings.about.clear_confirm") : t("settings.about.clear_btn")}
          </button>
          <button
            className={confirmArmed === "isolate_profile" ? "px-3 py-1.5 bg-amber-950/50 text-amber-300 border border-amber-900/60 rounded-xl text-xs font-medium transition-all cursor-pointer" : btnGhost}
            onClick={() => void handleIsolateProfile()}
          >
            {confirmArmed === "isolate_profile" ? t("settings.about.regenerate_confirm") : t("settings.about.regenerate_btn")}
          </button>
        </div>
        {msg && <p className="text-xs text-emerald-400 mt-2">{msg}</p>}
      </Section>

      <Section title={t("settings.about.update_title")} icon="⬆️" subtitle={t("settings.about.license_note")}
        aside={
          <div className="flex gap-2">
            <a className={btnGhost} href="https://github.com/CNDDVP/pulse-windows" target="_blank" rel="noreferrer" onClick={e => { e.preventDefault(); void invoke("open_external_url", { url: "https://github.com/CNDDVP/pulse-windows" }).catch(console.error); }}>{t("settings.about.repo_link")}</a>
            <a className={btnGhost} href="https://github.com/qunqin24/Pulse" target="_blank" rel="noreferrer" onClick={e => { e.preventDefault(); void invoke("open_external_url", { url: "https://github.com/qunqin24/Pulse" }).catch(console.error); }}>{t("settings.about.upstream_link")}</a>
          </div>
        }>
        <UpdateCenter hasDraft={hasDraft} />
        <div className="text-xs text-zinc-400">{t("settings.about.privacy_line", { version: runtime?.version || __APP_VERSION__ })}</div>
      </Section>

      <Section title={t("settings.about.dev_title")} icon="🧩" subtitle={t("settings.about.dev_sub")}>
        <pre className="bg-zinc-950 border border-white/5 rounded-xl px-3 py-2 text-[11px] font-mono text-zinc-300 select-text overflow-auto">pulse-windows.exe --json</pre>
        <p className="text-[11px] text-zinc-500">{t("settings.about.dev_note")}</p>
      </Section>
    </div>
  );
}
