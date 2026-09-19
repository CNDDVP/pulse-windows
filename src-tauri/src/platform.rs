//! Windows-only platform services kept out of the settings domain: login startup through
//! the HKCU Run key (real system state, never a JSON flag), the system toast switch,
//! and data-dir scoped single-instance management.
#[cfg(windows)]
mod imp {
    use windows::{core::PCWSTR, Win32::Foundation::*, Win32::System::Registry::*};
    use windows::Win32::System::Threading::{CreateMutexW, ReleaseMutex};
    use windows::Win32::System::DataExchange::COPYDATASTRUCT;
    use windows::Win32::UI::WindowsAndMessaging::*;
    use sha2::{Sha256, Digest};

    const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

    fn wide(s: &str) -> Vec<u16> { s.encode_utf16().chain(Some(0)).collect() }

    pub fn run_value_name() -> String {
        if crate::config::is_portable() {
            format!("Pulse_Portable_{}", crate::config::get_profile_id())
        } else {
            "Pulse".to_string()
        }
    }

    pub fn startup_command() -> Option<String> {
        let val_name = run_value_name();
        let sub = wide(RUN); let val = wide(&val_name); let mut len = 0u32;
        unsafe {
            if RegGetValueW(HKEY_CURRENT_USER, PCWSTR(sub.as_ptr()), PCWSTR(val.as_ptr()), RRF_RT_REG_SZ, None, None, Some(&mut len)) != ERROR_SUCCESS { return None; }
            let mut buf = vec![0u16; (len as usize / 2).max(1)];
            if RegGetValueW(HKEY_CURRENT_USER, PCWSTR(sub.as_ptr()), PCWSTR(val.as_ptr()), RRF_RT_REG_SZ, None, Some(buf.as_mut_ptr() as *mut _), Some(&mut len)) != ERROR_SUCCESS { return None; }
            Some(String::from_utf16_lossy(&buf).trim_end_matches('\0').to_string())
        }
    }

    pub fn set_startup(enable: bool) -> Result<(), String> {
        let val_name = run_value_name();
        let sub = wide(RUN); let val = wide(&val_name);
        unsafe {
            if enable {
                let exe = std::env::current_exe().map_err(|_| "无法定位程序路径")?;
                let cmd = wide(&format!("\"{}\"", exe.display()));
                if RegSetKeyValueW(HKEY_CURRENT_USER, PCWSTR(sub.as_ptr()), PCWSTR(val.as_ptr()), REG_SZ.0, Some(cmd.as_ptr() as *const _), (cmd.len() * 2) as u32) != ERROR_SUCCESS {
                    return Err("写入开机启动项失败".into());
                }
            } else {
                let r = RegDeleteKeyValueW(HKEY_CURRENT_USER, PCWSTR(sub.as_ptr()), PCWSTR(val.as_ptr()));
                if r != ERROR_SUCCESS && r != ERROR_FILE_NOT_FOUND { return Err("删除开机启动项失败".into()); }
            }
        }
        Ok(())
    }

    /// Automatically repairs stale registry autostart paths if a portable folder was moved.
    pub fn repair_startup_if_moved() {
        if !crate::config::is_portable() { return; }
        if let Some(cmd) = startup_command() {
            let Ok(exe) = std::env::current_exe() else { return };
            let current_exe_str = exe.display().to_string();
            let stored_clean = cmd.trim_matches('"');
            if !stored_clean.eq_ignore_ascii_case(&current_exe_str) {
                let _ = set_startup(true);
                eprintln!("Pulse 便携版：检测到运行路径变化，已自动更新开机启动项: {current_exe_str}");
            }
        }
    }

    /// The global "Notifications" switch in Windows Settings; `false` suppresses every toast.
    pub fn toasts_enabled() -> Option<bool> {
        let sub = wide(r"Software\Microsoft\Windows\CurrentVersion\PushNotifications"); let val = wide("ToastEnabled");
        let mut data = 0u32; let mut len = 4u32;
        unsafe {
            match RegGetValueW(HKEY_CURRENT_USER, PCWSTR(sub.as_ptr()), PCWSTR(val.as_ptr()), RRF_RT_REG_DWORD, None, Some(&mut data as *mut u32 as *mut _), Some(&mut len)) {
                ERROR_SUCCESS => Some(data != 0),
                ERROR_FILE_NOT_FOUND => Some(true),
                _ => None,
            }
        }
    }

    pub fn is_webview2_available() -> bool {
        let keys = [
            (HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-6E3A4A77C2DB}"),
            (HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-6E3A4A77C2DB}"),
            (HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-6E3A4A77C2DB}"),
        ];
        let val = wide("pv");
        for (root, sub) in keys {
            let sub_w = wide(sub);
            let mut len = 0u32;
            unsafe {
                if RegGetValueW(root, PCWSTR(sub_w.as_ptr()), PCWSTR(val.as_ptr()), RRF_RT_REG_SZ, None, None, Some(&mut len)) == ERROR_SUCCESS && len > 2 {
                    let mut buf = vec![0u16; (len as usize / 2).max(1)];
                    if RegGetValueW(root, PCWSTR(sub_w.as_ptr()), PCWSTR(val.as_ptr()), RRF_RT_REG_SZ, None, Some(buf.as_mut_ptr() as *mut _), Some(&mut len)) == ERROR_SUCCESS {
                        let ver = String::from_utf16_lossy(&buf).trim_end_matches('\0').trim().to_string();
                        if !ver.is_empty() && ver != "0.0.0.0" {
                            return true;
                        }
                    }
                }
            }
        }
        if let Ok(prog) = std::env::var("ProgramFiles(x86)").or_else(|_| std::env::var("ProgramFiles")) {
            let edge_dir = std::path::Path::new(&prog).join(r"Microsoft\EdgeWebView\Application");
            if edge_dir.exists() { return true; }
        }
        false
    }

    pub fn show_missing_webview2_dialog() {
        let title = wide("Pulse - 缺少 WebView2 运行时");
        let msg = wide("Pulse 需要 Microsoft Edge WebView2 运行时才能正常显示界面。\n\n检测到本机尚未安装 WebView2，请访问微软官方页面下载安装：\nhttps://developer.microsoft.com/microsoft-edge/webview2/\n\n安装完成后重新启动 Pulse 即可。");
        unsafe {
            let _ = MessageBoxW(None, PCWSTR(msg.as_ptr()), PCWSTR(title.as_ptr()), MB_OK | MB_ICONWARNING);
        }
    }

    pub struct SingleInstanceGuard {
        pub mutex: HANDLE,
        pub hwnd: HWND,
    }

    unsafe impl Send for SingleInstanceGuard {}
    unsafe impl Sync for SingleInstanceGuard {}

    impl Drop for SingleInstanceGuard {
        fn drop(&mut self) {
            unsafe {
                if !self.hwnd.0.is_null() {
                    let _ = DestroyWindow(self.hwnd);
                }
                if !self.mutex.0.is_null() {
                    let _ = ReleaseMutex(self.mutex);
                    let _ = CloseHandle(self.mutex);
                }
            }
        }
    }

    pub fn acquire_single_instance(data_dir: &std::path::Path) -> Result<Option<SingleInstanceGuard>, String> {
        let canonical = std::fs::canonicalize(data_dir).unwrap_or_else(|_| data_dir.to_path_buf());
        let norm_str = canonical.to_string_lossy().to_lowercase();
        let mut hasher = Sha256::new();
        hasher.update(norm_str.as_bytes());
        let full_hash = format!("{:x}", hasher.finalize());
        let hash = &full_hash[..16];

        let mutex_name = wide(&format!("Pulse_Instance_Mutex_{hash}"));
        let class_name = wide(&format!("Pulse_Instance_Class_{hash}"));
        let window_name = wide(&format!("Pulse_Instance_Window_{hash}"));

        unsafe {
            let hmutex = CreateMutexW(None, true, PCWSTR(mutex_name.as_ptr())).map_err(|e| format!("创建互斥量失败: {e}"))?;
            if GetLastError() == ERROR_ALREADY_EXISTS {
                if let Ok(hwnd) = FindWindowW(PCWSTR(class_name.as_ptr()), PCWSTR(window_name.as_ptr())) {
                    if !hwnd.0.is_null() {
                        let msg_data = b"wakeup\0";
                        let cds = COPYDATASTRUCT {
                            dwData: 1542,
                            cbData: msg_data.len() as u32,
                            lpData: msg_data.as_ptr() as *mut _,
                        };
                        let _ = SendMessageW(hwnd, WM_COPYDATA, WPARAM(0), LPARAM(&cds as *const _ as isize));
                    }
                }
                let _ = CloseHandle(hmutex);
                return Ok(None);
            }

            extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
                if msg == WM_COPYDATA {
                    if let Some(app) = crate::RAIL_APP.get() {
                        crate::open_settings_window(app);
                    }
                    return LRESULT(1);
                }
                unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
            }

            let h_instance = windows::Win32::System::LibraryLoader::GetModuleHandleW(None).unwrap_or_default();
            let wc = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                style: WNDCLASS_STYLES(0),
                lpfnWndProc: Some(wndproc),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: HINSTANCE(h_instance.0),
                hIcon: HICON(std::ptr::null_mut()),
                hCursor: HCURSOR(std::ptr::null_mut()),
                hbrBackground: windows::Win32::Graphics::Gdi::HBRUSH(std::ptr::null_mut()),
                lpszMenuName: PCWSTR(std::ptr::null()),
                lpszClassName: PCWSTR(class_name.as_ptr()),
                hIconSm: HICON(std::ptr::null_mut()),
            };
            let _ = RegisterClassExW(&wc);

            let hwnd = CreateWindowExW(
                WS_EX_NOACTIVATE | WS_EX_TRANSPARENT | WS_EX_LAYERED | WS_EX_TOOLWINDOW,
                PCWSTR(class_name.as_ptr()),
                PCWSTR(window_name.as_ptr()),
                WS_OVERLAPPED,
                0, 0, 0, 0,
                HWND(std::ptr::null_mut()),
                HMENU(std::ptr::null_mut()),
                h_instance,
                None,
            ).map_err(|e| format!("创建单实例监听窗口失败: {e}"))?;

            Ok(Some(SingleInstanceGuard { mutex: hmutex, hwnd }))
        }
    }
}
#[cfg(not(windows))]
mod imp {
    pub fn startup_command() -> Option<String> { None }
    pub fn set_startup(_: bool) -> Result<(), String> { Err("仅支持 Windows".into()) }
    pub fn repair_startup_if_moved() {}
    pub fn toasts_enabled() -> Option<bool> { None }
    pub fn is_webview2_available() -> bool { true }
    pub fn show_missing_webview2_dialog() {}

    pub struct SingleInstanceGuard;
    pub fn acquire_single_instance(_: &std::path::Path) -> Result<Option<SingleInstanceGuard>, String> {
        Ok(Some(SingleInstanceGuard))
    }
}
pub use imp::*;

/// Enabled only when the Run entry points at this very executable, so a stale entry from a
/// moved install reads as "off" and toggling it on repairs the path.
pub fn startup_enabled() -> bool {
    let Some(cmd) = startup_command() else { return false };
    let Ok(exe) = std::env::current_exe() else { return false };
    cmd.trim_matches('"').eq_ignore_ascii_case(&exe.display().to_string())
}
