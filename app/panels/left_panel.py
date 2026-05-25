import json
import os
import pathlib
import shutil
import subprocess

import gi
gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
from gi.repository import Gtk, Gdk, GLib, Pango

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
    def __init__(self, center_panel=None, default_apps_manager=None,
                 on_warm_changed=None):
        super().__init__(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        self.get_style_context().add_class("panel-left")
        self.set_size_request(220, -1)

        self._center = center_panel
        self._dam = default_apps_manager
        self._on_warm_changed = on_warm_changed
        self._disp = None
        self._root = None
        self._atoms: dict[str, int] = {}
        self._rows: dict[str, AppRow] = {}
        self._running: dict[str, dict] = {}
        self._oam: OpenAppsManager | None = None
        self._current_project: dict | None = None
        self._tree_refresh_source: int | None = None
        self._app_cycle_index: int = -1
        self._pending_auto_embed_exe: str | None = None

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

        rc = Gtk.GestureClick()
        rc.set_button(3)
        rc.connect("pressed", self._on_tree_right_click)
        self._file_tree.add_controller(rc)

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
        self._app_cycle_index = -1

        if self._tree_refresh_source is not None:
            GLib.source_remove(self._tree_refresh_source)
            self._tree_refresh_source = None

        if project:
            self._oam = OpenAppsManager(project["directory"])
            self._proj_stack.set_visible_child_name("tree")
            self._rebuild_file_tree()
            self._tree_refresh_source = GLib.timeout_add(5000, self._on_tree_tick)
            GLib.timeout_add(600, self._reopen_missing_apps)
            self._notify_warm()
        else:
            self._oam = None
            self._file_store.clear()
            self._proj_stack.set_visible_child_name("placeholder")

        self._rebuild_app_rows()

    def _notify_warm(self):
        if self._on_warm_changed is None or self._current_project is None:
            return
        warm = bool(self._oam and self._oam.entries)
        self._on_warm_changed(self._current_project["id"], warm)

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
        return False

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
            if entry.name in (".git", "open_apps.json", "project_default_apps.json"):
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
            self._open_file(full_path)

    # ── right-click context menu ──────────────────────────────────────────────

    def _on_tree_right_click(self, gesture, _n, x, y):
        path_info = self._file_tree.get_path_at_pos(int(x), int(y))
        if path_info is None:
            return
        tree_path, _col, _cx, _cy = path_info
        it = self._file_store.get_iter(tree_path)
        is_dir = self._file_store.get_value(it, 3)
        full_path = self._file_store.get_value(it, 2)
        self._file_tree.get_selection().select_path(tree_path)
        self._show_context_menu(x, y, full_path, is_dir)

    def _show_context_menu(self, x, y, path, is_dir):
        popover = Gtk.Popover()
        popover.set_parent(self._file_tree)
        popover.set_has_arrow(False)

        rect = Gdk.Rectangle()
        rect.x = int(x)
        rect.y = int(y)
        rect.width = 1
        rect.height = 1
        popover.set_pointing_to(rect)

        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        box.set_margin_start(4)
        box.set_margin_end(4)
        box.set_margin_top(4)
        box.set_margin_bottom(4)

        def btn(label, cb, css=None):
            b = Gtk.Button(label=label)
            b.add_css_class("flat")
            b.set_halign(Gtk.Align.FILL)
            if css:
                b.add_css_class(css)
            b.connect("clicked", lambda _: (popover.popdown(), cb()))
            return b

        if not is_dir:
            box.append(btn("Open", lambda: self._open_file(path)))
            box.append(btn("Open With…",
                           lambda: self._show_choose_app_dialog(path, force=True)))
            box.append(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL))
        else:
            box.append(btn("Open in File Manager",
                           lambda: self._reveal_in_fm(path, select=False)))
            box.append(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL))

        box.append(btn("Copy Path", lambda: self._copy_path(path)))
        box.append(btn("Reveal in File Manager", lambda: self._reveal_in_fm(path)))
        box.append(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL))
        box.append(btn("Rename…", lambda: self._rename_dialog(path)))
        box.append(btn("Delete", lambda: self._delete_confirm(path), "destructive-action"))

        popover.set_child(box)
        popover.popup()

    # ── file open ─────────────────────────────────────────────────────────────

    def _open_file(self, path: str):
        project_dir = self._current_project.get("directory") if self._current_project else None
        app = None
        if self._dam is not None:
            app = self._dam.get_app_for_file(path, project_dir)
        if app is None:
            self._show_choose_app_dialog(path)
            return
        try:
            subprocess.Popen([app, path], cwd=project_dir or os.path.dirname(path))
            if self._oam is not None:
                self._oam.add_or_update(app, os.path.basename(app), [])
                self._notify_warm()
            self._pending_auto_embed_exe = GLib.find_program_in_path(app) or app
        except OSError:
            self._show_choose_app_dialog(path)

    def _show_choose_app_dialog(self, path: str, force: bool = False):
        win = Gtk.Window()
        win.set_title("Open With")
        win.set_modal(True)
        win.set_default_size(360, 0)
        root = self.get_root()
        if isinstance(root, Gtk.Window):
            win.set_transient_for(root)

        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        box.set_margin_start(16)
        box.set_margin_end(16)
        box.set_margin_top(16)
        box.set_margin_bottom(16)

        lbl = Gtk.Label(label=f"Open  {os.path.basename(path)}")
        lbl.set_xalign(0)
        lbl.add_css_class("heading")
        box.append(lbl)

        entry_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        app_entry = Gtk.Entry()
        app_entry.set_placeholder_text("App command…")
        app_entry.set_hexpand(True)
        entry_row.append(app_entry)

        browse_btn = Gtk.Button(label="Browse…")
        browse_btn.add_css_class("flat")
        entry_row.append(browse_btn)
        box.append(entry_row)

        project_dir = self._current_project.get("directory") if self._current_project else None
        ext = pathlib.Path(path).suffix.lower()

        save_proj = Gtk.CheckButton(label="Remember for this project")
        save_proj.set_sensitive(bool(project_dir and ext))
        box.append(save_proj)

        save_global = Gtk.CheckButton(label="Remember globally (all projects)")
        save_global.set_group(save_proj)
        save_global.set_sensitive(bool(ext))
        box.append(save_global)

        btn_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        btn_row.set_halign(Gtk.Align.END)
        cancel_btn = Gtk.Button(label="Cancel")
        cancel_btn.add_css_class("flat")
        cancel_btn.connect("clicked", lambda _: win.close())
        open_btn = Gtk.Button(label="Open")
        open_btn.add_css_class("suggested-action")
        btn_row.append(cancel_btn)
        btn_row.append(open_btn)
        box.append(btn_row)

        def on_browse(_btn):
            def cb(cmd):
                app_entry.set_text(cmd)
            self._show_app_picker(cb, parent=win)

        browse_btn.connect("clicked", on_browse)

        def on_open(_btn):
            cmd = app_entry.get_text().strip()
            if not cmd:
                return
            if save_proj.get_active() and self._dam and project_dir and ext:
                self._dam.set_project_app(project_dir, ext, cmd)
            elif save_global.get_active() and self._dam and ext:
                self._dam.set_global_app(ext, cmd)
            try:
                subprocess.Popen([cmd, path],
                                 cwd=project_dir or os.path.dirname(path))
                if self._oam is not None:
                    self._oam.add_or_update(cmd, os.path.basename(cmd), [])
                    self._notify_warm()
                self._pending_auto_embed_exe = GLib.find_program_in_path(cmd) or cmd
            except OSError:
                pass
            win.close()

        open_btn.connect("clicked", on_open)
        app_entry.connect("activate", on_open)

        win.set_child(box)
        win.present()

    def _show_app_picker(self, callback, parent=None):
        from default_apps_manager import get_installed_apps
        apps = get_installed_apps()

        win = Gtk.Window()
        win.set_title("Choose Application")
        win.set_modal(True)
        win.set_default_size(360, 440)
        if parent is None:
            root = self.get_root()
            parent = root if isinstance(root, Gtk.Window) else None
        if parent:
            win.set_transient_for(parent)

        vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)

        search = Gtk.SearchEntry()
        search.set_placeholder_text("Search apps…")
        search.set_margin_start(8)
        search.set_margin_end(8)
        search.set_margin_top(8)
        search.set_margin_bottom(4)
        vbox.append(search)

        scrolled = Gtk.ScrolledWindow()
        scrolled.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        scrolled.set_vexpand(True)

        listbox = Gtk.ListBox()
        listbox.set_selection_mode(Gtk.SelectionMode.SINGLE)

        def row_filter(r):
            q = search.get_text().lower().strip()
            if not q:
                return True
            return q in r.app_name.lower() or q in r.app_exec.lower()

        listbox.set_filter_func(row_filter)
        search.connect("search-changed", lambda _: listbox.invalidate_filter())

        for a in apps:
            r = Gtk.ListBoxRow()
            r.app_name = a["name"]
            r.app_exec = a["exec"]
            lbl = Gtk.Label(label=a["name"], xalign=0)
            lbl.set_margin_start(8)
            lbl.set_margin_top(4)
            lbl.set_margin_bottom(4)
            r.set_child(lbl)
            listbox.append(r)

        def on_activated(_lb, r):
            callback(r.app_exec)
            win.close()

        listbox.connect("row-activated", on_activated)
        scrolled.set_child(listbox)
        vbox.append(scrolled)

        win.set_child(vbox)
        win.present()

    # ── context menu helpers ──────────────────────────────────────────────────

    def _copy_path(self, path: str):
        display = Gdk.Display.get_default()
        if display:
            display.get_clipboard().set(path)

    def _reveal_in_fm(self, path: str, select: bool = True):
        target = os.path.dirname(path) if select else path
        try:
            subprocess.Popen(["xdg-open", target])
        except OSError:
            pass

    def _rename_dialog(self, path: str):
        win = Gtk.Window()
        win.set_title("Rename")
        win.set_modal(True)
        win.set_default_size(300, 0)
        root = self.get_root()
        if isinstance(root, Gtk.Window):
            win.set_transient_for(root)

        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        box.set_margin_start(16)
        box.set_margin_end(16)
        box.set_margin_top(16)
        box.set_margin_bottom(16)

        entry = Gtk.Entry()
        entry.set_text(os.path.basename(path))
        box.append(entry)

        btn_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        btn_row.set_halign(Gtk.Align.END)
        cancel = Gtk.Button(label="Cancel")
        cancel.add_css_class("flat")
        cancel.connect("clicked", lambda _: win.close())
        ok = Gtk.Button(label="Rename")
        ok.add_css_class("suggested-action")
        btn_row.append(cancel)
        btn_row.append(ok)
        box.append(btn_row)

        def do_rename(_w):
            new_name = entry.get_text().strip()
            if new_name and new_name != os.path.basename(path):
                new_path = os.path.join(os.path.dirname(path), new_name)
                try:
                    os.rename(path, new_path)
                    self._rebuild_file_tree()
                except OSError:
                    pass
            win.close()

        ok.connect("clicked", do_rename)
        entry.connect("activate", do_rename)

        win.set_child(box)
        win.present()

    def _delete_confirm(self, path: str):
        win = Gtk.Window()
        win.set_title("Delete")
        win.set_modal(True)
        win.set_default_size(300, 0)
        root = self.get_root()
        if isinstance(root, Gtk.Window):
            win.set_transient_for(root)

        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        box.set_margin_start(16)
        box.set_margin_end(16)
        box.set_margin_top(16)
        box.set_margin_bottom(16)

        lbl = Gtk.Label(label=f"Delete  {os.path.basename(path)}?")
        lbl.set_wrap(True)
        lbl.set_xalign(0)
        box.append(lbl)

        btn_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        btn_row.set_halign(Gtk.Align.END)
        cancel = Gtk.Button(label="Cancel")
        cancel.add_css_class("flat")
        cancel.connect("clicked", lambda _: win.close())
        ok = Gtk.Button(label="Delete")
        ok.add_css_class("destructive-action")
        btn_row.append(cancel)
        btn_row.append(ok)
        box.append(btn_row)

        def do_delete(_w):
            try:
                if os.path.isdir(path):
                    shutil.rmtree(path)
                else:
                    os.unlink(path)
                self._rebuild_file_tree()
            except OSError:
                pass
            win.close()

        ok.connect("clicked", do_delete)

        win.set_child(box)
        win.present()

    # ── app-click / app-remove / cycle ────────────────────────────────────────

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
            self._notify_warm()
        row = self._rows.pop(exe, None)
        if row is not None:
            self._listbox.remove(row)

    def cycle_next_app(self):
        running_rows = [row for row in self._rows.values() if row.xid is not None]
        if not running_rows:
            return
        self._app_cycle_index = (self._app_cycle_index + 1) % len(running_rows)
        self._on_app_click(running_rows[self._app_cycle_index])

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

        # Auto-embed: scan all normal windows for the pending exe (skip CWD filter)
        if self._pending_auto_embed_exe is not None:
            for xid in xids:
                try:
                    win = self._disp.create_resource_object("window", xid)
                    if not self._is_normal(win):
                        continue
                    pid = self._window_pid(win)
                    if pid is None or pid == _OWN_PID:
                        continue
                    exe = self._get_process_exe(pid)
                    if exe == self._pending_auto_embed_exe:
                        self._pending_auto_embed_exe = None
                        if self._center is not None and hasattr(self._center, "show_app_window"):
                            GLib.idle_add(lambda x=xid: self._center.show_app_window(x))
                        break
                except Exception:
                    continue

        # Record newly-seen apps in open_apps.json
        if self._oam is not None:
            prev_count = len(self._oam.entries)
            for exe, info in new_running.items():
                self._oam.add_or_update(exe, info["name"], info["args"])
            if len(self._oam.entries) != prev_count:
                self._notify_warm()

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

        for exe in [e for e in list(self._rows) if e not in entry_exes]:
            self._listbox.remove(self._rows.pop(exe))

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
