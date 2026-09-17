import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { AppSettings, ProviderUsage } from "./types";
import { FloatingRail } from "./components/FloatingRail";
import { SettingsWindow } from "./pages/SettingsWindow";

export const App: React.FC = () => {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [usages, setUsages] = useState<ProviderUsage[]>([]);
  
  const isSettingsView = (() => {
    try {
      if (getCurrentWebviewWindow().label === "settings") return true;
    } catch (_) {}
    return window.location.hash.includes("settings") || window.location.search.includes("settings");
  })();

  useEffect(() => {
    // 1. Fetch initial settings
    invoke<AppSettings>("get_settings")
      .then((s) => setSettings(s))
      .catch(console.error);

    // 2. Fetch initial usages (only for rail view)
    if (!isSettingsView) {
      invoke<ProviderUsage[]>("get_usages")
        .then((u) => setUsages(u))
        .catch(console.error);

      // 3. Listen to realtime usage updates from Rust backend
      const unlistenPromise = listen<ProviderUsage[]>("usages-updated", (event) => {
        setUsages(event.payload);
      });

      return () => {
        unlistenPromise.then((unlisten) => unlisten());
      };
    }
  }, [isSettingsView]);

  if (!settings) {
    return isSettingsView ? (
      <div className="w-screen h-screen flex items-center justify-center bg-[#16161a] text-zinc-400 text-[13px]">
        加载设置中...
      </div>
    ) : null;
  }

  if (isSettingsView) {
    return (
      <SettingsWindow
        initialSettings={settings}
        onSaved={(newS) => setSettings(newS)}
      />
    );
  }

  return (
    <div className="w-screen h-screen bg-transparent overflow-visible flex items-center justify-end pointer-events-none">
      <FloatingRail
        usages={usages}
        settings={settings}
        onRefresh={() => invoke("refresh_usages")}
      />
    </div>
  );
};

export default App;
