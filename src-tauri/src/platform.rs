//! Windows-only platform services kept out of the settings domain: login startup through
//! the HKCU Run key (real system state, never a JSON flag) and the system toast switch.
#[cfg(windows)]
mod imp {
    use windows::{core::PCWSTR, Win32::Foundation::*, Win32::System::Registry::*};
    const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const VALUE: &str = "Pulse";
    fn wide(s: &str) -> Vec<u16> { s.encode_utf16().chain(Some(0)).collect() }

    pub fn startup_command() -> Option<String> {
        let sub = wide(RUN); let val = wide(VALUE); let mut len = 0u32;
        unsafe {
            if RegGetValueW(HKEY_CURRENT_USER, PCWSTR(sub.as_ptr()), PCWSTR(val.as_ptr()), RRF_RT_REG_SZ, None, None, Some(&mut len)) != ERROR_SUCCESS { return None; }
            let mut buf = vec![0u16; (len as usize / 2).max(1)];
            if RegGetValueW(HKEY_CURRENT_USER, PCWSTR(sub.as_ptr()), PCWSTR(val.as_ptr()), RRF_RT_REG_SZ, None, Some(buf.as_mut_ptr() as *mut _), Some(&mut len)) != ERROR_SUCCESS { return None; }
            Some(String::from_utf16_lossy(&buf).trim_end_matches('\0').to_string())
        }
    }
    pub fn set_startup(enable: bool) -> Result<(), String> {
        if crate::config::is_portable() {
            return Err("便携模式下已禁用开机自启，避免移动文件夹后在系统注册表遗留失效路径".into());
        }
        let sub = wide(RUN); let val = wide(VALUE);
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
        use windows::Win32::UI::WindowsAndMessaging::*;
        let title = wide("Pulse - 缺少 WebView2 运行时");
        let msg = wide("Pulse 需要 Microsoft Edge WebView2 运行时才能正常显示界面。\n\n检测到本机尚未安装 WebView2，请访问微软官方页面下载安装：\nhttps://developer.microsoft.com/microsoft-edge/webview2/\n\n安装完成后重新启动 Pulse 即可。");
        unsafe {
            let _ = MessageBoxW(None, PCWSTR(msg.as_ptr()), PCWSTR(title.as_ptr()), MB_OK | MB_ICONWARNING);
        }
    }
}
#[cfg(not(windows))]
mod imp {
    pub fn startup_command() -> Option<String> { None }
    pub fn set_startup(_: bool) -> Result<(), String> { Err("仅支持 Windows".into()) }
    pub fn toasts_enabled() -> Option<bool> { None }
    pub fn is_webview2_available() -> bool { true }
    pub fn show_missing_webview2_dialog() {}
}
pub use imp::*;

/// Enabled only when the Run entry points at this very executable, so a stale entry from a
/// moved install reads as "off" and toggling it on repairs the path.
pub fn startup_enabled() -> bool {
    let Some(cmd) = startup_command() else { return false };
    let Ok(exe) = std::env::current_exe() else { return false };
    cmd.trim_matches('"').eq_ignore_ascii_case(&exe.display().to_string())
}
