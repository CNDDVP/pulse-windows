import type { ReactNode } from "react";

export function Switch({ checked, onChange, disabled = false, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-emerald-500/50 ${checked ? "bg-emerald-500" : "bg-zinc-700"} ${disabled ? "opacity-40 cursor-not-allowed" : ""}`}
    >
      <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition duration-200 ease-in-out ${checked ? "translate-x-4" : "translate-x-0"}`} />
    </button>
  );
}

export function Section({ title, icon, subtitle, children, aside }: { title: string; icon?: string; subtitle?: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="p-5 bg-zinc-900/40 rounded-2xl border border-white/5 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-white flex items-center gap-2">{icon && <span>{icon}</span>}{title}</h3>
          {subtitle && <p className="text-[11px] text-zinc-400 mt-0.5">{subtitle}</p>}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** Title says what it is, subtitle says what it does; the control sits on the right. */
export function Row({ title, subtitle, children, disabled }: { title: string; subtitle?: string; children: ReactNode; disabled?: boolean }) {
  return (
    <div className={`flex items-start justify-between gap-4 ${disabled ? "opacity-50" : ""}`}>
      <div className="space-y-0.5 min-w-0">
        <strong className="text-xs text-zinc-200">{title}</strong>
        {subtitle && <p className="text-[11px] text-zinc-400">{subtitle}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-zinc-400">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-zinc-500">{hint}</span>}
    </label>
  );
}
