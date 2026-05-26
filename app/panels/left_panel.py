import json
import os
import pathlib
import shutil
import subprocess

import gi
gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
from gi.repository import Gtk, Gdk, GLib, Pango


def _human_size(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n} {unit}"
        n //= 1024
    return f"{n} TB"


class LeftPanel(Gtk.Box):
    def __init__(self, center_panel=None, default_apps_manager=None):
        super().__init__(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        self.get_style_context().add_class("panel-left")
        self.set_size_request(220, -1)

        self._center = center_panel
        self._dam = default_apps_manager
        self._current_project: dict | None = None
        self._tree_refresh_source: int | None = None
        self._path_colors: dict[str, str] = {}  # abs_path → "#rrggbb"

        self._build_ui()

    # ── UI ────────────────────────────────────────────────────────────────────

    def _build_ui(self):
        proj_header_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=0)
        proj_header_row.set_margin_start(8)
        proj_header_row.set_margin_top(8)
        proj_header_row.set_margin_bottom(4)

        proj_header = Gtk.Label(label="PROJECT")
        proj_header.get_style_context().add_class("panel-header")
        proj_header.set_xalign(0)
        proj_header.set_hexpand(True)
        proj_header_row.append(proj_header)

        self._show_hidden_btn = Gtk.CheckButton()
        self._show_hidden_btn.set_tooltip_text("Show hidden files")
        self._show_hidden_btn.set_valign(Gtk.Align.CENTER)
        self._show_hidden_btn.set_margin_end(2)
        self._show_hidden_btn.connect("toggled", lambda _: self._rebuild_file_tree())
        proj_header_row.append(self._show_hidden_btn)

        self._proj_settings_btn = Gtk.Button()
        self._proj_settings_btn.set_icon_name("preferences-system-symbolic")
        self._proj_settings_btn.add_css_class("flat")
        self._proj_settings_btn.set_tooltip_text("Per-project file type apps")
        self._proj_settings_btn.set_sensitive(False)
        self._proj_settings_btn.set_margin_end(4)
        self._proj_settings_btn.connect("clicked", self._on_proj_settings_clicked)
        proj_header_row.append(self._proj_settings_btn)

        self.append(proj_header_row)

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
        col.set_cell_data_func(text_r, self._color_data_func)
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

        bg_rc = Gtk.GestureClick()
        bg_rc.set_button(3)
        bg_rc.connect("pressed", self._on_tree_bg_right_click)
        tree_scrolled.add_controller(bg_rc)
        self._tree_scrolled = tree_scrolled

        self._proj_stack = Gtk.Stack()
        self._proj_stack.set_transition_type(Gtk.StackTransitionType.NONE)
        self._proj_stack.set_vexpand(True)
        self._proj_stack.add_named(self._proj_placeholder, "placeholder")
        self._proj_stack.add_named(tree_scrolled, "tree")
        self._proj_stack.set_visible_child_name("placeholder")
        self.append(self._proj_stack)

    # ── file-tree colors ──────────────────────────────────────────────────────

    def _colors_file(self) -> pathlib.Path | None:
        if self._current_project is None:
            return None
        return pathlib.Path(self._current_project["directory"]) / ".eldrun_colors.json"

    def _load_colors(self):
        self._path_colors = {}
        cf = self._colors_file()
        if cf is None or not cf.exists():
            return
        project_dir = self._current_project["directory"]
        try:
            data = json.loads(cf.read_text())
            for rel, color in data.items():
                self._path_colors[os.path.join(project_dir, rel)] = color
        except Exception:
            pass

    def _save_colors(self):
        cf = self._colors_file()
        if cf is None or self._current_project is None:
            return
        project_dir = self._current_project["directory"]
        rel_map = {}
        for abs_path, color in self._path_colors.items():
            try:
                rel = os.path.relpath(abs_path, project_dir)
                rel_map[rel] = color
            except ValueError:
                pass
        tmp = str(cf) + ".tmp"
        with open(tmp, "w") as f:
            json.dump(rel_map, f, indent=2, sort_keys=True)
        os.replace(tmp, str(cf))

    def _color_data_func(self, column, cell, model, iter_, data):
        path = model.get_value(iter_, 2)
        color = self._path_colors.get(path)
        if color:
            cell.set_property("foreground", color)
            cell.set_property("foreground-set", True)
        else:
            cell.set_property("foreground-set", False)

    # ── project update ────────────────────────────────────────────────────────

    def update_project(self, project: dict | None):
        self._current_project = project
        self._proj_settings_btn.set_sensitive(project is not None)

        if self._tree_refresh_source is not None:
            GLib.source_remove(self._tree_refresh_source)
            self._tree_refresh_source = None

        if project:
            self._proj_stack.set_visible_child_name("tree")
            self._rebuild_file_tree()
            self._load_colors()
            self._tree_refresh_source = GLib.timeout_add(5000, self._on_tree_tick)
        else:
            self._file_store.clear()
            self._proj_stack.set_visible_child_name("placeholder")

    # ── project file tree ─────────────────────────────────────────────────────

    def _on_tree_tick(self) -> bool:
        self._rebuild_file_tree()
        return True

    def _rebuild_file_tree(self):
        expanded_paths: set[str] = set()
        def _collect(store, path, it, _data):
            if self._file_tree.row_expanded(path):
                expanded_paths.add(store.get_value(it, 2))
        self._file_store.foreach(_collect, None)

        self._file_store.clear()
        if self._current_project is None:
            return
        directory = self._current_project.get("directory", "")
        if not os.path.isdir(directory):
            return
        self._populate_dir(None, directory)

        if expanded_paths:
            def _restore(store, path, it, _data):
                if store.get_value(it, 2) in expanded_paths:
                    self._file_tree.expand_row(path, False)
            self._file_store.foreach(_restore, None)

    def _populate_dir(self, parent_it, directory: str):
        show_hidden = self._show_hidden_btn.get_active()
        try:
            entries = sorted(
                os.scandir(directory),
                key=lambda e: (not e.is_dir(), e.name.lower()),
            )
        except OSError:
            return
        _always_skip = {".git", "open_apps.json", "project.json",
                        "project_default_apps.json", ".eldrun_colors.json"}
        for entry in entries:
            if entry.name in _always_skip:
                continue
            if entry.name.startswith(".") and not show_hidden:
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

        parent_dir = path if is_dir else os.path.dirname(path)

        if not is_dir:
            box.append(btn("Open", lambda: self._open_file(path)))
            box.append(btn("Open With…",
                           lambda: self._show_choose_app_dialog(path, force=True)))
            box.append(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL))
        else:
            box.append(btn("Open in File Manager",
                           lambda: self._reveal_in_fm(path, select=False)))
            box.append(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL))

        box.append(btn("New File…", lambda: self._new_entry_dialog(parent_dir, is_dir=False)))
        box.append(btn("New Folder…", lambda: self._new_entry_dialog(parent_dir, is_dir=True)))
        box.append(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL))
        box.append(btn("Copy Path", lambda: self._copy_path(path)))
        box.append(btn("Reveal in File Manager", lambda: self._reveal_in_fm(path)))
        box.append(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL))
        box.append(btn("Color…", lambda: self._color_pick_dialog(path)))
        if path in self._path_colors:
            box.append(btn("Reset color", lambda: self._reset_color(path)))
        box.append(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL))
        box.append(btn("Rename…", lambda: self._rename_dialog(path)))
        box.append(btn("Delete", lambda: self._delete_confirm(path), "destructive-action"))
        box.append(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL))
        box.append(btn("Properties", lambda: self._show_properties(path)))

        popover.set_child(box)
        popover.popup()

    def _on_tree_bg_right_click(self, gesture, _n, x, y):
        proj_dir = (self._current_project.get("directory")
                    if self._current_project else None)
        if proj_dir is None:
            return
        popover = Gtk.Popover()
        popover.set_parent(self._tree_scrolled)
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

        def btn(label, cb):
            b = Gtk.Button(label=label)
            b.add_css_class("flat")
            b.set_halign(Gtk.Align.FILL)
            b.connect("clicked", lambda _: (popover.popdown(), cb()))
            return b

        box.append(btn("New File…", lambda: self._new_entry_dialog(proj_dir, is_dir=False)))
        box.append(btn("New Folder…", lambda: self._new_entry_dialog(proj_dir, is_dir=True)))

        popover.set_child(box)
        popover.popup()

    # ── file open ─────────────────────────────────────────────────────────────

    def _resolve_default_handler(self, path: str) -> str | None:
        from default_apps_manager import get_mime_for_file
        mime = get_mime_for_file(path)
        if not mime:
            return None
        try:
            desktop = subprocess.check_output(
                ["xdg-mime", "query", "default", mime],
                stderr=subprocess.DEVNULL, text=True,
            ).strip()
            if not desktop:
                return None
        except (OSError, subprocess.CalledProcessError):
            return None
        search_dirs = [
            pathlib.Path.home() / ".local/share/applications",
            pathlib.Path("/usr/share/applications"),
            pathlib.Path("/usr/local/share/applications"),
        ]
        for d in search_dirs:
            df = d / desktop
            if not df.exists():
                continue
            for line in df.read_text(errors="replace").splitlines():
                if line.startswith("Exec="):
                    raw = line[5:].split("%")[0].strip().split()[0]
                    return GLib.find_program_in_path(raw) or raw
        return None

    def _launch_and_track(self, app: str, path: str, project_dir: str | None):
        proc = subprocess.Popen([app, path], cwd=project_dir or os.path.dirname(path))
        if self._center is not None:
            name = os.path.basename(path)
            project_id = self._current_project["id"] if self._current_project else None
            self._center.add_app_tab(name, proc, project_id)

    def _open_file(self, path: str):
        project_dir = self._current_project.get("directory") if self._current_project else None
        app = None
        if self._dam is not None:
            app = self._dam.get_app_for_file(path, project_dir)

        if app is None:
            app = self._resolve_default_handler(path)

        if app is not None:
            try:
                self._launch_and_track(app, path, project_dir)
            except OSError:
                try:
                    subprocess.Popen(["xdg-open", path])
                except OSError:
                    self._show_choose_app_dialog(path)
            return

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
        save_global.set_active(True)
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
            self._show_app_picker(cb, parent=win, for_file=path)

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
                self._launch_and_track(cmd, path, project_dir)
            except OSError:
                pass
            win.close()

        open_btn.connect("clicked", on_open)
        app_entry.connect("activate", on_open)

        win.set_child(box)
        win.present()

    def _show_app_picker(self, callback, parent=None, for_file: str | None = None):
        from default_apps_manager import get_installed_apps, get_mime_for_file
        apps = get_installed_apps()

        suggested_execs: set[str] = set()
        if for_file:
            mime = get_mime_for_file(for_file)
            if mime:
                suggested_execs = {
                    a["exec"] for a in apps
                    if mime in a.get("mime_types", [])
                }

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
            app_name = getattr(r, "app_name", "")
            app_exec = getattr(r, "app_exec", "")
            return q in app_name.lower() or q in app_exec.lower()

        listbox.set_filter_func(row_filter)
        search.connect("search-changed", lambda _: listbox.invalidate_filter())

        def make_app_row(a: dict) -> Gtk.ListBoxRow:
            r = Gtk.ListBoxRow()
            r.app_name = a["name"]
            r.app_exec = a["exec"]
            row_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
            row_box.set_margin_start(8)
            row_box.set_margin_top(4)
            row_box.set_margin_bottom(4)
            icon = Gtk.Image.new_from_icon_name(
                a.get("icon", "application-x-executable-symbolic")
            )
            icon.set_pixel_size(16)
            row_box.append(icon)
            lbl = Gtk.Label(label=a["name"], xalign=0)
            lbl.set_hexpand(True)
            row_box.append(lbl)
            r.set_child(row_box)
            return r

        def add_header(text: str):
            hr = Gtk.ListBoxRow()
            hr.set_selectable(False)
            hr.app_name = ""
            hr.app_exec = ""
            hl = Gtk.Label(label=text, xalign=0)
            hl.add_css_class("dim-label")
            hl.set_margin_start(8)
            hl.set_margin_top(6)
            hl.set_margin_bottom(2)
            hr.set_child(hl)
            listbox.append(hr)

        def add_separator():
            sr = Gtk.ListBoxRow()
            sr.set_selectable(False)
            sr.app_name = ""
            sr.app_exec = ""
            sr.set_child(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL))
            listbox.append(sr)

        if suggested_execs:
            suggested = [a for a in apps if a["exec"] in suggested_execs]
            others = [a for a in apps if a["exec"] not in suggested_execs]
            add_header("Suggested")
            for a in suggested:
                listbox.append(make_app_row(a))
            add_separator()
            add_header("All Applications")
            for a in others:
                listbox.append(make_app_row(a))
        else:
            for a in apps:
                listbox.append(make_app_row(a))

        def on_activated(_lb, r):
            if getattr(r, "app_exec", ""):
                callback(r.app_exec)
                win.close()

        listbox.connect("row-activated", on_activated)
        scrolled.set_child(listbox)
        vbox.append(scrolled)

        win.set_child(vbox)
        win.present()

    # ── context menu helpers ──────────────────────────────────────────────────

    def _color_pick_dialog(self, path: str):
        dialog = Gtk.ColorDialog()
        dialog.set_title("Choose Color")
        initial = Gdk.RGBA()
        current = self._path_colors.get(path)
        if current:
            initial.parse(current)
        else:
            initial.red = initial.green = initial.blue = initial.alpha = 1.0
        root = self.get_root()
        parent = root if isinstance(root, Gtk.Window) else None

        def on_done(dlg, result):
            try:
                rgba = dlg.choose_rgba_finish(result)
                if rgba:
                    color_hex = "#{:02x}{:02x}{:02x}".format(
                        int(rgba.red * 255), int(rgba.green * 255), int(rgba.blue * 255)
                    )
                    self._path_colors[path] = color_hex
                    self._save_colors()
                    self._rebuild_file_tree()
            except Exception:
                pass

        dialog.choose_rgba(parent, initial, None, on_done)

    def _reset_color(self, path: str):
        self._path_colors.pop(path, None)
        self._save_colors()
        self._rebuild_file_tree()

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

    def _new_entry_dialog(self, parent_dir: str, is_dir: bool):
        kind = "Folder" if is_dir else "File"
        win = Gtk.Window()
        win.set_title(f"New {kind}")
        win.set_modal(True)
        win.set_resizable(False)
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
        entry.set_placeholder_text(f"{'folder' if is_dir else 'file'}-name")
        box.append(entry)

        btn_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        btn_row.set_halign(Gtk.Align.END)
        cancel = Gtk.Button(label="Cancel")
        cancel.add_css_class("flat")
        cancel.connect("clicked", lambda _: win.close())
        ok = Gtk.Button(label=f"Create {kind}")
        ok.add_css_class("suggested-action")
        btn_row.append(cancel)
        btn_row.append(ok)
        box.append(btn_row)

        def do_create(_w):
            name = entry.get_text().strip()
            if not name:
                return
            target = os.path.join(parent_dir, name)
            try:
                if is_dir:
                    os.makedirs(target, exist_ok=False)
                else:
                    open(target, "x").close()
                self._rebuild_file_tree()
            except (OSError, FileExistsError):
                pass
            win.close()

        ok.connect("clicked", do_create)
        entry.connect("activate", do_create)

        win.set_child(box)
        win.present()

    def _show_properties(self, path: str):
        import datetime as _dt
        win = Gtk.Window()
        win.set_title("Properties")
        win.set_modal(True)
        win.set_resizable(False)
        win.set_default_size(320, 0)
        root = self.get_root()
        if isinstance(root, Gtk.Window):
            win.set_transient_for(root)

        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        box.set_margin_start(16)
        box.set_margin_end(16)
        box.set_margin_top(16)
        box.set_margin_bottom(16)

        def row(label_text, value_text):
            r = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
            lbl = Gtk.Label(label=label_text, xalign=0)
            lbl.add_css_class("dim-label")
            lbl.set_width_chars(10)
            r.append(lbl)
            val = Gtk.Label(label=value_text, xalign=0)
            val.set_hexpand(True)
            val.set_selectable(True)
            val.set_wrap(True)
            r.append(val)
            return r

        try:
            stat = os.stat(path)
            is_dir = os.path.isdir(path)

            box.append(row("Name", os.path.basename(path)))
            box.append(row("Path", path))
            box.append(row("Type", "Folder" if is_dir else "File"))

            if is_dir:
                try:
                    count = sum(len(files) for _, _, files in os.walk(path))
                    total = sum(
                        os.path.getsize(os.path.join(dp, f))
                        for dp, _, files in os.walk(path)
                        for f in files
                    )
                    box.append(row("Contents", f"{count} files"))
                    box.append(row("Total size", _human_size(total)))
                except OSError:
                    pass
            else:
                box.append(row("Size", _human_size(stat.st_size)))

            mtime = _dt.datetime.fromtimestamp(stat.st_mtime)
            box.append(row("Modified", mtime.strftime("%Y-%m-%d %H:%M:%S")))

            import stat as _stat_mod
            perms = _stat_mod.filemode(stat.st_mode)
            box.append(row("Permissions", perms))
        except OSError as e:
            box.append(Gtk.Label(label=str(e), xalign=0))

        close_btn = Gtk.Button(label="Close")
        close_btn.add_css_class("flat")
        close_btn.set_halign(Gtk.Align.END)
        close_btn.connect("clicked", lambda _: win.close())
        box.append(close_btn)

        win.set_child(box)
        win.present()

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

    # ── per-project file-type settings ───────────────────────────────────────

    def _on_proj_settings_clicked(self, _btn):
        if self._current_project is None:
            return
        project = self._current_project
        project_dir = project.get("directory", "")

        win = Gtk.Window()
        win.set_title(f"File Type Apps — {project['name']}")
        win.set_modal(True)
        win.set_default_size(420, 380)
        root = self.get_root()
        if isinstance(root, Gtk.Window):
            win.set_transient_for(root)

        outer = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        outer.set_margin_start(16)
        outer.set_margin_end(16)
        outer.set_margin_top(16)
        outer.set_margin_bottom(16)

        hdr = Gtk.Label(label=f"Default apps for {project['name']}")
        hdr.add_css_class("heading")
        hdr.set_xalign(0)
        outer.append(hdr)

        desc = Gtk.Label(label="Override default apps for this project's file types.")
        desc.set_xalign(0)
        desc.set_wrap(True)
        desc.add_css_class("dim-label")
        outer.append(desc)

        outer.append(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL))

        scrolled = Gtk.ScrolledWindow()
        scrolled.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        scrolled.set_vexpand(True)
        pft_listbox = Gtk.ListBox()
        pft_listbox.set_selection_mode(Gtk.SelectionMode.NONE)
        scrolled.set_child(pft_listbox)
        outer.append(scrolled)

        def add_row(ext: str, app: str):
            row = Gtk.ListBoxRow()
            box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
            box.set_margin_start(4)
            box.set_margin_end(4)
            box.set_margin_top(4)
            box.set_margin_bottom(4)

            ext_entry = Gtk.Entry()
            ext_entry.set_placeholder_text(".ext")
            ext_entry.set_text(ext)
            ext_entry.set_max_width_chars(8)
            ext_entry.set_width_chars(8)
            box.append(ext_entry)

            app_entry = Gtk.Entry()
            app_entry.set_placeholder_text("app command")
            app_entry.set_text(app)
            app_entry.set_hexpand(True)
            box.append(app_entry)

            def browse(_btn, ae=app_entry):
                def cb(cmd):
                    ae.set_text(cmd)
                self._show_app_picker(cb, parent=win)

            browse_btn = Gtk.Button(label="⋯")
            browse_btn.add_css_class("flat")
            browse_btn.connect("clicked", browse)
            box.append(browse_btn)

            def save_row(_w, ee=ext_entry, ae=app_entry, old_ext=ext):
                new_ext = ee.get_text().strip().lower()
                new_app = ae.get_text().strip()
                if not new_ext or not new_app:
                    return
                if self._dam:
                    if old_ext and old_ext != new_ext:
                        self._dam.remove_project_app(project_dir, old_ext)
                    self._dam.set_project_app(project_dir, new_ext, new_app)

            ext_entry.connect("activate", save_row)
            app_entry.connect("activate", save_row)
            ext_entry.connect("focus-out-event", save_row)
            app_entry.connect("focus-out-event", save_row)

            def rm_row(_btn, r=row, ee=ext_entry):
                ext_val = ee.get_text().strip().lower()
                if ext_val and self._dam:
                    self._dam.remove_project_app(project_dir, ext_val)
                pft_listbox.remove(r)

            rm_btn = Gtk.Button(label="×")
            rm_btn.add_css_class("flat")
            rm_btn.get_style_context().add_class("close-btn")
            rm_btn.connect("clicked", rm_row)
            box.append(rm_btn)

            row.set_child(box)
            pft_listbox.append(row)

        if self._dam:
            pmap = self._dam.get_project_map(project_dir)
            for e, a in sorted(pmap.items()):
                add_row(e, a)

        add_btn = Gtk.Button(label="+ Add Entry")
        add_btn.add_css_class("flat")
        add_btn.set_halign(Gtk.Align.START)
        add_btn.connect("clicked", lambda _: add_row("", ""))
        outer.append(add_btn)

        win.set_child(outer)
        win.present()
