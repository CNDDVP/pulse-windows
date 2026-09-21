use std::sync::atomic::Ordering;
use crate::{types::{AppSettings,ProviderUsage},secrets::{SecretStore,WindowsSecrets},AppState};
use tauri::{AppHandle,Emitter,State,Manager};
#[tauri::command]
pub fn publish_rail_warning(window:tauri::Window,app:AppHandle,snapshot:serde_json::Value)->Result<(),String>{
    if window.label()!="main" || snapshot.to_string().len()>65536 {return Err("收纳条状态来源无效".into());}
    app.emit_to("settings","rail-warning-state",snapshot).map_err(|_|"收纳条状态同步失败".into())
}
fn needs_initial_refresh(old:Option<&crate::types::ProviderConfig>,next:&crate::types::ProviderConfig,has_reading:bool)->bool {
    next.enabled && !has_reading && old.is_none_or(|previous|!previous.enabled || previous.use_local!=next.use_local)
}
#[tauri::command]
pub async fn token_spend(days:u32,state:State<'_,AppState>)->Result<crate::ledger::Summary,String>{
    if crate::updater::applying(){return Err("正在退出升级，请稍后操作".into())}
    {
        let s = state.settings.lock().await;
        if !s.token_spend_enabled {
            return Err("Token 消耗统计未启用；请在常规设置中开启".into());
        }
    }
    let scan_id = state.next_ledger_scan_id();
    let current_id = state.ledger_scan_id.clone();
    let is_cancelled = move || current_id.load(Ordering::Relaxed) != scan_id;

    let _gate=state.ledger_gate.lock().await;
    if is_cancelled() {
        return Err("已取消".into());
    }
    tauri::async_runtime::spawn_blocking(move||crate::ledger::scan_with_cancel(days, &is_cancelled)).await.map_err(|_|"统计任务失败")?
}
#[tauri::command]
pub fn cancel_token_spend(state:State<'_,AppState>){
    state.cancel_ledger_scan();
}
#[derive(serde::Serialize)]
pub struct MonitorOption{pub name:String,pub label:String}
#[tauri::command]
pub fn monitors(app:AppHandle)->Result<Vec<MonitorOption>,String>{
    let window=app.get_webview_window("main").ok_or("窗口不存在")?;
    let friendly=crate::window::friendly_monitor_names();
    let primary=window.primary_monitor().ok().flatten().and_then(|m|m.name().cloned());
    Ok(window.available_monitors().map_err(|_|"显示器查询失败")?.iter().enumerate().filter_map(|(i,m)|{
        // `name` stays the stable GDI id the settings file stores; only the label is human.
        let name=m.name()?.clone();let size=m.size();let scale=(m.scale_factor()*100.0).round() as u32;
        let model=friendly.get(&name).cloned().unwrap_or_else(||format!("显示器 {}",i+1));
        let mut label=format!("{model} · {}×{} @{scale}%",size.width,size.height);
        if primary.as_deref()==Some(name.as_str()){label.push_str(" · 主屏");}
        Some(MonitorOption{name,label})
    }).collect())
}
#[tauri::command]
pub async fn get_settings(state:State<'_,AppState>)->Result<AppSettings,String>{
    // Defaults are returned even when settings.json failed to load, so the UI can
    // repair the file; the failure itself is surfaced through `diagnostics`.
    Ok(state.settings.lock().await.clone())
}
#[tauri::command]
pub async fn update_settings(mut new_settings:AppSettings,state:State<'_,AppState>,app:AppHandle)->Result<AppSettings,String>{
    if crate::updater::applying(){return Err("正在退出升级，请稍后操作".into())}
    new_settings.validate()?;
    // 事务化（A03）：从读快照到写盘、写回内存全程持 settings_io 锁，串行化所有
    // 设置写路径——并发保存/拖拽/凭据操作交错时不再互相覆盖。
    let _io=state.settings_io.lock().await;
    let old=state.settings.lock().await.clone();
    // 位置口径无条件以后端为准（B01）：位置的唯一写方是拖拽/窗口路径，设置表单
    // 不编辑位置——表单快照里的旧位置不得把刚拖好的位置改回去。
    new_settings.dock_side=old.dock_side.clone();
    new_settings.monitor_name=old.monitor_name.clone();
    new_settings.free_x=old.free_x;
    new_settings.free_y=old.free_y;
    if new_settings.generation!=0 && new_settings.generation!=old.generation{
        // 其余字段仍以用户表单为准；代际差保留给在途结果失效判定。
        new_settings.generation=old.generation;
    }
    // An existing account cannot silently change the provider that receives its credential.
    for (id,cfg) in &new_settings.providers{if old.providers.get(id).is_some_and(|c|c.provider_id!=cfg.provider_id){return Err("不能更改已有账号的服务商，请新建账号".into())}}
    if new_settings.hotkeys!=old.hotkeys{
        if let Err(e)=crate::apply_hotkeys(&app,&new_settings.hotkeys){let _=crate::apply_hotkeys(&app,&old.hotkeys);return Err(e)}
    }
    let proxy_changed = new_settings.network_proxy != old.network_proxy;
    if proxy_changed {
        let new_client = crate::providers::client_with_proxy(&new_settings.network_proxy)?;
        *state.http.write().await = new_client;
        for id in new_settings.providers.keys() {
            state.bump_account_gen(id).await;
        }
        state.schedule.lock().await.clear();
        state.inflight.lock().await.clear();
    }
    for (id,cfg) in &new_settings.providers{
        // 凭据来源（use_local）也是结果有效性的边界（B19）：变化即失效在途请求。
        if old.providers.get(id).map(|c|(c.order,c.enabled,&c.label,c.use_local))!=Some((cfg.order,cfg.enabled,&cfg.label,cfg.use_local)){
            state.bump_account_gen(id).await;
        }
    }
    for id in old.providers.keys(){if !new_settings.providers.contains_key(id){state.bump_account_gen(id).await;}}
    new_settings.generation=old.generation.wrapping_add(1);
    let had_error=state.config_error().is_some();
    let new_settings=tauri::async_runtime::spawn_blocking(move||{
        let mut s=new_settings;crate::config::refresh_credential_flags(&mut s)?;
        if had_error{crate::config::backup_settings()?;}
        crate::config::save_settings(&s)?;Ok::<_,String>(s)
    }).await.map_err(|_|"设置保存任务失败")??;
    *state.settings.lock().await=new_settings.clone();state.clear_config_error();
    let mut cached=state.cached_usages.lock().await;
    for u in cached.iter_mut(){
        let pin=new_settings.providers.get(&u.account_id).and_then(|c|c.primary_window.as_deref());
        crate::cache::apply_primary_window(u,pin);
    }
    cached.retain(|u|new_settings.providers.get(&u.account_id).is_some_and(|c|c.enabled));
    // The rail renders readings in array order; a saved reorder must reach it now, not at the next refresh.
    cached.sort_by_key(|u|new_settings.providers.get(&u.account_id).map(|c|c.order).unwrap_or(u32::MAX));
    let retained=cached.clone();drop(cached);
    app.emit("settings-updated",&new_settings).map_err(|_|"设置已保存，但窗口通知失败")?;
    app.emit("usages-updated",&retained).map_err(|_|"窗口通知失败")?;
    // 找出所有已启用但在 cached_usages 中尚无读数的账号（例如新添加的账号），或代理变更时刷所有已启用账号
    let to_refresh_ids: Vec<String> = if proxy_changed {
        new_settings.providers.iter()
            .filter(|(_, cfg)| cfg.enabled)
            .map(|(id, _)| id.clone())
            .collect()
    } else {
        let cached = state.cached_usages.lock().await;
        new_settings.providers.iter()
            .filter(|(id, cfg)| needs_initial_refresh(old.providers.get(*id), cfg, cached.iter().any(|u| &u.account_id == *id)))
            .map(|(id, _)| id.clone())
            .collect()
    };
    if !to_refresh_ids.is_empty() {
        let app_clone = app.clone();
        tauri::async_runtime::spawn(async move {
            for aid in to_refresh_ids {
                let _ = crate::AppState::refresh_account_now(&app_clone, &aid).await;
            }
        });
    }
    let mut mode=state.window_mode.lock().await.clone();
    if new_settings.auto_collapse_seconds == 0 && mode == "collapsed" {
        mode = "rail".into();
        *state.window_mode.lock().await = "rail".into();
        let _ = app.emit("window-state-changed", "rail");
    }
    *state.last_cursor_over.lock().unwrap() = std::time::Instant::now();
    crate::window::position(&app,&new_settings,&mode);Ok(new_settings)
}
#[tauri::command]
pub async fn get_usages(state:State<'_,AppState>)->Result<Vec<ProviderUsage>,String>{
    let settings=state.settings.lock().await.clone();
    let now=crate::cache::now();
    Ok(state.cached_usages.lock().await.iter().cloned().map(|r|{
        let pin=settings.providers.get(&r.account_id).and_then(|c|c.primary_window.as_deref());
        let mut x=crate::cache::expire_with_pin(r,pin,now);
        x.is_active=state.activity_flag(&x.account_id);
        x
    }).collect())
}
#[tauri::command]
pub async fn refresh_usages(app:AppHandle)->Result<crate::RefreshSummary,String>{crate::refresh_usages_and_emit(&app, true).await}
#[tauri::command]
pub async fn refresh_account(account_id:String,app:AppHandle)->Result<u64,String>{crate::AppState::refresh_account_now(&app,&account_id).await}
#[tauri::command]
pub async fn test_account(account_id:String,state:State<'_,AppState>,app:AppHandle)->Result<ProviderUsage,String>{
    let (cfg, is_auth) = {
        let s = state.settings.lock().await;
        let c = s.providers.get(&account_id).cloned().ok_or("账号不存在")?;
        let auth = !s.monitoring_setup_completed || s.authorized_providers.contains(&c.provider_id);
        (c, auth)
    };
    if !is_auth {
        return Err(format!("服务商 {} 未授权监控；请在常规设置中开启授权", cfg.provider_id));
    }
    let http = state.http.read().await.clone();
    let usage=crate::providers::fetch_one(&account_id,&cfg,&http).await;
    let _=crate::apply_single_reading(&app,&account_id,usage.clone(),None).await;
    Ok(usage)
}
#[tauri::command]
pub async fn set_window_state(state:String,app:AppHandle)->Result<(),String>{
    if !["collapsed","rail","expanded"].contains(&state.as_str()){return Err("窗口状态无效".into())}
    if state == "collapsed" {
        let app_state = app.state::<AppState>();
        let settings = app_state.settings.lock().await.clone();
        let interacting = app_state.dragging.load(Ordering::Relaxed) || ["main", "detail"].iter().any(|label|
            app.get_webview_window(label).is_some_and(|w| w.is_visible().unwrap_or(false) && crate::window::is_cursor_over_window(&w)));
        if !crate::rail_state::may_collapse(&settings, *app_state.rail_pin_until.lock().unwrap(), std::time::Instant::now(), interacting) {
            let _ = app.emit("window-state-changed", "rail");
            return Ok(());
        }
    }
    *app.state::<AppState>().window_mode.lock().await=state.clone();
    if state == "rail" {
        *app.state::<AppState>().last_cursor_over.lock().unwrap() = std::time::Instant::now();
    }
    if app.state::<AppState>().dragging.load(Ordering::Relaxed){return Ok(())}
    let settings=app.state::<AppState>().settings.lock().await.clone();crate::window::position(&app,&settings,&state);Ok(())
}
#[tauri::command]
pub fn open_settings(app:AppHandle){crate::open_settings_window(&app)}
#[tauri::command]
pub async fn settings_window_ready(state:State<'_,AppState>,app:AppHandle)->Result<(),String>{
    state.close_coordinator.on_frontend_ready(&app).await;
    Ok(())
}
#[tauri::command]
pub async fn request_close_settings(source:String,state:State<'_,AppState>,app:AppHandle)->Result<u64,String>{
    Ok(state.close_coordinator.request_close(&app,&source).await)
}
#[tauri::command]
pub async fn pending_settings_close(state:State<'_,AppState>)->Result<Option<crate::settings_close::CloseRequestPayload>,String>{
    Ok(state.close_coordinator.pending_close().await)
}
#[tauri::command]
pub async fn acknowledge_close(request_id:u64,has_draft:bool,state:State<'_,AppState>)->Result<(),String>{
    state.close_coordinator.acknowledge_close(request_id,has_draft).await
}
#[tauri::command]
pub async fn confirm_close_settings(request_id:u64,action:String,state:State<'_,AppState>,app:AppHandle)->Result<(),String>{
    state.cancel_ledger_scan();
    state.close_coordinator.confirm_close(&app,request_id,&action).await
}
#[tauri::command]
pub async fn close_settings_window(state:State<'_,AppState>,app:AppHandle)->Result<(),String>{
    state.cancel_ledger_scan();
    state.close_coordinator.confirm_close(&app,0,"discard_and_hide").await
}
#[tauri::command]
pub async fn set_credential(account_id:String,secret:String,state:State<'_,AppState>,app:AppHandle)->Result<(),String>{
    if crate::updater::applying(){return Err("正在退出升级，请稍后操作".into())}
    let _io=state.settings_io.lock().await;
    let mut settings=state.settings.lock().await.clone();
    let pid = settings.providers.get_mut(&account_id).ok_or("账号不存在")?.provider_id.clone();
    settings.providers.get_mut(&account_id).unwrap().credential_configured=true;
    if !settings.authorized_providers.contains(&pid) {
        settings.authorized_providers.push(pid.clone());
    }
    settings.generation=settings.generation.wrapping_add(1);
    let had_error=state.config_error().is_some();
    let had_cred=WindowsSecrets.get(&account_id)?;
    let secret=if pid=="stepfun" {
        crate::providers::credentials::merge_stepfun_credentials(had_cred.as_deref().unwrap_or(""), &secret)
    } else {secret};
    let saved=tauri::async_runtime::spawn_blocking({let account_id=account_id.clone();move||{
        let put=WindowsSecrets.put(&account_id,secret.trim());
        if let Err(put_err)=put{
            // 凭据已改、设置未落盘（B14）：回滚旧凭据，不留半套状态。
            if let Some(sec)=&had_cred{let _=WindowsSecrets.put(&account_id,sec);}
            return Err(put_err);
        }
        let persist=(|| {if had_error{crate::config::backup_settings()?;} crate::config::save_settings(&settings)})();
        if let Err(error)=persist {
            let rollback=if let Some(old)=&had_cred {WindowsSecrets.put(&account_id,old)} else {WindowsSecrets.delete(&account_id)};
            return Err(match rollback {Ok(())=>error,Err(_)=>format!("{error}；凭据回滚失败，请重新检查凭据")});
        }
        Ok::<_,String>(settings)
    }}).await.map_err(|_|"凭据保存任务失败")??;
    *state.settings.lock().await=saved.clone();state.clear_config_error();
    state.bump_account_gen(&account_id).await;
    state.schedule.lock().await.remove(&account_id);
    // 清读数并广播（B05/B06 同语义）：悬浮栏立即摆脱旧凭据下的旧额度。
    let snapshot={let mut cached=state.cached_usages.lock().await;cached.retain(|r|r.account_id!=account_id);cached.clone()};
    let _=app.emit("usages-updated",&snapshot);
    app.emit("settings-updated",&saved).map_err(|_|"凭据已保存但窗口通知失败")?;
    // 凭据保存成功后，立即在后台发起一次即时刷新，无需等待 5 分钟轮询
    let app2=app.clone();
    let aid=account_id.clone();
    tauri::async_runtime::spawn(async move {
        let _=crate::AppState::refresh_account_now(&app2,&aid).await;
    });
    Ok(())
}
#[tauri::command]
pub async fn delete_credential(account_id:String,state:State<'_,AppState>,app:AppHandle)->Result<(),String>{
    if crate::updater::applying(){return Err("正在退出升级，请稍后操作".into())}
    let _io=state.settings_io.lock().await;
    let mut settings=state.settings.lock().await.clone();
    settings.providers.get_mut(&account_id).ok_or("账号不存在")?.credential_configured=false;
    settings.generation=settings.generation.wrapping_add(1);
    let had_error=state.config_error().is_some();
    let saved=tauri::async_runtime::spawn_blocking({let account_id=account_id.clone();move||{
        WindowsSecrets.delete(&account_id)?;
        if had_error{crate::config::backup_settings()?;}
        crate::config::save_settings(&settings)?;Ok::<_,String>(settings)
    }}).await.map_err(|_|"凭据删除任务失败")??;
    *state.settings.lock().await=saved.clone();state.clear_config_error();
    state.bump_account_gen(&account_id).await;
    state.schedule.lock().await.remove(&account_id);
    let snapshot={let mut cached=state.cached_usages.lock().await;cached.retain(|r|r.account_id!=account_id);cached.clone()};
    let _=app.emit("usages-updated",&snapshot);
    app.emit("settings-updated",&saved).map_err(|_|"窗口通知失败")?;Ok(())
}
#[tauri::command]
pub async fn delete_account(account_id:String,state:State<'_,AppState>,app:AppHandle)->Result<AppSettings,String>{
    if crate::updater::applying(){return Err("正在退出升级，请稍后操作".into())}
    let _io=state.settings_io.lock().await;
    let mut settings=state.settings.lock().await.clone();
    if !settings.providers.contains_key(&account_id){return Err("账号不存在".into());}
    settings.providers.remove(&account_id);
    settings.generation=settings.generation.wrapping_add(1);
    let had_cred=WindowsSecrets.get(&account_id).unwrap_or(None);
    let had_error=state.config_error().is_some();
    let saved=tauri::async_runtime::spawn_blocking({
        let account_id=account_id.clone();
        let settings=settings.clone();
        move||{
            let _=WindowsSecrets.delete(&account_id);
            if had_error{
                if let Err(e)=crate::config::backup_settings(){
                    if let Some(ref sec)=had_cred{let _=WindowsSecrets.put(&account_id,sec);}
                    return Err(e);
                }
            }
            if let Err(e)=crate::config::save_settings(&settings){
                if let Some(ref sec)=had_cred{let _=WindowsSecrets.put(&account_id,sec);}
                return Err(format!("保存设置失败，已回滚凭据: {e}"));
            }
            Ok::<_,String>(settings)
        }
    }).await.map_err(|_|"删除账号任务失败")??;
    *state.settings.lock().await=saved.clone();
    state.clear_config_error();
    state.bump_account_gen(&account_id).await;
    state.schedule.lock().await.remove(&account_id);
    let mut cached=state.cached_usages.lock().await;
    cached.retain(|u|u.account_id!=account_id);
    let retained=cached.clone();
    drop(cached);
    app.emit("settings-updated",&saved).map_err(|_|"账号已删除但窗口通知失败")?;
    app.emit("usages-updated",&retained).map_err(|_|"窗口通知失败")?;
    Ok(saved)
}
pub fn sanitize_diagnostics_string(raw:&str)->String{
    let mut out=String::with_capacity(raw.len());
    let chars:Vec<char>=raw.chars().collect();
    let n=chars.len();
    let mut i=0;
    while i<n{
        let is_drive_start = i == 0 || !chars[i - 1].is_ascii_alphanumeric();
        if is_drive_start && i+2<n && chars[i].is_ascii_alphabetic() && chars[i+1]==':' && (chars[i+2]=='\\' || chars[i+2]=='/'){
            out.push_str("[PATH]");
            i+=3;
            while i<n && !chars[i].is_whitespace() && chars[i]!='"' && chars[i]!='\'' && chars[i]!=',' && chars[i]!=';' && chars[i]!=':'{
                i+=1;
            }
            continue;
        }
        if chars[i]=='/' && i+1<n && chars[i+1].is_ascii_alphabetic(){
            let rem:String=chars[i..].iter().collect();
            if rem.starts_with("/Users/") || rem.starts_with("/home/") || rem.starts_with("/etc/"){
                out.push_str("[PATH]");
                i+=1;
                while i<n && !chars[i].is_whitespace() && chars[i]!='"' && chars[i]!='\'' && chars[i]!=',' && chars[i]!=';' && chars[i]!=':'{
                    i+=1;
                }
                continue;
            }
        }
        out.push(chars[i]);
        i+=1;
    }
    out
}

#[tauri::command]
pub async fn diagnostics(state:State<'_,AppState>)->Result<String,String>{
    // A whitelist, not regex scrubbing: no account id, label, token, raw body or path.
    let rows:Vec<_>=state.cached_usages.lock().await.iter().map(|r|serde_json::json!({
        "provider":r.provider_id,
        "state":r.state,
        "code":r.error_code,
        "source":sanitize_diagnostics_string(&r.source),
        "checked_at":r.checked_at,
        "last_success_at":r.last_success_at
    })).collect();
    let sanitized_err=state.config_error().map(|e|sanitize_diagnostics_string(&e));
    let close_events=state.close_coordinator.diagnostics.lock().await.clone();
    serde_json::to_string_pretty(&serde_json::json!({
        "version":env!("CARGO_PKG_VERSION"),
        "configuration_error":sanitized_err,
        "readings":rows,
        "close_diagnostics":close_events,
    })).map_err(|_|"诊断生成失败".into())
}

#[tauri::command]
pub fn startup_enabled()->bool{crate::platform::startup_enabled()}
#[tauri::command]
pub fn set_startup(enable:bool)->Result<bool,String>{crate::platform::set_startup(enable)?;Ok(crate::platform::startup_enabled())}
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct NotificationSendResult {
    pub success: bool,
    pub stage: String,
    pub setting: String,
    pub test_id: String,
    pub error: Option<String>,
    pub hint: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct NotificationFullStatus {
    pub identity_status: String,
    pub shortcut_path: Option<String>,
    pub shortcut_target: Option<String>,
    pub current_exe: String,
    pub windows_toasts_enabled: Option<bool>,
    pub app_notification_setting: String,
    pub is_portable: bool,
    pub plugin_permission: String,
    pub last_error: Option<String>,
}

static TEST_COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);

#[tauri::command]
pub fn get_notification_status(app: AppHandle) -> NotificationFullStatus {
    use tauri_plugin_notification::NotificationExt;
    let plugin_permission = match app.notification().permission_state() {
        Ok(p) => format!("{p:?}").to_lowercase(),
        Err(_) => "unknown".into(),
    };
    let (identity_status, shortcut_path, shortcut_target) = crate::platform::check_notification_identity();
    let current_exe = std::env::current_exe().map(|e| e.display().to_string()).unwrap_or_default();
    let windows_toasts_enabled = crate::platform::toasts_enabled();
    let app_notification_setting = crate::platform::get_app_notification_setting();
    let is_portable = crate::config::is_portable();

    NotificationFullStatus {
        identity_status,
        shortcut_path,
        shortcut_target,
        current_exe,
        windows_toasts_enabled,
        app_notification_setting,
        is_portable,
        plugin_permission,
        last_error: None,
    }
}

#[tauri::command]
pub fn notification_status(app: AppHandle) -> NotificationFullStatus {
    get_notification_status(app)
}

#[tauri::command]
pub fn register_notification_identity(app: AppHandle) -> Result<NotificationFullStatus, String> {
    crate::platform::register_notification_identity()?;
    Ok(get_notification_status(app))
}

#[tauri::command]
pub fn unregister_notification_identity(app: AppHandle) -> Result<NotificationFullStatus, String> {
    crate::platform::unregister_notification_identity()?;
    Ok(get_notification_status(app))
}

#[tauri::command]
pub fn test_notification(_app: AppHandle) -> Result<NotificationSendResult, String> {
    let count = TEST_COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let now = chrono::Local::now().format("%H:%M:%S").to_string();
    let test_id = format!("#{count} ({now})");
    let title = format!("Pulse 测试通知 {test_id}");
    let body = "如果你看到这条通知横幅，说明 Windows 原生通知链路正常。";

    #[cfg(windows)]
    {
        match crate::platform::send_native_toast(&title, body) {
            Ok(mut res) => {
                res.test_id = test_id;
                Ok(res)
            }
            Err(e) => {
                Err(format!("通知提交失败：{e}"))
            }
        }
    }
    #[cfg(not(windows))]
    {
        crate::notify(&app, &title, body)?;
        Ok(NotificationSendResult {
            success: true,
            stage: "submitted".into(),
            setting: "enabled".into(),
            test_id,
            error: None,
            hint: None,
        })
    }
}

#[tauri::command]
pub fn begin_free_drag(app:AppHandle)->Result<(),String>{
    app.get_webview_window("main").ok_or("窗口不存在")?.start_dragging().map_err(|e|format!("无法开始拖动：{e}"))
}

/// After a native drag: clamp the rail into the monitor it landed on and persist the
/// position as normalized coordinates plus that monitor's name, so a restart restores it.
#[tauri::command]
pub async fn commit_free_position(state:State<'_,AppState>,app:AppHandle)->Result<(),String>{
    let w=app.get_webview_window("main").ok_or("窗口不存在")?;
    let (pos,size)=match (w.outer_position(),w.outer_size()){(Ok(p),Ok(s))=>(p,s),_=>return Err("无法读取窗口位置".into())};
    let monitor=w.current_monitor().ok().flatten().or_else(||w.primary_monitor().ok().flatten()).ok_or("无法确定显示器")?;
    let area=monitor.work_area();
    let (left,top)=(area.position.x as f64,area.position.y as f64);
    let (aw,ah)=(area.size.width as f64,area.size.height as f64);
    let (wpx,hpx)=(size.width as f64,size.height as f64);
    let x=(pos.x as f64).clamp(left,(left+aw-wpx).max(left));
    let y=(pos.y as f64).clamp(top,(top+ah-hpx).max(top));
    let mut settings_guard=state.settings.lock().await;
    // A late commit after the user already switched back to a dock must not snap them
    // back into free mode: only update the remembered position while free is active.
    if settings_guard.dock_side!="free"{crate::window::position(&app,&settings_guard,"rail");return Ok(())}
    let mon_name=monitor.name().cloned();
    let fx=(if aw>wpx{(x-left)/(aw-wpx)}else{0.5}).clamp(0.0, 1.0);
    let fy=(if ah>hpx{(y-top)/(ah-hpx)}else{0.5}).clamp(0.0, 1.0);
    if settings_guard.monitor_name==mon_name && (settings_guard.free_x-fx).abs()<1e-4 && (settings_guard.free_y-fy).abs()<1e-4 {
        return Ok(());
    }
    settings_guard.monitor_name=mon_name;
    settings_guard.free_x=fx;
    settings_guard.free_y=fy;
    settings_guard.generation=settings_guard.generation.wrapping_add(1);
    let to_save=settings_guard.clone();
    let had_error=state.config_error().is_some();
    tauri::async_runtime::spawn_blocking(move||{
        if had_error{crate::config::backup_settings()?;}
        crate::config::save_settings(&to_save)?;Ok::<_,String>(())
    }).await.map_err(|_|"保存窗口位置失败")??;
    let settings=settings_guard.clone();
    drop(settings_guard);
    let _=app.emit("settings-updated",&settings);
    crate::window::position(&app,&settings,"rail");Ok(())
}

#[derive(Clone, serde::Serialize)]
pub struct DetailLayout {
    request_id: u64,
    account_id: String,
    placement: String,
    width: u32,
    height: u32,
}
static DETAIL_LAYOUT: std::sync::Mutex<Option<DetailLayout>> = std::sync::Mutex::new(None);
static DETAIL_PRESENTED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static DETAIL_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
/// 上一次内容自适应后的详情窗口高度（物理像素）；0=尚未学习，用默认 360。
static LAST_DETAIL_H: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
/// 各账号上次内容自适应后的高度记录（逻辑像素），使各账号悬停时初始高度在不同 DPI 屏幕上均精准换算。
static ACCOUNT_DETAIL_H: std::sync::Mutex<Option<std::collections::HashMap<String, f64>>> = std::sync::Mutex::new(None);

#[tauri::command]
pub fn get_detail_layout() -> Option<DetailLayout> {
    DETAIL_LAYOUT.lock().ok().and_then(|v|v.clone())
}

/// 内容驱动的详情窗口高度自适应：前端测量卡片实际高度（逻辑像素）后调用。
/// 钳制在屏幕工作区高度的 90% 内，超限时内容走滚动；若向下延伸超出屏幕底边则向上平移，避免被任务栏或屏幕裁切。
#[tauri::command]
pub fn resize_detail(height:f64,request_id:u64,app:AppHandle)->Result<Option<DetailLayout>,String>{
    if !height.is_finite()||height<=0.0||height>100000.0{return Err("详情高度无效".into())}
    let mut guard=DETAIL_LAYOUT.lock().map_err(|_|"详情布局锁异常")?;
    let Some(layout)=guard.as_mut().filter(|l|l.request_id==request_id)else{return Ok(None)};
    let width=layout.width;
    let Some(w)=app.get_webview_window("detail")else{return Ok(None)};
    let scale=w.scale_factor().unwrap_or(1.0);
    let monitor=w.current_monitor().ok().flatten().or_else(||w.primary_monitor().ok().flatten());
    let max_h=monitor.as_ref().map(|m|((m.work_area().size.height as f64)*0.9).round() as u32).unwrap_or(1600);
    let dh=((height*scale).round() as u32).clamp(120,max_h.max(120));
    LAST_DETAIL_H.store(dh,Ordering::SeqCst);
    layout.height=dh;
    if let Ok(mut map)=ACCOUNT_DETAIL_H.lock(){map.get_or_insert_with(std::collections::HashMap::new).insert(layout.account_id.clone(),height);}
    let pos=w.outer_position().map_err(|_|"无法读取详情窗口位置".to_string())?;
    let (new_x, new_y) = if let Some(ref m) = monitor {
        let area = m.work_area();
        let min_y = area.position.y + 4;
        let max_y = (area.position.y + area.size.height as i32 - dh as i32 - 4).max(min_y);
        let min_x = area.position.x + 4;
        let max_x = (area.position.x + area.size.width as i32 - width as i32 - 4).max(min_x);
        let cy = if pos.y + (dh as i32) > (area.position.y + area.size.height as i32 - 4) {
            max_y
        } else {
            pos.y.max(min_y)
        };
        let cx = pos.x.clamp(min_x, max_x);
        (cx, cy)
    } else {
        (pos.x, pos.y)
    };
    crate::window::place_at(&w,new_x,new_y,width,dh);
    Ok(Some(layout.clone()))
}

#[tauri::command]
pub async fn detail_layout_ready(app:AppHandle, request_id:u64)->Result<bool,String>{
    let handle=app.clone();
    let (send, receive) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let present = || {
        let Ok(layout)=DETAIL_LAYOUT.lock() else{return false};
        if !layout.as_ref().is_some_and(|v|v.request_id==request_id){return false}
        if DETAIL_PRESENTED.load(Ordering::SeqCst)==request_id{return true}
        let state=handle.state::<AppState>();
        if state.dragging.load(Ordering::Relaxed)||state.user_hidden.load(Ordering::Relaxed){return false}
        if let Ok(settings)=state.settings.try_lock(){
            if !settings.show_rail || (settings.hide_fullscreen && crate::window::fullscreen_other(&handle)){return false}
        } else {return false}
        if let Some(w)=handle.get_webview_window("detail") {
            if w.show().is_ok(){DETAIL_PRESENTED.store(request_id,Ordering::SeqCst);return true;}
        }
        false
        };
        let _ = send.send(present());
    }).map_err(|e|e.to_string())?;
    receive.await.map_err(|_| String::from("详情显示确认中断"))
}

/// The detail card is its own topmost overlay so showing it never resizes or flickers the rail.
#[tauri::command]
pub async fn show_detail(
    app:AppHandle,
    account_id:String,
    center_ratio:f64,
    horizontal_ratio:Option<f64>,
    state:State<'_,AppState>,
)->Result<(),String>{
    use tauri::Manager;
    // 拖动中一律拒绝弹出：drag_begin 已 hide，但拖动里窗口跟随光标的相对抖动会
    // 重新触发图标的 mouseenter——没有这道闸详情面板会残留在屏幕上。
    if state.dragging.load(Ordering::Relaxed){return Ok(())}
    let rail=app.get_webview_window("main").ok_or("窗口不存在")?;
    let (pos,size)=match (rail.outer_position(),rail.outer_size()){(Ok(p),Ok(s))=>(p,s),_=>return Err("无法读取悬浮栏位置".into())};
    let monitor=rail.current_monitor().ok().flatten().or_else(||rail.primary_monitor().ok().flatten()).ok_or("无法确定显示器")?;
    let area=monitor.work_area();let scale=monitor.scale_factor();
    let max_w = (area.size.width as f64 - 8.0).max(100.0);
    let max_h = (area.size.height as f64 - 8.0).max(100.0);
    let dw = (340.0 * scale).min(max_w);
    // 高度优先使用该账号的历史自适应高度（逻辑像素按当前屏幕缩放），其次按窗口数预估，最后兜底 360
    let account_learned = ACCOUNT_DETAIL_H.lock().ok().and_then(|m| m.as_ref().and_then(|h| h.get(&account_id).copied()));
    let estimated = if let Some(logical_h) = account_learned {
        (logical_h * scale).round()
    } else {
        let base_id = account_id.split("::").next().unwrap_or(&account_id);
        let win_count = state.cached_usages.try_lock().ok().and_then(|u| {
            u.iter().find(|x| x.account_id == base_id).map(|x| x.windows.len())
        }).unwrap_or(1);
        let est_logical = match win_count {
            0 | 1 => 200.0,
            2 => 270.0,
            3 => 350.0,
            _ => 430.0,
        };
        (est_logical * scale).round()
    };
    let dh = estimated.min(max_h);

    let min_y = area.position.y as f64 + 4.0;
    let max_y = ((area.position.y + area.size.height as i32) as f64 - dh - 4.0).max(min_y);
    let min_x = area.position.x as f64 + 4.0;
    let max_x = ((area.position.x + area.size.width as i32) as f64 - dw - 4.0).max(min_x);

    let settings = state.settings.lock().await.clone();
    let dock_side = settings.dock_side.as_str();

    let ((x, y), placement) = match dock_side {
        "right" => {
            let x = pos.x as f64 - dw;
            let desired_y = pos.y as f64 + size.height as f64 * center_ratio - dh / 2.0;
            let y = desired_y.clamp(min_y, max_y);
            ((x, y), "left")
        }
        "left" => {
            let x = (pos.x + size.width as i32) as f64;
            let desired_y = pos.y as f64 + size.height as f64 * center_ratio - dh / 2.0;
            let y = desired_y.clamp(min_y, max_y);
            ((x, y), "right")
        }
        "top" => {
            let h_ratio = horizontal_ratio.unwrap_or(0.5);
            let desired_x = pos.x as f64 + size.width as f64 * h_ratio - dw / 2.0;
            let x = desired_x.clamp(min_x, max_x);
            let y = (pos.y + size.height as i32) as f64;
            ((x, y), "top")
        }
        "bottom" => {
            let h_ratio = horizontal_ratio.unwrap_or(0.5);
            let desired_x = pos.x as f64 + size.width as f64 * h_ratio - dw / 2.0;
            let x = desired_x.clamp(min_x, max_x);
            let y = (pos.y as f64 - dh).clamp(min_y, max_y);
            ((x, y), "bottom")
        }
        _ => {
            let rail_cx = pos.x as f64 + size.width as f64 / 2.0;
            let mon_cx = area.position.x as f64 + area.size.width as f64 / 2.0;
            let right_space = (area.position.x + area.size.width as i32) as f64 - (pos.x as f64 + size.width as f64);
            let left_space = pos.x as f64 - area.position.x as f64;
            let prefer_right = rail_cx < mon_cx;
            let side_right = if prefer_right { right_space >= dw || right_space >= left_space } else { left_space < dw && right_space > left_space };
            let x = if side_right { pos.x as f64 + size.width as f64 } else { pos.x as f64 - dw };
            let desired_y = pos.y as f64 + size.height as f64 * center_ratio - dh / 2.0;
            let y = desired_y.clamp(min_y, max_y);
            let x = x.clamp(min_x, max_x);
            ((x, y), if side_right { "right" } else { "left" })
        }
    };

    let window=match app.get_webview_window("detail"){
        Some(w)=>w,
        None=>tauri::WebviewWindowBuilder::new(&app,"detail",tauri::WebviewUrl::App("index.html".into()))
            .decorations(false).transparent(true).always_on_top(true).skip_taskbar(true).shadow(false).resizable(false).focused(false)
            .inner_size(340.0,360.0).visible(false).build().map_err(|e|format!("详情窗口创建失败：{e}"))?,
    };
    let layout=DetailLayout {
        request_id: DETAIL_SEQUENCE.fetch_add(1,Ordering::SeqCst),
        account_id: account_id.clone(), placement:placement.into(),
        width:dw as u32, height:dh as u32,
    };
    let fallback_req = layout.request_id;
    *state.detail_account.lock().map_err(|_|"状态锁损坏")?=Some(account_id);
    *DETAIL_LAYOUT.lock().map_err(|_|"详情布局锁损坏")?=Some(layout.clone());
    let handle=app.clone();
    let target_x = x.clamp(min_x, max_x) as i32;
    let target_y = y.clamp(min_y, max_y) as i32;
    app.run_on_main_thread(move || {
        let Ok(current)=DETAIL_LAYOUT.lock() else{return};
        if !current.as_ref().is_some_and(|v|v.request_id==layout.request_id){return}
        let already_visible = window.is_visible().unwrap_or(false);

        let result=(|| -> tauri::Result<()> {
            if !already_visible {
                window.hide()?;
            }
            crate::window::place_at(&window, target_x, target_y, layout.width, layout.height);
            window.set_always_on_top(true)?;
            handle.emit("detail-layout", &layout)?;
            if already_visible {
                DETAIL_PRESENTED.store(layout.request_id, Ordering::SeqCst);
            }
            Ok(())
        })();
        if let Err(error)=result {eprintln!("Pulse detail layout: {error}");}
    }).map_err(|e|format!("详情定位失败: {e}"))?;

    // 兜底显示：如果前端视口测量未在 260ms 内完成，强制显示（窗口位置已由 place_at 定位好）
    let handle_fallback = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(260)).await;
        let h = handle_fallback.clone();
        let _ = handle_fallback.run_on_main_thread(move || {
            let Ok(current) = DETAIL_LAYOUT.lock() else { return };
            if !current.as_ref().is_some_and(|v| v.request_id == fallback_req) || DETAIL_PRESENTED.load(Ordering::SeqCst) == fallback_req { return }
            let state = h.state::<AppState>();
            if state.dragging.load(Ordering::Relaxed) || state.user_hidden.load(Ordering::Relaxed) { return }
            if let Ok(settings) = state.settings.try_lock() {
                if !settings.show_rail || (settings.hide_fullscreen && crate::window::fullscreen_other(&h)) { return }
            } else { return }
            if let Some(w) = h.get_webview_window("detail") {
                if w.show().is_ok() { DETAIL_PRESENTED.store(fallback_req, Ordering::SeqCst); }
            }
        });
    });

    Ok(())
}
#[tauri::command]
pub fn detail_account(state:State<'_,AppState>)->Option<String>{
    state.detail_account.lock().ok().and_then(|g|g.clone())
}
#[tauri::command]
pub fn hide_detail(app:AppHandle,state:State<'_,AppState>)->Result<(),String>{
    if let Ok(mut layout)=DETAIL_LAYOUT.lock(){*layout=None;}
    if let Ok(mut g)=state.detail_account.lock(){*g=None;}
    if let Some(w)=app.get_webview_window("detail"){let _=w.hide();}
    Ok(())
}
#[tauri::command]
pub fn set_detail_hover(app:AppHandle,hovered:bool)->Result<(),String>{
    app.emit("detail-pointer",hovered).map_err(|e|format!("通知详情悬停状态失败: {e}"))
}

#[tauri::command]
pub fn is_portable()->bool{
    crate::config::is_portable()
}

#[tauri::command]
pub async fn detect_network_proxy(state: State<'_, AppState>) -> Result<crate::providers::ProxyDetection, String> {
    let settings = state.settings.lock().await;
    Ok(crate::providers::detect_proxy(&settings.network_proxy))
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct NetworkTestResult {
    pub ok: bool,
    pub target: String,
    pub status: Option<u16>,
    pub duration_ms: u64,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn test_network_connection(state: State<'_, AppState>, target: Option<String>) -> Result<NetworkTestResult, String> {
    let url = target.unwrap_or_else(|| "https://chatgpt.com".to_string());
    let http = state.http.read().await.clone();
    let start = std::time::Instant::now();
    let res = http.get(&url).send().await;
    let duration_ms = start.elapsed().as_millis() as u64;
    match res {
        Ok(resp) => {
            let status = resp.status().as_u16();
            Ok(NetworkTestResult {
                ok: resp.status().is_success() || status == 401 || status == 403,
                target: url,
                status: Some(status),
                duration_ms,
                error: None,
            })
        }
        Err(e) => {
            let err_str = e.to_string();
            let detail = if e.is_timeout() {
                "连接超时"
            } else if err_str.contains("proxy") {
                "代理端口无法连接"
            } else if err_str.contains("dns") || err_str.contains("resolve") {
                "DNS 解析失败"
            } else if err_str.contains("tls") || err_str.contains("certificate") {
                "TLS 握手/证书验证失败"
            } else {
                "无法建立连接"
            };
            Ok(NetworkTestResult {
                ok: false,
                target: url,
                status: None,
                duration_ms,
                error: Some(format!("{detail}: {e}")),
            })
        }
    }
}

#[tauri::command]
pub fn get_profile_info()->crate::config::AppProfile{
    crate::config::get_profile()
}

#[tauri::command]
pub async fn clear_profile_credentials(state:State<'_,AppState>,app:AppHandle)->Result<(),String>{
    if crate::updater::applying(){return Err("正在退出升级，请稍后操作".into())}
    let _io=state.settings_io.lock().await;
    crate::secrets::clear_profile_credentials()?;
    // 全量清理同步（B02）：全部账号读数清空、在途请求失效、凭据标志由下次写盘重核，
    // 广播清空快照——不再出现"提示成功但旧额度仍在、旧请求回写"。
    let snapshot={let mut cached=state.cached_usages.lock().await;cached.clear();cached.clone()};
    state.schedule.lock().await.clear();
    let ids:Vec<String>=state.settings.lock().await.providers.keys().cloned().collect();
    for id in &ids{state.bump_account_gen(id).await;}
    let _=app.emit("usages-updated",&snapshot);
    if let Ok(s)=crate::config::load_settings(){let _=app.emit("settings-updated",&s);}
    Ok(())
}

#[tauri::command]
pub async fn create_isolated_profile(state:State<'_,AppState>,app:AppHandle)->Result<String,String>{
    if crate::updater::applying(){return Err("正在退出升级，请稍后操作".into())}
    let new_id=crate::config::create_isolated_profile()?;
    // 身份切换事务化（A25）：清读数与调度、失效全部账号的在途请求（代际 bump），
    // 广播清空后的读数——旧身份的结果不得在新身份下提交。
    let snapshot={let mut cached=state.cached_usages.lock().await;cached.clear();cached.clone()};
    state.schedule.lock().await.clear();
    let ids:Vec<String>=state.settings.lock().await.providers.keys().cloned().collect();
    for id in &ids{state.bump_account_gen(id).await;}
    let _=app.emit("usages-updated",&snapshot);
    // 写回内存（B06）：重载的设置同时进 state.settings，查询接口与界面一致。
    if let Ok(s)=crate::config::load_settings(){*state.settings.lock().await=s.clone();let _=app.emit("settings-updated",&s);}
    Ok(new_id)
}

#[derive(serde::Serialize, Clone)]
pub struct RuntimeInfo {
    pub version: String,
    pub commit: String,
    pub build_time: String,
    pub mode: String,
    pub data_dir: String,
    pub exe_path: String,
    pub exe_sha256: String,
    pub profile_id: String,
}

static CACHED_EXE_SHA256: std::sync::OnceLock<String> = std::sync::OnceLock::new();

pub fn get_exe_sha256() -> String {
    CACHED_EXE_SHA256.get_or_init(|| {
        if let Ok(exe) = std::env::current_exe() {
            if let Ok(bytes) = std::fs::read(&exe) {
                use sha2::{Sha256, Digest};
                let mut hasher = Sha256::new();
                hasher.update(&bytes);
                return format!("{:x}", hasher.finalize());
            }
        }
        "unknown".to_string()
    }).clone()
}

#[tauri::command]
pub fn get_runtime_info() -> RuntimeInfo {
    let mode_str = match crate::config::get_config_mode() {
        crate::config::ConfigMode::Installed => "installed",
        crate::config::ConfigMode::Portable => "portable",
        crate::config::ConfigMode::CustomEnv => "custom_env",
    };
    RuntimeInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        commit: option_env!("GIT_COMMIT").unwrap_or("unknown").to_string(),
        build_time: option_env!("BUILD_TIME").unwrap_or("unknown").to_string(),
        mode: mode_str.to_string(),
        data_dir: crate::config::get_config_dir().to_string_lossy().to_string(),
        exe_path: std::env::current_exe().map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
        exe_sha256: get_exe_sha256(),
        profile_id: crate::config::get_profile_id(),
    }
}

#[tauri::command]
pub fn check_profile_status() -> Result<crate::config::ProfileStatus, String> {
    Ok(crate::config::check_profile_status())
}

#[tauri::command]
pub fn check_importable_config() -> Result<Option<crate::config::ImportableConfigSummary>, String> {
    crate::config::check_importable_config()
}

#[tauri::command]
pub async fn import_installed_config(state: State<'_, AppState>, app: AppHandle, mode: Option<String>) -> Result<AppSettings, String> {
    if crate::updater::applying(){return Err("正在退出升级，请稍后操作".into())}
    let _io = state.settings_io.lock().await;
    let import_mode = match mode.as_deref() {
        Some("overwrite") => crate::config::ImportMode::Overwrite,
        _ => crate::config::ImportMode::Append,
    };
    let imported = tauri::async_runtime::spawn_blocking(move || {
        crate::config::import_installed_config(import_mode)
    }).await.map_err(|_| "导入任务失败")??;

    *state.settings.lock().await = imported.clone();
    state.clear_config_error();
    for id in imported.providers.keys() {
        state.bump_account_gen(id).await;
    }
    state.schedule.lock().await.clear();
    let snapshot = {
        let mut cached = state.cached_usages.lock().await;
        cached.clear();
        cached.clone()
    };
    let _ = app.emit("usages-updated", &snapshot);
    let _ = app.emit("settings-updated", &imported);
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = crate::refresh_usages_and_emit(&app_clone, true).await;
    });
    Ok(imported)
}

#[cfg(test)]
mod tests {
    #[test]
    fn appearance_saves_do_not_trigger_missing_account_requests() {
        let mut account=crate::types::ProviderConfig::default();account.enabled=true;
        assert!(!super::needs_initial_refresh(Some(&account),&account,false));
        assert!(super::needs_initial_refresh(None,&account,false));
        let mut disabled=account.clone();disabled.enabled=false;
        assert!(super::needs_initial_refresh(Some(&disabled),&account,false));
        assert!(!super::needs_initial_refresh(None,&account,true));
    }
    use super::*;

    #[test]
    fn test_sanitize_diagnostics_string() {
        let raw_win = r"Failed to load C:\Users\alice\AppData\Roaming\pulse-windows\settings.json: syntax error";
        assert_eq!(sanitize_diagnostics_string(raw_win), "Failed to load [PATH]: syntax error");

        let raw_unix = "Failed to load /Users/bob/.config/pulse/settings.json: error";
        assert_eq!(sanitize_diagnostics_string(raw_unix), "Failed to load [PATH]: error");

        let clean = "network timeout on https://api.openai.com";
        assert_eq!(sanitize_diagnostics_string(clean), clean);
    }
}

#[tauri::command]
pub fn drag_begin(app:AppHandle)->Result<(),String>{
    let state=app.state::<AppState>();
    state.dragging.store(true,Ordering::Relaxed);
    if let Some(w)=app.get_webview_window("detail"){let _=w.hide();}
    if let Ok(mut g)=state.detail_account.lock(){*g=None;}
    let win=app.get_webview_window("main").ok_or("窗口不存在")?;
    // Real system cursor: immune to the window moving under us and to per-monitor DPI math.
    let Some((px,py))=crate::window::get_cursor_screen_pos()else{return Ok(())};
    let pos=win.outer_position().map_err(|e|e.to_string())?;
    let start_scale = win.current_monitor().ok().flatten().map(|m| m.scale_factor()).unwrap_or(1.0);
    *state.drag_grab.lock().unwrap()=((px-pos.x) as f64 / start_scale, (py-pos.y) as f64 / start_scale);
    // Monitor enumeration is an expensive Win32 call: cache the list once per drag so
    // drag_move stays cheap enough to track the cursor tightly.
    let monitors=win.available_monitors().map_err(|e|e.to_string())?;
    *state.drag_monitors.lock().unwrap()=monitors;
    Ok(())
}
/// Custom drag: the rail follows the real cursor; edges snap with 32/48 DIP hysteresis.
#[tauri::command]
pub fn drag_move(app:AppHandle)->Result<(),String>{
    let state=app.state::<AppState>();
    if !state.dragging.load(Ordering::Relaxed){return Ok(())}
    let Some((px,py))=crate::window::get_cursor_screen_pos()else{return Ok(())};
    let win=app.get_webview_window("main").ok_or("窗口不存在")?;
    let monitors=state.drag_monitors.lock().unwrap().clone();
    let m_owned:tauri::Monitor=monitors.iter().find(|m|{let a=m.work_area();px>=a.position.x&&px<a.position.x+a.size.width as i32&&py>=a.position.y&&py<a.position.y+a.size.height as i32}).cloned()
        .or_else(||win.current_monitor().ok().flatten())
        .or_else(||win.primary_monitor().ok().flatten()).ok_or("无法确定显示器")?;
    let m=&m_owned;
    let prev_side=state.drag_side.lock().unwrap().clone();
    let (side,fx,fy)=classify_drag(&state,m,px,py);
    // 预览停靠边变化时通知前端切换布局：窗口在 free 分支已按竖排 rail 尺寸 resize，
    // 布局若仍按旧 dock_side 渲染，横排内容会被裁成"只剩一个图标"的窄条。
    if side!=prev_side{use tauri::Emitter;let _=app.emit("drag-side",&side);}
    if side=="free"{
        let (gx_dip,gy_dip)=*state.drag_grab.lock().unwrap();
        let cur_scale=m.scale_factor();
        let gx=(gx_dip * cur_scale).round() as i32;
        let gy=(gy_dip * cur_scale).round() as i32;
        // A docked preview may have resized the window: restore rail size for this monitor.
        let Some(settings)=state.settings.try_lock().ok().map(|s|s.clone())else{return Ok(())};
        let rect=crate::window::dock_rect(&settings,&m,"rail",(0.5,0.5));
        let area=m.work_area();
        let aw=(area.size.width as i32-rect.w as i32).max(0);
        let ah=(area.size.height as i32-rect.h as i32).max(0);
        let x=(px-gx).clamp(area.position.x,area.position.x+aw);
        let y=(py-gy).clamp(area.position.y,area.position.y+ah);
        crate::window::place_at(&win,x,y,rect.w,rect.h);
    }else{
        let Some(settings)=state.settings.try_lock().ok().map(|s|s.clone())else{return Ok(())};
        let rect=crate::window::dock_rect(&settings,&m,&side,(fx,fy));
        crate::window::place(&win,&rect);
    }
    Ok(())
}
/// Pointer position -> (dock side or free, ratio along the edge), with 32/48 DIP hysteresis.
fn classify_drag(state:&tauri::State<AppState>,m:&tauri::Monitor,px:i32,py:i32)->(String,f64,f64){
    let area=m.work_area();let ms=m.scale_factor();
    let dl=(px-area.position.x) as f64/ms;let dr=(area.position.x+area.size.width as i32-px) as f64/ms;
    let dt=(py-area.position.y) as f64/ms;
    let cur=state.drag_side.lock().unwrap().clone();
    let side=(match cur.as_str(){
        "left" if dl<=48.0=>"left","right" if dr<=48.0=>"right","top" if dt<=48.0=>"top",
        _=>if dl<=32.0{"left"}else if dr<=32.0{"right"}else if dt<=32.0{"top"}else{"free"},
    }).to_string();
    let (mut fx,mut fy)=(0.5f64,0.5f64);
    if side=="top"{fx=((px-area.position.x) as f64/area.size.width as f64).clamp(0.0,1.0);}
    else if side!="free"{fy=((py-area.position.y) as f64/area.size.height as f64).clamp(0.0,1.0);}
    *state.drag_side.lock().unwrap()=side.clone();
    *state.drag_ratio.lock().unwrap()=(fx,fy);
    (side,fx,fy)
}
#[tauri::command]
pub async fn drag_end(app:AppHandle)->Result<(),String>{
    let state=app.state::<AppState>();
    if !state.dragging.swap(false,Ordering::Relaxed){return Ok(())}
    let Some((px,py))=crate::window::get_cursor_screen_pos()else{return Ok(())};
    let win=app.get_webview_window("main").ok_or("窗口不存在")?;
    let monitors=state.drag_monitors.lock().unwrap().clone();
    let m_owned:tauri::Monitor=monitors.iter().find(|m|{let a=m.work_area();px>=a.position.x&&px<a.position.x+a.size.width as i32&&py>=a.position.y&&py<a.position.y+a.size.height as i32}).cloned()
        .or_else(||win.current_monitor().ok().flatten())
        .or_else(||win.primary_monitor().ok().flatten()).ok_or("无法确定显示器")?;
    let (side,fx,fy)=classify_drag(&state,&m_owned,px,py);
    let m=&m_owned;
    let area=m.work_area();
    let size=win.outer_size().map_err(|e|e.to_string())?;
    let mut changed=false;
    // Patch ONLY the position fields into the CURRENT settings: a save from the settings
    // window that lands mid-drag must not be clobbered by the drag (and vice versa).
    // 拖拽保存同样串行（A03）：patch 基于最新的已提交设置，写盘期间不会被并发保存覆盖。
    let _io=state.settings_io.lock().await;
    let mut settings=state.settings.lock().await.clone();
    if settings.dock_side!=side{settings.dock_side=side.clone();changed=true;}
    // 跨屏拖动即使比例不变也要落盘 monitor_name，否则重启后 position() 找错屏。
    if settings.monitor_name.as_ref()!=m.name(){settings.monitor_name=m.name().cloned();changed=true;}
    if side=="free"{
        let pos=win.outer_position().map_err(|e|e.to_string())?;
        // Save and restore share one denominator: the MOVABLE range (work area minus window).
        let aw=(area.size.width as f64-size.width as f64).max(1.0);
        let ah=(area.size.height as f64-size.height as f64).max(1.0);
        let x=(pos.x as f64-area.position.x as f64).clamp(0.0,aw);
        let y=(pos.y as f64-area.position.y as f64).clamp(0.0,ah);
        let nfx=(x/aw).clamp(0.0,1.0);let nfy=(y/ah).clamp(0.0,1.0);
        if (settings.free_x-nfx).abs()>1e-4{settings.free_x=nfx;changed=true;}
        if (settings.free_y-nfy).abs()>1e-4{settings.free_y=nfy;changed=true;}
        // 松手时把窗口完整钳回工作区，避免悬浮栏半挂在屏幕外。
        let _=win.set_position(tauri::PhysicalPosition::new(
            area.position.x+(x as i32),area.position.y+(y as i32)));
    }else{
        if (settings.free_x-fx).abs()>1e-4{settings.free_x=fx;changed=true;}
        if (settings.free_y-fy).abs()>1e-4{settings.free_y=fy;changed=true;}
        crate::window::position(&app,&settings,"rail");
    }
    if changed{
        // 位置变化递增 generation（B01）：A03 串行化后表单保存不再因代际差误拒
        // （位置已无条件后端为准），而代际推进让在途刷新结果按新位置口径失效。
        settings.generation=settings.generation.wrapping_add(1);
        crate::config::save_settings(&settings)?;
        *state.settings.lock().await=settings.clone();
        let _=app.emit("settings-updated",&settings);
    }
    Ok(())
}
#[tauri::command]
pub async fn drag_cancel(app:AppHandle)->Result<(),String>{
    let state=app.state::<AppState>();
    state.dragging.store(false,Ordering::Relaxed);
    let mode=state.window_mode.lock().await.clone();
    let settings=state.settings.lock().await.clone();
    crate::window::position(&app,&settings,&mode);Ok(())
}

#[tauri::command]
pub fn rail_menu_cmd(app:AppHandle,window:tauri::Window)->Result<(),String>{
    use tauri::menu::{ContextMenu,Menu,MenuItem};
    let m_set=MenuItem::with_id(&app,"rail-settings","设置…",true,None::<&str>).map_err(|e|e.to_string())?;
    let m_ref=MenuItem::with_id(&app,"rail-refresh","立即刷新",true,None::<&str>).map_err(|e|e.to_string())?;
    let m_tog=MenuItem::with_id(&app,"rail-toggle","显示 / 隐藏悬浮栏",true,None::<&str>).map_err(|e|e.to_string())?;
    let m_quit=MenuItem::with_id(&app,"rail-quit","退出 Pulse",true,None::<&str>).map_err(|e|e.to_string())?;
    let menu=Menu::with_items(&app,&[&m_set,&m_ref,&m_tog,&m_quit]).map_err(|e|e.to_string())?;
    menu.popup(window).map_err(|e|e.to_string())
}

#[tauri::command]
pub async fn check_local_antigravity() -> Result<bool, String> {
    #[cfg(not(windows))]
    {
        Ok(false)
    }
    #[cfg(windows)]
    {
        let script = r#"if (Get-CimInstance Win32_Process -Filter "Name LIKE 'language_server%'" | Where-Object { $_.ExecutablePath -match 'Antigravity' }) { exit 0 } else { exit 1 }"#;
        let mut cmd = tokio::process::Command::new("powershell.exe");
        cmd.args(["-NoProfile", "-NonInteractive", "-Command", script])
            .creation_flags(0x08000000)
            .kill_on_drop(true);
        match tokio::time::timeout(std::time::Duration::from_secs(4), cmd.status()).await {
            Ok(Ok(status)) if status.success() => Ok(true),
            _ => Ok(false),
        }
    }
}

#[tauri::command]
pub async fn quick_add_antigravity_account(state: State<'_, AppState>, app: AppHandle) -> Result<AppSettings, String> {
    if crate::updater::applying(){return Err("正在退出升级，请稍后操作".into())}
    let _io = state.settings_io.lock().await;
    let mut settings = state.settings.lock().await.clone();

    // If an antigravity account already exists, return current settings
    if settings.providers.values().any(|p| p.provider_id == "antigravity") {
        return Ok(settings);
    }

    let account_id = if !settings.providers.contains_key("antigravity-default") {
        "antigravity-default".to_string()
    } else {
        format!("antigravity-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0))
    };

    let max_order = settings.providers.values().map(|p| p.order).max().unwrap_or(0);

    let config = crate::types::ProviderConfig {
        provider_id: "antigravity".to_string(),
        label: "Antigravity".to_string(),
        enabled: true,
        order: max_order + 1,
        use_local: true,
        credential_configured: false,
        ..Default::default()
    };

    settings.providers.insert(account_id.clone(), config);
    settings.generation = settings.generation.wrapping_add(1);

    let had_error = state.config_error().is_some();
    let saved = tauri::async_runtime::spawn_blocking({
        let settings = settings.clone();
        move || {
            if had_error {
                crate::config::backup_settings()?;
            }
            crate::config::save_settings(&settings)?;
            Ok::<_, String>(settings)
        }
    }).await.map_err(|_| "添加 Antigravity 账号任务失败")??;

    *state.settings.lock().await = saved.clone();
    state.clear_config_error();
    state.bump_account_gen(&account_id).await;

    let _ = app.emit("settings-updated", &saved);

    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = crate::refresh_usages_and_emit(&app_clone, true).await;
    });

    Ok(saved)
}
