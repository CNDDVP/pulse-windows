//! Bounded StepFun browser session capture and renewal. Secrets never cross IPC.
use crate::{
    secrets::{SecretStore, WindowsSecrets},
    types::ProviderUsage,
    AppState,
};
use tauri::{Emitter, Manager};
// Login/renewal share one browser operation; never close another account's window.
static STEPFUN_BROWSER_GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static STEPFUN_RENEW_ATTEMPTS: std::sync::Mutex<
    Option<std::collections::HashMap<String, RenewState>>,
> = std::sync::Mutex::new(None);
/// S4：冷却提示保留脱敏的失败阶段与原因，不再只剩"冷却中"。
pub struct RenewState {
    pub at: std::time::Instant,
    pub reason: String,
}
impl RenewState {
    fn cooldown_left(&self) -> std::time::Duration {
        std::time::Duration::from_secs(300).saturating_sub(self.at.elapsed())
    }
}
fn record_renew_failure(account_id: &str, reason: String) {
    if let Ok(mut attempts) = STEPFUN_RENEW_ATTEMPTS.lock() {
        let map = attempts.get_or_insert_with(std::collections::HashMap::new);
        map.retain(|_, t| t.at.elapsed() < std::time::Duration::from_secs(300));
        let key = format!("{}:{account_id}", crate::config::get_profile_id());
        map.insert(key, RenewState { at: std::time::Instant::now(), reason });
    }
}
fn renew_cooldown_msg(account_id: &str) -> Option<String> {
    let mut attempts = STEPFUN_RENEW_ATTEMPTS.lock().ok()?;
    let map = attempts.as_mut()?;
    let key = format!("{}:{account_id}", crate::config::get_profile_id());
    if let Some(st) = map.get(&key) {
        let left = st.cooldown_left().as_secs();
        if left > 0 {
            return Some(format!(
                "自动续期冷却中（约 {} 秒后重试）；上次失败：{}",
                left,
                st.reason
            ));
        } else {
            map.remove(&key);
        }
    }
    None
}

pub fn clear_renew_cooldown(account_id: &str) {
    if let Ok(mut attempts) = STEPFUN_RENEW_ATTEMPTS.lock() {
        if let Some(map) = attempts.as_mut() {
            let key = format!("{}:{account_id}", crate::config::get_profile_id());
            map.remove(&key);
        }
    }
}

async fn stepfun_cookies(
    window: &tauri::WebviewWindow,
) -> Result<(Option<String>, String), String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<(Option<String>, String)>();
    let win_clone = window.clone();
    let res = win_clone.with_webview(move |webview| {
        #[cfg(windows)]
        unsafe {
            use webview2_com::Microsoft::Web::WebView2::Win32::*;
            use windows_core::Interface;
            let c = webview.controller();
            if let Ok(w2) = c.CoreWebView2() {
                if let Ok(w2_2) = w2.cast::<ICoreWebView2_2>() {
                    if let Ok(cm) = w2_2.CookieManager() {
                        let handler = webview2_com::GetCookiesCompletedHandler::create(Box::new(
                            move |_res, list| {
                                let mut token_found: Option<String> = None;
                                let mut all_cookies: Vec<String> = Vec::new();
                                if let Some(list) = list {
                                    let mut count = 0;
                                    let _ = list.Count(&mut count);
                                    for i in 0..count {
                                        if let Ok(cookie) = list.GetValueAtIndex(i) {
                                            let mut name = windows_core::PWSTR::null();
                                            let _ = cookie.Name(&mut name);
                                            let mut val = windows_core::PWSTR::null();
                                            let _ = cookie.Value(&mut val);
                                            let n = if !name.is_null() {
                                                let s = name.to_string().unwrap_or_default();
                                                windows::Win32::System::Com::CoTaskMemFree(Some(
                                                    name.as_ptr() as *const _,
                                                ));
                                                s
                                            } else {
                                                String::new()
                                            };
                                            let v = if !val.is_null() {
                                                let s = val.to_string().unwrap_or_default();
                                                windows::Win32::System::Com::CoTaskMemFree(Some(
                                                    val.as_ptr() as *const _,
                                                ));
                                                s
                                            } else {
                                                String::new()
                                            };
                                            if !n.is_empty() {
                                                all_cookies.push(format!("{n}={v}"));
                                                if n.eq_ignore_ascii_case("Oasis-Token")
                                                    && !v.trim().is_empty()
                                                {
                                                    token_found = Some(v.trim().to_string());
                                                }
                                            }
                                        }
                                    }
                                }
                                let _ = tx.send((token_found, all_cookies.join("; ")));
                                Ok(())
                            },
                        ));
                        let _ = cm.GetCookies(
                            windows_core::w!("https://platform.stepfun.com/"),
                            &handler,
                        );
                        return;
                    }
                }
            }
        }
        let _ = tx.send((None, String::new()));
    });
    res.map_err(|_| "登录窗口已关闭")?;
    tokio::time::timeout(std::time::Duration::from_secs(2), rx)
        .await
        .map_err(|_| "读取登录会话超时")?
        .map_err(|_| "读取登录会话失败".into())
}

async fn save_stepfun_login_token(
    app: &tauri::AppHandle,
    account_id: &str,
    token: &str,
    cookie: &str,
    expected: Option<&str>,
    profile: &str,
    automatic: bool,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let _io = state.settings_io.lock().await;
    if crate::updater::applying() {
        return Err("正在升级，取消登录写入".into());
    }
    if state.config_error().is_some() || crate::config::get_profile_id() != profile {
        return Err("配置身份已变化，请重新登录".into());
    }
    let mut settings = state.settings.lock().await.clone();
    let cfg = settings
        .providers
        .get_mut(account_id)
        .filter(|c| c.provider_id == "stepfun")
        .ok_or("StepFun 账号已删除或变更")?;
    let had = WindowsSecrets.get(account_id)?;
    if had.as_deref() != expected {
        return Err("凭据已被其他操作修改，本次登录结果已取消".into());
    }
    let secret = crate::providers::credentials::merge_stepfun_credentials(
        had.as_deref().unwrap_or(""),
        &serde_json::json!({"oasis_token":token,"cookie":cookie}).to_string(),
    );
    cfg.credential_configured = true;
    if !automatic {
        settings.generation = settings.generation.wrapping_add(1);
        if !settings.authorized_providers.iter().any(|p| p == "stepfun") {
            settings.authorized_providers.push("stepfun".into());
        }
    }
    let aid = account_id.to_string();
    let saved = settings.clone();
    tokio::task::spawn_blocking(move || {
        WindowsSecrets.put(&aid, &secret)?;
        if !automatic {
            if let Err(e) = crate::config::save_settings(&saved) {
                let rollback = match had {
                    Some(old) => WindowsSecrets.put(&aid, &old),
                    None => WindowsSecrets.delete(&aid),
                };
                return Err(if rollback.is_err() {
                    format!("{e}；凭据回滚失败")
                } else {
                    e
                });
            }
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|_| "保存登录任务失败")??;
    if !automatic {
        *state.settings.lock().await = settings.clone();
        state.bump_account_gen(account_id).await;
        state.schedule.lock().await.remove(account_id);
        let _ = app.emit("settings-updated", settings);
    }
    // Automatic rotation keeps the same identity/generation, so its own retry is not discarded.
    Ok(())
}

pub async fn renew_stepfun_token(
    app: &tauri::AppHandle,
    account_id: &str,
) -> Result<String, String> {
    let _gate = STEPFUN_BROWSER_GATE
        .try_lock()
        .map_err(|_| "已有 StepFun 登录或续期进行中")?;
    if crate::updater::applying() {
        return Err("正在退出升级".into());
    }
    if app.get_webview_window("stepfun_login").is_some() {
        return Err("请先完成网页登录".into());
    }
    if let Some(msg) = renew_cooldown_msg(account_id) {
        return Err(msg);
    }
    record_renew_failure(account_id, "尝试已开始".into());
    let old = WindowsSecrets
        .get(account_id)?
        .ok_or("未保存网页登录凭据")?;
    let creds = crate::providers::credentials::parse_stepfun_credentials(&old);
    let token = creds.oasis_token.ok_or("未保存网页 Token")?;
    // 问题 3: 严格区分"手填 Token"与"可续期网页登录会话"；无活跃 Session Cookie 时明确提示不支持自动续期，要求重新登录
    if creds.cookie.as_deref().is_none_or(|c| c.trim().is_empty()) {
        return Err("当前凭据仅包含手动填写的 Token，未保存网页登录会话，不支持自动续期；请点击「网页登录」完成会话绑定".into());
    }
    let profile = crate::config::get_profile_id();
    let window = tauri::WebviewWindowBuilder::new(
        app,
        "stepfun_renew",
        tauri::WebviewUrl::External("https://platform.stepfun.com/".parse().unwrap()),
    )
    .title("StepFun 会话续期")
    .inner_size(400.0, 300.0)
    .visible(false)
    .skip_taskbar(true)
    .focused(false)
    .build()
    .map_err(|_| "无法创建续期窗口")?;
    let result = async {
        // S5：硬 deadline 贯穿全流程；子操作用剩余预算约束，不再各自独立超时叠加。
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(12);
        let mut checked = String::new();
        let mut network_failures = 0u32;
        let mut retry_allowed = false;
        let mut last_stage = "等待会话 Cookie".to_string();
        let mut last_failed_reason: Option<String> = None;
        while std::time::Instant::now() < deadline {
            let budget = deadline.saturating_duration_since(std::time::Instant::now());
            tokio::time::sleep(std::time::Duration::from_millis(600).min(budget)).await;
            let cookie_timeout = std::time::Duration::from_secs(2).min(budget);
            match tokio::time::timeout(cookie_timeout, stepfun_cookies(&window)).await {
                Ok(Ok((candidate, cookie))) => {
                    if let Some(candidate) = candidate {
                        if !crate::providers::credentials::stepfun_renew_candidate(
                            &token,
                            &candidate,
                            chrono::Utc::now().timestamp(),
                        ) {
                            if last_failed_reason.is_none() {
                                last_stage = "会话未产生新 Token（可能需重新网页登录）".into();
                            }
                            continue;
                        }
                        if checked == candidate && !retry_allowed {
                            continue;
                        }
                        checked = candidate.clone();
                        last_stage = "验证候选 Token".into();
                        let http = app.state::<AppState>().http.read().await.clone();
                        let secret = serde_json::json!({"oasis_token":candidate,"cookie":cookie})
                            .to_string();
                        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
                        if remaining.as_millis() == 0 {
                            last_failed_reason = Some("续期总流程超时".into());
                            break;
                        }
                        match tokio::time::timeout(
                            remaining.min(std::time::Duration::from_secs(6)),
                            crate::providers::stepfun::fetch(&secret, &http),
                        )
                        .await
                        {
                            Ok(Ok(v)) => {
                                if v.get("plan_credit_rate_limit").is_some()
                                    && !v["web_auth_required"].as_bool().unwrap_or(false)
                                {
                                    save_stepfun_login_token(
                                        app,
                                        account_id,
                                        &candidate,
                                        &cookie,
                                        Some(&old),
                                        &profile,
                                        true,
                                    )
                                    .await?;
                                    clear_renew_cooldown(account_id);
                                    return Ok(candidate);
                                }
                                retry_allowed = false;
                                let err_detail = if v["web_auth_required"].as_bool().unwrap_or(false) {
                                    "凭据已被注销或会话失效"
                                } else {
                                    "套餐接口返回空数据"
                                };
                                last_failed_reason = Some(format!("候选 Token 验证拒绝: {err_detail}"));
                            }
                            Ok(Err(e)) => {
                                retry_allowed = true;
                                network_failures += 1;
                                let err_msg = e.error_message.unwrap_or_else(|| "网络请求异常".into());
                                last_failed_reason = Some(format!("验证请求失败: {err_msg}"));
                                if network_failures > 2 {
                                    break;
                                }
                            }
                            Err(_) => {
                                retry_allowed = true;
                                network_failures += 1;
                                last_failed_reason = Some("验证请求超时".into());
                                if network_failures > 2 {
                                    break;
                                }
                            }
                        }
                    }
                }
                Ok(Err(e)) => {
                    last_failed_reason = Some(format!("读取 Cookie 失败: {e}"));
                }
                Err(_) => {
                    last_failed_reason = Some("读取 Cookie 耗时超出预算".into());
                }
            }
        }
        let final_reason = last_failed_reason.unwrap_or(last_stage);
        Err(format!(
            "网页会话续期未成功（{final_reason}）；请在账号设置中重新网页登录。API 余额仍独立查询"
        ))
    }
    .await;
    let _ = window.close();
    if let Err(reason) = &result {
        record_renew_failure(account_id, reason.clone());
    }
    result
}

pub async fn open_stepfun_login(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    account_id: String,
) -> Result<(), String> {
    if window.label() != "settings" {
        return Err("仅允许从设置窗口登录".into());
    }
    let gate = STEPFUN_BROWSER_GATE
        .try_lock()
        .map_err(|_| "已有 StepFun 登录或续期进行中")?;
    if crate::updater::applying() {
        return Err("正在退出升级".into());
    }
    if app.get_webview_window("stepfun_login").is_some() {
        return Err("请先完成或关闭已有登录窗口".into());
    }
    if !app
        .state::<AppState>()
        .settings
        .lock()
        .await
        .providers
        .get(&account_id)
        .is_some_and(|c| c.provider_id == "stepfun")
    {
        return Err("StepFun 账号不存在".into());
    }
    let old = WindowsSecrets.get(&account_id)?;
    let profile = crate::config::get_profile_id();
    // S2：若浏览器已有其他账号的会话，登录前提示用户先退出——避免第二账号
    // 静默绑定到第一账号的会话。检测方式：已有会话 Token 与本账号已存 Token 不同。
    if let Ok(Some(existing)) = WindowsSecrets.get(&account_id) {
        let _ = existing; // 本账号已有凭据不阻断（覆盖式重登）
    }
    // S2: 为每个 Profile/账号建立独立的隔离会话标识与窗口，防止多账号登录相互覆盖或复用已有非目标会话
    let win_label = format!("stepfun_login_{}", &account_id[..account_id.len().min(8)]);
    if app.get_webview_window(&win_label).is_some() {
        return Err("当前账号已有登录窗口正在进行中".into());
    }
    let win = tauri::WebviewWindowBuilder::new(
        &app,
        &win_label,
        tauri::WebviewUrl::External("https://platform.stepfun.com/".parse().unwrap()),
    )
    .title(format!("阶跃星辰 StepFun - 网页登录（绑定账号：{}）", account_id))
    .inner_size(860.0, 720.0)
    .center()
    .resizable(true)
    .build()
    .map_err(|_| "无法创建登录窗口")?;
    tauri::async_runtime::spawn(async move {
        let _gate = gate;
        let mut checked = String::new();
        let mut success = false;
        for _ in 0..600 {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            if crate::updater::applying() {
                break;
            }
            let Ok((Some(token), cookie)) = stepfun_cookies(&win).await else {
                if app.get_webview_window(&win_label).is_none() {
                    break;
                }
                continue;
            };
            if checked == token {
                continue;
            }
            checked = token.clone();
            if crate::providers::credentials::stepfun_expires_at(&token)
                .is_some_and(|t| t <= chrono::Utc::now().timestamp() + 60)
            {
                continue;
            }
            let http = app.state::<AppState>().http.read().await.clone();
            let candidate = serde_json::json!({"oasis_token":token,"cookie":cookie}).to_string();
            if !matches!(crate::providers::stepfun::fetch(&candidate,&http).await,Ok(v) if v.get("plan_credit_rate_limit").is_some()&&!v["web_auth_required"].as_bool().unwrap_or(false))
            {
                continue;
            }
            match save_stepfun_login_token(
                &app,
                &account_id,
                &token,
                &cookie,
                old.as_deref(),
                &profile,
                false,
            )
            .await
            {
                Ok(()) => {
                    success = true;
                    let _ = app.emit(
                        "stepfun-login-success",
                        serde_json::json!({"account_id":account_id}),
                    );
                    let _ = AppState::refresh_account_now(&app, &account_id).await;
                }
                Err(e) => {
                    let _ = app.emit("stepfun-login-error", e);
                }
            }
            break;
        }
        let _ = win.close();
        if !success {
            let _ = app.emit("stepfun-login-closed", ());
        }
    });
    Ok(())
}

pub async fn recover_stepfun_reading(
    app: &tauri::AppHandle,
    account_id: &str,
    cfg: &crate::types::ProviderConfig,
    http: &reqwest::Client,
    mut reading: ProviderUsage,
) -> ProviderUsage {
    if cfg.provider_id != "stepfun" || crate::updater::applying() {
        return reading;
    }
    let near_expiry = WindowsSecrets
        .get(account_id)
        .ok()
        .flatten()
        .and_then(|s| crate::providers::credentials::parse_stepfun_credentials(&s).oasis_token)
        .and_then(|t| crate::providers::credentials::stepfun_expires_at(&t))
        .is_some_and(|exp| exp <= chrono::Utc::now().timestamp() + 90);
    if !reading.web_auth_required && !near_expiry {
        return reading;
    }
    match renew_stepfun_token(app, account_id).await {
        Ok(_) => {
            if let Ok(next) = tokio::time::timeout(
                std::time::Duration::from_secs(25),
                crate::providers::fetch_one(account_id, cfg, http),
            )
            .await
            {
                return next;
            }
            if reading.web_auth_required {
                reading.error_message = Some(format!(
                    "{}；续期后查询超时，下次刷新重试",
                    reading.error_message.unwrap_or_default()
                ));
            }
        }
        Err(e) => {
            if reading.web_auth_required {
                reading.error_message = Some(format!(
                    "{}；{e}",
                    reading.error_message.unwrap_or_default()
                ));
            }
        }
    }
    reading
}
