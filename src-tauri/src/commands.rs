use crate::{types::{AppSettings,ProviderUsage},secrets::{SecretStore,WindowsSecrets},AppState};
use tauri::{AppHandle,Emitter,State,Manager};
#[tauri::command]
pub async fn token_spend(days:u32,state:State<'_,AppState>)->Result<crate::ledger::Summary,String>{
    let _gate=state.ledger_gate.lock().await;
    tauri::async_runtime::spawn_blocking(move||crate::ledger::scan(days)).await.map_err(|_|"统计任务失败")?
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
    new_settings.validate()?;
    let old=state.settings.lock().await.clone();
    if new_settings.generation!=0 && new_settings.generation!=old.generation{
        return Err("设置已被其他操作修改，请重新加载后再试".into());
    }
    // An existing account cannot silently change the provider that receives its credential.
    for (id,cfg) in &new_settings.providers{if old.providers.get(id).is_some_and(|c|c.provider_id!=cfg.provider_id){return Err("不能更改已有账号的服务商，请新建账号".into())}}
    if new_settings.hotkeys!=old.hotkeys{
        if let Err(e)=crate::apply_hotkeys(&app,&new_settings.hotkeys){let _=crate::apply_hotkeys(&app,&old.hotkeys);return Err(e)}
    }
    for (id,cfg) in &new_settings.providers{
        if old.providers.get(id).map(|c|(c.order,c.enabled,&c.label))!=Some((cfg.order,cfg.enabled,&cfg.label)){
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
    let mode=state.window_mode.lock().await.clone();
    crate::window::position(&app,&new_settings,&mode);Ok(new_settings)
}
#[tauri::command]
pub async fn get_usages(state:State<'_,AppState>)->Result<Vec<ProviderUsage>,String>{
    let settings=state.settings.lock().await.clone();
    let now=crate::cache::now();
    Ok(state.cached_usages.lock().await.iter().cloned().map(|r|{
        let pin=settings.providers.get(&r.account_id).and_then(|c|c.primary_window.as_deref());
        crate::cache::expire_with_pin(r,pin,now)
    }).collect())
}
#[tauri::command]
pub async fn refresh_usages(app:AppHandle)->Result<Vec<ProviderUsage>,String>{crate::refresh_usages_and_emit(&app).await}
#[tauri::command]
pub async fn test_account(account_id:String,state:State<'_,AppState>)->Result<ProviderUsage,String>{
    let cfg={
        let s=state.settings.lock().await;
        s.providers.get(&account_id).cloned().ok_or("账号不存在")?
    };
    let usage=crate::providers::fetch_one(&account_id,&cfg,&state.http).await;
    Ok(usage)
}
#[tauri::command]
pub async fn set_window_state(state:String,app:AppHandle)->Result<(),String>{
    if !["collapsed","rail","expanded"].contains(&state.as_str()){return Err("窗口状态无效".into())}
    *app.state::<AppState>().window_mode.lock().await=state.clone();
    let settings=app.state::<AppState>().settings.lock().await.clone();crate::window::position(&app,&settings,&state);Ok(())
}
#[tauri::command]
pub fn open_settings(app:AppHandle){crate::open_settings_window(&app)}
#[tauri::command]
pub fn close_settings_window(app:AppHandle){
    if let Some(w)=app.get_webview_window("settings"){
        let _=w.hide();
    }
}
#[tauri::command]
pub async fn set_credential(account_id:String,secret:String,state:State<'_,AppState>,app:AppHandle)->Result<(),String>{
    let mut settings=state.settings.lock().await.clone();
    settings.providers.get_mut(&account_id).ok_or("账号不存在")?.credential_configured=true;
    settings.generation=settings.generation.wrapping_add(1);
    let had_error=state.config_error().is_some();
    let saved=tauri::async_runtime::spawn_blocking({let account_id=account_id.clone();move||{
        WindowsSecrets.put(&account_id,secret.trim())?;
        if had_error{crate::config::backup_settings()?;}
        crate::config::save_settings(&settings)?;Ok::<_,String>(settings)
    }}).await.map_err(|_|"凭据保存任务失败")??;
    *state.settings.lock().await=saved.clone();state.clear_config_error();
    state.bump_account_gen(&account_id).await;
    state.schedule.lock().await.remove(&account_id);state.cached_usages.lock().await.retain(|r|r.account_id!=account_id);
    app.emit("settings-updated",&saved).map_err(|_|"凭据已保存但窗口通知失败")?;Ok(())
}
#[tauri::command]
pub async fn delete_credential(account_id:String,state:State<'_,AppState>,app:AppHandle)->Result<(),String>{
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
    state.schedule.lock().await.remove(&account_id);state.cached_usages.lock().await.retain(|r|r.account_id!=account_id);
    app.emit("settings-updated",&saved).map_err(|_|"窗口通知失败")?;Ok(())
}
#[tauri::command]
pub async fn delete_account(account_id:String,state:State<'_,AppState>,app:AppHandle)->Result<AppSettings,String>{
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
    serde_json::to_string_pretty(&serde_json::json!({"version":env!("CARGO_PKG_VERSION"),"configuration_error":sanitized_err,"readings":rows})).map_err(|_|"诊断生成失败".into())
}

#[tauri::command]
pub fn startup_enabled()->bool{crate::platform::startup_enabled()}
#[tauri::command]
pub fn set_startup(enable:bool)->Result<bool,String>{crate::platform::set_startup(enable)?;Ok(crate::platform::startup_enabled())}
#[derive(serde::Serialize)]
pub struct NotificationStatus{pub system_toasts:Option<bool>,pub permission:String}
#[tauri::command]
pub fn notification_status(app:AppHandle)->NotificationStatus{
    use tauri_plugin_notification::NotificationExt;
    let permission=match app.notification().permission_state(){Ok(p)=>format!("{p:?}").to_lowercase(),Err(_)=>"unknown".into()};
    NotificationStatus{system_toasts:crate::platform::toasts_enabled(),permission}
}
#[tauri::command]
pub fn test_notification(app:AppHandle)->Result<(),String>{crate::notify(&app,"Pulse 测试通知","如果你看到这条消息，Windows 通知链路正常。")}

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
    let rail=app.get_webview_window("main").ok_or("窗口不存在")?;
    let (pos,size)=match (rail.outer_position(),rail.outer_size()){(Ok(p),Ok(s))=>(p,s),_=>return Err("无法读取悬浮栏位置".into())};
    let monitor=rail.current_monitor().ok().flatten().or_else(||rail.primary_monitor().ok().flatten()).ok_or("无法确定显示器")?;
    let area=monitor.work_area();let scale=monitor.scale_factor();
    let max_w = (area.size.width as f64 - 8.0).max(100.0);
    let max_h = (area.size.height as f64 - 8.0).max(100.0);
    let dw = (340.0 * scale).min(max_w);
    let dh = (360.0 * scale).min(max_h);

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
            ((x, y), "left")
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
            .inner_size(340.0,360.0).build().map_err(|e|format!("详情窗口创建失败：{e}"))?,
    };
    let _=window.set_size(tauri::PhysicalSize::new(dw as u32,dh as u32));
    let _=window.set_position(tauri::PhysicalPosition::new(x as i32,y as i32));
    *state.detail_account.lock().map_err(|_|"状态锁损坏")?=Some(account_id.clone());
    let _=window.show();
    let _=window.set_always_on_top(true);
    let _=app.emit("detail-placement",placement);
    let _=app.emit("detail-account",&account_id);
    Ok(())
}
#[tauri::command]
pub fn detail_account(state:State<'_,AppState>)->Option<String>{
    state.detail_account.lock().ok().and_then(|g|g.clone())
}
#[tauri::command]
pub fn hide_detail(app:AppHandle,state:State<'_,AppState>)->Result<(),String>{
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
pub fn get_profile_info()->crate::config::AppProfile{
    crate::config::get_profile()
}

#[tauri::command]
pub fn clear_profile_credentials()->Result<(),String>{
    crate::secrets::clear_profile_credentials()
}

#[tauri::command]
pub fn create_isolated_profile()->Result<String,String>{
    crate::config::create_isolated_profile()
}

#[cfg(test)]
mod tests {
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
