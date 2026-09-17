use crate::{secrets::{SecretStore,WindowsSecrets},types::AppSettings};
use std::{fs,io::Write,path::{Path,PathBuf}};
pub fn get_config_dir()->PathBuf {
    std::env::var_os("PULSE_DATA_DIR").map(PathBuf::from).filter(|p|p.is_absolute())
        .unwrap_or_else(||dirs::config_dir().unwrap_or_else(std::env::temp_dir).join("pulse-windows"))
}
pub fn load_settings()->Result<AppSettings,String>{load_from(&get_config_dir().join("settings.json"),&WindowsSecrets)}
pub fn load_from(path:&Path,store:&dyn SecretStore)->Result<AppSettings,String>{
    if !path.exists(){return Ok(AppSettings::default())}
    let bytes=fs::read(path).map_err(|_|"无法读取设置；原文件未修改")?;
    let mut root:serde_json::Value=serde_json::from_slice(&bytes).map_err(|_|"设置 JSON 损坏；原文件未修改")?;
    let legacy=root.get("schema_version").is_none();
    if legacy {
        let providers=root.get_mut("providers").and_then(|v|v.as_object_mut()).ok_or("旧设置缺少 providers")?;
        for (id,cfg) in providers.iter_mut(){
            if !crate::types::valid_id(id){return Err("旧账号标识无效".into())}
            let map=cfg.as_object_mut().ok_or("旧账号设置无效")?;
            map.insert("provider_id".into(),serde_json::json!(id));
            map.insert("label".into(),serde_json::json!(crate::types::name(id)));
            map.insert("use_local".into(),serde_json::json!(true));
            if map.get("custom_endpoint").and_then(|v|v.as_str()).is_some_and(|s|!s.is_empty()) {
                return Err("旧配置含自定义地址；请先核对，不会忽略或覆盖原文件".into());
            }
            map.remove("custom_endpoint");
        }
        root["schema_version"]=serde_json::json!(2);
    }
    let mut cleaned=root.clone();
    if let Some(providers)=cleaned.get_mut("providers").and_then(|v|v.as_object_mut()) {
        for cfg in providers.values_mut(){cfg.as_object_mut().ok_or("账号设置无效")?.remove("api_key");}
    }
    let mut settings:AppSettings=serde_json::from_value(cleaned).map_err(|_|"设置结构无效；原文件未修改")?;
    settings.validate()?;
    // Older schemas deserialize through serde defaults; persist them at the current version so
    // every field is spelled out on disk and a downgrade is visible instead of silent.
    let upgraded=settings.schema_version<crate::types::SCHEMA_VERSION;
    settings.schema_version=crate::types::SCHEMA_VERSION;
    let mut migrated=legacy||upgraded;
    for (id,cfg) in settings.providers.iter_mut(){
        if let Some(key)=root["providers"][id]["api_key"].as_str().filter(|s|!s.trim().is_empty()) {
            store.put(id,key)?;
            if store.get(id)?.as_deref()!=Some(key){return Err("迁移凭据校验失败；原设置未修改".into())}
            migrated=true;
        }
        cfg.credential_configured=store.get(id)?.is_some();
    }
    if migrated {save_to(path,&settings)?;}
    Ok(settings)
}
pub fn save_settings(settings:&AppSettings)->Result<(),String>{save_to(&get_config_dir().join("settings.json"),settings)}
/// Called before the UI overwrites a settings file that failed to load, so a
/// legacy file (possibly still holding api_key entries) is never silently lost.
pub fn backup_settings(){
    let path=get_config_dir().join("settings.json");
    if path.exists(){let _=fs::copy(&path,path.with_extension(format!("json.{}.bak",chrono::Utc::now().format("%Y%m%d%H%M%S"))));}
}
pub fn save_to(path:&Path,settings:&AppSettings)->Result<(),String>{
    settings.validate()?;
    let bytes=serde_json::to_vec_pretty(settings).map_err(|_|"设置序列化失败")?;
    atomic_write(path,&bytes)
}
pub fn atomic_write(path:&Path,bytes:&[u8])->Result<(),String>{
    let parent=path.parent().ok_or("设置目录无效")?;
    fs::create_dir_all(parent).map_err(|_|"无法创建数据目录")?;
    let temp=path.with_extension(format!("{}.tmp",uuid::Uuid::new_v4()));
    let result=(||{
        let mut file=fs::OpenOptions::new().create_new(true).write(true).open(&temp).map_err(|_|"无法创建临时文件")?;
        file.write_all(bytes).and_then(|_|file.sync_all()).map_err(|_|"无法写入临时文件")?;
        drop(file);
        #[cfg(windows)] {
            use windows::{core::PCWSTR,Win32::Storage::FileSystem::*};
            use std::os::windows::ffi::OsStrExt;
            let a:Vec<u16>=temp.as_os_str().encode_wide().chain(Some(0)).collect();
            let b:Vec<u16>=path.as_os_str().encode_wide().chain(Some(0)).collect();
            unsafe {MoveFileExW(PCWSTR(a.as_ptr()),PCWSTR(b.as_ptr()),MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH)}.map_err(|_|"无法原子替换文件")?;
        }
        #[cfg(not(windows))] fs::rename(&temp,path).map_err(|_|"无法原子替换文件")?;
        Ok(())
    })();
    if result.is_err(){let _=fs::remove_file(&temp);} result
}
pub fn refresh_credential_flags(settings:&mut AppSettings)->Result<(),String>{
    for (id,cfg) in settings.providers.iter_mut(){cfg.credential_configured=WindowsSecrets.get(id)?.is_some();} Ok(())
}
#[cfg(test)] mod tests {
    use super::*; use std::{cell::RefCell,collections::HashMap};
    #[derive(Default)] struct Memory(RefCell<HashMap<String,String>>,bool);
    impl SecretStore for Memory {
        fn get(&self,id:&str)->Result<Option<String>,String>{Ok(self.0.borrow().get(id).cloned())}
        fn put(&self,id:&str,key:&str)->Result<(),String>{if self.1{return Err("failure".into())} self.0.borrow_mut().insert(id.into(),key.into());Ok(())}
        fn delete(&self,id:&str)->Result<(),String>{self.0.borrow_mut().remove(id);Ok(())}
    }
    #[test] fn damaged_file_is_unchanged(){let d=tempfile::tempdir().unwrap();let p=d.path().join("settings.json");fs::write(&p,b"broken").unwrap();assert!(load_from(&p,&Memory::default()).is_err());assert_eq!(fs::read(p).unwrap(),b"broken");}
    #[test] fn migrates_only_after_verified_store(){
        let d=tempfile::tempdir().unwrap();let p=d.path().join("settings.json");
        let old=r#"{"providers":{"claude":{"enabled":true,"order":0,"api_key":"fixture-secret"}}}"#;
        fs::write(&p,old).unwrap();assert!(load_from(&p,&Memory(RefCell::default(),true)).is_err());assert_eq!(fs::read_to_string(&p).unwrap(),old);
        let m=Memory::default();let s=load_from(&p,&m).unwrap();assert!(s.providers["claude"].credential_configured);assert!(!fs::read_to_string(&p).unwrap().contains("fixture-secret"));assert!(!serde_json::to_string(&s).unwrap().contains("api_key"));
    }
    #[test] fn invalid_settings_are_not_written(){let d=tempfile::tempdir().unwrap();let mut s=AppSettings::default();s.refresh_interval_seconds=0;assert!(save_to(&d.path().join("x"),&s).is_err());}
    #[test] fn unicode_path_and_roundtrip(){let d=tempfile::tempdir().unwrap();let p=d.path().join("中文 空格/settings.json");save_to(&p,&AppSettings::default()).unwrap();assert!(load_from(&p,&Memory::default()).is_ok());}
    #[test] fn v2_settings_upgrade_to_v3_keeping_everything(){
        let d=tempfile::tempdir().unwrap();let p=d.path().join("settings.json");
        let v2=r#"{"schema_version":2,"dock_side":"left","auto_collapse_seconds":2,"theme":"translucent","refresh_interval_seconds":300,"display_mode":"remaining","forecast":true,"show_elapsed":true,"follow_active_display":false,"hide_fullscreen":true,"monitor_name":"\\\\.\\DISPLAY3","free_x":0.5,"free_y":0.5,"providers":{"codex":{"provider_id":"codex","label":"工作","enabled":true,"order":2,"use_local":true,"credential_configured":false,"primary_window":"account-primary_window"}}}"#;
        fs::write(&p,v2).unwrap();
        let s=load_from(&p,&Memory::default()).unwrap();
        assert_eq!(s.schema_version,3);assert_eq!(s.dock_side,"left");assert_eq!(s.theme,"translucent");assert_eq!(s.refresh_interval_seconds,300);
        assert_eq!(s.providers["codex"].order,2);assert_eq!(s.providers["codex"].label,"工作");assert_eq!(s.providers["codex"].primary_window.as_deref(),Some("account-primary_window"));
        assert_eq!(s.warning_threshold,90);assert_eq!(s.notifications,crate::types::NotificationSettings::default());assert!(s.show_rail);assert_eq!(s.start_behavior,"rail");
        let on_disk:serde_json::Value=serde_json::from_slice(&fs::read(&p).unwrap()).unwrap();
        assert_eq!(on_disk["schema_version"],3,"file is rewritten at the current schema");
        assert_eq!(on_disk["providers"]["codex"]["order"],2);
        assert!(load_from(&p,&Memory::default()).is_ok(),"the rewritten file loads again");
    }
}
