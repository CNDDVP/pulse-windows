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
                let res = RegSetKeyValueW(HKEY_CURRENT_USER, PCWSTR(sub.as_ptr()), PCWSTR(val.as_ptr()), REG_SZ.0, Some(cmd.as_ptr() as *const _), (cmd.len() * 2) as u32);
                if res != ERROR_SUCCESS {
                    return Err(format!("写入开机启动项失败 (错误码: {:?})", res.0));
                }
            } else {
                let r = RegDeleteKeyValueW(HKEY_CURRENT_USER, PCWSTR(sub.as_ptr()), PCWSTR(val.as_ptr()));
                if r != ERROR_SUCCESS && r != ERROR_FILE_NOT_FOUND {
                    return Err(format!("删除开机启动项失败 (错误码: {:?})", r.0));
                }
            }
        }
        Ok(())
    }

    pub fn remove_startup_for_profile(profile_id: &str) -> Result<(), String> {
        let val_name = format!("Pulse_Portable_{profile_id}");
        let sub = wide(RUN); let val = wide(&val_name);
        unsafe {
            let r = RegDeleteKeyValueW(HKEY_CURRENT_USER, PCWSTR(sub.as_ptr()), PCWSTR(val.as_ptr()));
            if r != ERROR_SUCCESS && r != ERROR_FILE_NOT_FOUND {
                return Err(format!("清理旧启动项失败 (错误码: {:?})", r.0));
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

    /// Detects Windows WinINet system proxy from HKCU Internet Settings.
    pub fn detect_windows_system_proxy() -> Option<String> {
        let sub = wide(r"Software\Microsoft\Windows\CurrentVersion\Internet Settings");
        let val_enable = wide("ProxyEnable");
        let val_server = wide("ProxyServer");
        let mut enabled = 0u32;
        let mut len = 4u32;
        unsafe {
            if RegGetValueW(HKEY_CURRENT_USER, PCWSTR(sub.as_ptr()), PCWSTR(val_enable.as_ptr()), RRF_RT_REG_DWORD, None, Some(&mut enabled as *mut u32 as *mut _), Some(&mut len)) != ERROR_SUCCESS || enabled == 0 {
                return None;
            }
            let mut str_len = 0u32;
            if RegGetValueW(HKEY_CURRENT_USER, PCWSTR(sub.as_ptr()), PCWSTR(val_server.as_ptr()), RRF_RT_REG_SZ, None, None, Some(&mut str_len)) != ERROR_SUCCESS || str_len <= 2 {
                return None;
            }
            let mut buf = vec![0u16; (str_len as usize / 2).max(1)];
            if RegGetValueW(HKEY_CURRENT_USER, PCWSTR(sub.as_ptr()), PCWSTR(val_server.as_ptr()), RRF_RT_REG_SZ, None, Some(buf.as_mut_ptr() as *mut _), Some(&mut str_len)) != ERROR_SUCCESS {
                return None;
            }
            let s = String::from_utf16_lossy(&buf).trim_end_matches('\0').trim().to_string();
            if s.is_empty() { None } else { Some(s) }
        }
    }

    pub const APP_AUMID: &str = "com.cnddvp.pulse";
    pub const APP_NAME: &str = "Pulse";

    pub fn start_menu_shortcut_path() -> Option<std::path::PathBuf> {
        dirs::data_dir().map(|d| d.join(r"Microsoft\Windows\Start Menu\Programs\Pulse.lnk"))
    }


    pub fn check_notification_identity() -> (String, Option<String>, Option<String>) {
        use windows::core::Interface;
        let Some(shortcut) = start_menu_shortcut_path() else {
            return ("missing_shortcut".into(), None, None);
        };
        let shortcut_str = shortcut.display().to_string();
        if !shortcut.exists() {
            return ("missing_shortcut".into(), Some(shortcut_str), None);
        }

        let Ok(current_exe) = std::env::current_exe() else {
            return ("missing_shortcut".into(), Some(shortcut_str), None);
        };
        let current_exe_str = current_exe.display().to_string();

        unsafe {
            let _ = windows::Win32::System::Com::CoInitializeEx(None, windows::Win32::System::Com::COINIT_APARTMENTTHREADED);
            let link_res: windows::core::Result<windows::Win32::UI::Shell::IShellLinkW> =
                windows::Win32::System::Com::CoCreateInstance(
                    &windows::Win32::UI::Shell::ShellLink,
                    None,
                    windows::Win32::System::Com::CLSCTX_INPROC_SERVER,
                );
            let Ok(link) = link_res else {
                return ("missing_shortcut".into(), Some(shortcut_str), None);
            };

            let persist_res: windows::core::Result<windows::Win32::System::Com::IPersistFile> = link.cast();
            let Ok(persist) = persist_res else {
                return ("missing_shortcut".into(), Some(shortcut_str), None);
            };

            let shortcut_w = wide(&shortcut_str);
            if persist.Load(PCWSTR(shortcut_w.as_ptr()), windows::Win32::System::Com::STGM_READ).is_err() {
                return ("missing_shortcut".into(), Some(shortcut_str), None);
            }

            let mut path_buf = [0u16; 1024];
            let _ = link.GetPath(&mut path_buf, std::ptr::null_mut(), 0);
            let target_path = String::from_utf16_lossy(&path_buf).trim_end_matches('\0').trim().to_string();

            if !target_path.is_empty() && !target_path.eq_ignore_ascii_case(&current_exe_str) {
                return ("moved".into(), Some(shortcut_str), Some(target_path));
            }

            let store_res: windows::core::Result<windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore> = link.cast();
            if let Ok(store) = store_res {
                let pkey = windows::Win32::UI::Shell::PropertiesSystem::PROPERTYKEY {
                    fmtid: windows::core::GUID::from_values(0x9F4C2855, 0x9F79, 0x4B39, [0xA8, 0xE0, 0xE1, 0xB3, 0xD2, 0xF4, 0x79, 0xD0]),
                    pid: 5,
                };
                if let Ok(propvar) = store.GetValue(&pkey) {
                    let s = propvar.to_string();
                    if !s.eq_ignore_ascii_case(APP_AUMID) {
                        return ("missing_aumid".into(), Some(shortcut_str), Some(target_path));
                    }
                } else {
                    return ("missing_aumid".into(), Some(shortcut_str), Some(target_path));
                }
            } else {
                return ("missing_aumid".into(), Some(shortcut_str), Some(target_path));
            }

            let reg_sub = wide(&format!(r"Software\Classes\AppUserModelId\{APP_AUMID}"));
            let mut hkey = HKEY::default();
            if RegOpenKeyExW(HKEY_CURRENT_USER, PCWSTR(reg_sub.as_ptr()), 0, KEY_READ, &mut hkey) != ERROR_SUCCESS {
                return ("unregistered".into(), Some(shortcut_str), Some(target_path));
            }
            let _ = RegCloseKey(hkey);

            ("registered".into(), Some(shortcut_str), Some(target_path))
        }
    }

    pub fn register_notification_identity() -> Result<(), String> {
        use windows::core::Interface;
        let shortcut = start_menu_shortcut_path().ok_or("无法解析开始菜单路径")?;
        if let Some(parent) = shortcut.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let current_exe = std::env::current_exe().map_err(|e| format!("获取程序路径失败: {e}"))?;
        let current_exe_str = current_exe.display().to_string();
        let shortcut_str = shortcut.display().to_string();

        unsafe {
            let _ = windows::Win32::System::Com::CoInitializeEx(None, windows::Win32::System::Com::COINIT_APARTMENTTHREADED);
            let link: windows::Win32::UI::Shell::IShellLinkW =
                windows::Win32::System::Com::CoCreateInstance(
                    &windows::Win32::UI::Shell::ShellLink,
                    None,
                    windows::Win32::System::Com::CLSCTX_INPROC_SERVER,
                ).map_err(|e| format!("创建 ShellLink COM 失败: {e}"))?;

            let exe_w = wide(&current_exe_str);
            link.SetPath(PCWSTR(exe_w.as_ptr())).map_err(|e| format!("设置目标路径失败: {e}"))?;

            if let Some(parent) = current_exe.parent() {
                let parent_w = wide(&parent.display().to_string());
                let _ = link.SetWorkingDirectory(PCWSTR(parent_w.as_ptr()));
            }

            let _ = link.SetIconLocation(PCWSTR(exe_w.as_ptr()), 0);
            let desc_w = wide("Pulse - AI 配额监控");
            let _ = link.SetDescription(PCWSTR(desc_w.as_ptr()));

            let store: windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore =
                link.cast().map_err(|e| format!("获取 PropertyStore 失败: {e}"))?;

            let pkey = windows::Win32::UI::Shell::PropertiesSystem::PROPERTYKEY {
                fmtid: windows::core::GUID::from_values(0x9F4C2855, 0x9F79, 0x4B39, [0xA8, 0xE0, 0xE1, 0xB3, 0xD2, 0xF4, 0x79, 0xD0]),
                pid: 5,
            };
            let propvar = windows::core::PROPVARIANT::from(APP_AUMID);
            store.SetValue(&pkey, &propvar).map_err(|e| format!("设置 AUMID 属性失败: {e}"))?;
            store.Commit().map_err(|e| format!("提交 PropertyStore 失败: {e}"))?;

            let persist: windows::Win32::System::Com::IPersistFile =
                link.cast().map_err(|e| format!("获取 IPersistFile 失败: {e}"))?;
            let shortcut_w = wide(&shortcut_str);
            persist.Save(PCWSTR(shortcut_w.as_ptr()), true).map_err(|e| format!("保存快捷方式失败: {e}"))?;

            let reg_sub = wide(&format!(r"Software\Classes\AppUserModelId\{APP_AUMID}"));
            let mut hkey = HKEY::default();
            let res = RegCreateKeyExW(
                HKEY_CURRENT_USER,
                PCWSTR(reg_sub.as_ptr()),
                0,
                PCWSTR(std::ptr::null()),
                REG_OPTION_NON_VOLATILE,
                KEY_ALL_ACCESS,
                None,
                &mut hkey,
                None,
            );
            if res != ERROR_SUCCESS {
                return Err(format!("创建注册表项失败 (错误码: {:?})", res.0));
            }

            let name_w = wide(APP_NAME);
            let val_name = wide("DisplayName");
            let _ = RegSetValueExW(hkey, PCWSTR(val_name.as_ptr()), 0, REG_SZ, Some(std::slice::from_raw_parts(name_w.as_ptr() as *const u8, name_w.len() * 2)));

            let val_icon = wide("IconUri");
            let _ = RegSetValueExW(hkey, PCWSTR(val_icon.as_ptr()), 0, REG_SZ, Some(std::slice::from_raw_parts(exe_w.as_ptr() as *const u8, exe_w.len() * 2)));

            let val_settings = wide("ShowInSettings");
            let one: u32 = 1;
            let _ = RegSetValueExW(hkey, PCWSTR(val_settings.as_ptr()), 0, REG_DWORD, Some(std::slice::from_raw_parts(&one as *const u32 as *const u8, 4)));

            let _ = RegCloseKey(hkey);
        }

        Ok(())
    }

    pub fn unregister_notification_identity() -> Result<(), String> {
        if let Some(shortcut) = start_menu_shortcut_path() {
            if shortcut.exists() {
                let _ = std::fs::remove_file(&shortcut);
            }
        }
        let reg_sub = wide(&format!(r"Software\Classes\AppUserModelId\{APP_AUMID}"));
        unsafe {
            let _ = RegDeleteTreeW(HKEY_CURRENT_USER, PCWSTR(reg_sub.as_ptr()));
        }
        Ok(())
    }

    pub fn sync_portable_notification_identity() {
        if !crate::config::is_portable() { return; }
        let (status, _, _) = check_notification_identity();
        if status == "moved" {
            let _ = register_notification_identity();
            if let Ok(exe) = std::env::current_exe() {
                eprintln!("Pulse 便携版：检测到运行路径变化，已自动修复通知快捷方式: {}", exe.display());
            }
        }
    }

    pub fn get_app_notification_setting() -> String {
        if let Ok(notifier) = windows::UI::Notifications::ToastNotificationManager::CreateToastNotifierWithId(
            &windows::core::HSTRING::from(APP_AUMID)
        ) {
            match notifier.Setting() {
                Ok(windows::UI::Notifications::NotificationSetting::Enabled) => "enabled".into(),
                Ok(windows::UI::Notifications::NotificationSetting::DisabledForApplication) => "disabled_for_app".into(),
                Ok(windows::UI::Notifications::NotificationSetting::DisabledForUser) => "disabled_for_user".into(),
                Ok(windows::UI::Notifications::NotificationSetting::DisabledByGroupPolicy) => "disabled_by_policy".into(),
                Ok(windows::UI::Notifications::NotificationSetting::DisabledByManifest) => "disabled_by_manifest".into(),
                _ => "unknown".into(),
            }
        } else {
            "unknown".into()
        }
    }

    pub fn send_native_toast(title: &str, body: &str) -> Result<crate::commands::NotificationSendResult, String> {
        let (id_status, _, _) = check_notification_identity();
        let hint = match id_status.as_str() {
            "missing_shortcut" | "unregistered" => Some("提示：检测到尚未初始化 Windows 通知身份，请在设置中点击「启用 Windows 通知」以确保横幅正常弹出".into()),
            "moved" => Some("提示：便携版路径已改变，请在设置中点击「修复通知路径」".into()),
            _ => None,
        };

        let xml_str = format!(
            r#"<toast><visual><binding template="ToastGeneric"><text>{}</text><text>{}</text></binding></visual></toast>"#,
            super::xml_escape(title),
            super::xml_escape(body)
        );

        let xml = windows::Data::Xml::Dom::XmlDocument::new().map_err(|e| format!("创建 XML 失败: {e}"))?;
        xml.LoadXml(&windows::core::HSTRING::from(xml_str)).map_err(|e| format!("加载 Toast XML 失败: {e}"))?;

        let toast = windows::UI::Notifications::ToastNotification::CreateToastNotification(&xml)
            .map_err(|e| format!("创建 ToastNotification 失败: {e}"))?;

        let notifier = windows::UI::Notifications::ToastNotificationManager::CreateToastNotifierWithId(
            &windows::core::HSTRING::from(APP_AUMID)
        ).map_err(|e| format!("创建 ToastNotifier 失败: {e}"))?;

        let setting = notifier.Setting().unwrap_or(windows::UI::Notifications::NotificationSetting::Enabled);
        let setting_str = match setting {
            windows::UI::Notifications::NotificationSetting::Enabled => "enabled",
            windows::UI::Notifications::NotificationSetting::DisabledForApplication => "disabled_for_app",
            windows::UI::Notifications::NotificationSetting::DisabledForUser => "disabled_for_user",
            windows::UI::Notifications::NotificationSetting::DisabledByGroupPolicy => "disabled_by_policy",
            windows::UI::Notifications::NotificationSetting::DisabledByManifest => "disabled_by_manifest",
            _ => "unknown",
        };

        if setting == windows::UI::Notifications::NotificationSetting::DisabledForApplication {
            return Err("通知提交被系统阻止：Windows 设置中已禁用 Pulse 的通知（请在「Windows 设置 → 系统 → 通知」中允许 Pulse）".into());
        }
        if setting == windows::UI::Notifications::NotificationSetting::DisabledForUser {
            return Err("通知提交被系统阻止：Windows 全局通知开关已关闭（请在「Windows 设置 → 系统 → 通知」中开启总开关）".into());
        }
        if setting == windows::UI::Notifications::NotificationSetting::DisabledByGroupPolicy {
            return Err("通知提交被系统阻止：Windows 组策略已禁用通知".into());
        }
        if setting == windows::UI::Notifications::NotificationSetting::DisabledByManifest {
            return Err("通知提交被系统阻止：Windows 未识别 Pulse 通知身份（请先点击「启用 Windows 通知」）".into());
        }

        notifier.Show(&toast).map_err(|e| format!("Windows 提交通知失败 (HRESULT {:?}): {e}", e.code()))?;

        Ok(crate::commands::NotificationSendResult {
            success: true,
            stage: "submitted".into(),
            setting: setting_str.into(),
            test_id: "".into(),
            error: None,
            hint,
        })
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
                        let mut result: usize = 0;
                        let _ = SendMessageTimeoutW(
                            hwnd,
                            WM_COPYDATA,
                            WPARAM(0),
                            LPARAM(&cds as *const _ as isize),
                            SMTO_ABORTIFHUNG | SMTO_BLOCK,
                            2000,
                            Some(&mut result),
                        );
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
    pub fn remove_startup_for_profile(_: &str) -> Result<(), String> { Ok(()) }
    pub fn repair_startup_if_moved() {}
    pub fn toasts_enabled() -> Option<bool> { None }
    pub fn is_webview2_available() -> bool { true }
    pub fn show_missing_webview2_dialog() {}
    pub fn detect_windows_system_proxy() -> Option<String> { None }

    pub fn start_menu_shortcut_path() -> Option<std::path::PathBuf> { None }
    pub fn check_notification_identity() -> (String, Option<String>, Option<String>) {
        ("unregistered".into(), None, None)
    }
    pub fn register_notification_identity() -> Result<(), String> { Err("仅支持 Windows".into()) }
    pub fn unregister_notification_identity() -> Result<(), String> { Ok(()) }
    pub fn sync_portable_notification_identity() {}
    pub fn get_app_notification_setting() -> String { "unknown".into() }
    pub fn send_native_toast(_title: &str, _body: &str) -> Result<crate::commands::NotificationSendResult, String> {
        Err("仅支持 Windows".into())
    }

    pub struct SingleInstanceGuard;
    pub fn acquire_single_instance(_: &std::path::Path) -> Result<Option<SingleInstanceGuard>, String> {
        Ok(Some(SingleInstanceGuard))
    }
}
pub use imp::*;

pub fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// Enabled only when the Run entry points at this very executable, so a stale entry from a
/// moved install reads as "off" and toggling it on repairs the path.
pub fn startup_enabled() -> bool {
    let Some(cmd) = startup_command() else { return false };
    let Ok(exe) = std::env::current_exe() else { return false };
    cmd.trim_matches('"').eq_ignore_ascii_case(&exe.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_xml_escape() {
        assert_eq!(xml_escape("Hello <World> & '\"'"), "Hello &lt;World&gt; &amp; &apos;&quot;&apos;");
    }

    #[test]
    fn test_start_menu_shortcut_path() {
        if cfg!(windows) {
            let path = start_menu_shortcut_path();
            assert!(path.is_some());
            let p = path.unwrap();
            assert!(p.to_string_lossy().ends_with(r"Microsoft\Windows\Start Menu\Programs\Pulse.lnk"));
        }
    }

    #[test]
    fn test_check_notification_identity_structure() {
        let (status, shortcut_path, _) = check_notification_identity();
        assert!(["registered", "moved", "missing_shortcut", "missing_aumid", "unregistered"].contains(&status.as_str()));
        if cfg!(windows) {
            assert!(shortcut_path.is_some());
        }
    }
}

