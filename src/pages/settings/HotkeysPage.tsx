import { useEffect, useState } from "react";
import type { AppSettings, HotkeySettings } from "../../types";
import { useLang } from "../../lib/i18n";
import { Section } from "./shared";
import { btnGhost } from "./constants";

const MODS = ["Control", "Alt", "Shift", "Meta"] as const;
const KEY_LABEL: Record<string, string> = { Space: "Space", Enter: "Enter", Tab: "Tab", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right" };
/** `e.code` → the token the Rust side (`global_hotkey`) parses: KeyP→P, Digit1→1, F1→F1. */
const normKey = (code: string) => code.startsWith("Key") ? code.slice(3) : code.startsWith("Digit") ? code.slice(5) : (KEY_LABEL[code] ?? code);

function Recorder({ label, value, onChange, onError }: { label: string; value: string | null; onChange: (v: string | null) => void; onError: (m: string) => void }) {
  const { t } = useLang();
  const [recording, setRecording] = useState(false);
  useEffect(() => {
    if (!recording) return;
    const down = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === "Escape") { setRecording(false); return; }
      if (e.key === "Backspace" || e.key === "Delete") { onChange(null); setRecording(false); return; }
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
      const mods = MODS.filter(m => e.getModifierState(m));
      if (!mods.some(m => m !== "Shift")) { onError(t("settings.hotkeys.need_modifier")); return; }
      // Injected or remote-desktop keys may carry no scan code (empty `code`); fall back to `key`.
      const token = e.code ? normKey(e.code) : e.key.length === 1 ? e.key.toUpperCase() : e.key;
      if (!token) { onError(t("settings.hotkeys.unknown_key")); return; }
      onChange(`${mods.join("+")}+${token}`);
      setRecording(false);
    };
    window.addEventListener("keydown", down, true);
    return () => window.removeEventListener("keydown", down, true);
  }, [recording, onChange, onError, t]);
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <strong className="text-xs text-[var(--text-1)]">{label}</strong>
        <p className="text-[11px] text-[var(--text-2)]">{t("settings.hotkeys.recorder_hint")}</p>
      </div>
      <button type="button" className={`${btnGhost} font-mono min-w-36 ${recording ? "ring-2 ring-[var(--accent)]" : ""}`} onClick={() => setRecording(r => !r)} aria-label={t("settings.hotkeys.recorder_aria", { label })}>
        {recording ? t("settings.hotkeys.recording") : value ?? t("settings.hotkeys.unset")}
      </button>
    </div>
  );
}

export function HotkeysPage({ settings, save, onError }: {
  settings: AppSettings; save: (next: HotkeySettings) => void; onError: (m: string) => void;
}) {
  const { t } = useLang();
  const hk = settings.hotkeys;
  const assign = (field: keyof HotkeySettings, v: string | null) => {
    const other = field === "open_settings" ? hk.toggle_rail : hk.open_settings;
    if (v !== null && v === other) { onError(t("settings.hotkeys.duplicate")); return; }
    save({ ...hk, [field]: v });
  };
  return (
    <div className="space-y-5 max-w-2xl">
      <Section title={t("settings.hotkeys.title")} icon="⌨" subtitle={t("settings.hotkeys.subtitle")}>
        <Recorder label={t("settings.hotkeys.open_settings")} value={hk.open_settings ?? null} onChange={v => assign("open_settings", v)} onError={onError} />
        <Recorder label={t("settings.hotkeys.toggle_rail")} value={hk.toggle_rail ?? null} onChange={v => assign("toggle_rail", v)} onError={onError} />
      </Section>
    </div>
  );
}
