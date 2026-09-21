use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};
pub type Result<T> = std::result::Result<T, String>;
pub const REPO: &str = "https://github.com/CNDDVP/pulse-windows";
pub const API: &str = "https://api.github.com/repos/CNDDVP/pulse-windows/releases/latest";
pub const FILES: &[&str] = &[
    "Pulse.exe",
    "portable.flag",
    "README-portable.zh-CN.md",
    "LICENSE",
    "NOTICE",
    "BUILD_INFO.json",
    "BUILD_INFO.txt",
];
pub const MAX_PACKAGE: u64 = 512 * 1024 * 1024;
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Asset {
    pub name: String,
    pub browser_download_url: String,
    pub size: u64,
}
#[derive(Clone, Debug, Deserialize)]
pub struct Release {
    pub tag_name: String,
    pub draft: bool,
    pub prerelease: bool,
    pub html_url: String,
    #[serde(default)]
    pub body: Option<String>,
    pub assets: Vec<Asset>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Offer {
    pub version: String,
    pub url: String,
    pub notes: String,
    pub package: Asset,
    pub sums: Asset,
}
pub fn version(s: &str) -> Result<semver::Version> {
    semver::Version::parse(s.strip_prefix('v').unwrap_or(s))
        .map_err(|_| "版本号不是合法 SemVer".into())
}
pub fn offer(r: Release, current: &str, mode: &str) -> Result<Option<Offer>> {
    let v = version(&r.tag_name)?;
    if r.draft || r.prerelease || !v.pre.is_empty() || !v.build.is_empty() || v <= version(current)?
    {
        return Ok(None);
    }
    if r.tag_name != format!("v{v}") || r.html_url != format!("{REPO}/releases/tag/v{v}") {
        return Err("发布地址不匹配".into());
    }
    let setup = format!("Pulse-{v}-windows-x64-setup.exe");
    let zip = format!("Pulse-{v}-windows-x64-portable.zip");
    let find = |name: &str| -> Result<Asset> {
        let matches: Vec<_> = r.assets.iter().filter(|a| a.name == name).collect();
        if matches.len() != 1 {
            return Err(format!("发布尚不完整或资产重复：{name}"));
        }
        let a = matches[0];
        if a.size == 0
            || a.size > MAX_PACKAGE
            || a.browser_download_url != format!("{REPO}/releases/download/v{v}/{name}")
        {
            return Err("发布资产地址或大小不合法".into());
        }
        Ok(a.clone())
    };
    let installer = find(&setup)?;
    let portable = find(&zip)?;
    let sums = find("SHA256SUMS.txt")?;
    find("BUILD_INFO.txt")?;
    Ok(Some(Offer {
        version: v.to_string(),
        url: r.html_url,
        notes: r.body.unwrap_or_default().chars().take(8000).collect(),
        package: if mode == "portable" {
            portable
        } else {
            installer
        },
        sums,
    }))
}
pub fn checksum(text: &str, name: &str) -> Result<String> {
    let mut found = None;
    for line in text.trim_start_matches('\u{feff}').lines() {
        let line = line.trim();
        if line.len() < 66 {
            continue;
        }
        let Some(hash) = line.get(..64) else { continue };
        let Some(tail) = line.get(64..) else { continue };
        if tail.trim().trim_start_matches('*') == name {
            if found.is_some() || !hash.bytes().all(|c| c.is_ascii_hexdigit()) {
                return Err("校验清单存在重复或无效 Hash".into());
            }
            found = Some(hash.to_ascii_lowercase());
        }
    }
    found.ok_or_else(|| "校验清单中缺少目标文件".into())
}
pub fn hash(path: &Path) -> Result<String> {
    let mut f = fs::File::open(path).map_err(|_| "无法读取校验文件")?;
    let mut h = Sha256::new();
    let mut b = [0; 65536];
    loop {
        let n = f.read(&mut b).map_err(|_| "读取校验文件失败")?;
        if n == 0 {
            break;
        }
        h.update(&b[..n]);
    }
    Ok(format!("{:x}", h.finalize()))
}
pub fn verify(path: &Path, expected: &str) -> Result<()> {
    if expected.len() != 64 || hash(path)? != expected.to_ascii_lowercase() {
        return Err("SHA256 校验失败，禁止执行更新".into());
    }
    Ok(())
}
pub fn plain(path: &Path) -> Result<()> {
    if path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("路径包含父目录跳转".into());
    }
    for p in path.ancestors() {
        if let Ok(m) = fs::symlink_metadata(p) {
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if m.file_attributes() & 0x400 != 0 {
                    return Err("更新路径含重解析点".into());
                }
            }
            if m.file_type().is_symlink() {
                return Err("更新路径含符号链接".into());
            }
        }
    }
    Ok(())
}
pub fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    plain(path)?;
    let tmp = path.with_extension(format!("{}.new", uuid::Uuid::new_v4()));
    plain(&tmp)?;
    let mut f = fs::File::create(&tmp).map_err(|_| "无法写入更新状态")?;
    f.write_all(&serde_json::to_vec_pretty(value).map_err(|_| "更新状态编码失败")?)
        .map_err(|_| "更新状态写入失败")?;
    f.sync_all().map_err(|_| "更新状态同步失败")?;
    drop(f);
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::{
            core::PCWSTR,
            Win32::Storage::FileSystem::{
                MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
            },
        };
        let a: Vec<u16> = tmp.as_os_str().encode_wide().chain(Some(0)).collect();
        let b: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        unsafe {
            MoveFileExW(
                PCWSTR(a.as_ptr()),
                PCWSTR(b.as_ptr()),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
            .map_err(|_| "更新状态替换失败")?;
        }
    }
    #[cfg(not(windows))]
    fs::rename(tmp, path).map_err(|_| "更新状态替换失败")?;
    Ok(())
}
pub fn read_json<T: for<'a> Deserialize<'a>>(path: &Path) -> Result<T> {
    plain(path)?;
    if fs::metadata(path).map_err(|_| "无法读取更新状态")?.len() > 1024 * 1024 {
        return Err("更新状态过大".into());
    }
    let b = fs::read(path).map_err(|_| "无法读取更新状态")?;
    if b.len() > 1024 * 1024 {
        return Err("更新状态过大".into());
    }
    serde_json::from_slice(b.strip_prefix(&[239, 187, 191]).unwrap_or(&b))
        .map_err(|_| "更新状态无效".into())
}
#[derive(Deserialize)]
pub struct BuildInfo {
    pub product: String,
    pub version: String,
    pub target: String,
    pub exe_sha256: String,
}
pub fn validate_stage(stage: &Path, version: &str) -> Result<String> {
    let info: BuildInfo = read_json(&stage.join("BUILD_INFO.json"))?;
    if info.product != "Pulse for Windows"
        || info.version != version
        || info.target != "x86_64-pc-windows-msvc"
    {
        return Err("包体 BUILD_INFO 与目标版本或架构不符".into());
    }
    for name in FILES {
        plain(&stage.join(name))?;
        if !stage.join(name).is_file() {
            return Err(format!("包体缺少 {name}"));
        }
    }
    verify(&stage.join("Pulse.exe"), &info.exe_sha256)?;
    Ok(info.exe_sha256)
}
pub fn extract(zip: &Path, stage: &Path, version: &str) -> Result<String> {
    plain(stage)?;
    fs::create_dir(stage).map_err(|_| "无法创建独立 staging")?;
    let mut z = zip::ZipArchive::new(fs::File::open(zip).map_err(|_| "无法读取 ZIP")?)
        .map_err(|_| "ZIP 损坏")?;
    if z.len() > FILES.len() {
        return Err("ZIP 包含非发行文件".into());
    }
    let mut seen = BTreeSet::new();
    let mut total = 0;
    for i in 0..z.len() {
        let mut entry = z.by_index(i).map_err(|_| "ZIP 目录损坏")?;
        let name = entry.name().to_string();
        if !FILES.contains(&name.as_str())
            || !seen.insert(name.clone())
            || entry.is_dir()
            || entry.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000)
        {
            return Err("ZIP 包含路径穿越、重复项或非白名单文件".into());
        }
        total += entry.size();
        if total > MAX_PACKAGE {
            return Err("ZIP 解压大小超限".into());
        }
        let mut out = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(stage.join(name))
            .map_err(|_| "staging 文件创建失败")?;
        let actual = std::io::copy(&mut entry.by_ref().take(MAX_PACKAGE + 1), &mut out)
            .map_err(|_| "ZIP 解压失败")?;
        if actual != entry.size() {
            return Err("ZIP 长度不一致".into());
        }
        out.sync_all().map_err(|_| "staging 同步失败")?;
    }
    validate_stage(stage, version)
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Journal {
    pub phase: String,
    pub existed: Vec<String>,
    pub hashes: Vec<(String, String)>,
}
pub fn rollback(root: &Path, backup: &Path, journal: &Journal) -> Result<()> {
    plain(root)?;
    plain(backup)?;
    let names: BTreeSet<_> = journal.existed.iter().collect();
    let hashes: BTreeSet<_> = journal.hashes.iter().map(|(n, _)| n).collect();
    if names != hashes
        || names.len() != journal.existed.len()
        || hashes.len() != journal.hashes.len()
        || !names.iter().all(|n| FILES.contains(&n.as_str()))
        || !names.iter().any(|n| n.as_str() == "Pulse.exe")
    {
        return Err("备份清单不完整".into());
    }

    for (name, sha) in &journal.hashes {
        if !FILES.contains(&name.as_str()) {
            return Err("备份清单非法".into());
        }
        verify(&backup.join(name), sha)?;
    }
    for name in FILES {
        let target = root.join(name);
        plain(&target)?;
        if journal.existed.iter().any(|s| s == name) {
            durable_copy(&backup.join(name), &target)?;
        } else if target.exists() {
            fs::remove_file(target).map_err(|_| "回滚删除新发行文件失败")?;
        }
    }
    Ok(())
}
pub fn replace(
    root: &Path,
    stage: &Path,
    work: &Path,
    version: &str,
    fail_after: Option<usize>,
) -> Result<()> {
    plain(root)?;
    validate_stage(stage, version)?;
    let backup = work.join("backup");
    fs::create_dir(&backup).map_err(|_| "无法创建唯一备份目录")?;
    let mut j = Journal {
        phase: "backup".into(),
        existed: vec![],
        hashes: vec![],
    };
    for name in FILES {
        let old = root.join(name);
        plain(&old)?;
        if old.exists() {
            let sha = hash(&old)?;
            durable_copy(&old, &backup.join(name))?;
            verify(&backup.join(name), &sha)?;
            j.existed.push(name.to_string());
            j.hashes.push((name.to_string(), sha));
        }
    }
    j.phase = "replacing".into();
    write_json(&work.join("journal.json"), &j)?;
    let result: Result<()> = (|| {
        for (i, name) in FILES.iter().enumerate() {
            if fail_after == Some(i) {
                return Err("注入替换失败".into());
            }
            let target = root.join(name);
            plain(&target)?;
            let mut ok = false;
            for _ in 0..5 {
                if durable_copy(&stage.join(name), &target).is_ok() {
                    ok = true;
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            if !ok {
                return Err("发行文件被占用或无法写入".into());
            }
        }
        validate_stage(root, version)?;
        Ok(())
    })();
    if let Err(e) = result {
        rollback(root, &backup, &j)?;
        j.phase = "rolled_back".into();
        write_json(&work.join("journal.json"), &j)?;
        return Err(format!("{e}；已恢复旧版"));
    }
    j.phase = "awaiting_confirmation".into();
    write_json(&work.join("journal.json"), &j)?;
    Ok(())
}
pub fn cache_for(exe: &Path) -> PathBuf {
    let key = format!(
        "{:x}",
        Sha256::digest(exe.to_string_lossy().to_lowercase().as_bytes())
    );
    dirs::cache_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("Pulse")
        .join("updates")
        .join(&key[..24])
}

fn durable_copy(source: &Path, target: &Path) -> Result<()> {
    plain(source)?;
    plain(target)?;
    let temp = target.with_extension(format!("{}.pulse-update-new", uuid::Uuid::new_v4()));
    plain(&temp)?;
    fs::copy(source, &temp).map_err(|_| "更新文件复制失败")?;
    fs::OpenOptions::new()
        .write(true)
        .open(&temp)
        .and_then(|f| f.sync_all())
        .map_err(|_| "更新文件落盘失败")?;
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::{
            core::PCWSTR,
            Win32::Storage::FileSystem::{
                MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
            },
        };
        let a: Vec<_> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
        let b: Vec<_> = target.as_os_str().encode_wide().chain(Some(0)).collect();
        unsafe {
            MoveFileExW(
                PCWSTR(a.as_ptr()),
                PCWSTR(b.as_ptr()),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
            .map_err(|_| "文件被占用，无法提交更新")?;
        }
    }
    #[cfg(not(windows))]
    fs::rename(temp, target).map_err(|_| "无法提交更新文件")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn release(v: &str) -> Release {
        Release {
            tag_name: format!("v{v}"),
            draft: false,
            prerelease: false,
            html_url: format!("{REPO}/releases/tag/v{v}"),
            body: None,
            assets: [
                format!("Pulse-{v}-windows-x64-setup.exe"),
                format!("Pulse-{v}-windows-x64-portable.zip"),
                "SHA256SUMS.txt".into(),
                "BUILD_INFO.txt".into(),
            ]
            .into_iter()
            .map(|name| Asset {
                browser_download_url: format!("{REPO}/releases/download/v{v}/{name}"),
                name,
                size: 5,
            })
            .collect(),
        }
    }
    fn stage(root: &Path) {
        fs::create_dir_all(root).unwrap();
        for n in FILES {
            fs::write(root.join(n), b"new").unwrap()
        }
        write_json(&root.join("BUILD_INFO.json"),&serde_json::json!({"product":"Pulse for Windows","version":"0.6.4","target":"x86_64-pc-windows-msvc","exe_sha256":hash(&root.join("Pulse.exe")).unwrap()})).unwrap();
    }
    #[test]
    fn semver_and_release_completeness() {
        assert!(offer(release("0.6.10"), "0.6.9", "portable")
            .unwrap()
            .unwrap()
            .package
            .name
            .ends_with("portable.zip"));
        assert!(offer(release("0.6.3"), "0.6.3", "portable")
            .unwrap()
            .is_none());
        assert!(offer(release("0.6.2"), "0.6.3", "portable")
            .unwrap()
            .is_none());
        let mut r = release("0.6.4");
        r.assets.pop();
        assert!(offer(r, "0.6.3", "portable").is_err());
        let mut r = release("0.6.4");
        r.draft = true;
        assert!(offer(r, "0.6.3", "portable").unwrap().is_none());
        assert!(offer(release("0.7.0-beta.1"), "0.6.3", "portable")
            .unwrap()
            .is_none());
    }
    #[test]
    fn release_rejects_foreign_urls_and_duplicate_assets() {
        let mut r = release("0.6.4");
        r.assets[0].browser_download_url = "https://example.com/setup.exe".into();
        assert!(offer(r, "0.6.3", "portable").is_err());
        let mut r = release("0.6.4");
        r.assets.push(r.assets[0].clone());
        assert!(offer(r, "0.6.3", "portable").is_err());
    }
    #[test]
    fn sums_bom_unicode_duplicate_and_missing() {
        let h = "a".repeat(64);
        assert_eq!(
            checksum(&format!("\u{feff}{h}  app.zip"), "app.zip").unwrap(),
            h
        );
        assert!(checksum(&format!("{h}  app.zip\n{h}  app.zip"), "app.zip").is_err());
        assert!(checksum(&"中文".repeat(40), "app.zip").is_err());
        assert!(checksum(&format!("{h}  other.zip"), "app.zip").is_err());
    }
    #[test]
    fn wrong_hash_and_build_identity_are_rejected() {
        let t = tempfile::tempdir().unwrap();
        stage(t.path());
        assert!(verify(&t.path().join("Pulse.exe"), &"f".repeat(64)).is_err());
        assert!(validate_stage(t.path(), "0.6.5").is_err());
    }
    #[test]
    fn replace_and_rollback_preserve_all_user_data() {
        for fail in [None, Some(0), Some(2), Some(6)] {
            let t = tempfile::tempdir().unwrap();
            let root = t.path().join("中文 含空格");
            fs::create_dir_all(root.join("data")).unwrap();
            fs::write(root.join("Pulse.exe"), b"old").unwrap();
            fs::write(root.join("data/settings.json"), b"private settings").unwrap();
            fs::write(root.join("user-note.txt"), b"keep").unwrap();
            let st = t.path().join("stage");
            stage(&st);
            let work = t.path().join("work");
            fs::create_dir(&work).unwrap();
            let result = replace(&root, &st, &work, "0.6.4", fail);
            assert_eq!(result.is_ok(), fail.is_none());
            assert_eq!(
                fs::read(root.join("Pulse.exe")).unwrap(),
                if fail.is_none() { b"new" } else { b"old" }
            );
            assert_eq!(
                fs::read(root.join("data/settings.json")).unwrap(),
                b"private settings"
            );
            assert_eq!(fs::read(root.join("user-note.txt")).unwrap(), b"keep");
        }
    }
    #[test]
    fn incomplete_backup_cannot_delete_target() {
        let t = tempfile::tempdir().unwrap();
        fs::write(t.path().join("Pulse.exe"), b"old").unwrap();
        let j = Journal {
            phase: "replacing".into(),
            existed: vec!["Pulse.exe".into()],
            hashes: vec![],
        };
        assert!(rollback(t.path(), t.path(), &j).is_err());
        assert_eq!(fs::read(t.path().join("Pulse.exe")).unwrap(), b"old");
    }
    fn zip_with(path: &Path, names: &[&str]) {
        let mut z = zip::ZipWriter::new(fs::File::create(path).unwrap());
        for name in names {
            z.start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            z.write_all(b"bad").unwrap();
        }
        z.finish().unwrap();
    }
    #[test]
    fn zip_traversal_unknown_and_incomplete_are_rejected() {
        for name in [
            "../Pulse.exe",
            "/Pulse.exe",
            "data/settings.json",
            "unknown",
            "Pulse.exe",
        ] {
            let t = tempfile::tempdir().unwrap();
            let z = t.path().join("bad.zip");
            zip_with(&z, &[name]);
            assert!(extract(&z, &t.path().join("stage"), "0.6.4").is_err());
            assert!(!t.path().join("Pulse.exe").exists());
        }
    }
    #[test]
    fn valid_zip_extracts_and_verifies() {
        let t = tempfile::tempdir().unwrap();
        let src = t.path().join("source");
        stage(&src);
        let z = t.path().join("ok.zip");
        let mut writer = zip::ZipWriter::new(fs::File::create(&z).unwrap());
        for name in FILES {
            writer
                .start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            writer
                .write_all(&fs::read(src.join(name)).unwrap())
                .unwrap();
        }
        writer.finish().unwrap();
        assert!(extract(&z, &t.path().join("stage"), "0.6.4").is_ok());
    }
    #[test]
    fn parent_path_is_rejected() {
        assert!(plain(Path::new("C:/test/../other")).is_err());
    }
}
