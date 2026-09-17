use crate::types::AppSettings;
use std::fs;
use std::path::PathBuf;

pub fn get_config_dir() -> PathBuf {
    if let Some(app_data) = dirs::config_dir() {
        app_data.join("pulse-windows")
    } else {
        PathBuf::from("./config")
    }
}

pub fn get_config_path() -> PathBuf {
    get_config_dir().join("settings.json")
}

pub fn load_settings() -> AppSettings {
    let path = get_config_path();
    if path.exists() {
        if let Ok(content) = fs::read_to_string(&path) {
            if let Ok(settings) = serde_json::from_str::<AppSettings>(&content) {
                return settings;
            }
        }
    }
    
    // Save default settings if not existing
    let default_settings = AppSettings::default();
    let _ = save_settings(&default_settings);
    default_settings
}

pub fn save_settings(settings: &AppSettings) -> Result<(), String> {
    let dir = get_config_dir();
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    let path = get_config_path();
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())?;
    Ok(())
}
