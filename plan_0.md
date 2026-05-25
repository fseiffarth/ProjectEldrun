# ProjectEldrun — Implementation Plan

## What we're building

The same developer workspace idea as AgentCinnamon, but as a **proper standalone desktop application** — no Cinnamon extension required. It runs on any Linux desktop (GNOME, Cinnamon, KDE, XFCE) and launches like a normal app.

Core UX is identical:
- Left panel: running application windows (click to raise)
- Center panel: per-project embedded terminal (`Vte.Terminal`)
- Right panel: master terminal + scrollable project list
- Top bar: "+" button to create a new project

---

## Tech Stack Decision

### Options evaluated

| Stack | Terminal embed | Window tracking | Cross-DE | Code reuse | Effort |
|-------|---------------|-----------------|----------|------------|--------|
| **Python + GTK4 + Libadwaita + VTE-GTK4** | VTE 0.84 (GTK4) | Wnck 3 | Linux | ~80% | Low |
| Python + GTK3 (copy AgentCinnamon) | VTE 0.84 (GTK3) | Wnck 3 | Linux | ~95% | Minimal |
| Tauri + xterm.js (Rust) | xterm.js + portable-pty | xdo / wmctrl | Linux/Mac/Win | 0% | High |
| Electron + node-pty | xterm.js + node-pty | xdo / wmctrl | Linux/Mac/Win | 0% | Medium |

### Recommendation: **Python + GTK4 + Libadwaita + VTE-GTK4**

**Why GTK4 over keeping GTK3:**
- GTK3 is in maintenance mode; GTK4 is the current generation
- Libadwaita gives modern, polished UI for free (Adwaita design system)
- VTE GTK4 build is already on this machine (needs `sudo apt install gir1.2-vte-3.91`)
- GTK4 has better performance and animation support
- Prepares the project for future Flatpak distribution
- Code changes from GTK3 → GTK4 are small (~10-15% of lines touched)

**Why not Tauri/Electron:**
- No embedded terminal widget; would need xterm.js + pty bridging — much more code
- User's existing knowledge is Python/GTK
- Heavier binary (Electron ~200 MB overhead)

**Why not stay on GTK3:**
- GTK4 is available and worth the minor migration effort now vs later

---

## System Requirements

| Requirement | Version | Status |
|-------------|---------|--------|
| Python | 3.10+ | ✅ 3.14.4 installed |
| GTK4 | 4.x | ✅ installed |
| Libadwaita | 1.x | ✅ installed |
| VTE GTK4 | 0.84+ | ✅ installed (`gir1.2-vte-3.91`) |
| python-xlib | 0.33+ | ✅ installed (`python3-xlib`) — replaces Wnck |

---

## Key Changes vs AgentCinnamon

| AgentCinnamon | ProjectEldrun |
|--------------|---------------|
| Requires Cinnamon desktop | Works on any Linux DE |
| Launched by GJS extension | Launched by `.desktop` file or CLI |
| `set_keep_below(True)` desktop replacement | Normal window, optionally fullscreen |
| GTK3 + Vte 2.91 | GTK4 + Vte 3.91 (GTK4 build) |
| No window chrome | Adwaita titlebar (or fullscreen) |
| No installation packaging | `.desktop` launcher + optional systemd user service |
| GJS extension lifecycle (enable/disable) | Standard app lifecycle |

---

## Architecture

```
ProjectEldrun/
├── CLAUDE.md
├── TODO.md
├── plan_0.md
├── eldrun.desktop              # XDG .desktop launcher
│
└── app/
    ├── eldrun.py               # Entry point: CSS/Adwaita init, Adw.Application
    ├── window.py               # EldrunWindow (Adw.ApplicationWindow)
    ├── project_manager.py      # CRUD + JSON persistence (reused from AgentCinnamon)
    └── panels/
        ├── left_panel.py       # Wnck app list (reused, minor GTK4 port)
        ├── center_panel.py     # Gtk.Stack of Vte.Terminal (reused, GTK4 port)
        └── right_panel.py      # Master terminal + project ListBox (reused, GTK4 port)
```

### Data paths
| Path | Content |
|------|---------|
| `~/.local/share/eldrun/projects.json` | Persisted project list (id, name, git_type, directory, created_at) |
| `~/projects/` | Root folder — every project is a subdirectory here |
| `~/projects/<name>/` | Project folder: git repo + scaffold files |
| `~/projects/<name>/CLAUDE.md` | Claude Code context for this project |
| `~/projects/<name>/AGENTS.md` | Agent instructions |
| `~/projects/<name>/.gitignore` | General-purpose gitignore |
| `~/projects/<name>/TODO.md` | Task list |
| `~/projects/<name>/ROADMAP.md` | Versioned roadmap |
| `~/projects/<name>/STATUS.md` | Current status |
| `~/projects/<name>/DOCUMENTATION.md` | Project documentation |

## Center terminal behavior
Each project terminal spawns `claude` (falls back to `bash`) in `~/projects/<name>/`. Clicking a project in the right panel = switching to that project's Claude Code session in the center.

---

## GTK3 → GTK4 Migration Notes

The porting work is mechanical, not architectural:

| GTK3 | GTK4 equivalent |
|------|----------------|
| `gi.require_version("Gtk", "3.0")` | `gi.require_version("Gtk", "4.0")` |
| `gi.require_version("Vte", "2.91")` | `gi.require_version("Vte", "3.91")` |
| `Gtk.Window` | `Adw.ApplicationWindow` (or `Gtk.ApplicationWindow`) |
| `Gtk.main()` | `app.run(sys.argv)` |
| `widget.show_all()` | `window.present()` (children shown by default) |
| `Gtk.CssProvider.load_from_data(bytes)` | `load_from_data(str)` (string, not bytes) |
| `Gtk.StyleContext.add_provider_for_screen(...)` | `Gtk.StyleContext.add_provider_for_display(...)` |
| `Gtk.Paned` pack1/pack2 | `Gtk.Paned.set_start_child()` / `set_end_child()` |
| `box.pack_start(w, True, True, 0)` | `box.append(w)` + `w.set_hexpand(True)` |
| `Gtk.FileChooserButton` | `Gtk.FileDialog` (async) or keep chooser button via compat |
| `Gtk.STOCK_*` buttons | `add_button("Cancel", ...)` with plain strings |
| `Gtk.ScrolledWindow` | unchanged (add `set_child()` instead of `add()`) |
| `Gtk.ListBox.connect("row-selected", ...)` | unchanged |

**Vte API change (GTK4 build):** `spawn_async()` signature is identical; the namespace is `Vte.Terminal` in `gi.repository` with version `"3.91"`.

**Wnck:** No changes needed — `gir1.2-wnck-3.0` works with GTK4 apps.

---

## Launch / Installation

### Run directly
```bash
cd /home/user/Documents/repos/ProjectEldrun/app
python3 eldrun.py
```

### Install .desktop launcher
```bash
cp eldrun.desktop ~/.local/share/applications/
update-desktop-database ~/.local/share/applications/
```

### Optional: autostart with desktop
```bash
mkdir -p ~/.config/autostart
cp eldrun.desktop ~/.config/autostart/
```

### Install VTE GTK4 GIR binding (one-time)
```bash
sudo apt install gir1.2-vte-3.91
```

---

## Implementation Phases

### Phase 1 — Project scaffold + dependencies
- Create directory structure and `__init__.py` files
- Verify `sudo apt install gir1.2-vte-3.91`
- Write entry point `eldrun.py` with `Adw.Application`

### Phase 2 — Main window
- `EldrunWindow(Adw.ApplicationWindow)`
- Top bar with "+" button, 3-column `Gtk.Paned` layout
- Fullscreen toggle (F11)

### Phase 3 — Project Manager
- Copy from AgentCinnamon, change data path to `~/.local/share/eldrun/`

### Phase 4 — Right Panel
- Port `right_panel.py` to GTK4
- Master terminal (Vte.Terminal, GTK4 build)
- Project ListBox

### Phase 5 — Center Panel
- Port `center_panel.py` to GTK4
- `Gtk.Stack` of `Vte.Terminal` widgets, one per project

### Phase 6 — Left Panel
- Port `left_panel.py` to GTK4
- Wnck window tracking (no changes needed to Wnck usage)

### Phase 7 — New project flow + wiring
- `NewProjectDialog` (GTK4: use `Gtk.FileDialog` async or keep chooser)
- Restore persisted projects on startup

### Phase 8 — Packaging
- `eldrun.desktop` launcher file
- CLAUDE.md, DOCUMENTATION.md

---

## Verification Checklist

| Check | How |
|-------|-----|
| App starts | `python3 app/eldrun.py` |
| Terminals accept keyboard input | Type in master + project terminal |
| Project creation | Click "+", fill dialog, shell opens in chosen dir |
| Project persistence | Kill + reopen — projects reloaded |
| App list | Open a browser → appears in left panel |
| Window tracking | Close app → removed from left panel |
| Fullscreen toggle | F11 |
