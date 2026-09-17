use crate::config::save_settings;
use crate::types::{AppSettings, ProviderUsage};
use crate::window;
use crate::AppState;
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> Result<AppSettings, String> {
    let settings = state.settings.lock().await;
    Ok(settings.clone())
}

#[tauri::command]
pub async fn update_settings(
    new_settings: AppSettings,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    save_settings(&new_settings)?;
    {
        let mut settings = state.settings.lock().await;
        *settings = new_settings.clone();
    }
    // Update window dock if changed
    window::position_edge_window(&app, &new_settings.dock_side, "rail");
    let _ = app.emit("settings-updated", &new_settings);
    // Trigger refresh
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = crate::refresh_usages_and_emit(&app_clone).await;
    });
    Ok(())
}

#[tauri::command]
pub async fn get_usages(state: State<'_, AppState>) -> Result<Vec<ProviderUsage>, String> {
    let usages = state.cached_usages.lock().await;
    Ok(usages.clone())
}

#[tauri::command]
pub async fn refresh_usages(app: AppHandle) -> Result<Vec<ProviderUsage>, String> {
    crate::refresh_usages_and_emit(&app).await
}

#[tauri::command]
pub fn set_window_state(side: String, state: String, app: AppHandle) {
    window::position_edge_window(&app, &side, &state);
}

#[tauri::command]
pub async fn open_settings(app: AppHandle) -> Result<(), String> {
    crate::open_settings_window(&app);
    Ok(())
}
