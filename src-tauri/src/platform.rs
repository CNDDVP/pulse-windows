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
}
#[cfg(not(windows))]
mod imp {
    pub fn startup_command() -> Option<String> { None }
    pub fn set_startup(_: bool) -> Result<(), String> { Err("仅支持 Windows".into()) }
    pub fn toasts_enabled() -> Option<bool> { None }
}
pub use imp::*;

/// Enabled only when the Run entry points at this very executable, so a stale entry from a
/// moved install reads as "off" and toggling it on repairs the path.
pub fn startup_enabled() -> bool {
    let Some(cmd) = startup_command() else { return false };
    let Ok(exe) = std::env::current_exe() else { return false };
    cmd.trim_matches('"').eq_ignore_ascii_case(&exe.display().to_string())
}
