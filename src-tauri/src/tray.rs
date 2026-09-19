use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};

pub fn setup_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let show = MenuItem::with_id(app, "toggle", "显示/隐藏悬浮条", true, None::<&str>)?;
    let refresh = MenuItem::with_id(app, "refresh", "立即刷新配额", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "设置...", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 Pulse", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&show, &refresh, &settings, &quit])?;

    let icon = match app.default_window_icon() {
        Some(i) => i.clone(),
        None => tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png"))?,
    };

    let _tray = TrayIconBuilder::with_id("pulse-tray")
        .tooltip("Pulse - AI 配额监控器")
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            match event.id.as_ref() {
                "toggle" => {
                    let state = app.state::<crate::AppState>();
                    let hidden = state.user_hidden.fetch_xor(true, std::sync::atomic::Ordering::Relaxed);
                    if let Some(w) = app.get_webview_window("main") {
                        if !hidden {
                            let _ = w.hide();
                        } else {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                            let _ = app.emit("reveal-rail", ());
                            let app_c = app.clone();
                            tauri::async_runtime::spawn(async move {
                                let s = app_c.state::<crate::AppState>().settings.lock().await.clone();
                                *app_c.state::<crate::AppState>().window_mode.lock().await = "rail".into();
                                crate::window::position(&app_c, &s, "rail");
                            });
                        }
                    }
                }
                "refresh" => {
                    let app_clone = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = crate::refresh_usages_and_emit(&app_clone, true).await;
                    });
                }
                "settings" => {
                    crate::open_settings_window(app);
                }
                "quit" => {
                    app.exit(0);
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            match event {
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } => {
                    let app = tray.app_handle();
                    app.state::<crate::AppState>().user_hidden.store(false, std::sync::atomic::Ordering::Relaxed);
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.unminimize();
                        let _ = w.set_focus();
                    }
                    let _ = app.emit("reveal-rail", ());
                    let app_c = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let s = app_c.state::<crate::AppState>().settings.lock().await.clone();
                        *app_c.state::<crate::AppState>().window_mode.lock().await = "rail".into();
                        crate::window::position(&app_c, &s, "rail");
                    });
                }
                TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                } => {
                    crate::open_settings_window(tray.app_handle());
                }
                _ => {}
            }
        })
        .build(app)?;

    Ok(())
}
