//! X11 workspace backend — EWMH two-desktop parking model.
//!
//! Matches the Python kde_kwin.py (X11 path) behavior:
//! - Two desktops: desktop 0 = active project, desktop 1 = parked windows.
//! - Switching projects moves old project windows to desktop 1 and restores
//!   new project windows from desktop 1 to desktop 0.
//! - Protected WM_CLASS names are never moved; any that drift to desktop 1
//!   are rescued back to desktop 0 on each switch.
//! - All window management uses ClientMessage events (proper EWMH), not
//!   ChangeProperty, so KWin intercepts and honors the requests.

use std::collections::{HashMap, HashSet};
use std::process::Command;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use xcb::x::{self, Atom, Window};
use xcb::{Connection, Xid, XidNew};

use super::{WorkspaceBackend, WorkspaceInfo};

// ── Constants ─────────────────────────────────────────────────────────────

const ACTIVE_DESKTOP: u32 = 0;
const PARKED_DESKTOP: u32 = 1;
const ROOT_PROJECT_ID: &str = "__eldrun_root__";

const PROTECTED_CLASSES: &[&str] = &[
    "eldrun",
    "plasmashell",
    "kwin",
    "cinnamon",
];

// ── Backend ────────────────────────────────────────────────────────────────

pub struct X11Backend {
    conn: Connection,
    screen_num: i32,
    atoms: Atoms,
    /// Maps project_id → windows currently parked on desktop 1.
    parked: Mutex<HashMap<String, Vec<Window>>>,
    original_desktop_count: u32,
    cinnamon: Option<CinnamonWorkspaceState>,
    cleaned_up: Mutex<bool>,
}

struct Atoms {
    net_current_desktop: Atom,
    net_number_of_desktops: Atom,
    net_wm_desktop: Atom,
    net_client_list: Atom,
    net_wm_name: Atom,
    utf8_string: Atom,
}

struct CinnamonWorkspaceState {
    original_num_workspaces: Option<String>,
    original_workspace_names: Option<String>,
    original_dynamic_workspaces: Option<String>,
}

impl X11Backend {
    pub fn try_new() -> Result<Self, String> {
        let (conn, screen_num) =
            xcb::Connection::connect(None).map_err(|e| format!("xcb connect: {e}"))?;

        let atoms = intern_atoms(&conn)?;
        let original_desktop_count =
            get_cardinal(&conn, screen_num, atoms.net_number_of_desktops).unwrap_or(1);
        let cinnamon = if is_cinnamon_desktop() {
            Some(configure_cinnamon_workspaces()?)
        } else {
            None
        };

        ensure_desktop_count(&conn, screen_num, &atoms, 2)?;

        Ok(X11Backend {
            conn,
            screen_num,
            atoms,
            parked: Mutex::new(HashMap::new()),
            original_desktop_count,
            cinnamon,
            cleaned_up: Mutex::new(false),
        })
    }
}

impl WorkspaceBackend for X11Backend {
    fn name(&self) -> &'static str {
        "x11"
    }

    fn info(&self) -> WorkspaceInfo {
        let current =
            get_cardinal(&self.conn, self.screen_num, self.atoms.net_current_desktop)
                .unwrap_or(0);
        let count =
            get_cardinal(&self.conn, self.screen_num, self.atoms.net_number_of_desktops)
                .unwrap_or(2);
        WorkspaceInfo {
            label: format!("ws {}", current + 1),
            current_desktop: Some(current as usize),
            desktop_count: Some(count as usize),
        }
    }

    fn switch_to_project(
        &self,
        project_id: Option<&str>,
        previous_project_id: Option<&str>,
        previous_window_ids: &[u64],
        current_window_ids: &[u64],
    ) -> Result<(), String> {
        let project_id = project_id.unwrap_or(ROOT_PROJECT_ID);
        let previous_project_id = previous_project_id.unwrap_or(ROOT_PROJECT_ID);
        ensure_desktop_count(&self.conn, self.screen_num, &self.atoms, 2)?;
        let all_windows = list_client_windows(&self.conn, self.screen_num, &self.atoms)?;
        let mut parked = self.parked.lock().unwrap();
        let all_window_ids: HashSet<u32> = all_windows.iter().map(Window::resource_id).collect();

        let mut ws1_set = HashSet::new();
        for &wid in &all_windows {
            match get_window_desktop(&self.conn, wid, &self.atoms) {
                Some(d) if d == PARKED_DESKTOP => {
                    ws1_set.insert(wid);
                }
                _ => {} // sticky or other desktops — leave untouched
            }
        }

        let previous_windows: Vec<Window> = previous_window_ids
            .iter()
            .copied()
            .filter_map(window_from_u64)
            .filter(|id| all_window_ids.contains(&id.resource_id()))
            .filter(|&wid| !is_protected(&self.conn, wid))
            .collect();

        for &wid in &previous_windows {
            if let Err(e) = self.move_window(wid, PARKED_DESKTOP) {
                eprintln!("{e}");
            }
        }
        parked.insert(previous_project_id.to_string(), previous_windows.clone());

        let mut effective_ws1 = ws1_set;
        for wid in previous_windows {
            effective_ws1.insert(wid);
        }

        // Rescue any protected windows that drifted to desktop 1.
        let ws1_snapshot: Vec<Window> = effective_ws1.iter().copied().collect();
        for wid in ws1_snapshot {
            if is_protected(&self.conn, wid) {
                if let Err(e) = self.move_window(wid, ACTIVE_DESKTOP) {
                    eprintln!("{e}");
                }
                effective_ws1.remove(&wid);
            }
        }

        let mut restore_windows: Vec<Window> = current_window_ids
            .iter()
            .copied()
            .filter_map(window_from_u64)
            .filter(|id| all_window_ids.contains(&id.resource_id()))
            .collect();
        if let Some(project_wins) = parked.get(project_id) {
            restore_windows.extend(project_wins.iter().copied());
        }
        restore_windows.sort_by_key(|wid| wid.resource_id());
        restore_windows.dedup_by_key(|wid| wid.resource_id());

        for wid in restore_windows {
            if effective_ws1.contains(&wid) && !is_protected(&self.conn, wid) {
                if let Err(e) = self.move_window(wid, ACTIVE_DESKTOP) {
                    eprintln!("{e}");
                }
            }
        }

        // Switch active virtual desktop to 0.
        switch_current_desktop(&self.conn, self.screen_num, &self.atoms, ACTIVE_DESKTOP)?;
        self.conn.flush().ok();
        Ok(())
    }

    fn show_window(&self, window_id: u64) -> Result<(), String> {
        let wid =
            window_from_u64(window_id).ok_or_else(|| format!("invalid x11 window id {window_id}"))?;
        if is_protected(&self.conn, wid) {
            return Ok(());
        }
        self.conn
            .send_and_check_request(&x::MapWindow { window: wid })
            .map_err(|e| e.to_string())?;
        self.conn
            .send_and_check_request(&x::ConfigureWindow {
                window: wid,
                value_list: &[x::ConfigWindow::StackMode(x::StackMode::Above)],
            })
            .map_err(|e| e.to_string())?;
        self.conn.flush().map_err(|e| e.to_string())
    }

    fn hide_window(&self, window_id: u64) -> Result<(), String> {
        let wid =
            window_from_u64(window_id).ok_or_else(|| format!("invalid x11 window id {window_id}"))?;
        if is_protected(&self.conn, wid) {
            return Ok(());
        }
        self.conn
            .send_and_check_request(&x::UnmapWindow { window: wid })
            .map_err(|e| e.to_string())?;
        self.conn.flush().map_err(|e| e.to_string())
    }

    fn make_sticky(&self, _eldrun_pid: u32) -> Result<(), String> {
        Ok(())
    }

    fn cleanup(&self) -> Result<(), String> {
        let mut cleaned_up = self.cleaned_up.lock().unwrap();
        if *cleaned_up {
            return Ok(());
        }
        *cleaned_up = true;
        drop(cleaned_up);

        let parked = self.parked.lock().unwrap();
        for windows in parked.values() {
            for &wid in windows {
                if let Err(e) = self.move_window(wid, ACTIVE_DESKTOP) {
                    eprintln!("{e}");
                }
            }
        }
        drop(parked);

        if self.original_desktop_count < 2 {
            request_desktop_count(
                &self.conn,
                self.screen_num,
                &self.atoms,
                self.original_desktop_count,
            )
            .ok();
        }
        if let Some(cinnamon) = &self.cinnamon {
            cinnamon.restore();
        }
        self.conn.flush().ok();
        Ok(())
    }
}

impl X11Backend {
    fn move_window(&self, wid: Window, desktop: u32) -> Result<(), String> {
        send_wm_desktop(&self.conn, self.screen_num, wid, &self.atoms, desktop)?;
        self.conn.flush().map_err(|e| e.to_string())?;

        for _ in 0..5 {
            if get_window_desktop(&self.conn, wid, &self.atoms) == Some(desktop) {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(30));
        }

        if self.cinnamon.is_some() {
            set_window_desktop_property(&self.conn, wid, &self.atoms, desktop)?;
            self.conn.flush().map_err(|e| e.to_string())?;
            for _ in 0..5 {
                if get_window_desktop(&self.conn, wid, &self.atoms) == Some(desktop) {
                    return Ok(());
                }
                thread::sleep(Duration::from_millis(30));
            }
        }

        let actual = get_window_desktop(&self.conn, wid, &self.atoms);
        Err(format!(
            "workspace move failed: window={} class={:?} title={:?} target={} actual={:?}",
            wid.resource_id(),
            get_wm_class(&self.conn, wid),
            get_window_title(&self.conn, wid, &self.atoms),
            desktop,
            actual,
        ))
    }
}

impl Drop for X11Backend {
    fn drop(&mut self) {
        let _ = self.cleanup();
    }
}

// ── EWMH ClientMessage helpers ─────────────────────────────────────────────

/// Send a _NET_WM_DESKTOP ClientMessage to move `wid` to `desktop`.
/// KWin requires a ClientMessage sent to root (not direct ChangeProperty).
fn send_wm_desktop(
    conn: &Connection,
    screen_num: i32,
    wid: Window,
    atoms: &Atoms,
    desktop: u32,
) -> Result<(), String> {
    let root = root_window(conn, screen_num);
    let event = x::ClientMessageEvent::new(
        wid,
        atoms.net_wm_desktop,
        x::ClientMessageData::Data32([desktop, 2, 0, 0, 0]),
    );
    conn.send_and_check_request(&x::SendEvent {
        propagate: false,
        destination: x::SendEventDest::Window(root),
        event_mask: x::EventMask::SUBSTRUCTURE_REDIRECT | x::EventMask::SUBSTRUCTURE_NOTIFY,
        event: &event,
    })
    .map_err(|e| e.to_string())
}

/// Send a _NET_CURRENT_DESKTOP ClientMessage to switch the active desktop.
fn switch_current_desktop(
    conn: &Connection,
    screen_num: i32,
    atoms: &Atoms,
    desktop: u32,
) -> Result<(), String> {
    let root = root_window(conn, screen_num);
    let event = x::ClientMessageEvent::new(
        root,
        atoms.net_current_desktop,
        x::ClientMessageData::Data32([desktop, x::CURRENT_TIME, 0, 0, 0]),
    );
    conn.send_and_check_request(&x::SendEvent {
        propagate: false,
        destination: x::SendEventDest::Window(root),
        event_mask: x::EventMask::SUBSTRUCTURE_REDIRECT | x::EventMask::SUBSTRUCTURE_NOTIFY,
        event: &event,
    })
    .map_err(|e| e.to_string())
}

/// Request the window manager to change the desktop count via EWMH.
fn request_desktop_count(
    conn: &Connection,
    screen_num: i32,
    atoms: &Atoms,
    count: u32,
) -> Result<(), String> {
    let root = root_window(conn, screen_num);
    let event = x::ClientMessageEvent::new(
        root,
        atoms.net_number_of_desktops,
        x::ClientMessageData::Data32([count, 0, 0, 0, 0]),
    );
    conn.send_and_check_request(&x::SendEvent {
        propagate: false,
        destination: x::SendEventDest::Window(root),
        event_mask: x::EventMask::SUBSTRUCTURE_REDIRECT | x::EventMask::SUBSTRUCTURE_NOTIFY,
        event: &event,
    })
    .map_err(|e| e.to_string())?;
    conn.flush().map_err(|e| e.to_string())
}

fn ensure_desktop_count(
    conn: &Connection,
    screen_num: i32,
    atoms: &Atoms,
    min_count: u32,
) -> Result<(), String> {
    if get_cardinal(conn, screen_num, atoms.net_number_of_desktops).unwrap_or(1) >= min_count {
        return Ok(());
    }

    request_desktop_count(conn, screen_num, atoms, min_count)?;
    for _ in 0..10 {
        if get_cardinal(conn, screen_num, atoms.net_number_of_desktops).unwrap_or(1) >= min_count {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(50));
    }

    let actual = get_cardinal(conn, screen_num, atoms.net_number_of_desktops).unwrap_or(1);
    Err(format!(
        "window manager kept {actual} desktop(s) after requesting {min_count}"
    ))
}

// ── Low-level X helpers ────────────────────────────────────────────────────

fn root_window(conn: &Connection, screen_num: i32) -> Window {
    conn.get_setup()
        .roots()
        .nth(screen_num as usize)
        .unwrap()
        .root()
}

fn window_from_u64(window_id: u64) -> Option<Window> {
    u32::try_from(window_id).ok().map(Window::new)
}

fn intern_atom(conn: &Connection, name: &[u8]) -> Result<Atom, String> {
    conn.wait_for_reply(conn.send_request(&x::InternAtom {
        only_if_exists: false,
        name,
    }))
    .map(|r| r.atom())
    .map_err(|e| format!("InternAtom {}: {e}", String::from_utf8_lossy(name)))
}

fn intern_atoms(conn: &Connection) -> Result<Atoms, String> {
    Ok(Atoms {
        net_current_desktop: intern_atom(conn, b"_NET_CURRENT_DESKTOP")?,
        net_number_of_desktops: intern_atom(conn, b"_NET_NUMBER_OF_DESKTOPS")?,
        net_wm_desktop: intern_atom(conn, b"_NET_WM_DESKTOP")?,
        net_client_list: intern_atom(conn, b"_NET_CLIENT_LIST")?,
        net_wm_name: intern_atom(conn, b"_NET_WM_NAME")?,
        utf8_string: intern_atom(conn, b"UTF8_STRING")?,
    })
}

fn get_cardinal(conn: &Connection, screen_num: i32, atom: Atom) -> Option<u32> {
    let root = root_window(conn, screen_num);
    let cookie = conn.send_request(&x::GetProperty {
        delete: false,
        window: root,
        property: atom,
        r#type: x::ATOM_CARDINAL,
        long_offset: 0,
        long_length: 1,
    });
    conn.wait_for_reply(cookie)
        .ok()
        .and_then(|r| r.value::<u32>().first().copied())
}

fn list_client_windows(
    conn: &Connection,
    screen_num: i32,
    atoms: &Atoms,
) -> Result<Vec<Window>, String> {
    let root = root_window(conn, screen_num);
    let cookie = conn.send_request(&x::GetProperty {
        delete: false,
        window: root,
        property: atoms.net_client_list,
        r#type: x::ATOM_WINDOW,
        long_offset: 0,
        long_length: 1024,
    });
    let reply = conn.wait_for_reply(cookie).map_err(|e| e.to_string())?;
    Ok(reply.value::<Window>().to_vec())
}

fn get_window_desktop(conn: &Connection, wid: Window, atoms: &Atoms) -> Option<u32> {
    let cookie = conn.send_request(&x::GetProperty {
        delete: false,
        window: wid,
        property: atoms.net_wm_desktop,
        r#type: x::ATOM_CARDINAL,
        long_offset: 0,
        long_length: 1,
    });
    conn.wait_for_reply(cookie)
        .ok()
        .and_then(|r| r.value::<u32>().first().copied())
}

fn set_window_desktop_property(
    conn: &Connection,
    wid: Window,
    atoms: &Atoms,
    desktop: u32,
) -> Result<(), String> {
    conn.send_and_check_request(&x::ChangeProperty {
        mode: x::PropMode::Replace,
        window: wid,
        property: atoms.net_wm_desktop,
        r#type: x::ATOM_CARDINAL,
        data: &[desktop],
    })
    .map_err(|e| e.to_string())
}

fn get_wm_class(conn: &Connection, wid: Window) -> Option<String> {
    let cookie = conn.send_request(&x::GetProperty {
        delete: false,
        window: wid,
        property: x::ATOM_WM_CLASS,
        r#type: x::ATOM_STRING,
        long_offset: 0,
        long_length: 64,
    });
    conn.wait_for_reply(cookie)
        .ok()
        .map(|r| String::from_utf8_lossy(r.value::<u8>()).to_string())
}

fn get_window_title(conn: &Connection, wid: Window, atoms: &Atoms) -> Option<String> {
    let cookie = conn.send_request(&x::GetProperty {
        delete: false,
        window: wid,
        property: atoms.net_wm_name,
        r#type: atoms.utf8_string,
        long_offset: 0,
        long_length: 128,
    });
    conn.wait_for_reply(cookie).ok().and_then(|r| {
        let title = String::from_utf8_lossy(r.value::<u8>()).to_string();
        if title.is_empty() {
            None
        } else {
            Some(title)
        }
    })
}

fn is_protected(conn: &Connection, wid: Window) -> bool {
    let class = get_wm_class(conn, wid)
        .unwrap_or_default()
        .to_lowercase();
    PROTECTED_CLASSES
        .iter()
        .any(|p| class.contains(*p))
}

fn get_pid_for_window(conn: &Connection, wid: Window) -> Option<u32> {
    let atom = conn
        .wait_for_reply(conn.send_request(&x::InternAtom {
            only_if_exists: true,
            name: b"_NET_WM_PID",
        }))
        .ok()
        .map(|r| r.atom())?;

    if atom == x::ATOM_NONE {
        return None;
    }

    let cookie = conn.send_request(&x::GetProperty {
        delete: false,
        window: wid,
        property: atom,
        r#type: x::ATOM_CARDINAL,
        long_offset: 0,
        long_length: 1,
    });
    conn.wait_for_reply(cookie)
        .ok()
        .and_then(|r| r.value::<u32>().first().copied())
}

fn is_cinnamon_desktop() -> bool {
    std::env::var("XDG_CURRENT_DESKTOP")
        .unwrap_or_default()
        .to_lowercase()
        .contains("cinnamon")
}

fn configure_cinnamon_workspaces() -> Result<CinnamonWorkspaceState, String> {
    let state = CinnamonWorkspaceState {
        original_num_workspaces: gsettings_get("org.cinnamon.desktop.wm.preferences", "num-workspaces"),
        original_workspace_names: gsettings_get("org.cinnamon.desktop.wm.preferences", "workspace-names"),
        original_dynamic_workspaces: gsettings_get("org.cinnamon.muffin", "dynamic-workspaces"),
    };

    let current_num = state
        .original_num_workspaces
        .as_deref()
        .and_then(|value| value.trim().parse::<u32>().ok())
        .unwrap_or(1);
    if current_num < 2 {
        gsettings_set(
            "org.cinnamon.desktop.wm.preferences",
            "num-workspaces",
            "2",
        )?;
    }

    let names = state
        .original_workspace_names
        .as_deref()
        .map(cinnamon_workspace_names)
        .unwrap_or_default();
    let desired_names = cinnamon_workspace_names_value(&names);
    gsettings_set(
        "org.cinnamon.desktop.wm.preferences",
        "workspace-names",
        &desired_names,
    )?;

    if state.original_dynamic_workspaces.as_deref() == Some("true") {
        gsettings_set("org.cinnamon.muffin", "dynamic-workspaces", "false")?;
    }

    Ok(state)
}

impl CinnamonWorkspaceState {
    fn restore(&self) {
        if let Some(value) = &self.original_workspace_names {
            gsettings_set("org.cinnamon.desktop.wm.preferences", "workspace-names", value).ok();
        }
        if let Some(value) = &self.original_num_workspaces {
            gsettings_set("org.cinnamon.desktop.wm.preferences", "num-workspaces", value).ok();
        }
        if let Some(value) = &self.original_dynamic_workspaces {
            gsettings_set("org.cinnamon.muffin", "dynamic-workspaces", value).ok();
        }
    }
}

fn gsettings_get(schema: &str, key: &str) -> Option<String> {
    let output = Command::new("gsettings")
        .args(["get", schema, key])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn gsettings_set(schema: &str, key: &str, value: &str) -> Result<(), String> {
    let output = Command::new("gsettings")
        .args(["set", schema, key, value])
        .output()
        .map_err(|e| format!("gsettings set {schema} {key}: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("gsettings set {schema} {key}: {}", stderr.trim()))
    }
}

fn cinnamon_workspace_names(value: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut current = String::new();
    let mut in_string = false;
    let mut escaped = false;

    for ch in value.chars() {
        if escaped {
            current.push(ch);
            escaped = false;
            continue;
        }
        match ch {
            '\\' if in_string => escaped = true,
            '\'' if in_string => {
                names.push(current.clone());
                current.clear();
                in_string = false;
            }
            '\'' => in_string = true,
            _ if in_string => current.push(ch),
            _ => {}
        }
    }

    names
}

fn cinnamon_workspace_names_value(original: &[String]) -> String {
    let mut names = original.to_vec();
    if names.is_empty() {
        names.push("Eldrun".to_string());
    }
    if names.len() == 1 {
        names.push("Eldrun-Hidden".to_string());
    }
    names[0] = "Eldrun".to_string();
    names[1] = "Eldrun-Hidden".to_string();
    let values = names
        .into_iter()
        .map(|name| format!("'{}'", name.replace('\\', "\\\\").replace('\'', "\\'")))
        .collect::<Vec<_>>()
        .join(", ");
    format!("[{values}]")
}
