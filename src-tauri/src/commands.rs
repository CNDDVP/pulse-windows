use crate::{types::{AppSettings,ProviderUsage},secrets::{SecretStore,WindowsSecrets},AppState};
use tauri::{AppHandle,Emitter,State,Manager};
#[tauri::command]
pub async fn token_spend(days:u32,state:State<'_,AppState>)->Result<crate::ledger::Summary,String>{
    let _gate=state.ledger_gate.lock().await;
    tauri::async_runtime::spawn_blocking(move||crate::ledger::scan(days)).await.map_err(|_|"统计任务失败")?
}
#[tauri::command]
pub fn monitors(app:AppHandle)->Result<Vec<String>,String>{
    Ok(app.get_webview_window("main").ok_or("窗口不存在")?.available_monitors().map_err(|_|"显示器查询失败")?.iter().filter_map(|m|m.name().cloned()).collect())
}
#[tauri::command]
pub async fn get_settings(state:State<'_,AppState>)->Result<AppSettings,String>{
    // Defaults are returned even when settings.json failed to load, so the UI can
    // repair the file; the failure itself is surfaced through `diagnostics`.
    Ok(state.settings.lock().await.clone())
}
#[tauri::command]
pub async fn update_settings(new_settings:AppSettings,state:State<'_,AppState>,app:AppHandle)->Result<AppSettings,String>{
    new_settings.validate()?;let _gate=state.refresh_gate.lock().await;
    let old=state.settings.lock().await.clone();
    // An existing account cannot silently change the provider that receives its credential.
    for (id,cfg) in &new_settings.providers{if old.providers.get(id).is_some_and(|c|c.provider_id!=cfg.provider_id){return Err("不能更改已有账号的服务商，请新建账号".into())}}
    let had_error=state.config_error().is_some();
    let new_settings=tauri::async_runtime::spawn_blocking(move||{
        let mut s=new_settings;crate::config::refresh_credential_flags(&mut s)?;
        if had_error{crate::config::backup_settings();}
        crate::config::save_settings(&s)?;Ok::<_,String>(s)
    }).await.map_err(|_|"设置保存任务失败")??;
    *state.settings.lock().await=new_settings.clone();state.clear_config_error();
    let mut cached=state.cached_usages.lock().await;
    for u in cached.iter_mut(){
        let pin=new_settings.providers.get(&u.account_id).and_then(|c|c.primary_window.as_deref());
        crate::cache::apply_primary_window(u,pin);
    }
    cached.retain(|u|new_settings.providers.get(&u.account_id).is_some_and(|c|c.enabled));
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
pub async fn test_account(account_id:String,app:AppHandle)->Result<ProviderUsage,String>{
    let r=crate::refresh_usages_and_emit(&app).await?;
    r.into_iter().find(|r|r.account_id==account_id).ok_or("账号未启用；先保存账号设置".into())
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
    let _gate=state.refresh_gate.lock().await;
    let mut settings=state.settings.lock().await.clone();
    settings.providers.get_mut(&account_id).ok_or("账号不存在")?.credential_configured=true;
    let had_error=state.config_error().is_some();
    let saved=tauri::async_runtime::spawn_blocking({let account_id=account_id.clone();move||{
        WindowsSecrets.put(&account_id,secret.trim())?;
        if had_error{crate::config::backup_settings();}
        crate::config::save_settings(&settings)?;Ok::<_,String>(settings)
    }}).await.map_err(|_|"凭据保存任务失败")??;
    *state.settings.lock().await=saved.clone();state.clear_config_error();
    state.schedule.lock().await.remove(&account_id);state.cached_usages.lock().await.retain(|r|r.account_id!=account_id);
    app.emit("settings-updated",&saved).map_err(|_|"凭据已保存但窗口通知失败")?;Ok(())
}
#[tauri::command]
pub async fn delete_credential(account_id:String,state:State<'_,AppState>,app:AppHandle)->Result<(),String>{
    let _gate=state.refresh_gate.lock().await;
    let mut settings=state.settings.lock().await.clone();
    settings.providers.get_mut(&account_id).ok_or("账号不存在")?.credential_configured=false;
    let had_error=state.config_error().is_some();
    let saved=tauri::async_runtime::spawn_blocking({let account_id=account_id.clone();move||{
        WindowsSecrets.delete(&account_id)?;
        if had_error{crate::config::backup_settings();}
        crate::config::save_settings(&settings)?;Ok::<_,String>(settings)
    }}).await.map_err(|_|"凭据删除任务失败")??;
    *state.settings.lock().await=saved.clone();state.clear_config_error();
    state.schedule.lock().await.remove(&account_id);state.cached_usages.lock().await.retain(|r|r.account_id!=account_id);
    app.emit("settings-updated",&saved).map_err(|_|"窗口通知失败")?;Ok(())
}
#[tauri::command]
pub async fn diagnostics(state:State<'_,AppState>)->Result<String,String>{
    // A whitelist, not regex scrubbing: no account id, label, token, raw body or path.
    let rows:Vec<_>=state.cached_usages.lock().await.iter().map(|r|serde_json::json!({"provider":r.provider_id,"state":r.state,"code":r.error_code,"source":r.source,"checked_at":r.checked_at,"last_success_at":r.last_success_at})).collect();
    serde_json::to_string_pretty(&serde_json::json!({"version":"0.2.0","configuration_error":state.config_error(),"readings":rows})).map_err(|_|"诊断生成失败".into())
}
