//! Windows project-window backend.
//!
//! Eldrun records native HWND values for windows it launches. The backend only
//! shows or hides those tracked windows; it does not enumerate arbitrary user
//! windows into projects.

use std::thread;
use std::time::Duration;

use super::{WorkspaceBackend, WorkspaceInfo};

type Bool = i32;
type Dword = u32;
type Hwnd = isize;
type Lparam = isize;

const SW_HIDE: i32 = 0;
const SW_RESTORE: i32 = 9;
const GW_OWNER: u32 = 4;

#[link(name = "user32")]
extern "system" {
    fn EnumWindows(
        lp_enum_func: extern "system" fn(Hwnd, Lparam) -> Bool,
        lparam: Lparam,
    ) -> Bool;
    fn GetWindowThreadProcessId(hwnd: Hwnd, process_id: *mut Dword) -> Dword;
    fn IsWindow(hwnd: Hwnd) -> Bool;
    fn IsWindowVisible(hwnd: Hwnd) -> Bool;
    fn GetParent(hwnd: Hwnd) -> Hwnd;
    fn GetWindow(hwnd: Hwnd, cmd: u32) -> Hwnd;
    fn ShowWindow(hwnd: Hwnd, cmd_show: i32) -> Bool;
    fn SetForegroundWindow(hwnd: Hwnd) -> Bool;
    fn BringWindowToTop(hwnd: Hwnd) -> Bool;
}

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
        unsafe {
            ShowWindow(hwnd, SW_RESTORE);
            BringWindowToTop(hwnd);
            SetForegroundWindow(hwnd);
        }
        Ok(())
    }

    fn hide_window(&self, window_id: u64) -> Result<(), String> {
        let hwnd = hwnd_from_u64(window_id)?;
        if !is_window(hwnd) {
            return Ok(());
        }
        unsafe {
            ShowWindow(hwnd, SW_HIDE);
        }
        Ok(())
    }

    fn switch_to_project(
        &self,
        _project_id: Option<&str>,
        _previous_project_id: Option<&str>,
        _previous_window_ids: &[u64],
        _current_window_ids: &[u64],
    ) -> Result<(), String> {
        Ok(())
    }

    fn make_sticky(&self, _eldrun_pid: u32) -> Result<(), String> {
        Ok(())
    }

    fn cleanup(&self) -> Result<(), String> {
        Ok(())
    }
}

pub fn list_window_ids() -> Vec<u64> {
    enumerate_windows()
        .into_iter()
        .map(hwnd_to_u64)
        .collect()
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

fn enumerate_windows() -> Vec<Hwnd> {
    let mut windows = Vec::<Hwnd>::new();
    unsafe {
        EnumWindows(enum_window, &mut windows as *mut Vec<Hwnd> as Lparam);
    }
    windows
}

extern "system" fn enum_window(hwnd: Hwnd, lparam: Lparam) -> Bool {
    if is_candidate_window(hwnd) {
        let windows = lparam as *mut Vec<Hwnd>;
        unsafe {
            (*windows).push(hwnd);
        }
    }
    1
}

fn is_candidate_window(hwnd: Hwnd) -> bool {
    unsafe {
        IsWindow(hwnd) != 0
            && IsWindowVisible(hwnd) != 0
            && GetParent(hwnd) == 0
            && GetWindow(hwnd, GW_OWNER) == 0
    }
}

fn is_window(hwnd: Hwnd) -> bool {
    unsafe { IsWindow(hwnd) != 0 }
}

fn window_pid(hwnd: Hwnd) -> Option<u32> {
    let mut pid: Dword = 0;
    unsafe {
        GetWindowThreadProcessId(hwnd, &mut pid as *mut Dword);
    }
    (pid != 0).then_some(pid)
}

fn hwnd_to_u64(hwnd: Hwnd) -> u64 {
    hwnd as usize as u64
}

fn hwnd_from_u64(window_id: u64) -> Result<Hwnd, String> {
    usize::try_from(window_id)
        .map(|value| value as Hwnd)
        .map_err(|_| format!("invalid windows window id {window_id}"))
}
