use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize};

pub fn position_edge_window(app: &AppHandle, side: &str, state: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let monitor = window
            .primary_monitor()
            .ok()
            .flatten()
            .or_else(|| window.current_monitor().ok().flatten());

        if let Some(m) = monitor {
            let mon_scale = m.scale_factor();
            let mon_pos = m.position();
            let mon_size = m.size();

            let target_logical_w = match state {
                "collapsed" => 16.0,
                "rail" => 72.0,
                "expanded" => 360.0,
                _ => 72.0,
            };
            let target_logical_h = 820.0;

            let physical_w = (target_logical_w * mon_scale).round() as u32;
            let physical_h = (target_logical_h * mon_scale).round() as u32;

            let physical_y = mon_pos.y + ((mon_size.height as i32 - physical_h as i32) / 2).max(0);

            let physical_x = if side == "left" {
                mon_pos.x
            } else {
                mon_pos.x + mon_size.width as i32 - physical_w as i32
            };

            // Avoid redundant SetWindowPos if already in position
            if let (Ok(cur_size), Ok(cur_pos)) = (window.inner_size(), window.outer_position()) {
                if (cur_size.width as i32 - physical_w as i32).abs() <= 1
                    && (cur_size.height as i32 - physical_h as i32).abs() <= 1
                    && (cur_pos.x - physical_x).abs() <= 1
                    && (cur_pos.y - physical_y).abs() <= 1
                {
                    return;
                }
            }

            #[cfg(windows)]
            {
                use windows::Win32::Foundation::HWND;
                use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER};
                if let Ok(hwnd) = window.hwnd() {
                    unsafe {
                        let _ = SetWindowPos(
                            HWND(hwnd.0),
                            HWND(std::ptr::null_mut()),
                            physical_x,
                            physical_y,
                            physical_w as i32,
                            physical_h as i32,
                            SWP_NOZORDER | SWP_NOACTIVATE,
                        );
                    }
                    return;
                }
            }

            let _ = window.set_position(PhysicalPosition::new(physical_x, physical_y));
            let _ = window.set_size(PhysicalSize::new(physical_w, physical_h));
        }
    }
}
