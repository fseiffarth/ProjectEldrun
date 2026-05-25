import json
import os
import pathlib
import subprocess

import gi
gi.require_version("Gtk", "4.0")
from gi.repository import Gtk, GLib, Pango

from Xlib import display as Xdisplay, X
from Xlib.protocol import event as Xevent

_OWN_PID = os.getpid()


class OpenAppsManager:
    """Persists open-file/app associations for a single project."""

    def __init__(self, project_dir: str):
        self._path = pathlib.Path(project_dir) / "open_apps.json"
        self.entries: list[dict] = self._load()

    def _load(self) -> list[dict]:
        if not self._path.exists():
            return []
        try:
            with open(self._path) as f:
                data = json.load(f)
            return data if isinstance(data, list) else []
        except (json.JSONDecodeError, OSError):
            return []

    def _save(self):
        tmp = str(self._path) + ".tmp"
        with open(tmp, "w") as f:
            json.dump(self.entries, f, indent=2)
        os.replace(tmp, str(self._path))

    def add_or_update(self, exe: str, name: str, args: list):
        for e in self.entries:
            if e.get("exe") == exe:
                e["name"] = name
                e["args"] = args
                self._save()
                return
        self.entries.append({"name": name, "exe": exe, "args": args})
        self._save()

    def remove(self, exe: str):
        self.entries = [e for e in self.entries if e.get("exe") != exe]
        self._save()

    def reopen_missing(self, running_exes: set, project_dir: str):
        for entry in self.entries:
            exe = entry.get("exe", "")
            if not exe or exe in running_exes:
                continue
            args = entry.get("args", [])
            try:
                subprocess.Popen([exe] + args, cwd=project_dir)
            except OSError:
                pass


class AppRow(Gtk.ListBoxRow):
    def __init__(self, entry: dict, on_click, on_remove):
        super().__init__()
        self.entry = entry
        self.xid: int | None = None
        self.get_style_context().add_class("app-row")

        box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        box.set_margin_start(8)
        box.set_margin_end(4)
        box.set_margin_top(5)
        box.set_margin_bottom(5)

        self._indicator = Gtk.Label(label="●")
        self._indicator.add_css_class("app-stopped")
        self._indicator.set_valign(Gtk.Align.CENTER)
        box.append(self._indicator)

        icon = Gtk.Image.new_from_icon_name("application-x-executable-symbolic")
        box.append(icon)

        name = entry.get("name") or os.path.basename(entry.get("exe", "app"))
        self._label = Gtk.Label(label=name, xalign=0.0)
        self._label.set_ellipsize(Pango.EllipsizeMode.END)
        self._label.set_max_width_chars(14)
        self._label.set_hexpand(True)
        box.append(self._label)

        rm_btn = Gtk.Button(label="×")
        rm_btn.add_css_class("flat")
        rm_btn.get_style_context().add_class("close-btn")
        rm_btn.connect("clicked", lambda _: on_remove(entry.get("exe", "")))
        box.append(rm_btn)

        self.set_child(box)

        gesture = Gtk.GestureClick()
        gesture.connect("pressed", lambda *_: on_click(self))
        self.add_controller(gesture)

    def set_running(self, running: bool, xid: int | None = None):
        self.xid = xid
        if running:
            self._indicator.remove_css_class("app-stopped")
            self._indicator.add_css_class("app-running")
        else:
            self._indicator.remove_css_class("app-running")
            self._indicator.add_css_class("app-stopped")

    def update_name(self, name: str):
        self._label.set_label(name)


class LeftPanel(Gtk.Box):
    def __init__(self, center_panel=None):
        super().__init__(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        self.get_style_context().add_class("panel-left")
        self.set_size_request(220, -1)

        self._center = center_panel
        self._disp = None
        self._root = None
        self._atoms: dict[str, int] = {}
        self._rows: dict[str, AppRow] = {}       # exe → AppRow
        self._running: dict[str, dict] = {}      # exe → {xid, pid, name, args}
        self._oam: OpenAppsManager | None = None
        self._current_project: dict | None = None
        self._tree_refresh_source: int | None = None

        self._build_ui()
        GLib.idle_add(self._connect_display)

    # ── UI ────────────────────────────────────────────────────────────────────

    def _build_ui(self):
        apps_header = Gtk.Label(label="OPEN APPS")
        apps_header.get_style_context().add_class("panel-header")
        apps_header.set_xalign(0)
        apps_header.set_margin_start(8)
        apps_header.set_margin_top(10)
        apps_header.set_margin_bottom(4)
        self.append(apps_header)

        sep_top = Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL)
        sep_top.set_margin_bottom(4)
        self.append(sep_top)

        apps_scrolled = Gtk.ScrolledWindow()
        apps_scrolled.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        apps_scrolled.set_vexpand(True)

        self._listbox = Gtk.ListBox()
        self._listbox.set_selection_mode(Gtk.SelectionMode.NONE)
        apps_scrolled.set_child(self._listbox)
        self.append(apps_scrolled)

        sep_mid = Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL)
        sep_mid.set_margin_top(4)
        self.append(sep_mid)

        # ── project file tree ──────────────────────────────────────────────────
        proj_header = Gtk.Label(label="PROJECT")
        proj_header.get_style_context().add_class("panel-header")
        proj_header.set_xalign(0)
        proj_header.set_margin_start(8)
        proj_header.set_margin_top(8)
        proj_header.set_margin_bottom(4)
        self.append(proj_header)

        sep_proj = Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL)
        sep_proj.set_margin_bottom(4)
        self.append(sep_proj)

        self._proj_placeholder = Gtk.Label(label="No project selected")
        self._proj_placeholder.add_css_class("dim-label")
        self._proj_placeholder.set_valign(Gtk.Align.CENTER)
        self._proj_placeholder.set_halign(Gtk.Align.CENTER)

        self._file_store = Gtk.TreeStore(str, str, str, bool)  # icon, name, path, is_dir

        self._file_tree = Gtk.TreeView(model=self._file_store)
        self._file_tree.set_headers_visible(False)
        self._file_tree.set_enable_tree_lines(True)

        col = Gtk.TreeViewColumn()
        icon_r = Gtk.CellRendererPixbuf()
        col.pack_start(icon_r, False)
        col.add_attribute(icon_r, "icon-name", 0)
        text_r = Gtk.CellRendererText()
        text_r.set_property("ellipsize", Pango.EllipsizeMode.END)
        col.pack_start(text_r, True)
        col.add_attribute(text_r, "text", 1)
        self._file_tree.append_column(col)
        self._file_tree.connect("row-activated", self._on_tree_row_activated)

        tree_scrolled = Gtk.ScrolledWindow()
        tree_scrolled.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC)
        tree_scrolled.set_vexpand(True)
        tree_scrolled.set_child(self._file_tree)

        self._proj_stack = Gtk.Stack()
        self._proj_stack.set_transition_type(Gtk.StackTransitionType.NONE)
        self._proj_stack.set_vexpand(True)
        self._proj_stack.add_named(self._proj_placeholder, "placeholder")
        self._proj_stack.add_named(tree_scrolled, "tree")
        self._proj_stack.set_visible_child_name("placeholder")
        self.append(self._proj_stack)

    # ── project update ────────────────────────────────────────────────────────

    def update_project(self, project: dict | None):
        self._current_project = project

        if self._tree_refresh_source is not None:
            GLib.source_remove(self._tree_refresh_source)
            self._tree_refresh_source = None

        if project:
            self._oam = OpenAppsManager(project["directory"])
            self._proj_stack.set_visible_child_name("tree")
            self._rebuild_file_tree()
            self._tree_refresh_source = GLib.timeout_add(5000, self._on_tree_tick)
            # Reopen tracked apps that aren't currently running (after EWMH settles)
            GLib.timeout_add(600, self._reopen_missing_apps)
        else:
            self._oam = None
            self._file_store.clear()
            self._proj_stack.set_visible_child_name("placeholder")

        self._rebuild_app_rows()

    def _rebuild_app_rows(self):
        for row in list(self._rows.values()):
            self._listbox.remove(row)
        self._rows.clear()

        if self._oam is None:
            return

        for entry in self._oam.entries:
            exe = entry.get("exe", "")
            if not exe:
                continue
            row = AppRow(entry, self._on_app_click, self._on_app_remove)
            running_info = self._running.get(exe)
            row.set_running(running_info is not None,
                            running_info.get("xid") if running_info else None)
            self._listbox.append(row)
            self._rows[exe] = row

    def _reopen_missing_apps(self) -> bool:
        if self._oam is None or self._current_project is None:
            return False
        self._oam.reopen_missing(
            set(self._running.keys()),
            self._current_project.get("directory", ""),
        )
        return False  # run once

    # ── project file tree ─────────────────────────────────────────────────────

    def _on_tree_tick(self) -> bool:
        self._rebuild_file_tree()
        return True

    def _rebuild_file_tree(self):
        self._file_store.clear()
        if self._current_project is None:
            return
        directory = self._current_project.get("directory", "")
        if not os.path.isdir(directory):
            return
        self._populate_dir(None, directory)

    def _populate_dir(self, parent_it, directory: str):
        try:
            entries = sorted(
                os.scandir(directory),
                key=lambda e: (not e.is_dir(), e.name.lower()),
            )
        except OSError:
            return
        for entry in entries:
            if entry.name in (".git", "open_apps.json"):
                continue
            icon = "folder-symbolic" if entry.is_dir() else "text-x-generic-symbolic"
            it = self._file_store.append(
                parent_it, [icon, entry.name, entry.path, entry.is_dir()]
            )
            if entry.is_dir():
                self._populate_dir(it, entry.path)

    def _on_tree_row_activated(self, tree, path, _column):
        it = self._file_store.get_iter(path)
        is_dir = self._file_store.get_value(it, 3)
        full_path = self._file_store.get_value(it, 2)
        if is_dir:
            if tree.row_expanded(path):
                tree.collapse_row(path)
            else:
                tree.expand_row(path, False)
        else:
            try:
                subprocess.Popen(["xdg-open", full_path])
            except OSError:
                pass

    # ── app-click / app-remove ────────────────────────────────────────────────

    def _on_app_click(self, row: AppRow):
        if row.xid is not None:
            if self._center is not None and hasattr(self._center, "show_app_window"):
                self._center.show_app_window(row.xid)
            else:
                self._raise_window(row.xid)
        else:
            exe = row.entry.get("exe", "")
            args = row.entry.get("args", [])
            cwd = self._current_project.get("directory") if self._current_project else None
            if exe:
                try:
                    subprocess.Popen([exe] + args, cwd=cwd)
                except OSError:
                    pass

    def _on_app_remove(self, exe: str):
        if self._oam is not None:
            self._oam.remove(exe)
        row = self._rows.pop(exe, None)
        if row is not None:
            self._listbox.remove(row)

    # ── X display ─────────────────────────────────────────────────────────────

    def _connect_display(self):
        try:
            self._disp = Xdisplay.Display()
            self._root = self._disp.screen().root
            GLib.timeout_add(2000, self._refresh)
            self._refresh()
        except Exception:
            pass
        return False

    def _atom(self, name: str) -> int:
        if name not in self._atoms:
            self._atoms[name] = self._disp.intern_atom(name)
        return self._atoms[name]

    def _get_prop(self, window, atom_name: str):
        try:
            return window.get_full_property(self._atom(atom_name), X.AnyPropertyType)
        except Exception:
            return None

    # ── window helpers ────────────────────────────────────────────────────────

    def _window_name(self, window) -> str:
        for prop_name in ("_NET_WM_NAME", "WM_NAME"):
            prop = self._get_prop(window, prop_name)
            if prop and prop.value:
                val = prop.value
                if isinstance(val, bytes):
                    return val.rstrip(b"\x00").decode("utf-8", errors="replace")
                return str(val)
        return f"0x{window.id:x}"

    def _window_pid(self, window) -> int | None:
        prop = self._get_prop(window, "_NET_WM_PID")
        if prop and prop.value and hasattr(prop.value, "__getitem__"):
            return prop.value[0]
        return None

    def _is_normal(self, window) -> bool:
        prop = self._get_prop(window, "_NET_WM_WINDOW_TYPE")
        if not prop or not prop.value:
            return False
        return self._atom("_NET_WM_WINDOW_TYPE_NORMAL") in prop.value

    def _is_in_project(self, window) -> bool:
        if self._current_project is None:
            return False
        project_dir = self._current_project.get("directory", "")
        if not project_dir:
            return False
        pid = self._window_pid(window)
        if pid is None:
            return False
        try:
            cwd = os.readlink(f"/proc/{pid}/cwd")
        except OSError:
            return False
        return cwd == project_dir or cwd.startswith(project_dir + "/")

    def _get_process_exe(self, pid: int) -> str:
        try:
            return os.readlink(f"/proc/{pid}/exe")
        except OSError:
            return ""

    def _get_process_args(self, pid: int) -> list:
        try:
            with open(f"/proc/{pid}/cmdline", "rb") as f:
                parts = f.read().rstrip(b"\x00").split(b"\x00")
            return [p.decode("utf-8", errors="replace") for p in parts if p]
        except OSError:
            return []

    def _raise_window(self, xid: int):
        if self._disp is None:
            return
        try:
            win = self._disp.create_resource_object("window", xid)
            ev = Xevent.ClientMessage(
                window=win,
                client_type=self._atom("_NET_ACTIVE_WINDOW"),
                data=(32, [2, X.CurrentTime, 0, 0, 0]),
            )
            mask = X.SubstructureRedirectMask | X.SubstructureNotifyMask
            self._root.send_event(ev, event_mask=mask)
            self._disp.flush()
        except Exception:
            pass

    # ── polling ───────────────────────────────────────────────────────────────

    def _refresh(self) -> bool:
        if self._disp is None:
            return True

        try:
            prop = self._get_prop(self._root, "_NET_CLIENT_LIST")
            xids = list(prop.value) if (prop and prop.value) else []
        except Exception:
            return True

        new_running: dict[str, dict] = {}

        for xid in xids:
            try:
                win = self._disp.create_resource_object("window", xid)
                if not self._is_normal(win):
                    continue
                pid = self._window_pid(win)
                if pid is None or pid == _OWN_PID:
                    continue
                if not self._is_in_project(win):
                    continue
                exe = self._get_process_exe(pid)
                if not exe:
                    continue
                cmdline = self._get_process_args(pid)
                args = cmdline[1:] if len(cmdline) > 1 else []
                name = self._window_name(win) or os.path.basename(exe)
                new_running[exe] = {"xid": xid, "pid": pid, "name": name, "args": args}
            except Exception:
                continue

        self._running = new_running

        # Record newly-seen apps in open_apps.json
        if self._oam is not None:
            for exe, info in new_running.items():
                self._oam.add_or_update(exe, info["name"], info["args"])

        # Sync UI rows with open_apps entries + running state
        self._sync_rows()
        return True

    def _sync_rows(self):
        if self._oam is None:
            for row in list(self._rows.values()):
                self._listbox.remove(row)
            self._rows.clear()
            return

        entry_exes = {e.get("exe", "") for e in self._oam.entries if e.get("exe")}

        # Remove rows for entries that no longer exist in open_apps.json
        for exe in [e for e in list(self._rows) if e not in entry_exes]:
            self._listbox.remove(self._rows.pop(exe))

        # Add new rows / update running state of existing rows
        for entry in self._oam.entries:
            exe = entry.get("exe", "")
            if not exe:
                continue
            running_info = self._running.get(exe)
            is_running = running_info is not None
            xid = running_info.get("xid") if running_info else None

            if exe in self._rows:
                self._rows[exe].set_running(is_running, xid)
                if running_info:
                    self._rows[exe].update_name(running_info["name"])
            else:
                row = AppRow(entry, self._on_app_click, self._on_app_remove)
                row.set_running(is_running, xid)
                self._listbox.append(row)
                self._rows[exe] = row
