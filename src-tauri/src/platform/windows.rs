//! Windows project-window backend.
//!
//! Windows exposes a documented virtual desktop affinity API for top-level
//! windows, but not a supported API for creating or switching arbitrary virtual
//! desktops. Eldrun therefore hides the previous project's tracked windows and
//! moves the current project's tracked windows onto the desktop where Eldrun is
//! currently running, then restores/raises them.

use std::thread;
use std::time::Duration;

use super::{WorkspaceBackend, WorkspaceInfo};

use windows::core::GUID;
use windows::Win32::Foundation::{BOOL, HWND, LPARAM};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
};
use windows::Win32::UI::Shell::{IVirtualDesktopManager, VirtualDesktopManager};
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, EnumWindows, GetForegroundWindow, GetParent, GetWindow,
    GetWindowThreadProcessId, IsWindow, IsWindowVisible, SetForegroundWindow, ShowWindow, GW_OWNER,
    SW_HIDE, SW_RESTORE,
};

pub struct WindowsBackend;

impl WorkspaceBackend for WindowsBackend {
    fn name(&self) -> &'static str {
        "windows"
    }

    fn info(&self) -> WorkspaceInfo {
        WorkspaceInfo {
            label: "win".to_string(),
            current_desktop: None,
            desktop_count: None,
        }
    }

    fn show_window(&self, window_id: u64) -> Result<(), String> {
        let hwnd = hwnd_from_u64(window_id)?;
        if !is_window(hwnd) {
            return Ok(());
        }
        if let Ok(desktop_id) = current_desktop_id() {
            let _ = move_window_to_desktop(hwnd, desktop_id);
        }
        restore_and_raise(hwnd);
        Ok(())
    }

    fn hide_window(&self, window_id: u64) -> Result<(), String> {
        let hwnd = hwnd_from_u64(window_id)?;
        if is_window(hwnd) {
            unsafe {
                let _ = ShowWindow(hwnd, SW_HIDE);
            }
        }
        Ok(())
    }

    fn make_sticky(&self, _eldrun_pid: u32) -> Result<(), String> {
        // Documented Windows APIs do not expose "show on all desktops" for an
        // app-owned window. Leave Eldrun on the user-selected desktop.
        Ok(())
    }

    fn cleanup(&self) -> Result<(), String> {
        // No virtual desktops are created or switched by this backend, so there
        // is no desktop topology to restore.
        Ok(())
    }
}

pub fn list_window_ids() -> Vec<u64> {
    enumerate_windows().into_iter().map(hwnd_to_u64).collect()
}

pub fn find_window_for_pid(pid: u32, attempts: usize) -> Option<u64> {
    for _ in 0..attempts {
        if let Some(hwnd) = enumerate_windows()
            .into_iter()
            .find(|&hwnd| window_pid(hwnd) == Some(pid))
        {
            return Some(hwnd_to_u64(hwnd));
        }
        thread::sleep(Duration::from_millis(100));
    }
    None
}

pub fn find_new_window(before: &[u64], attempts: usize) -> Option<u64> {
    for _ in 0..attempts {
        if let Some(hwnd) = enumerate_windows()
            .into_iter()
            .map(hwnd_to_u64)
            .find(|id| !before.contains(id))
        {
            return Some(hwnd);
        }
        thread::sleep(Duration::from_millis(100));
    }
    None
}

fn current_desktop_id() -> Result<GUID, String> {
    let manager = virtual_desktop_manager()?;
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.0 == 0 {
        return Err("no foreground window for virtual desktop detection".to_string());
    }
    let mut desktop = GUID::zeroed();
    unsafe {
        manager
            .GetWindowDesktopId(hwnd, &mut desktop)
            .map_err(|e| format!("GetWindowDesktopId: {e}"))?;
    }
    Ok(desktop)
}

fn move_window_to_desktop(hwnd: HWND, desktop: GUID) -> Result<(), String> {
    let manager = virtual_desktop_manager()?;
    unsafe {
        manager
            .MoveWindowToDesktop(hwnd, &desktop)
            .map_err(|e| format!("MoveWindowToDesktop: {e}"))?;
    }
    Ok(())
}

fn virtual_desktop_manager() -> Result<IVirtualDesktopManager, String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        CoCreateInstance(&VirtualDesktopManager, None, CLSCTX_INPROC_SERVER)
            .map_err(|e| format!("VirtualDesktopManager: {e}"))
    }
}

fn enumerate_windows() -> Vec<HWND> {
    let mut windows = Vec::<HWND>::new();
    unsafe {
        let _ = EnumWindows(
            Some(enum_window),
            LPARAM(&mut windows as *mut Vec<HWND> as isize),
        );
    }
    windows
}

unsafe extern "system" fn enum_window(hwnd: HWND, lparam: LPARAM) -> BOOL {
    if is_candidate_window(hwnd) {
        let windows = lparam.0 as *mut Vec<HWND>;
        unsafe {
            (*windows).push(hwnd);
        }
    }
    true.into()
}

fn is_candidate_window(hwnd: HWND) -> bool {
    unsafe {
        IsWindow(hwnd).as_bool()
            && IsWindowVisible(hwnd).as_bool()
            && GetParent(hwnd).0 == 0
            && GetWindow(hwnd, GW_OWNER).0 == 0
    }
}

fn restore_and_raise(hwnd: HWND) {
    if !is_window(hwnd) {
        return;
    }
    unsafe {
        let _ = ShowWindow(hwnd, SW_RESTORE);
        let _ = BringWindowToTop(hwnd);
        let _ = SetForegroundWindow(hwnd);
    }
}

fn is_window(hwnd: HWND) -> bool {
    unsafe { IsWindow(hwnd).as_bool() }
}

fn window_pid(hwnd: HWND) -> Option<u32> {
    let mut pid = 0u32;
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
    }
    (pid != 0).then_some(pid)
}

fn hwnd_to_u64(hwnd: HWND) -> u64 {
    hwnd.0 as usize as u64
}

fn hwnd_from_u64(window_id: u64) -> Result<HWND, String> {
    isize::try_from(window_id)
        .map(HWND)
        .map_err(|_| format!("invalid windows window id {window_id}"))
}
