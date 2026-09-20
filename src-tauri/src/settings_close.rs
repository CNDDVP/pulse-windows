use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use serde::{Serialize, Deserialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ClosePhase {
    Idle,
    AwaitingFrontend,
    Confirming,
    Hiding,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloseRequestPayload {
    pub request_id: u64,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloseDiagnosticEntry {
    pub request_id: u64,
    pub source: String,
    pub phase: String,
    pub timestamp: String,
    pub detail: Option<String>,
}

pub struct SettingsCloseCoordinator {
    pub phase: Mutex<ClosePhase>,
    pub current_request_id: AtomicU64,
    pub frontend_ready: AtomicBool,
    pub pending_requests: Mutex<Vec<(u64, String)>>,
    pub request_counter: AtomicU64,
    pub diagnostics: Mutex<Vec<CloseDiagnosticEntry>>,
}

impl Default for SettingsCloseCoordinator {
    fn default() -> Self {
        Self {
            phase: Mutex::new(ClosePhase::Idle),
            current_request_id: AtomicU64::new(0),
            frontend_ready: AtomicBool::new(false),
            pending_requests: Mutex::new(Vec::new()),
            request_counter: AtomicU64::new(1),
            diagnostics: Mutex::new(Vec::new()),
        }
    }
}

impl SettingsCloseCoordinator {
    pub async fn log_diag(&self, request_id: u64, source: &str, phase: &str, detail: Option<String>) {
        let mut d = self.diagnostics.lock().await;
        if d.len() >= 50 {
            d.remove(0);
        }
        d.push(CloseDiagnosticEntry {
            request_id,
            source: source.to_string(),
            phase: phase.to_string(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            detail,
        });
    }

    pub async fn on_frontend_ready(self: &Arc<Self>, app: &AppHandle) {
        self.frontend_ready.store(true, Ordering::SeqCst);
        self.log_diag(0, "frontend", "ready", None).await;
        let mut pending = self.pending_requests.lock().await;
        if let Some((req_id, src)) = pending.pop() {
            pending.clear();
            drop(pending);
            let this = self.clone();
            let app_clone = app.clone();
            tauri::async_runtime::spawn(async move {
                this.dispatch_request(&app_clone, req_id, &src).await;
            });
        }
    }

    pub async fn request_close(self: &Arc<Self>, app: &AppHandle, source: &str) -> u64 {
        let mut p = self.phase.lock().await;
        if *p == ClosePhase::Confirming || *p == ClosePhase::Hiding {
            // Already in progress, do not duplicate
            return self.current_request_id.load(Ordering::SeqCst);
        }
        let req_id = self.request_counter.fetch_add(1, Ordering::SeqCst);
        self.current_request_id.store(req_id, Ordering::SeqCst);

        if !self.frontend_ready.load(Ordering::SeqCst) {
            self.log_diag(req_id, source, "queued_not_ready", None).await;
            let mut pending = self.pending_requests.lock().await;
            pending.push((req_id, source.to_string()));
            return req_id;
        }

        *p = ClosePhase::AwaitingFrontend;
        drop(p);

        self.dispatch_request(app, req_id, source).await;
        req_id
    }

    async fn dispatch_request(self: &Arc<Self>, app: &AppHandle, req_id: u64, source: &str) {
        self.log_diag(req_id, source, "dispatching", None).await;
        if let Some(w) = app.get_webview_window("settings") {
            let _ = w.emit("settings-close-requested", CloseRequestPayload {
                request_id: req_id,
                source: source.to_string(),
            });
        }

        // 2-second timeout protection
        let this = self.clone();
        let app_clone = app.clone();
        let src_string = source.to_string();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(2000)).await;
            if this.current_request_id.load(Ordering::SeqCst) == req_id {
                let mut p = this.phase.lock().await;
                if *p == ClosePhase::AwaitingFrontend {
                    this.log_diag(req_id, &src_string, "timeout_fallback", Some("Frontend did not acknowledge in 2s".into())).await;
                    #[cfg(windows)]
                    {
                        use windows::core::PCWSTR;
                        use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_OKCANCEL, MB_ICONWARNING, IDOK};
                        let title: Vec<u16> = "Pulse - 设置窗口未响应\0".encode_utf16().collect();
                        let msg: Vec<u16> = "设置窗口响应关闭请求超时。\n\n点击“确定”将保留当前草稿并直接隐藏设置窗口；\n点击“取消”将保持设置窗口打开。\0".encode_utf16().collect();
                        let res = unsafe {
                            MessageBoxW(None, PCWSTR(msg.as_ptr()), PCWSTR(title.as_ptr()), MB_OKCANCEL | MB_ICONWARNING)
                        };
                        if res == IDOK {
                            *p = ClosePhase::Hiding;
                            drop(p);
                            let _ = this.execute_hide(&app_clone, req_id).await;
                        } else {
                            *p = ClosePhase::Idle;
                        }
                    }
                    #[cfg(not(windows))]
                    {
                        *p = ClosePhase::Idle;
                    }
                }
            }
        });
    }

    pub async fn acknowledge_close(&self, req_id: u64, has_draft: bool) -> Result<(), String> {
        if req_id != self.current_request_id.load(Ordering::SeqCst) {
            return Ok(());
        }
        let mut p = self.phase.lock().await;
        if has_draft {
            *p = ClosePhase::Confirming;
            self.log_diag(req_id, "frontend", "confirming", Some("Has drafts".into())).await;
        } else {
            *p = ClosePhase::Hiding;
            self.log_diag(req_id, "frontend", "acknowledged_clean", None).await;
        }
        Ok(())
    }

    pub async fn confirm_close(&self, app: &AppHandle, req_id: u64, action: &str) -> Result<(), String> {
        self.log_diag(req_id, "frontend", "confirm_action", Some(action.to_string())).await;
        if req_id != 0 && req_id != self.current_request_id.load(Ordering::SeqCst) {
            return Err("请求已过期".into());
        }
        match action {
            "cancel" => {
                let mut p = self.phase.lock().await;
                *p = ClosePhase::Idle;
                Ok(())
            }
            "save_and_hide" | "discard_and_hide" | "hide" => {
                self.execute_hide(app, req_id).await
            }
            _ => Err("无效的关闭操作".into()),
        }
    }

    pub async fn execute_hide(&self, app: &AppHandle, req_id: u64) -> Result<(), String> {
        let w = app.get_webview_window("settings").ok_or("设置窗口不存在")?;
        w.hide().map_err(|e| format!("隐藏设置窗口失败: {e}"))?;
        if w.is_visible().unwrap_or(false) {
            self.log_diag(req_id, "backend", "hide_failed", Some("Window still visible".into())).await;
            return Err("窗口 hide 调用已执行，但窗口依然可见".into());
        }
        let mut p = self.phase.lock().await;
        *p = ClosePhase::Idle;
        drop(p);
        self.log_diag(req_id, "backend", "hidden_success", None).await;
        let _ = app.emit("settings-closed", ());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_close_coordinator_state_transitions() {
        let coord = Arc::new(SettingsCloseCoordinator::default());
        assert_eq!(*coord.phase.lock().await, ClosePhase::Idle);

        // Before frontend is ready, request is queued
        let req_id = coord.request_counter.fetch_add(1, Ordering::SeqCst);
        coord.current_request_id.store(req_id, Ordering::SeqCst);
        coord.pending_requests.lock().await.push((req_id, "native_x".to_string()));
        assert_eq!(coord.pending_requests.lock().await.len(), 1);

        // Acknowledge with draft moves to Confirming
        coord.acknowledge_close(req_id, true).await.unwrap();
        assert_eq!(*coord.phase.lock().await, ClosePhase::Confirming);

        // Acknowledge without draft moves to Hiding
        coord.acknowledge_close(req_id, false).await.unwrap();
        assert_eq!(*coord.phase.lock().await, ClosePhase::Hiding);

        // Stale request_id is ignored
        coord.acknowledge_close(req_id + 99, true).await.unwrap();
        assert_eq!(*coord.phase.lock().await, ClosePhase::Hiding);
    }

    #[tokio::test]
    async fn test_close_coordinator_diagnostics_capped() {
        let coord = SettingsCloseCoordinator::default();
        for i in 0..60 {
            coord.log_diag(i, "test", "phase", None).await;
        }
        let diags = coord.diagnostics.lock().await;
        assert_eq!(diags.len(), 50);
        assert_eq!(diags.last().unwrap().request_id, 59);
    }
}
