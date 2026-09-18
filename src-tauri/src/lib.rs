pub mod commands;
pub mod config;
pub mod providers;
pub mod secrets;
pub mod types;
pub mod cache;
pub mod ledger;
pub mod window;
pub mod tray;
pub mod alerts;
pub mod platform;
use std::{collections::HashMap,time::{Duration,Instant},sync::atomic::{AtomicBool,Ordering}};
use tauri::{AppHandle,Emitter,Manager};
use tokio::sync::Mutex;
use types::{AppSettings,HotkeySettings,ProviderUsage};

pub struct AppState {
    pub settings:Mutex<AppSettings>,pub cached_usages:Mutex<Vec<ProviderUsage>>,
    pub refresh_gate:Mutex<()>,pub schedule:Mutex<HashMap<String,(Instant,u32)>>,
    pub configuration_error:std::sync::Mutex<Option<String>>,pub http:reqwest::Client,
    pub window_mode:Mutex<String>,pub user_hidden:AtomicBool,
    pub ledger_gate:Mutex<()>,
    pub alerts:Mutex<alerts::Memory>,
    pub detail_account:std::sync::Mutex<Option<String>>,
    pub account_generations:Mutex<HashMap<String,u64>>,
}
impl AppState {
    pub fn config_error(&self)->Option<String>{self.configuration_error.lock().ok().and_then(|g|g.clone())}
    /// A successful save from the UI has replaced the unreadable file.
    pub fn clear_config_error(&self){if let Ok(mut g)=self.configuration_error.lock(){*g=None}}
    pub async fn bump_account_gen(&self, account_id: &str) -> u64 {
        let mut g = self.account_generations.lock().await;
        let next = g.get(account_id).copied().unwrap_or(0).wrapping_add(1);
        g.insert(account_id.to_string(), next);
        next
    }
}
pub fn toggle_rail(app:&AppHandle){
    let state=app.state::<AppState>();
    let hidden=!state.user_hidden.load(Ordering::Relaxed);
    state.user_hidden.store(hidden,Ordering::Relaxed);
    if !hidden{let _=app.emit("reveal-rail",());}
}
/// (Re)binds the two global shortcuts; a conflict or bad spec fails the whole call so the
/// caller can keep the previous bindings and tell the user.
pub fn apply_hotkeys(app:&AppHandle,hk:&HotkeySettings)->Result<(),String>{
    use tauri_plugin_global_shortcut::{GlobalShortcutExt,Shortcut,ShortcutState};
    let gs=app.global_shortcut();
    let _=gs.unregister_all();
    for (spec,action) in [(&hk.open_settings,"settings"),(&hk.toggle_rail,"rail")]{
        let Some(spec)=spec.as_deref() else{continue};
        let shortcut:Shortcut=spec.parse().map_err(|_|format!("快捷键格式无效：{spec}"))?;
        let handle=app.clone();
        gs.on_shortcut(shortcut,move|_,_,event|{
            if event.state==ShortcutState::Pressed{ if action=="settings"{open_settings_window(&handle)}else{toggle_rail(&handle)} }
        }).map_err(|e|format!("快捷键 {spec} 注册失败，可能已被其他程序占用（{e}）"))?;
    }
    Ok(())
}
pub fn notify(app:&AppHandle,title:&str,body:&str)->Result<(),String>{
    use tauri_plugin_notification::NotificationExt;
    app.notification().builder().title(title).body(body).show().map_err(|e|format!("通知发送失败：{e}"))
}
pub fn open_settings_window(app:&AppHandle){
    if let Some(w)=app.get_webview_window("settings"){
        let _=w.show();
        let _=w.unminimize();
        let _=w.set_focus();
    } else {
        let _ = tauri::WebviewWindowBuilder::new(
            app,
            "settings",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .title("Pulse 设置")
        .inner_size(900.0, 700.0)
        .min_inner_size(700.0, 480.0)
        .resizable(true)
        .decorations(true)
        .center()
        // Windows: the native drop handler swallows HTML5 drag events the reorder list relies on.
        .disable_drag_drop_handler()
        .build();
    }
}
pub async fn refresh_usages_and_emit(app:&AppHandle)->Result<Vec<ProviderUsage>,String>{
    let state=app.state::<AppState>();
    let Ok(_gate)=state.refresh_gate.try_lock() else {
        return Ok(state.cached_usages.lock().await.clone());
    };
    if let Some(e)=state.config_error(){return Err(e)}
    let settings=state.settings.lock().await.clone();
    let now=Instant::now();
    let mut due=settings.clone();
    {let schedule=state.schedule.lock().await;for (id,cfg) in due.providers.iter_mut(){if schedule.get(id).is_some_and(|(at,_)|*at>now){cfg.enabled=false}}}
    let start_gens=state.account_generations.lock().await.clone();
    let mut rx=providers::fetch_all_stream(&due,&state.http);
    let mut incoming=vec![];

    while let Some(fresh)=rx.recv().await {
        incoming.push(fresh.clone());
        let current_settings=state.settings.lock().await.clone();
        let id=fresh.account_id.clone();
        // Drop late response if account was deleted or modified during fetch
        if !current_settings.providers.contains_key(&id) { continue; }
        {
            let end_gens=state.account_generations.lock().await;
            if start_gens.get(&id) != end_gens.get(&id) { continue; }
        }

        let mut cached=state.cached_usages.lock().await;
        let mut schedule=state.schedule.lock().await;

        let previous=cached.iter().find(|u|u.account_id==id);
        let failures=if fresh.state=="live"{0}else{schedule.get(&id).map(|v|v.1).unwrap_or(0).saturating_add(1)};
        let delay=if failures==0{current_settings.refresh_interval_seconds}else{fresh.retry_after_seconds.unwrap_or((30u64.saturating_mul(1u64<<failures.min(6))).min(1800)).max(current_settings.refresh_interval_seconds)};
        schedule.insert(id.clone(),(Instant::now()+Duration::from_secs(delay),failures));
        let pin=current_settings.providers.get(&id).and_then(|c|c.primary_window.as_deref());
        let result=cache::reconcile_with_pin(fresh,previous,pin,cache::now());
        cached.retain(|u|u.account_id!=id);cached.push(result);
        cached.retain(|u|current_settings.providers.get(&u.account_id).is_some_and(|c|c.enabled));
        for u in cached.iter_mut(){
            let pin=current_settings.providers.get(&u.account_id).and_then(|c|c.primary_window.as_deref());
            *u=cache::expire_with_pin(u.clone(),pin,cache::now());
        }
        cached.sort_by_key(|u|current_settings.providers.get(&u.account_id).map(|c|c.order).unwrap_or(0));
        let snapshot=cached.clone();
        drop(schedule);
        drop(cached);

        let _=app.emit("usages-updated",&snapshot);
    }

    // Notices are judged on this cycle's raw fetches, before cache reconciliation can mask a failure.
    let notices={
        let mut mem=state.alerts.lock().await;
        let (notices,next)=alerts::evaluate(&incoming,&settings,mem.clone(),cache::now());
        if next!=*mem{*mem=next;let path=config::get_config_dir().join("alerts.json");let snapshot=mem.clone();let _=tauri::async_runtime::spawn_blocking(move||alerts::save(&path,&snapshot)).await;}
        notices
    };
    for n in &notices{let _=notify(app,&n.title,&n.body);}

    let final_cached=state.cached_usages.lock().await.clone();
    // This cache is sanitized and only used for --json, never for credentials or fallback across launches.
    if let Ok(bytes)=serde_json::to_vec(&final_cached){let path=config::get_config_dir().join("usage-cache.json");let _=tauri::async_runtime::spawn_blocking(move||config::atomic_write(&path,&bytes)).await;}
    Ok(final_cached)
}

#[cfg_attr(mobile,tauri::mobile_entry_point)]
pub fn run(){
    if !crate::platform::is_webview2_available() {
        crate::platform::show_missing_webview2_dialog();
        std::process::exit(1);
    }
    let (data_dir, mode) = match config::init_config_dir() {
        Ok(res) => res,
        Err(e) => {
            eprintln!("Pulse 初始化失败: {e}");
            #[cfg(windows)] {
                use windows::{core::PCWSTR, Win32::UI::WindowsAndMessaging::*};
                let title: Vec<u16> = "Pulse 初始化失败\0".encode_utf16().collect();
                let msg: Vec<u16> = format!("{e}\0").encode_utf16().collect();
                unsafe { let _ = MessageBoxW(None, PCWSTR(msg.as_ptr()), PCWSTR(title.as_ptr()), MB_OK | MB_ICONERROR); }
            }
            std::process::exit(1);
        }
    };
    if mode == config::ConfigMode::Portable || std::env::var_os("PULSE_DATA_DIR").is_some() {
        let wv2_dir = data_dir.join("webview2");
        let _ = std::fs::create_dir_all(&wv2_dir);
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", wv2_dir);
    }
    if std::env::args().any(|a|a=="--json"){
        let path=config::get_config_dir().join("usage-cache.json");
        let readings:Vec<ProviderUsage>=std::fs::read(path).ok().and_then(|b|serde_json::from_slice(&b).ok()).unwrap_or_default();
        println!("{}",serde_json::to_string(&readings.into_iter().map(|r|cache::expire(r,cache::now())).collect::<Vec<_>>()).unwrap_or_else(|_|"[]".into()));return;
    }
    let (settings,error)=match config::load_settings(){Ok(s)=>(s,None),Err(e)=>(AppSettings::default(),Some(e))};
    let http=providers::client().expect("HTTP client initialization failed");
    let settings_start_hidden=settings.start_behavior=="tray";
    let state=AppState{settings:Mutex::new(settings),cached_usages:Mutex::new(vec![]),refresh_gate:Mutex::new(()),schedule:Mutex::new(HashMap::new()),configuration_error:std::sync::Mutex::new(error),http,window_mode:Mutex::new("rail".into()),user_hidden:AtomicBool::new(settings_start_hidden),ledger_gate:Mutex::new(()),alerts:Mutex::new(alerts::load(&config::get_config_dir().join("alerts.json"))),detail_account:std::sync::Mutex::new(None),account_generations:Mutex::new(HashMap::new())};
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app,_,_|open_settings_window(app)))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(state)
        .setup(|app|{
            let app=app.handle();tray::setup_tray(app)?;
            let handle=app.clone();
            let window_handle=app.clone();
            tauri::async_runtime::spawn(async move{
                loop{
                    let state=window_handle.state::<AppState>();
                    let settings=state.settings.lock().await.clone();
                    let mode=state.window_mode.lock().await.clone();
                    let user_hidden=state.user_hidden.load(Ordering::Relaxed);
                    // Monitor enumeration and the foreground probe are synchronous Win32 calls;
                    // keep them off the async workers that serve IPC commands.
                    let tick_handle=window_handle.clone();
                    let _=tauri::async_runtime::spawn_blocking(move||{
                        let Some(w)=tick_handle.get_webview_window("main")else{return};
                        let hide=user_hidden || !settings.show_rail || (settings.hide_fullscreen && window::fullscreen_other(&tick_handle));
                        if hide {
                            if w.is_visible().unwrap_or(false){let _=w.hide();}
                        } else {
                            if !w.is_visible().unwrap_or(false) {
                                let _=w.show();
                                let _=w.set_always_on_top(true);
                            }
                            if mode != "expanded" && settings.dock_side != "free" {
                                window::position(&tick_handle,&settings,&mode);
                            }
                        }
                    }).await;
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            });
            tauri::async_runtime::spawn(async move{
                if let Some(w) = handle.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_always_on_top(true);
                }
                let settings=handle.state::<AppState>().settings.lock().await.clone();
                window::position(&handle,&settings,"rail");
                if std::env::args().any(|a| a == "--settings") || settings.start_behavior=="settings" || handle.state::<AppState>().config_error().is_some() {
                    open_settings_window(&handle);
                }
                // A conflict at launch must not stop the app; the settings page reports it on the next save.
                let _=apply_hotkeys(&handle,&settings.hotkeys);
                loop {
                    let _ = refresh_usages_and_emit(&handle).await;
                    let interval = {
                        let state = handle.state::<AppState>();
                        let s = state.settings.lock().await;
                        s.refresh_interval_seconds.clamp(30, 3600)
                    };
                    tokio::time::sleep(Duration::from_secs(interval)).await;
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
        .invoke_handler(tauri::generate_handler![commands::get_settings,commands::update_settings,commands::get_usages,commands::refresh_usages,commands::set_window_state,commands::open_settings,commands::close_settings_window,commands::set_credential,commands::delete_credential,commands::delete_account,commands::diagnostics,commands::test_account,commands::token_spend,commands::monitors,commands::startup_enabled,commands::set_startup,commands::notification_status,commands::test_notification,commands::begin_free_drag,commands::commit_free_position,commands::show_detail,commands::hide_detail,commands::detail_account,commands::set_detail_hover,commands::is_portable,commands::get_profile_info,commands::clear_profile_credentials,commands::create_isolated_profile])
        .run(tauri::generate_context!()).expect("Pulse runtime failed");
}
