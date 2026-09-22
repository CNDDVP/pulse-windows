use serde::Deserialize;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Listener, Manager,
};

/// 托盘菜单标签（Round5c 项目一，misc 域）。托盘是原生 UI，走不了前端 `useLang().t()`：
/// 事实来源是前端词典 src/lib/i18n.ts 的 `misc.tray.*`（zh/en 两份），src/trayBridge.tsx
/// 在启动与语言变化时经 "pulse-tray-labels" 事件下发本结构同形 JSON，这里重建菜单与
/// tooltip。`TrayLabels::zh()` 默认值必须与词典 zh 值逐字一致——src/misc.i18n.test.tsx
/// 与下方单测双向钉住，改词典 zh 值必须同步改这里（反之亦然）。
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct TrayLabels {
    pub toggle: String,
    pub refresh: String,
    pub settings: String,
    pub quit: String,
    pub tooltip: String,
}

impl TrayLabels {
    /// 与词典 misc.tray.* 的 zh 值逐字一致；webview 未就绪时托盘先显示这套默认值。
    pub fn zh() -> Self {
        Self {
            toggle: "显示/隐藏悬浮条".into(),
            refresh: "立即刷新配额".into(),
            settings: "设置...".into(),
            quit: "退出 Pulse".into(),
            tooltip: "Pulse - AI 配额监控器".into(),
        }
    }
}

/// 前端 emit 的 payload 是 JSON 对象字符串；解析失败返回 None（托盘保持当前标签，不 panic）。
fn parse_labels(payload: &str) -> Option<TrayLabels> {
    serde_json::from_str(payload).ok()
}

/// 按标签构建托盘菜单。菜单项 id（toggle/refresh/settings/quit）与事件分支一一对应，
/// 重建后 on_menu_event 处理器继续生效。
fn build_menu(app: &AppHandle, labels: &TrayLabels) -> tauri::Result<Menu<tauri::Wry>> {
    let show = MenuItem::with_id(app, "toggle", &labels.toggle, true, None::<&str>)?;
    let refresh = MenuItem::with_id(app, "refresh", &labels.refresh, true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", &labels.settings, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", &labels.quit, true, None::<&str>)?;
    Menu::with_items(app, &[&show, &refresh, &settings, &quit])
}

pub fn setup_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let labels = TrayLabels::zh();
    let menu = build_menu(app, &labels)?;

    let icon = match app.default_window_icon() {
        Some(i) => i.clone(),
        None => tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png"))?,
    };

    let _tray = TrayIconBuilder::with_id("pulse-tray")
        .tooltip(&labels.tooltip)
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
                            crate::reveal_rail(app);
                            let app_c = app.clone();
                            tauri::async_runtime::spawn(async move {
                                let s = app_c.state::<crate::AppState>().settings.lock().await.clone();
                                *app_c.state::<crate::AppState>().window_mode.lock().await = "rail".into();
                                *app_c.state::<crate::AppState>().last_cursor_over.lock().unwrap() = std::time::Instant::now();
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
                    crate::reveal_rail(app);
                    let app_c = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let s = app_c.state::<crate::AppState>().settings.lock().await.clone();
                        *app_c.state::<crate::AppState>().window_mode.lock().await = "rail".into();
                        *app_c.state::<crate::AppState>().last_cursor_over.lock().unwrap() = std::time::Instant::now();
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

    // 语言切换（Round5c 项目一）：前端 trayBridge 在启动与 settings.language 变化时
    // emit "pulse-tray-labels"；这里解析并重建菜单与 tooltip。解析失败/无托盘句柄时
    // 保持现状（webview 未就绪前托盘已是 zh 默认值，同值重发幂等）。
    let handle = app.clone();
    app.listen("pulse-tray-labels", move |event| {
        let Some(labels) = parse_labels(event.payload()) else { return; };
        let Ok(menu) = build_menu(&handle, &labels) else { return; };
        if let Some(tray) = handle.tray_by_id("pulse-tray") {
            let _ = tray.set_menu(Some(menu));
            let _ = tray.set_tooltip(Some(labels.tooltip.as_str()));
        }
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tray_labels_parse_frontend_payload() {
        // 与 src/trayBridge.tsx trayLabelPayload 的字段一一对应（misc.i18n.test.tsx 钉住另一侧）。
        let payload = r#"{"toggle":"t","refresh":"r","settings":"s","quit":"q","tooltip":"tt"}"#;
        let l = parse_labels(payload).expect("应能解析前端标签 payload");
        assert_eq!(l.toggle, "t");
        assert_eq!(l.refresh, "r");
        assert_eq!(l.settings, "s");
        assert_eq!(l.quit, "q");
        assert_eq!(l.tooltip, "tt");
    }

    #[test]
    fn tray_labels_reject_garbage_and_partial_payload() {
        // 坏 payload 一律静默回落（托盘保持当前标签，绝不 panic、绝不编造文案）。
        assert!(parse_labels("not json").is_none());
        assert!(parse_labels("null").is_none());
        assert!(parse_labels(r#"{"toggle":"t"}"#).is_none(), "缺字段整单拒绝");
        assert!(parse_labels(r#"{"toggle":1,"refresh":"r","settings":"s","quit":"q","tooltip":"tt"}"#).is_none(), "类型不符拒绝");
    }

    #[test]
    fn tray_default_labels_match_dictionary_zh_verbatim() {
        // 与 src/lib/i18n.ts misc.tray.* 的 zh 值逐字一致；词典 zh 改动必须同步这里。
        let l = TrayLabels::zh();
        assert_eq!(l.toggle, "显示/隐藏悬浮条");
        assert_eq!(l.refresh, "立即刷新配额");
        assert_eq!(l.settings, "设置...");
        assert_eq!(l.quit, "退出 Pulse");
        assert_eq!(l.tooltip, "Pulse - AI 配额监控器");
    }
}
