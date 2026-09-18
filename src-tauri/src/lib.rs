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
pub mod activity;
pub mod platform;
use std::{collections::HashMap,time::{Duration,Instant},sync::atomic::{AtomicBool,AtomicU64,Ordering},sync::Arc};
use tauri::{AppHandle,Emitter,Manager};
use tokio::sync::{Mutex,Semaphore};
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
    pub refresh_slots:Arc<Semaphore>,
    pub inflight:Mutex<HashMap<String,u64>>,
    pub request_counter:AtomicU64,
    pub activity:std::sync::Mutex<HashMap<String,(bool,String)>>,
    pub activity_watcher:std::sync::Mutex<activity::Watcher>,
    pub app_handle:std::sync::OnceLock<tauri::AppHandle>,
    pub dragging:AtomicBool,
    pub drag_grab:std::sync::Mutex<(i32,i32)>,
    pub drag_side:std::sync::Mutex<String>,
    pub drag_ratio:std::sync::Mutex<(f64,f64)>,
    pub drag_monitors:std::sync::Mutex<Vec<tauri::Monitor>>,
}
impl AppState {
    pub fn config_error(&self)->Option<String>{self.configuration_error.lock().ok().and_then(|g|g.clone())}
    /// A successful save from the UI has replaced the unreadable file.
    pub fn clear_config_error(&self){if let Ok(mut g)=self.configuration_error.lock(){*g=None}}
    pub fn next_request_id(&self)->u64{self.request_counter.fetch_add(1,Ordering::Relaxed)+1}
    pub fn activity_flag(&self,account_id:&str)->bool{
        self.activity.lock().ok().and_then(|m|m.get(account_id).map(|(a,_)|*a)).unwrap_or(false)
    }

    /// Refresh one account on demand: merged clicks reuse the in-flight request, the
    /// server's backoff window is respected, and timeouts write a failure reading.
    pub async fn refresh_account_now(app:&AppHandle,account_id:&str)->Result<u64,String>{
        let state=app.state::<AppState>();
        if let Some(e)=state.config_error(){return Err(e)}
        let settings=state.settings.lock().await.clone();
        let Some(cfg)=settings.providers.get(account_id)else{return Err("账号不存在".into())};
        if !cfg.enabled{return Err("账号未启用；先保存账号设置".into())}
        // Honour the provider's backoff window from the last failed attempt.
        {
            let schedule=state.schedule.lock().await;
            if let Some((at,failures))=schedule.get(account_id){
                if *failures>0 && *at>Instant::now(){
                    let left=at.duration_since(Instant::now()).as_secs().max(1);
                    return Err(format!("服务商限流/退避中，约 {} 秒后可重试",left));
                }
            }
        }
        let created;
        let request_id={
            let mut inflight=state.inflight.lock().await;
            if let Some(&existing)=inflight.get(account_id){created=false;existing}
            else{created=true;let id=state.next_request_id();inflight.insert(account_id.to_string(),id);id}
        };
        if created{
            let _=app.emit("refresh-state",serde_json::json!({"account_id":account_id,"request_id":request_id,"phase":"started"}));
            let generation=state.account_generations.lock().await.get(account_id).copied().unwrap_or(0);
            let http=state.http.clone();let cfg_clone=cfg.clone();
            let aid=account_id.to_string();let app2=app.clone();
            let slots=state.refresh_slots.clone();
            tauri::async_runtime::spawn(async move{
                let permit=slots.acquire_owned().await;
                let reading=match permit{
                    Ok(p)=>{let _p=p;tokio::time::timeout(Duration::from_secs(25),providers::fetch_one(&aid,&cfg_clone,&http)).await.ok()}
                    Err(_)=>None,
                };
                let st=app2.state::<AppState>();
                let still_valid={
                    let s=st.settings.lock().await;
                    s.providers.get(&aid).is_some_and(|c|c.enabled)
                    && st.account_generations.lock().await.get(&aid).copied().unwrap_or(0)==generation
                };
                st.inflight.lock().await.remove(&aid);
                let (ok,kind)=match (&reading,still_valid){
                    (_,false)=>(false,"stale".to_string()),
                    (None,true)=>(false,"timeout".to_string()),
                    (Some(r),true)=>(r.state=="live",if r.state=="live"{"live".to_string()}else{r.error_code.clone().unwrap_or_else(||r.state.clone())}),
                };
                if still_valid{
                    // A timeout must be visible as a failure, not a silently stale reading.
                    let r=reading.unwrap_or_else(||{
                        let mut r=ProviderUsage::problem(&cfg_clone.provider_id,"timeout","查询超时；稍后自动重试");
                        r.account_id=aid.clone();r.display_name=cfg_clone.label.clone();
                        r
                    });
                    let _=apply_single_reading(&app2,&aid,r).await;
                }
                let _=app2.emit("refresh-state",serde_json::json!({"account_id":aid,"request_id":request_id,"phase":"finished","ok":ok,"kind":kind}));
            });
        }
        Ok(request_id)
    }
    pub async fn bump_account_gen(&self, account_id: &str) -> u64 {
        let mut g = self.account_generations.lock().await;
        let next = g.get(account_id).copied().unwrap_or(0).wrapping_add(1);
        g.insert(account_id.to_string(), next);
        next
    }
}
pub static RAIL_APP:std::sync::OnceLock<tauri::AppHandle>=std::sync::OnceLock::new();
/// WebView2 在控制器层吞掉右键事件：在原生窗口过程上挂子类，直接捕获 WM_RBUTTONUP。
pub fn rail_menu(app:tauri::AppHandle)->Result<(),String>{
    use tauri::menu::{ContextMenu,Menu,MenuItem};
    use tauri::Manager as _;
    let win=app.get_webview_window("main").ok_or("窗口不存在")?;
    let m_set=MenuItem::with_id(&app,"rail-settings","设置…",true,None::<&str>).map_err(|e|e.to_string())?;
    let m_ref=MenuItem::with_id(&app,"rail-refresh","立即刷新",true,None::<&str>).map_err(|e|e.to_string())?;
    let m_tog=MenuItem::with_id(&app,"rail-toggle","显示 / 隐藏悬浮栏",true,None::<&str>).map_err(|e|e.to_string())?;
    let m_quit=MenuItem::with_id(&app,"rail-quit","退出 Pulse",true,None::<&str>).map_err(|e|e.to_string())?;
    let menu=Menu::with_items(&app,&[&m_set,&m_ref,&m_tog,&m_quit]).map_err(|e|e.to_string())?;
    let native=win.as_ref().window();
    menu.popup(native).map_err(|e|e.to_string())
}
pub fn install_rail_context_menu_subclass(app:&AppHandle){
    use windows::Win32::Foundation::{HWND,LPARAM,LRESULT,WPARAM};
    use windows::Win32::UI::Shell::{DefSubclassProc,SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::{WM_RBUTTONUP};
    extern "system" fn proc(hwnd:HWND,msg:u32,wp:WPARAM,lp:LPARAM,_id:usize,_data:usize)->LRESULT{
        if msg==WM_RBUTTONUP{
            if let Some(app)=RAIL_APP.get(){
                let app=app.clone();
                let _=rail_menu(app);
            }
        }
        unsafe{DefSubclassProc(hwnd,msg,wp,lp)}
    }
    if let Some(win)=app.get_webview_window("main"){
        if let Ok(h)=win.hwnd(){
            unsafe{
                let _=SetWindowSubclass(HWND(h.0),Some(proc),1,0);
            }
        }
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
    {let schedule=state.schedule.lock().await;
     let inflight=state.inflight.lock().await;
     for (id,cfg) in due.providers.iter_mut(){
        // 手动刷新在途的账号由该请求负责写回，定时轮不再重复发起。
        if inflight.contains_key(id){cfg.enabled=false}
        else if schedule.get(id).is_some_and(|(at,_)|*at>now){cfg.enabled=false}
     }}
    let start_gens=state.account_generations.lock().await.clone();
    let mut rx=providers::fetch_all_stream(&due,&state.http,state.refresh_slots.clone());
    let mut incoming=vec![];
    let mut passed:Vec<ProviderUsage>=vec![];

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
        passed.push(fresh.clone());

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
            u.is_active=state.activity_flag(&u.account_id);
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
        let (notices,next)=alerts::evaluate(&passed,&settings,mem.clone(),cache::now());
        if next!=*mem{*mem=next;let path=config::get_config_dir().join("alerts.json");let snapshot=mem.clone();let _=tauri::async_runtime::spawn_blocking(move||alerts::save(&path,&snapshot)).await;}
        notices
    };
    for n in &notices{let _=notify(app,&n.title,&n.body);}

    let final_cached=state.cached_usages.lock().await.clone();
    // This cache is sanitized and only used for --json, never for credentials or fallback across launches.
    if let Ok(bytes)=serde_json::to_vec(&final_cached){let path=config::get_config_dir().join("usage-cache.json");let _=tauri::async_runtime::spawn_blocking(move||config::atomic_write(&path,&bytes)).await;}
    Ok(final_cached)
}

/// Apply one freshly fetched reading with the same reconcile/schedule/emit semantics as
/// the scheduled stream.
async fn apply_single_reading(app:&AppHandle,account_id:&str,fresh:ProviderUsage)->Result<(),String>{
    let state=app.state::<AppState>();
    let current_settings=state.settings.lock().await.clone();
    let mut cached=state.cached_usages.lock().await;
    let mut schedule=state.schedule.lock().await;
    let previous=cached.iter().find(|u|u.account_id==account_id);
    let failures=if fresh.state=="live"{0}else{schedule.get(account_id).map(|v|v.1).unwrap_or(0).saturating_add(1)};
    let delay=if failures==0{current_settings.refresh_interval_seconds}else{fresh.retry_after_seconds.unwrap_or((30u64.saturating_mul(1u64<<failures.min(6))).min(1800)).max(current_settings.refresh_interval_seconds)};
    schedule.insert(account_id.to_string(),(Instant::now()+Duration::from_secs(delay),failures));
    let pin=current_settings.providers.get(account_id).and_then(|c|c.primary_window.as_deref());
    let result=cache::reconcile_with_pin(fresh,previous,pin,cache::now());
    cached.retain(|u|u.account_id!=account_id);cached.push(result);
    cached.retain(|u|current_settings.providers.get(&u.account_id).is_some_and(|c|c.enabled));
    for u in cached.iter_mut(){
        let pin=current_settings.providers.get(&u.account_id).and_then(|c|c.primary_window.as_deref());
        *u=cache::expire_with_pin(u.clone(),pin,cache::now());
        u.is_active=state.activity_flag(&u.account_id);
    }
    cached.sort_by_key(|u|current_settings.providers.get(&u.account_id).map(|c|c.order).unwrap_or(0));
    let snapshot=cached.clone();
    drop(schedule);drop(cached);
    app.emit("usages-updated",&snapshot).map_err(|_|"无法通知窗口".to_string())?;
    Ok(())
}

/// Poll CLI activity every 5s; merge into cached readings and emit only on change.
/// Locks are std (short, no await); any poisoned lock skips one tick.
fn poll_activity(app:&AppHandle){
    let state=app.state::<AppState>();
    let (Ok(mut watcher),Ok(settings))=(state.activity_watcher.lock(),state.settings.try_lock())else{return};
    let sources=watcher.poll(cache::now());
    drop(settings);
    let mut changed=false;
    let Ok(mut map)=state.activity.lock()else{return};
    for (source,active) in sources{
        let Ok(settings)=state.settings.try_lock()else{return};
        let ids:Vec<String>=settings.providers.iter()
            .filter(|(_,c)|c.enabled&&c.provider_id==source)
            .map(|(id,_)|id.clone()).collect();
        drop(settings);
        let single=ids.len()==1;
        for id in ids{
            let newv=(single&&active,if single{"measured".to_string()}else{"unknown".to_string()});
            if map.get(&id)!=Some(&newv){map.insert(id,newv);changed=true;}
        }
    }
    if !changed{return}
    drop(map);
    let mut updated:Vec<ProviderUsage>=vec![];
    if let Ok(mut cached)=state.cached_usages.try_lock(){
        for u in cached.iter_mut(){u.is_active=state.activity_flag(&u.account_id);}
        updated=cached.clone();
    }
    if !updated.is_empty(){let _=app.emit("usages-updated",&updated);}
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
    // profile_id exists from first run, not first credential use.
    let _=config::get_profile();
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
    let state=AppState{settings:Mutex::new(settings),cached_usages:Mutex::new(vec![]),refresh_gate:Mutex::new(()),schedule:Mutex::new(HashMap::new()),configuration_error:std::sync::Mutex::new(error),http,window_mode:Mutex::new("rail".into()),user_hidden:AtomicBool::new(settings_start_hidden),ledger_gate:Mutex::new(()),alerts:Mutex::new(alerts::load(&config::get_config_dir().join("alerts.json"))),detail_account:std::sync::Mutex::new(None),account_generations:Mutex::new(HashMap::new()),refresh_slots:Arc::new(Semaphore::new(4)),inflight:Mutex::new(HashMap::new()),request_counter:AtomicU64::new(0),activity:std::sync::Mutex::new(HashMap::new()),activity_watcher:std::sync::Mutex::new(activity::Watcher::new(activity::Watcher::system_roots())),app_handle:std::sync::OnceLock::new(),dragging:AtomicBool::new(false),drag_grab:std::sync::Mutex::new((0,0)),drag_side:std::sync::Mutex::new("free".into()),drag_ratio:std::sync::Mutex::new((0.5,0.5)),drag_monitors:std::sync::Mutex::new(Vec::new())};
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app,_,_|open_settings_window(app)))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(state)
        .setup(|app|{
            let app_handle=app.handle().clone();
            let _=app.state::<AppState>().app_handle.set(app_handle.clone());
            let _=RAIL_APP.set(app_handle.clone());
            tray::setup_tray(&app_handle)?;
            let handle=app_handle.clone();
            let window_handle=app_handle.clone();
            install_rail_context_menu_subclass(&app_handle);
            tauri::async_runtime::spawn(async move{
                loop{
                    let state=window_handle.state::<AppState>();
                    let settings=state.settings.lock().await.clone();
                    let mode=state.window_mode.lock().await.clone();
                    let user_hidden=state.user_hidden.load(Ordering::Relaxed);
                    // A drag owns placement. Monitor enumeration and the foreground probe are
                    // synchronous Win32 calls; keep them off the async workers that serve IPC.
                    let tick_handle=window_handle.clone();
                    let dragging=state.dragging.load(Ordering::Relaxed);
                    let _=tauri::async_runtime::spawn_blocking(move||{
                        if dragging{return}
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
            tauri::async_runtime::spawn(async move{
                let poll_handle=app_handle.clone();
                    loop{tokio::time::sleep(Duration::from_secs(5)).await;poll_activity(&poll_handle);}
            });
            Ok(())
        })
        .on_menu_event(|app,event|{
            match event.id().0.as_str(){
                "rail-settings"=>open_settings_window(app),
                "rail-refresh"=>{let a=app.clone();tauri::async_runtime::spawn(async move{let _=refresh_usages_and_emit(&a).await;});}
                "rail-toggle"=>toggle_rail(app),
                "rail-quit"=>app.exit(0),
                _=>{}
            }
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "settings" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![commands::get_settings,commands::update_settings,commands::get_usages,commands::refresh_usages,commands::refresh_account,commands::drag_begin,commands::drag_move,commands::drag_end,commands::drag_cancel,commands::rail_menu_cmd,commands::set_window_state,commands::open_settings,commands::close_settings_window,commands::set_credential,commands::delete_credential,commands::delete_account,commands::diagnostics,commands::test_account,commands::token_spend,commands::monitors,commands::startup_enabled,commands::set_startup,commands::notification_status,commands::test_notification,commands::begin_free_drag,commands::commit_free_position,commands::show_detail,commands::hide_detail,commands::detail_account,commands::set_detail_hover,commands::is_portable,commands::get_profile_info,commands::clear_profile_credentials,commands::create_isolated_profile])
        .run(tauri::generate_context!()).expect("Pulse runtime failed");
}
