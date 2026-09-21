pub mod core;
pub mod helper;
use core::*;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};
static UI_READY: AtomicBool = AtomicBool::new(false);
static APPLYING: AtomicBool = AtomicBool::new(false);
pub fn applying() -> bool {
    APPLYING.load(Ordering::SeqCst)
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Preferences {
    pub automatic: bool,
    pub notify: bool,
    pub last_check: Option<i64>,
    pub last_notified: Option<String>,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            automatic: true,
            notify: true,
            last_check: None,
            last_notified: None,
        }
    }
}
#[derive(Clone, Serialize)]
pub struct Status {
    pub last_result: Option<String>,
    pub phase: String,
    pub message: String,
    pub current: String,
    pub mode: String,
    pub offer: Option<Offer>,
    pub received: u64,
    pub total: u64,
    pub preferences: Preferences,
}
pub struct UpdateService {
    state: Mutex<Status>,
    gate: tokio::sync::Mutex<()>,
    cancel: AtomicBool,
    ready: Mutex<Option<helper::Plan>>,
    last_attempt: Mutex<Option<Instant>>,
    retry_until: Mutex<Option<Instant>>,
}
impl Default for UpdateService {
    fn default() -> Self {
        let exe = std::env::current_exe().unwrap_or_default();
        let preferences = read_json(&cache_for(&exe).join("preferences.json")).unwrap_or_default();
        Self {
            state: Mutex::new(Status {
                last_result: read_json(&cache_for(&exe).join("last-result.json")).ok(),
                phase: "idle".into(),
                message: "启动后后台检查；更新需点击确认".into(),
                current: env!("CARGO_PKG_VERSION").into(),
                mode: helper::mode(&exe),
                offer: None,
                received: 0,
                total: 0,
                preferences,
            }),
            gate: tokio::sync::Mutex::new(()),
            cancel: AtomicBool::new(false),
            ready: Mutex::new(None),
            last_attempt: Mutex::new(None),
            retry_until: Mutex::new(None),
        }
    }
}
impl UpdateService {
    fn snapshot(&self) -> Status {
        self.state.lock().unwrap().clone()
    }
    fn stage(&self, app: &tauri::AppHandle, phase: &str, message: &str) {
        let snapshot = {
            let mut s = self.state.lock().unwrap();
            s.phase = phase.into();
            s.message = message.into();
            s.clone()
        };
        let _ = app.emit("update-status", snapshot);
    }
    fn fail(&self, app: &tauri::AppHandle, error: String) {
        self.stage(app, "failed", &error)
    }
    fn save_preferences(&self) -> Result<()> {
        let exe = std::env::current_exe().map_err(|_| "程序路径未知")?;
        let dir = cache_for(&exe);
        plain(&dir)?;
        fs::create_dir_all(&dir).map_err(|_| "更新缓存不可写")?;
        write_json(&dir.join("preferences.json"), &self.snapshot().preferences)
    }
    async fn client(app: &tauri::AppHandle) -> Result<reqwest::Client> {
        let config = app
            .state::<crate::AppState>()
            .settings
            .lock()
            .await
            .network_proxy
            .clone();
        crate::providers::updater_client(&config)
    }
    async fn check(&self, app: &tauri::AppHandle, manual: bool) -> Result<()> {
        let Ok(_gate) = self.gate.try_lock() else {
            return Ok(());
        };
        if self.ready.lock().unwrap().is_some() {
            return Ok(());
        }
        if self
            .retry_until
            .lock()
            .unwrap()
            .is_some_and(|t| t > Instant::now())
        {
            self.stage(app, "rate_limited", "GitHub 请求限流，请稍后重试");
            return Ok(());
        }
        if !manual
            && (!self.snapshot().preferences.automatic
                || self
                    .last_attempt
                    .lock()
                    .unwrap()
                    .is_some_and(|t| t.elapsed() < Duration::from_secs(7200)))
        {
            return Ok(());
        }
        *self.last_attempt.lock().unwrap() = Some(Instant::now());
        self.stage(app, "checking", "正在检查 GitHub 稳定版本…");
        let result: Result<()> = async {
            let response = Self::client(app)
                .await?
                .get(API)
                .timeout(Duration::from_secs(15))
                .send()
                .await
                .map_err(|_| "检查更新网络失败（不影响额度刷新）")?;
            if response.status().as_u16() == 429 || response.status().as_u16() == 403 {
                let seconds = response
                    .headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|s| s.parse::<u64>().ok())
                    .unwrap_or(7200)
                    .clamp(60, 86400);
                *self.retry_until.lock().unwrap() =
                    Some(Instant::now() + Duration::from_secs(seconds));
                return Err("GitHub 请求限流，请稍后重试".to_string());
            }
            if !response.status().is_success() {
                return Err(format!(
                    "GitHub 检查失败：HTTP {}",
                    response.status().as_u16()
                ));
            }
            let bytes = bounded(response, 1024 * 1024).await?;
            let release: Release =
                serde_json::from_slice(&bytes).map_err(|_| "GitHub 发布信息格式错误")?;
            let state = self.snapshot();
            let found = offer(release, &state.current, &state.mode)?;
            {
                let mut s = self.state.lock().unwrap();
                s.offer = found.clone();
                s.preferences.last_check = Some(chrono::Utc::now().timestamp());
            }
            if let Some(o) = found {
                self.stage(
                    app,
                    "available",
                    if state.mode == "advanced" {
                        "发现新版；此为开发/自定义部署，请手动安装"
                    } else {
                        "发现新版本，点击下载后可确认退出并升级"
                    },
                );
                let should_notify = {
                    let mut s = self.state.lock().unwrap();
                    if s.preferences.notify
                        && s.preferences.last_notified.as_deref() != Some(&o.version)
                    {
                        s.preferences.last_notified = Some(o.version.clone());
                        true
                    } else {
                        false
                    }
                };
                if should_notify {
                    use tauri_plugin_notification::NotificationExt;
                    let _ = app
                        .notification()
                        .builder()
                        .title("Pulse 更新")
                        .body(format!("Pulse v{} 已发布；在设置 → 关于中查看", o.version))
                        .show();
                }
            } else {
                self.stage(app, "up_to_date", "已是最新稳定版本")
            }
            self.save_preferences()?;
            Ok(())
        }
        .await;
        if let Err(e) = &result {
            self.fail(app, e.clone())
        }
        result
    }
    async fn download(&self, app: &tauri::AppHandle) -> Result<()> {
        let _gate = self.gate.try_lock().map_err(|_| "已有更新操作进行中")?;
        if self.ready.lock().unwrap().is_some() {
            return Ok(());
        }
        let s = self.snapshot();
        if !["portable", "installed"].contains(&s.mode.as_str()) {
            return Err("无法确认安装形态，请使用发布页面手动更新".into());
        }
        let offer = s.offer.ok_or("请先检查更新")?;
        let exe = std::env::current_exe().map_err(|_| "程序路径未知")?;
        plain(&exe)?;
        let root = exe.parent().ok_or("无法识别程序目录")?;
        if s.mode == "portable" {
            let probe = root.join(format!(".pulse-update-{}", uuid::Uuid::new_v4()));
            let f = fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&probe)
                .map_err(|_| "便携目录不可写，未开始下载")?;
            drop(f);
            fs::remove_file(probe).map_err(|_| "目录写入检查清理失败")?;
        }
        let _ = helper::cleanup(&exe);
        let cache = cache_for(&exe);
        plain(&cache)?;
        fs::create_dir_all(&cache).map_err(|_| "无法创建更新缓存")?;
        if fs2::available_space(&cache).map_err(|_| "无法检查磁盘空间")?
            < offer.package.size.saturating_mul(3) + MAX_PACKAGE
        {
            return Err("更新磁盘空间不足".into());
        }
        if s.mode == "portable"
            && fs2::available_space(root).map_err(|_| "无法检查目标磁盘空间")? < MAX_PACKAGE
        {
            return Err("便携目标磁盘空间不足".into());
        }
        // A validated saved package is reused after restart, but never auto-applied.
        if let Ok(p) = read_json::<helper::Plan>(&cache.join("ready.json")) {
            if p.version == offer.version
                && !p.work.join("backup").exists()
                && helper::validate(&p).is_ok()
            {
                *self.ready.lock().unwrap() = Some(p);
                self.stage(app, "ready", "下载已验证，准备退出并更新");
                return Ok(());
            }
        }
        let work = cache.join(uuid::Uuid::new_v4().to_string());
        fs::create_dir(&work).map_err(|_| "无法创建更新临时目录")?;
        self.cancel.store(false, Ordering::SeqCst);
        let result:Result<()>=async {
   let client=Self::client(app).await?;self.stage(app,"downloading","下载校验清单…");
   let r=client.get(&offer.sums.browser_download_url).timeout(Duration::from_secs(15)).send().await.map_err(|_|"校验清单下载失败")?;if !r.status().is_success(){return Err("校验清单下载失败".into())}let bytes=bounded(r,1024*1024).await?;let expected=checksum(std::str::from_utf8(&bytes).map_err(|_|"校验清单编码无效")?,&offer.package.name)?;
   let mut r=client.get(&offer.package.browser_download_url).send().await.map_err(|_|"更新包下载失败")?;if !r.status().is_success(){return Err("更新包下载失败".into())}
   let part=work.join("package.part");let mut f=fs::File::create(&part).map_err(|_|"下载文件不可写")?;let mut received=0u64;let mut last=Instant::now();
   loop {
    let next=tokio::time::timeout(Duration::from_secs(30),r.chunk());tokio::pin!(next);
    let chunk=loop{tokio::select!{
     value=&mut next=>break value.map_err(|_|"下载读取超时，可重新下载")?.map_err(|_|"下载中断，可重新下载")?,
     _=tokio::time::sleep(Duration::from_millis(200))=>{if self.cancel.load(Ordering::SeqCst){return Err("下载已取消".into())}}
    }};
    let Some(chunk)=chunk else{break};
    if self.cancel.load(Ordering::SeqCst){return Err("下载已取消".into())}received+=chunk.len() as u64;if received>offer.package.size||received>MAX_PACKAGE{return Err("下载大小超过发布清单".into())}f.write_all(&chunk).map_err(|_|"磁盘写入失败")?;
    if last.elapsed()>Duration::from_millis(200){let mut s=self.state.lock().unwrap();s.received=received;s.total=offer.package.size;drop(s);self.stage(app,"downloading","正在下载更新包…");last=Instant::now();}
   }
   if received!=offer.package.size{return Err("下载文件不完整".into())}f.sync_all().map_err(|_|"下载落盘失败")?;drop(f);self.stage(app,"verifying","校验 SHA256…");verify(&part,&expected)?;
   let package=work.join(&offer.package.name);fs::rename(part,&package).map_err(|_|"无法提交下载文件")?;
   if s.mode=="portable"{self.stage(app,"staging","安全解压并核对 BUILD_INFO…");let z=package.clone();let stage=work.join("staging");let v=offer.version.clone();tokio::task::spawn_blocking(move||extract(&z,&stage,&v)).await.map_err(|_|"解压任务失败")??;}
   let p=helper::Plan{exe:exe.clone(),data:crate::config::get_config_dir(),profile:crate::config::get_profile_id(),version:offer.version,mode:s.mode,parent_pid:std::process::id(),old_hash:hash(&exe)?,package_hash:expected,package_name:offer.package.name,work:work.clone()};
   helper::validate(&p)?;write_json(&cache.join("ready.json"),&p)?;*self.ready.lock().unwrap()=Some(p);self.stage(app,"ready","已校验；点击“退出并更新”，正常关闭后开始安装");Ok(())
  }.await;
        if let Err(e) = &result {
            let _ = fs::remove_file(work.join("package.part"));
            self.fail(app, e.clone());
        }
        result
    }
}
async fn bounded(mut r: reqwest::Response, max: u64) -> Result<Vec<u8>> {
    let mut data = vec![];
    while let Some(c) = r.chunk().await.map_err(|_| "下载中断")? {
        if data.len() as u64 + c.len() as u64 > max {
            return Err("响应超出大小限制".into());
        }
        data.extend_from_slice(&c);
    }
    Ok(data)
}
fn settings_window(w: &tauri::WebviewWindow) -> Result<()> {
    if w.label() != "settings" {
        return Err("更新操作仅允许设置窗口".into());
    }
    Ok(())
}
#[tauri::command]
pub fn update_ui_ready(window: tauri::WebviewWindow) -> Result<()> {
    if !["main", "settings"].contains(&window.label()) {
        return Err("窗口不匹配".into());
    }
    UI_READY.store(true, Ordering::SeqCst);
    Ok(())
}
#[tauri::command]
pub fn update_status(app: tauri::AppHandle) -> Status {
    app.state::<UpdateService>().snapshot()
}
#[tauri::command]
pub async fn update_check(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<()> {
    settings_window(&window)?;
    app.state::<UpdateService>().check(&app, true).await
}
#[tauri::command]
pub async fn update_download(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<()> {
    settings_window(&window)?;
    app.state::<UpdateService>().download(&app).await
}
#[tauri::command]
pub fn update_cancel(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<()> {
    settings_window(&window)?;
    app.state::<UpdateService>()
        .cancel
        .store(true, Ordering::SeqCst);
    Ok(())
}
#[tauri::command]
pub fn update_discard(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<()> {
    settings_window(&window)?;
    let service = app.state::<UpdateService>();
    let _gate = service.gate.try_lock().map_err(|_| "更新操作尚未完成")?;
    let exe = std::env::current_exe().map_err(|_| "程序路径未知")?;
    let path = cache_for(&exe).join("ready.json");
    plain(&path)?;
    if path.exists() {
        fs::remove_file(path).map_err(|_| "无法清除下载就绪标记")?;
    }
    *service.ready.lock().unwrap() = None;
    service.stage(&app, "available", "已取消本次升级，可重新下载；旧备份保留");
    Ok(())
}
#[tauri::command]
pub fn update_preferences(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    automatic: bool,
    notify: bool,
) -> Result<()> {
    settings_window(&window)?;
    let service = app.state::<UpdateService>();
    {
        let mut s = service.state.lock().unwrap();
        s.preferences.automatic = automatic;
        s.preferences.notify = notify;
    }
    service.save_preferences()
}
#[tauri::command]
pub async fn update_apply(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<()> {
    settings_window(&window)?;
    let service = app.state::<UpdateService>();
    let _gate = service.gate.try_lock().map_err(|_| "已有更新操作")?;
    let mut p = service
        .ready
        .lock()
        .unwrap()
        .clone()
        .ok_or("没有验证完成的更新")?;
    p.parent_pid = std::process::id();
    helper::validate(&p)?;
    let state = app.state::<crate::AppState>();
    if state.config_error().is_some() {
        return Err("配置异常，请先修复再升级".into());
    }
    if APPLYING.swap(true, Ordering::SeqCst) {
        return Err("更新已在进行".into());
    }
    state.cancel_ledger_scan();
    let result: Result<()> = async {
        let _settings = tokio::time::timeout(Duration::from_secs(20), state.settings_io.lock())
            .await
            .map_err(|_| "设置仍在保存，未退出")?;
        let _ledger = tokio::time::timeout(Duration::from_secs(20), state.ledger_gate.lock())
            .await
            .map_err(|_| "统计事务仍在运行，未退出")?;
        let _refresh = tokio::time::timeout(Duration::from_secs(20), state.refresh_gate.lock())
            .await
            .map_err(|_| "刷新仍在结束，未退出")?;
        let _slots =
            tokio::time::timeout(Duration::from_secs(20), state.refresh_slots.acquire_many(4))
                .await
                .map_err(|_| "仍有请求未结束，未退出")?
                .map_err(|_| "刷新调度已关闭")?;
        crate::config::save_settings(&state.settings.lock().await.clone())?;
        service.stage(&app, "waiting_for_exit", "正在交接更新助手…");
        tokio::task::spawn_blocking(move || helper::spawn(&p))
            .await
            .map_err(|_| "helper 任务失败")??;
        app.exit(0);
        Ok(())
    }
    .await;
    if let Err(e) = &result {
        APPLYING.store(false, Ordering::SeqCst);
        service.stage(
            &app,
            "ready",
            &format!("未退出：{e}。可重试或取消本次升级。"),
        )
    }
    result
}
pub fn start(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let service = app.state::<UpdateService>();
        let pending = std::env::current_exe()
            .ok()
            .is_some_and(|e| cache_for(&e).join("pending.json").exists());
        if pending {
            for _ in 0..150 {
                if UI_READY.load(Ordering::SeqCst) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }
        let confirmation = if pending && !UI_READY.load(Ordering::SeqCst) {
            Err("新版界面启动超时，尝试恢复旧版".into())
        } else {
            helper::confirm_startup()
        };
        match confirmation {
            Ok(Some(msg)) => {
                service.state.lock().unwrap().last_result = Some(msg.clone());
                service.stage(&app, "succeeded", &msg)
            }
            Err(e) => {
                service.fail(&app, e);
                if let Ok(exe) = std::env::current_exe() {
                    if let Ok(p) = read_json::<helper::Plan>(&cache_for(&exe).join("pending.json"))
                    {
                        if p.exe == exe
                            && p.mode == "portable"
                            && p.work.join("journal.json").exists()
                        {
                            if tokio::task::spawn_blocking(move || helper::spawn_recovery(&p))
                                .await
                                .is_ok_and(|r| r.is_ok())
                            {
                                app.exit(0);
                                return;
                            }
                        }
                    }
                }
            }
            _ => {}
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
        loop {
            let _ = service.check(&app, false).await;
            tokio::time::sleep(Duration::from_secs(7200)).await;
        }
    });
}
