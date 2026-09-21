use super::core::*;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};
#[derive(Clone, Serialize, Deserialize)]
pub struct Plan {
    pub exe: PathBuf,
    pub data: PathBuf,
    pub profile: String,
    pub version: String,
    pub mode: String,
    pub parent_pid: u32,
    pub old_hash: String,
    pub package_hash: String,
    pub package_name: String,
    pub work: PathBuf,
}
pub fn mode(exe: &Path) -> String {
    if std::env::var_os("PULSE_DATA_DIR").is_some() {
        return "advanced".into();
    }
    if exe.file_name().and_then(|s| s.to_str()) == Some("Pulse.exe")
        && exe.parent().unwrap().join("portable.flag").is_file()
    {
        return "portable".into();
    }
    #[cfg(windows)]
    {
        use winreg::{enums::*, RegKey};
        for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
            for view in [KEY_WOW64_64KEY, KEY_WOW64_32KEY] {
                if let Ok(keys) = RegKey::predef(hive).open_subkey_with_flags(
                    "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
                    KEY_READ | view,
                ) {
                    for name in keys.enum_keys().flatten() {
                        if let Ok(key) = keys.open_subkey(&name) {
                            let title: String = key.get_value("DisplayName").unwrap_or_default();
                            let location: String =
                                key.get_value("InstallLocation").unwrap_or_default();
                            let is_pulse_bin = exe.file_name().and_then(|s| s.to_str()).is_some_and(|n| {
                                n.eq_ignore_ascii_case("pulse-windows.exe") || n.eq_ignore_ascii_case("pulse.exe")
                            });
                            if is_pulse_bin
                                && title == "Pulse"
                                && !location.is_empty()
                                && fs::canonicalize(location.trim().trim_matches('"')).ok()
                                    == exe.parent().and_then(|p| fs::canonicalize(p).ok())
                            {
                                return "installed".into();
                            }
                        }
                    }
                }
            }
        }
    }
    "advanced".into()
}
pub fn lock(exe: &Path) -> Result<fs::File> {
    let root = cache_for(exe);
    plain(&root)?;
    fs::create_dir_all(&root).map_err(|_| "无法创建更新目录")?;
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root.join("apply.lock"))
        .map_err(|_| "无法打开更新锁")?;
    fs2::FileExt::try_lock_exclusive(&file).map_err(|_| "该 Pulse 正在更新，请稍后重试")?;
    Ok(file)
}
pub fn validate(p: &Plan) -> Result<()> {
    if !p.exe.is_absolute() || !p.data.is_absolute() {
        return Err("更新目标必须为绝对路径".into());
    }
    let root = p.exe.parent().ok_or("缺少更新目录")?;
    plain(root)?;
    plain(&p.data)?;
    plain(&p.work)?;
    let scope = cache_for(&p.exe);
    if p.work.parent() != Some(scope.as_path())
        || p.work
            .file_name()
            .and_then(|s| s.to_str())
            .and_then(|s| uuid::Uuid::parse_str(s).ok())
            .is_none()
    {
        return Err("更新工作目录越界".into());
    }
    if p.work.starts_with(root) || root.starts_with(&p.work) || p.data == root {
        return Err("程序/数据/更新目录关系不安全".into());
    }
    if p.mode == "installed" && mode(&p.exe) != "installed" {
        return Err("安装注册位置已变化".into());
    }
    if !["portable", "installed"].contains(&p.mode.as_str()) {
        return Err("不支持的部署模式".into());
    }
    if p.mode == "portable"
        && (p.exe.file_name().and_then(|s| s.to_str()) != Some("Pulse.exe")
            || p.data != root.join("data")
            || !root.join("portable.flag").is_file())
    {
        return Err("便携版目标验证失败".into());
    }
    let v = version(&p.version)?;
    if !v.pre.is_empty() {
        return Err("不能安装预发行版本".into());
    }
    let name = format!(
        "Pulse-{v}-windows-x64-{}",
        if p.mode == "portable" {
            "portable.zip"
        } else {
            "setup.exe"
        }
    );
    if name != p.package_name {
        return Err("包体文件名不匹配".into());
    }
    verify(&p.work.join(&p.package_name), &p.package_hash)?;
    let profile: serde_json::Value = read_json(&p.data.join("profile.json"))?;
    if profile["profile_id"].as_str() != Some(&p.profile) {
        return Err("Profile 已变化，更新已取消".into());
    }
    Ok(())
}
#[cfg(windows)]
fn wait_parent(p: &Plan) -> Result<()> {
    use windows::{
        core::PWSTR,
        Win32::{Foundation::*, System::Threading::*},
    };
    unsafe {
        let h = OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            false,
            p.parent_pid,
        )
        .map_err(|_| "无法确认旧 Pulse 进程")?;
        let result = (|| {
            let mut buf = [0u16; 32768];
            let mut len = buf.len() as u32;
            QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len)
                .map_err(|_| "无法读取旧进程身份")?;
            let actual = fs::canonicalize(PathBuf::from(String::from_utf16_lossy(
                &buf[..len as usize],
            )))
            .map_err(|_| "无法核实父进程路径")?;
            let expected = fs::canonicalize(&p.exe).map_err(|_| "无法核实目标程序路径")?;
            if actual != expected {
                return Err("父进程路径与更新目标不符".into());
            }
            fs::write(p.work.join("helper-ready"), b"ready").map_err(|_| "helper 握手失败")?;
            if WaitForSingleObject(h, 60000) != WAIT_OBJECT_0 {
                return Err("旧 Pulse 未退出，更新已取消（未强制终止）".into());
            }
            Ok(())
        })();
        let _ = CloseHandle(h);
        result
    }
}
#[cfg(not(windows))]
fn wait_parent(_: &Plan) -> Result<()> {
    Err("仅支持 Windows 更新".into())
}
fn restart(p: &Plan) -> Result<()> {
    Command::new(&p.exe)
        .current_dir(p.exe.parent().unwrap())
        .spawn()
        .map_err(|_| "新版启动失败，保留更新备份")?;
    Ok(())
}
pub fn run(path: &Path) -> Result<()> {
    let p: Plan = read_json(path)?;
    validate(&p)?;
    if path != p.work.join("plan.json") {
        return Err("helper 清单路径不匹配".into());
    }
    verify(
        &std::env::current_exe().map_err(|_| "helper 路径未知")?,
        &p.old_hash,
    )?;
    verify(&p.exe, &p.old_hash)?;
    let guard = lock(&p.exe)?;
    wait_parent(&p)?;
    validate(&p)?;
    write_json(&cache_for(&p.exe).join("pending.json"), &p)?;
    let result = if p.mode == "portable" {
        replace(
            p.exe.parent().unwrap(),
            &p.work.join("staging"),
            &p.work,
            &p.version,
            None,
        )
    } else {
        let mut cmd = Command::new(p.work.join(&p.package_name));
        // NSIS /D must be the last raw argument, unquoted, including paths with spaces.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.raw_arg(format!("/D={}", p.exe.parent().unwrap().display()));
        }
        match cmd.status() {
            Ok(status) if status.success() => Ok(()),
            Ok(_) => Err("安装器取消或失败；未删除原安装，需手动重试".into()),
            Err(_) => Err("无法启动安装器；旧版未删除".into()),
        }
    };
    let message = match &result {
        Ok(()) => "awaiting_confirmation".to_string(),
        Err(e) => e.clone(),
    };
    write_json(&p.work.join("result.json"), &message)?;
    write_json(&cache_for(&p.exe).join("last-result.json"), &message)?;
    drop(guard);
    if result.is_ok() {
        write_json(&cache_for(&p.exe).join("pending.json"), &p)?;
        restart(&p)?;
    } else if verify(&p.exe, &p.old_hash).is_ok() {
        let _ = fs::remove_file(cache_for(&p.exe).join("pending.json"));
        let _ = restart(&p);
    }
    result
}
pub fn entry() -> bool {
    let args: Vec<_> = std::env::args_os().collect();
    if args.get(1).and_then(|s| s.to_str()) == Some("--pulse-updater-recover") {
        if let Some(path) = args.get(2) {
            let _ = recover(Path::new(path));
        }
        return true;
    }
    if args.get(1).and_then(|s| s.to_str()) != Some("--pulse-updater") {
        return false;
    }
    if let Some(path) = args.get(2) {
        let path = PathBuf::from(path);
        if let Err(e) = run(&path) {
            // Only write diagnostics beside a validated cache manifest; never to arbitrary argv paths.
            if let Ok(p) = read_json::<Plan>(&path) {
                if validate(&p).is_ok() {
                    let _ = write_json(&p.work.join("result.json"), &e);
                }
            }
        }
    }
    true
}
pub fn startup_guard() -> Result<()> {
    let exe = std::env::current_exe().map_err(|_| "程序路径未知")?;
    let guard = lock(&exe)?;
    let pending = cache_for(&exe).join("pending.json");
    if pending.exists() {
        let p: Plan = read_json(&pending)?;
        validate(&p)?;
        if p.exe != exe {
            return Err("更新目标不匹配".into());
        }
        if p.mode == "portable" {
            if let Ok(j) = read_json::<Journal>(&p.work.join("journal.json")) {
                if j.phase == "replacing"
                    || (j.phase == "awaiting_confirmation"
                        && p.version != env!("CARGO_PKG_VERSION"))
                {
                    drop(guard);
                    spawn_recovery(&p)?;
                    return Err("已启动中断更新恢复，请等待旧版重新启动".into());
                }
                if j.phase == "rolled_back" {
                    fs::remove_file(pending).map_err(|_| "无法清除恢复标记")?;
                }
            }
        }
    }
    Ok(())
}
pub fn confirm_startup() -> Result<Option<String>> {
    let exe = std::env::current_exe().map_err(|_| "程序路径未知")?;
    let path = cache_for(&exe).join("pending.json");
    if !path.exists() {
        return Ok(None);
    }
    let p: Plan = read_json(&path)?;
    validate(&p)?;
    if p.exe != exe || p.version != env!("CARGO_PKG_VERSION") {
        return Err("更新后版本不匹配，备份仍保留".into());
    }
    crate::config::load_settings()?;
    let db = p.data.join("ledger-v1.sqlite");
    if db.exists() {
        let c =
            rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(|_| "更新后统计数据库不可读")?;
        let check: String = c
            .query_row("PRAGMA quick_check", [], |r| r.get(0))
            .map_err(|_| "更新后统计数据库检查失败")?;
        if check != "ok" {
            return Err("更新后统计数据库检查失败".into());
        }
    }
    if p.mode == "portable" {
        validate_stage(exe.parent().unwrap(), &p.version)?;
    }
    write_json(&p.work.join("result.json"), &"succeeded")?;
    fs::remove_file(path).map_err(|_| "更新确认标记无法清理")?;
    write_json(
        &cache_for(&exe).join("last-result.json"),
        &format!("已更新到 v{}；配置与 Profile 校验通过", p.version),
    )?;
    // Retain one previous managed-file backup for manual recovery, never touch data/.
    Ok(Some(format!(
        "已更新到 v{}；配置与 Profile 校验通过",
        p.version
    )))
}
pub fn spawn(p: &Plan) -> Result<()> {
    validate(p)?;
    let _ = fs::remove_file(p.work.join("helper-ready"));
    let helper = p.work.join("pulse-updater.exe");
    fs::copy(&p.exe, &helper).map_err(|_| "无法准备 updater helper")?;
    verify(&helper, &p.old_hash)?;
    write_json(&p.work.join("plan.json"), p)?;
    let mut cmd = Command::new(helper);
    cmd.arg("--pulse-updater").arg(p.work.join("plan.json"));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let mut child = cmd.spawn().map_err(|_| "无法启动 updater helper")?;
    for _ in 0..100 {
        if p.work.join("helper-ready").exists() {
            return Ok(());
        }
        if child.try_wait().ok().flatten().is_some() {
            return Err("helper 校验失败，Pulse 未退出".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err("helper 未就绪，Pulse 保持运行".into())
}

pub fn spawn_recovery(p: &Plan) -> Result<()> {
    validate(p)?;
    if p.mode != "portable" {
        return Err("安装版请重新运行已下载的安装器修复".into());
    }
    let helper = p.work.join("pulse-updater.exe");
    verify(&helper, &p.old_hash)?;
    let _ = fs::remove_file(p.work.join("helper-ready"));
    let mut next = p.clone();
    next.parent_pid = std::process::id();
    write_json(&p.work.join("recovery.json"), &next)?;
    let mut cmd = Command::new(helper);
    cmd.arg("--pulse-updater-recover")
        .arg(p.work.join("recovery.json"));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let mut child = cmd.spawn().map_err(|_| "无法启动恢复助手，备份保留")?;
    for _ in 0..100 {
        if p.work.join("helper-ready").exists() {
            return Ok(());
        }
        if child.try_wait().ok().flatten().is_some() {
            return Err("恢复助手校验失败，备份保留".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err("恢复助手未就绪，备份保留".into())
}
fn recover(path: &Path) -> Result<()> {
    let p: Plan = read_json(path)?;
    validate(&p)?;
    if path != p.work.join("recovery.json") || p.mode != "portable" {
        return Err("恢复清单不匹配".into());
    }
    verify(
        &std::env::current_exe().map_err(|_| "恢复助手路径未知")?,
        &p.old_hash,
    )?;
    let guard = lock(&p.exe)?;
    wait_parent(&p)?;
    let mut j: Journal = read_json(&p.work.join("journal.json"))?;
    rollback(p.exe.parent().unwrap(), &p.work.join("backup"), &j)?;
    verify(&p.exe, &p.old_hash)?;
    j.phase = "rolled_back".into();
    write_json(&p.work.join("journal.json"), &j)?;
    fs::remove_file(cache_for(&p.exe).join("pending.json")).map_err(|_| "恢复标记清理失败")?;
    write_json(
        &p.work.join("result.json"),
        &"更新未通过启动确认，已恢复旧程序；数据未回退",
    )?;
    drop(guard);
    restart(&p)
}

/// Only old, recognized UUID transaction directories are eligible; pending and ready
/// transactions and the most recent backup are always retained.
pub fn cleanup(exe: &Path) -> Result<()> {
    let root = cache_for(exe);
    plain(&root)?;
    if !root.exists() {
        return Ok(());
    }
    let mut keep = Vec::new();
    for name in ["pending.json", "ready.json"] {
        if let Ok(p) = read_json::<Plan>(&root.join(name)) {
            keep.push(p.work)
        }
    }
    let mut dirs: Vec<_> = fs::read_dir(&root)
        .map_err(|_| "缓存目录不可读")?
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            if !path.is_dir() || uuid::Uuid::parse_str(&e.file_name().to_string_lossy()).is_err() {
                return None;
            }
            let modified = e.metadata().ok()?.modified().ok()?;
            Some((modified, path))
        })
        .collect();
    dirs.sort_by(|a, b| b.0.cmp(&a.0));
    if let Some((_, p)) = dirs.iter().find(|(_, p)| p.join("backup").is_dir()) {
        keep.push(p.clone())
    }
    for (modified, path) in dirs.into_iter().rev().take(20) {
        if keep.contains(&path)
            || modified.elapsed().unwrap_or_default() < Duration::from_secs(7 * 86400)
        {
            continue;
        }
        if path.parent() != Some(root.as_path()) || !safe_cache_tree(&path, 0) {
            continue;
        }
        // Scope/UUID/reparse checks above precede recursive removal.
        fs::remove_dir_all(&path).map_err(|_| "旧更新缓存仍被占用")?;
    }
    Ok(())
}
fn safe_cache_tree(path: &Path, depth: u8) -> bool {
    if depth > 2 || plain(path).is_err() {
        return false;
    }
    let Ok(entries) = fs::read_dir(path) else {
        return false;
    };
    for entry in entries {
        let Ok(e) = entry else { return false };
        let p = e.path();
        if plain(&p).is_err() {
            return false;
        }
        let n = e.file_name().to_string_lossy().to_string();
        if p.is_dir() {
            if depth != 0
                || !["staging", "backup"].contains(&n.as_str())
                || !safe_cache_tree(&p, depth + 1)
            {
                return false;
            }
        } else if depth > 0 {
            if !FILES.contains(&n.as_str()) && !n.ends_with(".pulse-update-new") {
                return false;
            }
        } else if ![
            "plan.json",
            "recovery.json",
            "result.json",
            "journal.json",
            "helper-ready",
            "pulse-updater.exe",
            "package.part",
            "startup-attempt.json",
        ]
        .contains(&n.as_str())
            && !(n.starts_with("Pulse-")
                && (n.ends_with("-portable.zip") || n.ends_with("-setup.exe")))
        {
            return false;
        }
    }
    true
}
#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn wait_checks_exact_process_image() {
        let t = tempfile::tempdir().unwrap();
        let system = std::env::var("SystemRoot").unwrap();
        let exe = PathBuf::from(system).join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let mut child = Command::new(&exe)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Milliseconds 500",
            ])
            .spawn()
            .unwrap();
        let mut p = Plan {
            exe: exe.clone(),
            data: t.path().into(),
            profile: "test".into(),
            version: "0.6.4".into(),
            mode: "portable".into(),
            parent_pid: child.id(),
            old_hash: String::new(),
            package_hash: String::new(),
            package_name: String::new(),
            work: t.path().into(),
        };
        p.exe = t.path().join("not-the-process.exe");
        assert!(wait_parent(&p).is_err());
        assert!(!t.path().join("helper-ready").exists());
        p.exe = exe;
        assert!(wait_parent(&p).is_ok());
        assert!(child.wait().unwrap().success());
    }
    #[test]
    fn cache_cleanup_rejects_unknown_files() {
        let t = tempfile::tempdir().unwrap();
        fs::write(t.path().join("user.txt"), b"keep").unwrap();
        assert!(!safe_cache_tree(t.path(), 0));
    }
}

/// Called only after the application single-instance lock, so a second click on
/// Pulse cannot be mistaken for a crashed first launch.
pub fn mark_startup_attempt() -> Result<()> {
    let exe = std::env::current_exe().map_err(|_| "程序路径未知")?;
    let pending = cache_for(&exe).join("pending.json");
    if !pending.exists() {
        return Ok(());
    }
    let p: Plan = read_json(&pending)?;
    validate(&p)?;
    if p.exe != exe || p.mode != "portable" {
        return Ok(());
    }
    let journal: Journal = match read_json(&p.work.join("journal.json")) {
        Ok(j) => j,
        Err(_) => return Ok(()),
    };
    if journal.phase != "awaiting_confirmation" {
        return Ok(());
    }
    let attempt = p.work.join("startup-attempt.json");
    if attempt.exists() {
        spawn_recovery(&p)?;
        return Err("上次升级启动未完成，正在恢复旧程序".into());
    }
    write_json(&attempt, &1u8)
}
