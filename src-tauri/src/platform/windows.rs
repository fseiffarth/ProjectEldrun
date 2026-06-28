//! Windows project-window backend — SW_HIDE "parking" model.
//!
//! Windows exposes a documented virtual desktop affinity API for top-level
//! windows (`IVirtualDesktopManager`), but no supported API for creating or
//! switching arbitrary virtual desktops (that needs the undocumented, build-
//! fragile `IVirtualDesktopManagerInternal`). Eldrun therefore mirrors the X11
//! two-desktop "parking" model (see x11.rs) without a real second desktop: the
//! previous project's tracked windows are HIDDEN with `SW_HIDE` (the logical
//! "parked desktop"), and the current project's tracked windows are restored and
//! raised. The documented `MoveWindowToDesktop` is kept as a best-effort defense
//! (pull a window the user dragged onto another real desktop back onto Eldrun's),
//! but parking never depends on it.
//!
//! Every X11 safety invariant holds: Eldrun's own window is never hidden
//! (protected by owning-process identity AND the structural main-window guard),
//! protected shell/system windows are never hidden, the parkable override lets a
//! detached subwindow (#42) opt in, and cleanup restores everything Eldrun hid.
//! The pure decision logic lives FFI-free in `super::windows_park` so it is unit
//! tested on any OS.

use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use super::windows_park::{is_protected_process_name, WindowsParkState};
use super::{WorkspaceBackend, WorkspaceInfo};

use windows::core::BOOL;
use windows::core::GUID;
use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
};
use windows::Win32::System::Threading::{
    GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Shell::{IVirtualDesktopManager, VirtualDesktopManager};
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, EnumWindows, GetForegroundWindow, GetParent, GetWindow,
    GetWindowThreadProcessId, IsWindow, IsWindowVisible, SetForegroundWindow, ShowWindow, GW_OWNER,
    SW_HIDE, SW_SHOW,
};

pub struct WindowsBackend {
    /// Pure parking state: parkable override, main-window guard, parked set.
    state: Mutex<WindowsParkState>,
    /// Eldrun's own process id, captured at construction. The structural backbone
    /// of the "never hide Eldrun" invariant: every Eldrun-owned top-level (the
    /// main window AND detached subwindows) shares this pid, exactly as they share
    /// the `eldrun` WM_CLASS on X11.
    self_pid: u32,
    /// Idempotency latch for `cleanup` (mirrors x11.rs `cleaned_up`).
    cleaned_up: Mutex<bool>,
}

impl WindowsBackend {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(WindowsParkState::default()),
            self_pid: unsafe { GetCurrentProcessId() },
            cleaned_up: Mutex::new(false),
        }
    }

    fn is_parkable(&self, window_id: u64) -> bool {
        self.state.lock().unwrap().is_parkable(window_id)
    }

    /// Whether `hwnd` must NEVER be hidden. Combines owning-process identity (any
    /// Eldrun-owned window) with the protected-process-name list (desktop shell +
    /// Eldrun-named helpers). The Windows analog of x11.rs `is_protected`. The
    /// parkable override is consulted by callers BEFORE this gate (see
    /// show/hide_window), identical to X11's ordering.
    fn is_protected(&self, hwnd: HWND) -> bool {
        let Some(pid) = window_pid(hwnd) else {
            // No owning pid — be conservative and treat it as protected.
            return true;
        };
        // (a) Eldrun's own window (main or detached): the `eldrun` WM_CLASS analog.
        if pid == self.self_pid {
            return true;
        }
        // (b) Otherwise key on the owning process's executable basename. This
        // name backstop only reliably covers same-session user processes; a
        // failed lookup (cross-session/secured/PPL processes such as dwm.exe or
        // elevated apps) is treated as NOT protected. That is safe because the
        // real guarantee is the tracked-set invariant — `hide_window` is only
        // ever called with ids from the active project's tracked window set, and
        // such system windows never enter it (they cannot pass
        // `is_candidate_window`). Eldrun's own windows are independently shielded
        // by `self_pid`, so the name list is a defense-in-depth backstop for
        // user-session shell windows, not the primary safety mechanism.
        match process_exe_basename(pid) {
            Some(basename) => is_protected_process_name(&basename),
            None => {
                eprintln!("windows backend: could not resolve exe basename for pid {pid}; treating as parkable");
                false
            }
        }
    }
}

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
        // Override-before-protected, exactly like x11.rs: a detached Eldrun
        // subwindow (same self_pid, normally protected) is still restored when it
        // has been opted in. The main window can never be in the override
        // (structural guard in `add_parkable`).
        if !self.is_parkable(window_id) && self.is_protected(hwnd) {
            return Ok(());
        }
        // Best-effort defense: pull a window the user dragged onto another real
        // desktop back onto Eldrun's. Focus-stealing semantics differ from X11's
        // StackMode::Above raise (SetForegroundWindow frequently no-ops unless
        // Eldrun is already foreground), but the restore is what matters.
        if let Ok(desktop_id) = current_desktop_id() {
            let _ = move_window_to_desktop(hwnd, desktop_id);
        }
        restore_and_raise(hwnd);
        self.state.lock().unwrap().unmark_parked(window_id);
        Ok(())
    }

    fn hide_window(&self, window_id: u64) -> Result<(), String> {
        let hwnd = hwnd_from_u64(window_id)?;
        if !is_window(hwnd) {
            return Ok(());
        }
        // See show_window: the override lets a detached subwindow park; the main
        // window can never be in the override (structural guard). Because Eldrun
        // windows are protected by self_pid and the main window id can never enter
        // the override, the main Eldrun window can NEVER be SW_HIDE'd here.
        if !self.is_parkable(window_id) && self.is_protected(hwnd) {
            return Ok(());
        }
        unsafe {
            let _ = ShowWindow(hwnd, SW_HIDE);
        }
        self.state.lock().unwrap().mark_parked(window_id);
        Ok(())
    }

    fn make_sticky(&self, _eldrun_pid: u32) -> Result<(), String> {
        // Documented Windows APIs do not expose "show on all desktops" for an
        // app-owned window. Leave Eldrun on the user-selected desktop.
        Ok(())
    }

    fn set_parkable(&self, window_id: u64) {
        self.state.lock().unwrap().add_parkable(window_id);
    }

    fn unset_parkable(&self, window_id: u64) {
        self.state.lock().unwrap().remove_parkable(window_id);
    }

    fn set_main_window_id(&self, window_id: u64) {
        self.state.lock().unwrap().set_main(window_id);
    }

    fn cleanup(&self) -> Result<(), String> {
        let mut cleaned_up = self.cleaned_up.lock().unwrap();
        if *cleaned_up {
            return Ok(());
        }
        *cleaned_up = true;
        drop(cleaned_up);

        // Restore exactly the windows Eldrun hid (the SW_HIDE analog of x11.rs
        // cleanup moving PARKED_DESKTOP windows back to ACTIVE_DESKTOP).
        let parked = self.state.lock().unwrap().drain_parked();
        for window_id in parked {
            let Ok(hwnd) = hwnd_from_u64(window_id) else {
                continue;
            };
            if !is_window(hwnd) {
                continue;
            }
            // Re-check protection: HWND numeric values are recycled by the OS, so
            // a parked window that closed mid-session may have had its HWND reused
            // by an unrelated (possibly protected) window. Never un-hide/raise a
            // recycled-into-protected window. Mirrors x11.rs cleanup's is_protected
            // skip (x11.rs:211).
            if self.is_protected(hwnd) {
                continue;
            }
            restore_and_raise(hwnd);
        }
        // No virtual desktops were created or switched by this backend, so there
        // is no desktop topology to restore (unlike x11.rs).
        Ok(())
    }
}

impl Drop for WindowsBackend {
    fn drop(&mut self) {
        // Mirrors x11.rs: normal teardown always un-hides project windows even if
        // the explicit cleanup command is missed.
        let _ = self.cleanup();
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
    if hwnd.0.is_null() {
        return Err("no foreground window for virtual desktop detection".to_string());
    }
    let desktop = unsafe {
        manager
            .GetWindowDesktopId(hwnd)
            .map_err(|e| format!("GetWindowDesktopId: {e}"))?
    };
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
    ensure_com_initialized();
    unsafe {
        CoCreateInstance(&VirtualDesktopManager, None, CLSCTX_INPROC_SERVER)
            .map_err(|e| format!("VirtualDesktopManager: {e}"))
    }
}

/// Initialize COM for the calling thread exactly once per thread, for the
/// thread's lifetime. This is the only COM init Eldrun's Windows backend needs
/// (the best-effort `MoveWindowToDesktop` defense); parking never touches COM.
///
/// We deliberately do NOT pair this with `CoUninitialize`: the apartment is
/// reused by every later `MoveWindowToDesktop` on this thread, so it is
/// intentionally process/thread-lifetime state. The `Cell` latch means each
/// thread issues at most ONE `CoInitializeEx`, so there is no per-call refcount
/// leak (the old code re-init'd on every call). `S_FALSE` (already initialized)
/// and `RPC_E_CHANGED_MODE` (thread already MTA — common on Tauri worker
/// threads) are both fine: `CoCreateInstance` works in either apartment, so any
/// outcome counts as "ready" and the latch is set regardless.
fn ensure_com_initialized() {
    thread_local! {
        static COM_READY: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    }
    COM_READY.with(|ready| {
        if ready.get() {
            return;
        }
        unsafe {
            let _hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        }
        ready.set(true);
    });
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
        IsWindow(Some(hwnd)).as_bool()
            && IsWindowVisible(hwnd).as_bool()
            && GetParent(hwnd).map_or(true, |h| h.0.is_null())
            && GetWindow(hwnd, GW_OWNER).map_or(true, |h| h.0.is_null())
    }
}

fn restore_and_raise(hwnd: HWND) {
    if !is_window(hwnd) {
        return;
    }
    unsafe {
        // `SW_SHOW` (not `SW_RESTORE`) is the faithful inverse of the `SW_HIDE`
        // used to park: it un-hides the window while preserving its prior
        // maximized/normal placement. `SW_RESTORE` would also un-maximize, so a
        // maximized project app would lose that state on every switch-back. The
        // explicit raise below handles bringing it to front.
        let _ = ShowWindow(hwnd, SW_SHOW);
        let _ = BringWindowToTop(hwnd);
        let _ = SetForegroundWindow(hwnd);
    }
}

fn is_window(hwnd: HWND) -> bool {
    unsafe { IsWindow(Some(hwnd)).as_bool() }
}

fn window_pid(hwnd: HWND) -> Option<u32> {
    let mut pid = 0u32;
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
    }
    (pid != 0).then_some(pid)
}

/// The owning process's executable basename for `pid` (file name only, e.g.
/// "explorer.exe"). Returns `None` if the process can't be queried — this
/// reliably succeeds only for same-session user processes; cross-session or
/// secured processes (e.g. `dwm.exe`, elevated apps) are access-denied. Callers
/// treat `None` as NOT protected, which is safe because such windows are never
/// in the tracked set passed to `hide_window`, and Eldrun's own windows are
/// independently shielded by `self_pid`.
fn process_exe_basename(pid: u32) -> Option<String> {
    // SAFETY: the handle is closed before returning regardless of the query
    // result; the buffer is sized to MAX_PATH and `len` bounds the read.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 260];
        let mut len = buf.len() as u32;
        let result =
            QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len);
        let _ = CloseHandle(handle);
        result.ok()?;
        let full = String::from_utf16_lossy(&buf[..len as usize]);
        full.rsplit(['\\', '/']).next().map(|s| s.to_string())
    }
}

fn hwnd_to_u64(hwnd: HWND) -> u64 {
    hwnd.0 as usize as u64
}

fn hwnd_from_u64(window_id: u64) -> Result<HWND, String> {
    isize::try_from(window_id)
        .map(|v| HWND(v as *mut core::ffi::c_void))
        .map_err(|_| format!("invalid windows window id {window_id}"))
}
