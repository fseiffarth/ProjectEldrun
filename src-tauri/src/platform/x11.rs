//! X11 workspace backend — EWMH two-desktop parking model.
//!
//! Matches the Python kde_kwin.py (X11 path) behavior:
//! - Two desktops: desktop 0 = active project, desktop 1 = parked windows.
//! - Switching projects moves old project windows to desktop 1 and restores
//!   new project windows from desktop 1 to desktop 0.
//! - Eldrun itself is made sticky (_NET_WM_DESKTOP = 0xFFFFFFFF).
//! - Protected WM_CLASS names are never moved; any that drift to desktop 1
//!   are rescued back to desktop 0 on each switch.
//! - All window management uses ClientMessage events (proper EWMH), not
//!   ChangeProperty, so KWin intercepts and honors the requests.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use xcb::x::{self, Atom, Window};
use xcb::Connection;

use super::{WorkspaceBackend, WorkspaceInfo};

// ── Constants ─────────────────────────────────────────────────────────────

const STICKY_DESKTOP: u32 = 0xFFFF_FFFF;
const ACTIVE_DESKTOP: u32 = 0;
const PARKED_DESKTOP: u32 = 1;

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
}

struct Atoms {
    net_current_desktop: Atom,
    net_number_of_desktops: Atom,
    net_wm_desktop: Atom,
    net_client_list: Atom,
}

impl X11Backend {
    pub fn try_new() -> Result<Self, String> {
        let (conn, screen_num) =
            xcb::Connection::connect(None).map_err(|e| format!("xcb connect: {e}"))?;

        let atoms = intern_atoms(&conn)?;
        let original_desktop_count =
            get_cardinal(&conn, screen_num, atoms.net_number_of_desktops).unwrap_or(1);

        if original_desktop_count < 2 {
            set_cardinal(&conn, screen_num, atoms.net_number_of_desktops, 2)?;
        }

        Ok(X11Backend {
            conn,
            screen_num,
            atoms,
            parked: Mutex::new(HashMap::new()),
            original_desktop_count,
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
        project_id: &str,
        previous_project_id: Option<&str>,
    ) -> Result<(), String> {
        let all_windows = list_client_windows(&self.conn, self.screen_num, &self.atoms)?;
        let mut parked = self.parked.lock().unwrap();

        // Build per-desktop window sets from current state.
        let mut ws0_all = Vec::new();
        let mut ws1_set = HashSet::new();
        for &wid in &all_windows {
            match get_window_desktop(&self.conn, wid, &self.atoms) {
                Some(d) if d == ACTIVE_DESKTOP => ws0_all.push(wid),
                Some(d) if d == PARKED_DESKTOP => { ws1_set.insert(wid); }
                _ => {}  // sticky or other desktops — leave untouched
            }
        }

        // Filter desktop-0 windows: skip protected (includes Eldrun by class,
        // plus Eldrun is sticky so its desktop is 0xFFFFFFFF anyway).
        let ws0_moveable: Vec<Window> = ws0_all
            .into_iter()
            .filter(|&wid| !is_protected(&self.conn, wid))
            .collect();

        // Park old project's windows on desktop 1.
        for &wid in &ws0_moveable {
            send_wm_desktop(&self.conn, self.screen_num, wid, &self.atoms, PARKED_DESKTOP).ok();
        }
        if let Some(prev_id) = previous_project_id {
            parked.insert(prev_id.to_string(), ws0_moveable.clone());
        }

        // Build the logical desktop-1 set: existing ws1 plus what we just moved.
        let mut effective_ws1 = ws1_set;
        for wid in ws0_moveable {
            effective_ws1.insert(wid);
        }

        // Rescue any protected windows that drifted to desktop 1.
        let ws1_snapshot: Vec<Window> = effective_ws1.iter().copied().collect();
        for wid in ws1_snapshot {
            if is_protected(&self.conn, wid) {
                send_wm_desktop(&self.conn, self.screen_num, wid, &self.atoms, ACTIVE_DESKTOP)
                    .ok();
                effective_ws1.remove(&wid);
            }
        }

        // Restore new project's tracked windows from desktop 1 to desktop 0.
        if let Some(project_wins) = parked.get(project_id) {
            for &wid in project_wins {
                if effective_ws1.contains(&wid) {
                    send_wm_desktop(
                        &self.conn,
                        self.screen_num,
                        wid,
                        &self.atoms,
                        ACTIVE_DESKTOP,
                    )
                    .ok();
                }
            }
        }

        // Switch active virtual desktop to 0.
        switch_current_desktop(&self.conn, self.screen_num, &self.atoms, ACTIVE_DESKTOP)?;
        self.conn.flush().ok();
        Ok(())
    }

    fn make_sticky(&self, eldrun_pid: u32) -> Result<(), String> {
        let windows =
            list_client_windows(&self.conn, self.screen_num, &self.atoms)?;
        for wid in windows {
            if get_pid_for_window(&self.conn, wid)
                .map_or(false, |p| p == eldrun_pid)
            {
                send_wm_desktop(&self.conn, self.screen_num, wid, &self.atoms, STICKY_DESKTOP)
                    .ok();
            }
        }
        self.conn.flush().ok();
        Ok(())
    }

    fn cleanup(&self) -> Result<(), String> {
        let parked = self.parked.lock().unwrap();
        for windows in parked.values() {
            for &wid in windows {
                send_wm_desktop(&self.conn, self.screen_num, wid, &self.atoms, ACTIVE_DESKTOP)
                    .ok();
            }
        }
        if self.original_desktop_count < 2 {
            set_cardinal(
                &self.conn,
                self.screen_num,
                self.atoms.net_number_of_desktops,
                self.original_desktop_count,
            )
            .ok();
        }
        self.conn.flush().ok();
        Ok(())
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

// ── Low-level X helpers ────────────────────────────────────────────────────

fn root_window(conn: &Connection, screen_num: i32) -> Window {
    conn.get_setup()
        .roots()
        .nth(screen_num as usize)
        .unwrap()
        .root()
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

fn set_cardinal(conn: &Connection, screen_num: i32, atom: Atom, value: u32) -> Result<(), String> {
    let root = root_window(conn, screen_num);
    conn.send_and_check_request(&x::ChangeProperty {
        mode: x::PropMode::Replace,
        window: root,
        property: atom,
        r#type: x::ATOM_CARDINAL,
        data: &[value],
    })
    .map_err(|e| e.to_string())
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
