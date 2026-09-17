pub mod commands;
pub mod config;
pub mod providers;
pub mod tray;
pub mod types;
pub mod window;

use config::load_settings;
use providers::fetch_all_usages;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;
use types::{AppSettings, ProviderUsage};

pub struct AppState {
    pub settings: Arc<Mutex<AppSettings>>,
    pub cached_usages: Arc<Mutex<Vec<ProviderUsage>>>,
}

pub fn open_settings_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

pub async fn refresh_usages_and_emit(app: &AppHandle) -> Result<Vec<ProviderUsage>, String> {
    let state = app.state::<AppState>();
    let settings = {
        let s = state.settings.lock().await;
        s.clone()
    };

    let usages = fetch_all_usages(&settings).await;

    {
        let mut cached = state.cached_usages.lock().await;
        *cached = usages.clone();
    }

    let _ = app.emit("usages-updated", &usages);
    Ok(usages)
}

fn initial_cached_usages(settings: &AppSettings) -> Vec<ProviderUsage> {
    let mut ordered: Vec<(&String, &crate::types::ProviderConfig)> = settings
        .providers
        .iter()
        .filter(|(_, cfg)| cfg.enabled)
        .collect();
    ordered.sort_by_key(|(_, cfg)| cfg.order);

    ordered
        .into_iter()
        .map(|(id, _)| ProviderUsage {
            provider_id: id.clone(),
            display_name: match id.as_str() {
                "antigravity" => "Antigravity".to_string(),
                "cursor" => "Cursor".to_string(),
                "codex" => "Codex".to_string(),
                "claude" => "Claude Code".to_string(),
                "kimi" => "Kimi Code".to_string(),
                "copilot" => "GitHub Copilot".to_string(),
                "deepseek" => "DeepSeek".to_string(),
                other => other.to_string(),
            },
            icon: id.clone(),
            state: "loading".to_string(),
            primary_percent: 0,
            plan_name: None,
            is_active: false,
            windows: vec![],
            error_message: None,
        })
        .collect()
}

#[cfg(windows)]
mod single_instance {
    use windows::core::w;
    use windows::Win32::Foundation::{
        CloseHandle, GetLastError, BOOL, ERROR_ALREADY_EXISTS, HANDLE, HWND, LPARAM,
    };
    use windows::Win32::System::Threading::CreateMutexW;
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextW, SetForegroundWindow, ShowWindow, SW_RESTORE,
    };

    pub struct SingleInstanceGuard(Option<HANDLE>);

    impl SingleInstanceGuard {
        pub fn acquire() -> Option<Self> {
            unsafe {
                let handle = match CreateMutexW(None, true, w!("Global\\PulseWindowsSingleInstanceAppMutex")) {
                    Ok(h) => h,
                    Err(_) => return None,
                };
                if GetLastError() == ERROR_ALREADY_EXISTS {
                    let _ = CloseHandle(handle);
                    activate_existing_window();
                    return None;
                }
                Some(Self(Some(handle)))
            }
        }
    }

    impl Drop for SingleInstanceGuard {
        fn drop(&mut self) {
            if let Some(h) = self.0.take() {
                unsafe {
                    let _ = CloseHandle(h);
                }
            }
        }
    }

    unsafe extern "system" fn enum_windows_callback(hwnd: HWND, _: LPARAM) -> BOOL {
        let mut title = [0u16; 128];
        let len = GetWindowTextW(hwnd, &mut title);
        if len > 0 {
            let s = String::from_utf16_lossy(&title[..len as usize]);
            if s.contains("Pulse") {
                let _ = ShowWindow(hwnd, SW_RESTORE);
                let _ = SetForegroundWindow(hwnd);
                return BOOL(0);
            }
        }
        BOOL(1)
    }

    fn activate_existing_window() {
        unsafe {
            let _ = EnumWindows(Some(enum_windows_callback), LPARAM(0));
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(windows)]
    let _instance_guard = match single_instance::SingleInstanceGuard::acquire() {
        Some(guard) => guard,
        None => {
            eprintln!("Pulse is already running. Focused existing window and exiting.");
            return;
        }
    };

    let initial_settings = load_settings();
    let initial_usages = initial_cached_usages(&initial_settings);

    let app_state = AppState {
        settings: Arc::new(Mutex::new(initial_settings.clone())),
        cached_usages: Arc::new(Mutex::new(initial_usages)),
    };

    tauri::Builder::default()
        .manage(app_state)
        .setup(move |app| {
            let handle = app.handle();
            if let Err(e) = tray::setup_tray(handle) {
                eprintln!("Failed to setup tray: {}", e);
            }

            // Position initial window on screen edge
            window::position_edge_window(handle, &initial_settings.dock_side, "rail");

            // Start initial background fetch and periodic timer
            let handle_clone = handle.clone();
            tauri::async_runtime::spawn(async move {
                let _ = refresh_usages_and_emit(&handle_clone).await;

                loop {
                    let interval = {
                        let state = handle_clone.state::<AppState>();
                        let s = state.settings.lock().await;
                        s.refresh_interval_seconds.max(30)
                    };
                    tokio::time::sleep(tokio::time::Duration::from_secs(interval)).await;
                    let _ = refresh_usages_and_emit(&handle_clone).await;
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "settings" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::update_settings,
            commands::get_usages,
            commands::refresh_usages,
            commands::set_window_state,
            commands::open_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_fetch_providers() {
        let settings = config::load_settings();
        let usages = providers::fetch_all_usages(&settings).await;
        println!("=== Pulse for Windows: Provider Test ===");
        println!("Fetched {} usages:", usages.len());
        for u in &usages {
            println!("- {}: state={}, primary={}%, err={:?}", u.display_name, u.state, u.primary_percent, u.error_message);
            for w in &u.windows {
                println!("    * {}: {}% (reset: {:?})", w.name, w.used_percent, w.resets_in);
            }
        }
        assert!(!usages.is_empty());
    }
}
