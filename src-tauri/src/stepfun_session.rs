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
    Option<std::collections::HashMap<String, std::time::Instant>>,
> = std::sync::Mutex::new(None);

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
    {
        let mut attempts = STEPFUN_RENEW_ATTEMPTS.lock().map_err(|_| "续期状态异常")?;
        let map = attempts.get_or_insert_with(std::collections::HashMap::new);
        let key = format!("{}:{account_id}", crate::config::get_profile_id());
        if map
            .get(&key)
            .is_some_and(|t| t.elapsed() < std::time::Duration::from_secs(300))
        {
            return Err("自动续期冷却中；可点击网页登录恢复".into());
        }
        map.retain(|_, t| t.elapsed() < std::time::Duration::from_secs(300));
        map.insert(key, std::time::Instant::now());
    }
    let old = WindowsSecrets
        .get(account_id)?
        .ok_or("未保存网页登录凭据")?;
    let token = crate::providers::credentials::parse_stepfun_credentials(&old)
        .oasis_token
        .ok_or("未保存网页 Token")?;
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
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(12);
        let mut checked = String::new();
        while std::time::Instant::now() < deadline {
            tokio::time::sleep(std::time::Duration::from_millis(600)).await;
            let (candidate, cookie) = stepfun_cookies(&window).await?;
            if let Some(candidate) = candidate {
                if !crate::providers::credentials::stepfun_renew_candidate(
                    &token,
                    &candidate,
                    chrono::Utc::now().timestamp(),
                ) || checked == candidate
                {
                    continue;
                }
                checked = candidate.clone();
                let http = app.state::<AppState>().http.read().await.clone();
                let secret =
                    serde_json::json!({"oasis_token":candidate,"cookie":cookie}).to_string();
                if let Ok(Ok(v)) = tokio::time::timeout(
                    std::time::Duration::from_secs(8),
                    crate::providers::stepfun::fetch(&secret, &http),
                )
                .await
                {
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
                        return Ok(candidate);
                    }
                }
            }
        }
        Err("网页登录会话未产生有效新 Token，请在账号设置中重新网页登录；API 余额仍独立查询".into())
    }
    .await;
    let _ = window.close();
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
    let win = tauri::WebviewWindowBuilder::new(
        &app,
        "stepfun_login",
        tauri::WebviewUrl::External("https://platform.stepfun.com/".parse().unwrap()),
    )
    .title("阶跃星辰 StepFun - 网页登录")
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
                if app.get_webview_window("stepfun_login").is_none() {
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
