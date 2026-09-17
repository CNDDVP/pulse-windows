use crate::types::AppSettings;
use tauri::{AppHandle,Manager,PhysicalPosition,PhysicalSize};
#[derive(Debug,PartialEq)] pub struct Rect{pub x:i32,pub y:i32,pub w:u32,pub h:u32}
#[cfg(windows)]
pub fn get_cursor_screen_pos() -> Option<(i32, i32)> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    unsafe {
        let mut pt = POINT::default();
        if GetCursorPos(&mut pt).is_ok() {
            Some((pt.x, pt.y))
        } else {
            None
        }
    }
}
#[cfg(not(windows))]
pub fn get_cursor_screen_pos() -> Option<(i32, i32)> {
    None
}

/// GDI device name (`\\.\DISPLAY1`) → the monitor name Windows Settings shows
/// ("DELL U2723QE"). The GDI numbering is meaningless to a person.
#[cfg(windows)]
pub fn friendly_monitor_names() -> std::collections::HashMap<String, String> {
    use windows::Win32::Devices::Display::*;
    use windows::Win32::Foundation::ERROR_SUCCESS;
    let mut map = std::collections::HashMap::new();
    unsafe {
        let (mut paths, mut modes) = (0u32, 0u32);
        if GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut paths, &mut modes) != ERROR_SUCCESS {
            return map;
        }
        let mut path_buf = vec![DISPLAYCONFIG_PATH_INFO::default(); paths as usize];
        let mut mode_buf = vec![DISPLAYCONFIG_MODE_INFO::default(); modes as usize];
        if QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, &mut paths, path_buf.as_mut_ptr(), &mut modes, mode_buf.as_mut_ptr(), None) != ERROR_SUCCESS {
            return map;
        }
        for p in path_buf.iter().take(paths as usize) {
            let mut source = DISPLAYCONFIG_SOURCE_DEVICE_NAME::default();
            source.header = DISPLAYCONFIG_DEVICE_INFO_HEADER {
                r#type: DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
                size: std::mem::size_of::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>() as u32,
                adapterId: p.sourceInfo.adapterId,
                id: p.sourceInfo.id,
            };
            let mut target = DISPLAYCONFIG_TARGET_DEVICE_NAME::default();
            target.header = DISPLAYCONFIG_DEVICE_INFO_HEADER {
                r#type: DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME,
                size: std::mem::size_of::<DISPLAYCONFIG_TARGET_DEVICE_NAME>() as u32,
                adapterId: p.targetInfo.adapterId,
                id: p.targetInfo.id,
            };
            if DisplayConfigGetDeviceInfo(&mut source.header) != 0 || DisplayConfigGetDeviceInfo(&mut target.header) != 0 {
                continue;
            }
            let gdi = String::from_utf16_lossy(&source.viewGdiDeviceName).trim_end_matches('\0').to_string();
            let name = String::from_utf16_lossy(&target.monitorFriendlyDeviceName).trim_end_matches('\0').trim().to_string();
            if !gdi.is_empty() && !name.is_empty() {
                map.insert(gdi, name);
            }
        }
    }
    map
}
#[cfg(not(windows))]
pub fn friendly_monitor_names() -> std::collections::HashMap<String, String> {
    std::collections::HashMap::new()
}

pub fn geometry(area:Rect,scale:f64,side:&str,state:&str,count:usize,fx:f64,fy:f64)->Rect{
    let horizontal=side=="top";
    let length=((count.max(4) as f64*76.0)+20.0).clamp(320.0,900.0);
    // Collapsed width is the hover hit area; the visible edge bar drawn inside it is 4 dip.
    let breadth=if state=="collapsed"{10.0}else if state=="expanded"{380.0}else{72.0};
    let (lw,lh)=if horizontal{(length,breadth)}else{(breadth,length)};
    let w=((lw*scale).round() as u32).min(area.w);let h=((lh*scale).round() as u32).min(area.h);
    let x=match side{"left"=>area.x,"right"=>area.x+(area.w-w) as i32,_=>area.x+((area.w-w) as f64*fx.clamp(0.0,1.0)).round() as i32};
    let y=if horizontal{area.y}else{area.y+((area.h-h) as f64*fy.clamp(0.0,1.0)).round() as i32};
    Rect{x,y,w,h}
}
pub fn position(app:&AppHandle,settings:&AppSettings,state:&str){
    let Some(window)=app.get_webview_window("main")else{return};
    let monitors=window.available_monitors().unwrap_or_default();
    let monitor = if settings.follow_active_display && state != "expanded" {
        get_cursor_screen_pos().and_then(|(cx, cy)| {
            monitors.iter().find(|m| {
                let q = m.position();
                let s = m.size();
                cx >= q.x && cx < (q.x + s.width as i32) && cy >= q.y && cy < (q.y + s.height as i32)
            }).cloned()
        })
    } else {
        None
    }
    .or_else(|| {
        settings.monitor_name.as_ref().and_then(|n| {
            monitors.iter().find(|m| m.name() == Some(n)).cloned()
        })
    })
    .or_else(|| window.current_monitor().ok().flatten())
    .or_else(|| window.primary_monitor().ok().flatten());
    let Some(m)=monitor else{return};let area=m.work_area();
    let rect=geometry(Rect{x:area.position.x,y:area.position.y,w:area.size.width,h:area.size.height},m.scale_factor(),&settings.dock_side,state,settings.providers.values().filter(|c|c.enabled).count(),settings.free_x,settings.free_y);
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::{HWND, RECT};
        use windows::Win32::UI::WindowsAndMessaging::{
            GetWindowRect, SetWindowPos, SWP_NOACTIVATE, SWP_NOSENDCHANGING, SWP_NOZORDER,
        };
        if let Ok(hwnd) = window.hwnd() {
            unsafe {
                let mut current = RECT::default();
                if GetWindowRect(HWND(hwnd.0), &mut current).is_ok() {
                    if current.left == rect.x
                        && current.top == rect.y
                        && (current.right - current.left) == rect.w as i32
                        && (current.bottom - current.top) == rect.h as i32
                    {
                        return;
                    }
                }
                // SWP_NOCOPYBITS/SWP_DEFERERASE must stay off: they force a full client-area
                // erase before the WebView repaints, which shows as the whole transparent
                // window blinking out of existence on every state change.
                let _ = SetWindowPos(
                    HWND(hwnd.0),
                    HWND(std::ptr::null_mut()),
                    rect.x,
                    rect.y,
                    rect.w as i32,
                    rect.h as i32,
                    SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOSENDCHANGING,
                );
            }
            return;
        }
    }

    if window.outer_position().ok()==Some(PhysicalPosition::new(rect.x,rect.y)) && window.inner_size().ok()==Some(PhysicalSize::new(rect.w,rect.h)){return}
    let _=window.set_size(PhysicalSize::new(rect.w,rect.h));
    let _=window.set_position(PhysicalPosition::new(rect.x,rect.y));
}
pub fn fullscreen_other(app:&AppHandle)->bool{
    #[cfg(windows)] unsafe{
        use windows::Win32::{Foundation::RECT,Graphics::Gdi::*,UI::WindowsAndMessaging::*};
        let foreground=GetForegroundWindow();if foreground.0.is_null(){return false}
        if app.webview_windows().values().any(|w|w.hwnd().is_ok_and(|h|h.0==foreground.0)){return false}
        let mut class=[0u16;128];let n=GetClassNameW(foreground,&mut class);let name=String::from_utf16_lossy(&class[..n.max(0) as usize]);
        if ["Progman","WorkerW","Shell_TrayWnd"].contains(&name.as_str()){return false}
        let style = GetWindowLongW(foreground, GWL_STYLE) as u32;
        if (style & WS_MAXIMIZE.0) != 0 && (style & WS_CAPTION.0) != 0 {return false}
        let mut info=MONITORINFO{cbSize:std::mem::size_of::<MONITORINFO>() as u32,..Default::default()};
        let mon=MonitorFromWindow(foreground,MONITOR_DEFAULTTONEAREST);
        let mut rect=RECT::default();
        if !GetMonitorInfoW(mon,&mut info).as_bool() || GetWindowRect(foreground,&mut rect).is_err(){return false}
        return rect.left<=info.rcMonitor.left && rect.top<=info.rcMonitor.top && rect.right>=info.rcMonitor.right && rect.bottom>=info.rcMonitor.bottom;
    }
    #[cfg(not(windows))] false
}
#[cfg(test)]mod tests{use super::*;
    #[test]fn mixed_dpi_negative_origin_stays_inside(){for scale in [1.0,1.25,1.5,1.75,2.0]{for side in ["left","right","top","free"]{for state in ["collapsed","rail","expanded"]{let r=geometry(Rect{x:-1920,y:-300,w:1920,h:1040},scale,side,state,64,0.5,0.5);assert!(r.x>=-1920 && r.y>=-300 && r.x+r.w as i32<=0 && r.y+r.h as i32<=740);}}}}
}
