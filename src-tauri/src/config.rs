use crate::{secrets::{SecretStore,WindowsSecrets},types::AppSettings};
use std::{fs,io::Write,path::{Path,PathBuf}};
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConfigMode {
    Installed,
    Portable,
    CustomEnv,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AppProfile {
    pub profile_id: String,
    pub created_at: String,
    pub mode: ConfigMode,
    #[serde(default)]
    pub last_known_exe_path: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ProfileStatus {
    pub profile_id: String,
    pub mode: ConfigMode,
    pub created_at: String,
    pub last_known_exe_path: Option<String>,
    pub current_exe_path: Option<String>,
    pub is_copy: bool,
    pub is_moved: bool,
}

static DATA_DIR_AND_MODE: OnceLock<Result<(PathBuf, ConfigMode), String>> = OnceLock::new();
static CACHED_PROFILE: OnceLock<Mutex<AppProfile>> = OnceLock::new();

pub fn resolve_data_dir() -> Result<(PathBuf, ConfigMode), String> {
    if let Some(dir_str) = std::env::var_os("PULSE_DATA_DIR") {
        let p = PathBuf::from(dir_str);
        if !p.is_absolute() {
            return Err("环境变量 PULSE_DATA_DIR 必须为有效绝对路径".into());
        }
        fs::create_dir_all(&p).map_err(|e| format!("无法创建 PULSE_DATA_DIR 目录：{e}"))?;
        let test_file = p.join(format!(".pulse_write_test_{}", uuid::Uuid::new_v4()));
        fs::write(&test_file, b"ok").map_err(|e| format!("PULSE_DATA_DIR 目录不可写：{e}"))?;
        let _ = fs::remove_file(test_file);
        return Ok((p, ConfigMode::CustomEnv));
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            if exe_dir.join("portable.flag").exists() {
                let data_dir = exe_dir.join("data");
                fs::create_dir_all(&data_dir).map_err(|e| format!("便携模式无法创建 data 目录：{e}"))?;
                let test_file = data_dir.join(format!(".pulse_write_test_{}", uuid::Uuid::new_v4()));
                fs::write(&test_file, b"ok").map_err(|e| format!("便携模式 data 目录只读或不可写，请检查权限：{e}"))?;
                let _ = fs::remove_file(test_file);
                return Ok((data_dir, ConfigMode::Portable));
            }
        }
    }

    let app_data = dirs::config_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("pulse-windows");
    fs::create_dir_all(&app_data).map_err(|e| format!("无法创建用户数据目录：{e}"))?;
    Ok((app_data, ConfigMode::Installed))
}

pub fn init_config_dir() -> Result<(PathBuf, ConfigMode), String> {
    DATA_DIR_AND_MODE.get_or_init(resolve_data_dir).clone()
}

pub fn get_config_dir() -> PathBuf {
    match DATA_DIR_AND_MODE.get_or_init(resolve_data_dir) {
        Ok((p, _)) => p.clone(),
        Err(_) => dirs::config_dir().unwrap_or_else(std::env::temp_dir).join("pulse-windows"),
    }
}

pub fn get_config_mode() -> ConfigMode {
    match DATA_DIR_AND_MODE.get_or_init(resolve_data_dir) {
        Ok((_, m)) => *m,
        Err(_) => ConfigMode::Installed,
    }
}

pub fn is_portable() -> bool {
    get_config_mode() == ConfigMode::Portable
}

pub fn get_profile() -> AppProfile {
    let cell = CACHED_PROFILE.get_or_init(|| {
        let dir = get_config_dir();
        let path = dir.join("profile.json");
        let mode = get_config_mode();
        let current_exe_str = std::env::current_exe().ok().map(|p| p.to_string_lossy().to_string());
        if let Ok(bytes) = fs::read(&path) {
            match serde_json::from_slice::<AppProfile>(&bytes) {
                Ok(mut prof) => {
                    prof.mode = mode;
                    if prof.last_known_exe_path.is_none() && current_exe_str.is_some() {
                        prof.last_known_exe_path = current_exe_str;
                        if let Ok(b) = serde_json::to_vec_pretty(&prof) {
                            let _ = atomic_write(&path, &b);
                        }
                    }
                    return Mutex::new(prof);
                }
                Err(e) => {
                    // 损坏不静默：保留坏文件副本供诊断，写日志说明换发了新身份（A18）。
                    let bad = dir.join(format!("profile.json.bad-{}", chrono::Local::now().format("%Y%m%d-%H%M%S")));
                    if let Err(copy_err) = fs::copy(&path, &bad) {
                        eprintln!("Pulse: profile.json 损坏且无法保留副本: {copy_err}");
                    } else {
                        eprintln!("Pulse: profile.json 解析失败（副本已存 {}），生成新身份: {e}", bad.display());
                    }
                }
            }
        }
        // W11: 首次启动创建便携配置时，使用 crypto-random 生成持久的 Profile ID (pr_xxxxxxxx)
        let new_id = format!("pr_{}", &uuid::Uuid::new_v4().simple().to_string()[..16]);
        let prof = AppProfile {
            profile_id: new_id,
            created_at: chrono::Utc::now().to_rfc3339(),
            mode,
            last_known_exe_path: current_exe_str,
        };
        if let Ok(bytes) = serde_json::to_vec_pretty(&prof) {
            match atomic_write(&path, &bytes) {
                Ok(()) => {}
                Err(write_err)=>{
                    eprintln!("Pulse: 新 Profile 写盘失败: {write_err}");
                }
            }
        }
        Mutex::new(prof)
    });
    cell.lock().unwrap().clone()
}

pub fn get_profile_id() -> String {
    get_profile().profile_id
}

pub fn check_profile_status() -> ProfileStatus {
    let prof = get_profile();
    let current_exe = std::env::current_exe().ok().map(|p| p.to_string_lossy().to_string());
    let mut is_copy = false;
    let mut is_moved = false;
    if let (Some(ref last), Some(ref curr)) = (&prof.last_known_exe_path, &current_exe) {
        if !last.eq_ignore_ascii_case(curr) {
            if Path::new(last).exists() {
                is_copy = true;
            } else {
                is_moved = true;
            }
        }
    }
    ProfileStatus {
        profile_id: prof.profile_id,
        mode: prof.mode,
        created_at: prof.created_at,
        last_known_exe_path: prof.last_known_exe_path,
        current_exe_path: current_exe,
        is_copy,
        is_moved,
    }
}

pub fn create_isolated_profile() -> Result<String, String> {
    let dir = get_config_dir();
    let path = dir.join("profile.json");
    let mode = get_config_mode();
    let old_id = get_profile_id();
    let current_exe_str = std::env::current_exe().ok().map(|p| p.to_string_lossy().to_string());
    let new_id = format!("pr_{}", &uuid::Uuid::new_v4().simple().to_string()[..16]);
    let prof = AppProfile {
        profile_id: new_id.clone(),
        created_at: chrono::Utc::now().to_rfc3339(),
        mode,
        last_known_exe_path: current_exe_str,
    };
    let bytes = serde_json::to_vec_pretty(&prof).map_err(|e| format!("序列化 Profile 失败: {e}"))?;
    atomic_write(&path, &bytes)?;
    if let Some(cell) = CACHED_PROFILE.get() {
        *cell.lock().unwrap() = prof;
    }
    #[cfg(windows)]
    let _ = crate::platform::remove_startup_for_profile(&old_id);
    Ok(new_id)
}
pub fn parse_settings_readonly(path:&Path,store:&dyn SecretStore)->Result<AppSettings,String>{
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
    if !settings.monitoring_setup_completed && settings.providers.values().any(|p| p.enabled) {
        settings.monitoring_setup_completed = true;
        let mut auth: Vec<String> = settings.providers.values().filter(|p| p.enabled).map(|p| p.provider_id.clone()).collect();
        auth.sort();
        auth.dedup();
        settings.authorized_providers = auth;
    }
    settings.validate()?;
    settings.schema_version=crate::types::SCHEMA_VERSION;
    for (id,cfg) in settings.providers.iter_mut(){
        cfg.credential_configured=store.get(id)?.is_some()
            || root.get("providers").and_then(|p|p.get(id)).and_then(|c|c.get("api_key")).and_then(|k|k.as_str()).is_some_and(|k|!k.trim().is_empty());
    }
    Ok(settings)
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
    if !settings.monitoring_setup_completed && settings.providers.values().any(|p| p.enabled) {
        settings.monitoring_setup_completed = true;
        let mut auth: Vec<String> = settings.providers.values().filter(|p| p.enabled).map(|p| p.provider_id.clone()).collect();
        auth.sort();
        auth.dedup();
        settings.authorized_providers = auth;
    }
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
pub fn backup_settings()->Result<Option<PathBuf>,String>{
    backup_file(&get_config_dir().join("settings.json"))
}
pub fn backup_file(path:&Path)->Result<Option<PathBuf>,String>{
    if path.exists(){
        let unique=format!("json.{}_{}.bak",chrono::Utc::now().format("%Y%m%d%H%M%S%6f"),uuid::Uuid::new_v4());
        let backup_path=path.with_extension(unique);
        fs::copy(path,&backup_path).map_err(|e|format!("配置备份失败，已阻止覆盖原文件：{e}"))?;
        Ok(Some(backup_path))
    }else{
        Ok(None)
    }
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

#[derive(Debug, Clone, serde::Serialize)]
pub struct ImportableConfigSummary {
    pub account_count: usize,
    pub provider_names: Vec<String>,
    pub installed_path: String,
}

pub fn get_installed_config_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("pulse-windows")
}

pub fn check_importable_config() -> Result<Option<ImportableConfigSummary>, String> {
    if !is_portable() {
        return Ok(None);
    }
    let installed_dir = get_installed_config_dir();
    let installed_settings_path = installed_dir.join("settings.json");
    if !installed_settings_path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(&installed_settings_path).map_err(|e| format!("无法读取已安装版设置: {e}"))?;
    let root: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| format!("已安装版设置损坏: {e}"))?;
    let providers = root.get("providers").and_then(|v| v.as_object());
    let Some(providers) = providers else { return Ok(None); };
    if providers.is_empty() { return Ok(None); }

    let count = providers.len();
    let mut names = Vec::new();
    for (id, val) in providers {
        let label = val.get("label").and_then(|v| v.as_str()).unwrap_or(id);
        names.push(label.to_string());
    }
    Ok(Some(ImportableConfigSummary {
        account_count: count,
        provider_names: names,
        installed_path: installed_settings_path.to_string_lossy().to_string(),
    }))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportMode {
    Append,
    Overwrite,
}

pub fn import_installed_config(mode: ImportMode) -> Result<AppSettings, String> {
    if !is_portable() {
        return Err("仅便携版支持从安装版导入配置".into());
    }
    let installed_dir = get_installed_config_dir();
    let installed_settings_path = installed_dir.join("settings.json");
    if !installed_settings_path.exists() {
        return Err("未找到已安装版的 settings.json".into());
    }

    let installed_profile_path = installed_dir.join("profile.json");
    let installed_profile_id = if let Ok(bytes) = fs::read(&installed_profile_path) {
        serde_json::from_slice::<AppProfile>(&bytes).ok().map(|p| p.profile_id)
    } else {
        None
    }.unwrap_or_else(|| {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        use std::hash::{Hash, Hasher};
        installed_dir.hash(&mut hasher);
        format!("{:?}", ConfigMode::Installed).hash(&mut hasher);
        format!("pr{:016x}", hasher.finish())
    });

    struct OldStore {
        old_profile_id: String,
        old_dir: PathBuf,
    }
    impl SecretStore for OldStore {
        fn get(&self, id: &str) -> Result<Option<String>, String> {
            #[cfg(windows)] {
                use windows::{core::PCWSTR, Win32::Security::Credentials::*};
                if !crate::types::valid_id(id) { return Err("账号标识无效".into()); }
                let target: Vec<u16> = format!("PulseWindows/{}/{id}\0", &self.old_profile_id).encode_utf16().collect();
                unsafe {
                    let mut ptr = std::ptr::null_mut();
                    if CredReadW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, 0, &mut ptr).is_ok() {
                        let bytes = std::slice::from_raw_parts((*ptr).CredentialBlob, (*ptr).CredentialBlobSize as usize);
                        let result = String::from_utf8(bytes.to_vec()).map_err(|_| "凭据编码无效".into());
                        CredFree(ptr.cast());
                        return result.map(Some);
                    }
                    use sha2::{Digest, Sha256};
                    let scope = format!("{:x}", Sha256::digest(self.old_dir.to_string_lossy().as_bytes()));
                    let leg: Vec<u16> = format!("PulseWindows/{}/{id}\0", &scope[..24]).encode_utf16().collect();
                    let mut leg_ptr = std::ptr::null_mut();
                    if CredReadW(PCWSTR(leg.as_ptr()), CRED_TYPE_GENERIC, 0, &mut leg_ptr).is_ok() {
                        let bytes = std::slice::from_raw_parts((*leg_ptr).CredentialBlob, (*leg_ptr).CredentialBlobSize as usize);
                        let secret = String::from_utf8(bytes.to_vec()).map_err(|_| "凭据编码无效".to_string())?;
                        CredFree(leg_ptr.cast());
                        return Ok(Some(secret));
                    }
                    Ok(None)
                }
            }
            #[cfg(not(windows))] {
                Ok(None)
            }
        }
        fn put(&self, _: &str, _: &str) -> Result<(), String> { Ok(()) }
        fn delete(&self, _: &str) -> Result<(), String> { Ok(()) }
    }

    let old_store = OldStore {
        old_profile_id: installed_profile_id,
        old_dir: installed_dir,
    };

    // W04: 只读解析源配置，绝不写回或污染源目录
    let source_settings = parse_settings_readonly(&installed_settings_path, &old_store)?;

    // W06: 覆盖模式先备份，追加模式遇到冲突则分配新唯一 ID
    let mut current_settings = load_settings().unwrap_or_default();
    if mode == ImportMode::Overwrite {
        backup_settings()?;
        current_settings.providers.clear();
    }

    let mut written_keys: Vec<String> = Vec::new();

    let merge_result: Result<(), String> = (|| {
        let mut max_order = current_settings.providers.values().map(|c| c.order).max().unwrap_or(0);
        for (src_id, mut cfg) in source_settings.providers {
            let target_id = if current_settings.providers.contains_key(&src_id) {
                format!("{}_{}", src_id, &uuid::Uuid::new_v4().simple().to_string()[..6])
            } else {
                src_id.clone()
            };

            // W05: 迁移凭据并校验 (Read-after-Write)
            if let Ok(Some(secret)) = old_store.get(&src_id) {
                WindowsSecrets.put(&target_id, &secret)
                    .map_err(|e| format!("写入凭据失败 ({target_id}): {e}"))?;
                written_keys.push(target_id.clone());

                let readback = WindowsSecrets.get(&target_id)
                    .map_err(|e| format!("读回凭据校验异常 ({target_id}): {e}"))?;
                if readback.as_deref() != Some(&secret) {
                    return Err(format!("凭据读回校验不一致 ({target_id})"));
                }
                cfg.credential_configured = true;
            } else {
                cfg.credential_configured = false;
            }

            max_order += 1;
            cfg.order = max_order;
            cfg.provider_id = target_id.clone();
            current_settings.providers.insert(target_id, cfg);
        }
        Ok(())
    })();

    if let Err(e) = merge_result {
        // 发生错误时回滚所有已写入的目标凭据
        for key in &written_keys {
            let _ = WindowsSecrets.delete(key);
        }
        return Err(format!("导入失败已回滚凭据: {e}"));
    }

    save_settings(&current_settings)?;
    Ok(current_settings)
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
    #[test] fn v2_settings_upgrade_to_v4_keeping_everything(){
        let d=tempfile::tempdir().unwrap();let p=d.path().join("settings.json");
        let v2=r#"{"schema_version":2,"dock_side":"left","auto_collapse_seconds":2,"theme":"translucent","refresh_interval_seconds":300,"display_mode":"remaining","forecast":true,"show_elapsed":true,"follow_active_display":false,"hide_fullscreen":true,"monitor_name":"\\\\.\\DISPLAY3","free_x":0.5,"free_y":0.5,"providers":{"codex":{"provider_id":"codex","label":"工作","enabled":true,"order":2,"use_local":true,"credential_configured":false,"primary_window":"account-primary_window"}}}"#;
        fs::write(&p,v2).unwrap();
        let s=load_from(&p,&Memory::default()).unwrap();
        assert_eq!(s.schema_version,4);assert_eq!(s.dock_side,"left");assert_eq!(s.theme,"translucent");assert_eq!(s.refresh_interval_seconds,300);
        assert_eq!(s.providers["codex"].order,2);assert_eq!(s.providers["codex"].label,"工作");assert_eq!(s.providers["codex"].primary_window.as_deref(),Some("account-primary_window"));
        assert_eq!(s.warning_threshold,90);assert_eq!(s.notifications,crate::types::NotificationSettings::default());assert!(s.show_rail);assert_eq!(s.start_behavior,"rail");
        assert!(s.monitoring_setup_completed);
        assert_eq!(s.authorized_providers, vec!["codex"]);
        let on_disk:serde_json::Value=serde_json::from_slice(&fs::read(&p).unwrap()).unwrap();
        assert_eq!(on_disk["schema_version"],4,"file is rewritten at the current schema");
        assert_eq!(on_disk["providers"]["codex"]["order"],2);
        assert!(load_from(&p,&Memory::default()).is_ok(),"the rewritten file loads again");
    }
    #[test] fn backup_file_creates_unique_copy() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("settings.json");
        fs::write(&p, b"original content").unwrap();
        let b1 = backup_file(&p).unwrap().expect("backup 1 exists");
        let b2 = backup_file(&p).unwrap().expect("backup 2 exists");
        assert_ne!(b1, b2, "backup files must have unique names");
        assert_eq!(fs::read(&b1).unwrap(), b"original content");
        assert_eq!(fs::read(&b2).unwrap(), b"original content");
    }
    #[test] fn backup_file_nonexistent_returns_none() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("nonexistent.json");
        assert_eq!(backup_file(&p).unwrap(), None);
    }
    #[test] fn settings_generation_roundtrip() {
        let mut s = AppSettings::default();
        s.generation = 42;
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["generation"], 42);
        let s2: AppSettings = serde_json::from_value(v).unwrap();
        assert_eq!(s2.generation, 42);
    }
    #[test] fn profile_roundtrip_and_mode() {
        let p = AppProfile {
            profile_id: "p_1234567890abcdef".into(),
            created_at: "2026-09-18T00:00:00Z".into(),
            mode: ConfigMode::Portable,
            last_known_exe_path: None,
        };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["mode"], "portable");
        let p2: AppProfile = serde_json::from_value(v).unwrap();
        assert_eq!(p2.profile_id, "p_1234567890abcdef");
        assert_eq!(p2.mode, ConfigMode::Portable);
    }
    #[test] fn parse_settings_readonly_does_not_modify_disk() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("settings.json");
        let v2 = r#"{"schema_version":2,"providers":{"codex":{"provider_id":"codex","label":"工作","enabled":true,"order":2,"use_local":true,"credential_configured":false}}}"#;
        fs::write(&p, v2).unwrap();
        let s = parse_settings_readonly(&p, &Memory::default()).unwrap();
        assert_eq!(s.schema_version, crate::types::SCHEMA_VERSION);
        let on_disk = fs::read_to_string(&p).unwrap();
        assert_eq!(on_disk, v2, "source file on disk must NOT be modified by parse_settings_readonly");
    }
}
