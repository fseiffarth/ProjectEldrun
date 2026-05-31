//! X11 workspace backend — EWMH two-desktop parking model.
//!
//! Matches the Python cinnamon_x11.py and kde_kwin.py (X11 path) behavior:
//! - Two desktops: desktop 0 = active project, desktop 1 = parked windows.
//! - Switching projects moves their windows to desktop 0 and parks others on 1.
//! - Eldrun itself is made sticky (_NET_WM_DESKTOP = 0xFFFFFFFF).
//! - Protected WM_CLASS names are never moved.
//! - Cleanup: restore tracked-hidden windows, restore original desktop count.

use std::collections::HashMap;
use std::sync::Mutex;

use xcb::x::{self, Atom, Window};
use xcb::{Connection, Xid};

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

    fn switch_to_project(&self, project_id: &str) -> Result<(), String> {
        let windows =
            list_client_windows(&self.conn, self.screen_num, &self.atoms)?;
        let mut parked = self.parked.lock().unwrap();

        for wid in &windows {
            if is_protected(&self.conn, *wid) {
                continue;
            }
            let current_desk =
                get_window_desktop(&self.conn, *wid, &self.atoms).unwrap_or(0);
            if current_desk != STICKY_DESKTOP {
                set_window_desktop(&self.conn, *wid, &self.atoms, PARKED_DESKTOP).ok();
                parked.entry(project_id.to_string()).or_default().push(*wid);
            }
        }

        set_cardinal(
            &self.conn,
            self.screen_num,
            self.atoms.net_current_desktop,
            ACTIVE_DESKTOP,
        )?;
        self.conn.flush().ok();
        Ok(())
    }

    fn make_sticky(&self, eldrun_pid: u32) -> Result<(), String> {
        let windows =
            list_client_windows(&self.conn, self.screen_num, &self.atoms)?;
        for wid in windows {
            if get_pid_for_window(&self.conn, wid, self.screen_num)
                .map_or(false, |p| p == eldrun_pid)
            {
                set_window_desktop(&self.conn, wid, &self.atoms, STICKY_DESKTOP).ok();
            }
        }
        self.conn.flush().ok();
        Ok(())
    }

    fn cleanup(&self) -> Result<(), String> {
        let parked = self.parked.lock().unwrap();
        for windows in parked.values() {
            for &wid in windows {
                set_window_desktop(&self.conn, wid, &self.atoms, ACTIVE_DESKTOP).ok();
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

// ── Helpers ────────────────────────────────────────────────────────────────

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

fn set_window_desktop(
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

fn is_protected(conn: &Connection, wid: Window) -> bool {
    let class = get_wm_class(conn, wid)
        .unwrap_or_default()
        .to_lowercase();
    PROTECTED_CLASSES
        .iter()
        .any(|p| class.contains(*p))
}

fn get_pid_for_window(
    conn: &Connection,
    wid: Window,
    screen_num: i32,
) -> Option<u32> {
    // Intern _NET_WM_PID on demand (could be cached but this is rarely called).
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
