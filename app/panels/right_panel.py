import json
import os
import pathlib
import shutil
import subprocess

import gi
gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
from gi.repository import Gtk, Gdk, GLib, Pango

from launch_helpers import launch_on_other_monitor


# Historical filename: this module now exports the FileTreePanel, not the old
# project-list right panel.


def _lookup_desktop_icon(app_exe: str) -> str | None:
    """Return the icon name from the .desktop file matching app_exe."""
    app_name = os.path.basename(app_exe)
    search_dirs = [
        pathlib.Path.home() / ".local/share/applications",
        pathlib.Path("/usr/share/applications"),
        pathlib.Path("/usr/local/share/applications"),
    ]
    for d in search_dirs:
        try:
            for df in d.glob("*.desktop"):
                try:
                    lines = df.read_text(errors="replace").splitlines()
                    if not any(
                        ln.startswith("Exec=") and app_name in ln for ln in lines
                    ):
                        continue
                    for ln in lines:
                        if ln.startswith("Icon="):
                            return ln[5:].strip()
                except Exception:
                    continue
        except Exception:
            continue
    return None


def _get_desktop_icon(app_exe: str) -> str:
    """Return the icon name from the .desktop file matching app_exe, or a fallback."""
    icon = _lookup_desktop_icon(app_exe)
    if icon:
        return icon
    return "application-x-executable-symbolic"


_FOLDER_ICON = "folder-symbolic"
_FILE_ICON = "text-x-generic-symbolic"

_STANDARD_PROJECT_FILES = frozenset({
    "AGENTS.md", "CLAUDE.md", "GEMINI.md", "TODO.md", "ROADMAP.md",
    "STATUS.md", "DOCUMENTATION.md", ".gitignore", ".claude",
})

_TREE_COLORS = {
    "dark":        {"directory": "#c9d1d9", "file": "#8b949e"},
    "light":       {"directory": "#24292f",  "file": "#57606a"},
    "fancy_dark":  {"directory": "#d8e2f3",  "file": "#8ca3c7"},
    "fancy_light": {"directory": "#2f3a4f",  "file": "#5b6f91"},
}
_LEGACY_THEME_VALUES = {"fancy": "fancy_dark"}


def _normalize_theme(scheme) -> str:
    if isinstance(scheme, bool):
        return "dark" if scheme else "light"
    scheme = _LEGACY_THEME_VALUES.get(scheme, scheme)
    if scheme in _TREE_COLORS:
        return scheme
    return "dark"


def _human_size(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n} {unit}"
        n //= 1024
    return f"{n} TB"


class FileTreePanel(Gtk.Box):
    def __init__(self, center_panel=None, default_apps_manager=None,
                 settings_manager=None, on_context_menu_open_changed=None,
                 ollama_client=None, on_file_opened=None,
                 project_manager=None):
        super().__init__(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        self.get_style_context().add_class("panel-right")
        self.set_size_request(220, -1)

        self._center = center_panel
        self._dam = default_apps_manager
        self._on_context_menu_open_changed = on_context_menu_open_changed
        self._ollama_client = ollama_client
        self._on_file_opened = on_file_opened  # callback(project_id, exec_cmd, file_path)
        self._pm = project_manager
        self._color_scheme = _normalize_theme(
            settings_manager.get("color_scheme") if settings_manager else "dark"
        )
        self._current_project: dict | None = None
        self._tree_refresh_source: int | None = None
        self._hover_scroll_source: int | None = None
        self._hover_scroll_path: Gtk.TreePath | None = None
        self._path_colors: dict[str, str] = {}  # abs_path → "#rrggbb"
        self._default_icon_cache: dict[tuple[str, str], str] = {}
        self._context_popover: Gtk.Popover | None = None
        self._context_menu_open = False

        self._build_ui()

    # ── UI ────────────────────────────────────────────────────────────────────

    def _build_ui(self):
        proj_header_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=0)
        proj_header_row.add_css_class("right-panel-header-row")
        proj_header_row.set_margin_start(8)
        proj_header_row.set_margin_top(8)
        proj_header_row.set_margin_bottom(4)

        proj_header = Gtk.Label(label="PROJECT")
        proj_header.get_style_context().add_class("panel-header")
        proj_header.set_xalign(0)
        proj_header.set_hexpand(True)
        proj_header_row.append(proj_header)

        self._show_hidden = False
        self._show_standard_files = False

        self._proj_settings_btn = Gtk.Button()
        self._proj_settings_btn.set_icon_name("preferences-system-symbolic")
        self._proj_settings_btn.add_css_class("flat")
        self._proj_settings_btn.set_tooltip_text("Project settings")
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
        self._file_tree.add_css_class("right-file-tree")
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

        hover_motion = Gtk.EventControllerMotion()
        hover_motion.connect("motion", self._on_tree_hover_motion)
        hover_motion.connect("leave", self._on_tree_hover_leave)
        self._file_tree.add_controller(hover_motion)

        tree_scrolled = Gtk.ScrolledWindow()
        tree_scrolled.add_css_class("right-panel-surface")
        tree_scrolled.add_css_class("right-tree-surface")
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

        # ── open apps section (G4.4) ─────────────────────────────────────────
        sep_apps = Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL)
        sep_apps.set_margin_top(4)

        open_apps_hdr = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=0)
        open_apps_hdr.set_margin_start(8)
        open_apps_hdr.set_margin_top(6)
        open_apps_hdr.set_margin_bottom(4)
        open_apps_hdr.set_margin_end(8)

        open_apps_lbl = Gtk.Label(label="OPEN APPS")
        open_apps_lbl.get_style_context().add_class("panel-header")
        open_apps_lbl.set_xalign(0)
        open_apps_lbl.set_hexpand(True)
        open_apps_hdr.append(open_apps_lbl)

        self._open_apps_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
        self._open_apps_box.set_margin_start(8)
        self._open_apps_box.set_margin_end(8)
        self._open_apps_box.set_margin_bottom(8)

        self._open_apps_section = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        self._open_apps_section.append(sep_apps)
        self._open_apps_section.append(open_apps_hdr)
        self._open_apps_section.append(self._open_apps_box)
        self._open_apps_section.set_visible(False)
        self.append(self._open_apps_section)

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
        if not color:
            colors = _TREE_COLORS[self._color_scheme]
            is_dir = model.get_value(iter_, 3)
            color = colors["directory"] if is_dir else colors["file"]
        cell.set_property("foreground", color)
        cell.set_property("foreground-set", True)

    def apply_theme(self, scheme):
        self._color_scheme = _normalize_theme(scheme)
        self._file_tree.queue_draw()

    # ── long filename hover reveal ───────────────────────────────────────────

    def _on_tree_hover_motion(self, _ctrl, x, y):
        hit = self._file_tree.get_path_at_pos(int(x), int(y))
        path = hit[0] if hit else None
        if path is None:
            self._reset_tree_hover_scroll()
            return
        if (self._hover_scroll_path is not None
                and path.compare(self._hover_scroll_path) == 0):
            return

        self._reset_tree_hover_scroll(clear_path=False)
        self._hover_scroll_path = path.copy()
        self._hover_scroll_source = GLib.timeout_add(
            350, self._scroll_hovered_tree_row_right
        )

    def _on_tree_hover_leave(self, _ctrl):
        self._reset_tree_hover_scroll()

    def _reset_tree_hover_scroll(self, clear_path: bool = True):
        if self._hover_scroll_source is not None:
            GLib.source_remove(self._hover_scroll_source)
            self._hover_scroll_source = None
        if clear_path:
            self._hover_scroll_path = None
        try:
            self._tree_scrolled.get_hadjustment().set_value(0)
        except Exception:
            pass

    def _scroll_hovered_tree_row_right(self) -> bool:
        self._hover_scroll_source = None
        path = self._hover_scroll_path
        if path is None:
            return False
        try:
            it = self._file_store.get_iter(path)
            name = self._file_store.get_value(it, 1)
        except Exception:
            return False
        if not self._tree_row_needs_horizontal_scroll(path, name):
            return False
        hadj = self._tree_scrolled.get_hadjustment()
        max_scroll = max(0, hadj.get_upper() - hadj.get_page_size())
        if max_scroll > 0:
            hadj.set_value(max_scroll)
        return False

    def _tree_row_needs_horizontal_scroll(self, path, name: str) -> bool:
        layout = self._file_tree.create_pango_layout(name)
        text_width, _height = layout.get_pixel_size()
        visible_width = self._tree_scrolled.get_hadjustment().get_page_size()
        if visible_width <= 0:
            visible_width = self._tree_scrolled.get_width()
        depth = path.get_depth() if hasattr(path, "get_depth") else 1
        row_indent = max(0, depth - 1) * 18
        icon_and_padding = 46
        return row_indent + icon_and_padding + text_width > visible_width

    def _clear_default_icon_cache(self):
        self._default_icon_cache = {}

    def _refresh_default_app_icons(self):
        self._clear_default_icon_cache()
        if self._current_project is not None:
            self._rebuild_file_tree()

    def _icon_for_tree_entry(self, path: str, is_dir: bool) -> str:
        if is_dir:
            return _FOLDER_ICON
        return self._default_icon_for_file(path)

    def _default_icon_for_file(self, path: str) -> str:
        ext = pathlib.Path(path).suffix.lower()
        if not ext or self._dam is None or self._current_project is None:
            return _FILE_ICON

        project_dir = self._current_project.get("directory", "")
        cache = getattr(self, "_default_icon_cache", None)
        if cache is None:
            self._default_icon_cache = {}
            cache = self._default_icon_cache
        key = (project_dir, ext)
        if key in cache:
            return cache[key]

        app = self._dam.get_app_for_file(path, project_dir)
        icon = (_lookup_desktop_icon(app) if app else None) or _FILE_ICON
        cache[key] = icon
        return icon

    # ── open apps (G4.4) ─────────────────────────────────────────────────────

    @staticmethod
    def _is_pid_alive(pid: int) -> bool:
        """Return True if the process with the given PID is still running."""
        try:
            os.kill(pid, 0)
            return True
        except (OSError, ProcessLookupError):
            return False

    def _rebuild_open_apps(self):
        """Rebuild the open-apps list from the current project's open_apps metadata."""
        child = self._open_apps_box.get_first_child()
        while child:
            nxt = child.get_next_sibling()
            self._open_apps_box.remove(child)
            child = nxt

        if self._current_project is None:
            self._open_apps_section.set_visible(False)
            return

        apps = self._current_project.get("open_apps", [])
        if not isinstance(apps, list):
            apps = []

        visible = [
            a for a in apps[:10]
            if isinstance(a, dict) and a.get("exec") and a.get("file")
        ]
        if not visible:
            self._open_apps_section.set_visible(False)
            return

        self._open_apps_section.set_visible(True)
        for entry in visible:
            exec_cmd = entry["exec"]
            file_path = entry["file"]
            pid = entry.get("pid")
            is_running = self._is_pid_alive(pid) if pid else False

            row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=4)
            row.set_margin_top(2)
            row.set_margin_start(2)
            row.set_margin_end(2)

            status_lbl = Gtk.Label(label="●" if is_running else "○")
            status_lbl.set_valign(Gtk.Align.CENTER)
            status_lbl.add_css_class("status-online" if is_running else "status-offline")
            row.append(status_lbl)

            name_lbl = Gtk.Label(label=os.path.basename(file_path))
            name_lbl.set_xalign(0)
            name_lbl.set_hexpand(True)
            name_lbl.set_ellipsize(Pango.EllipsizeMode.END)
            name_lbl.set_max_width_chars(14)
            name_lbl.set_valign(Gtk.Align.CENTER)
            name_lbl.set_tooltip_text(
                f"{file_path}\n(via {os.path.basename(exec_cmd)})"
            )
            row.append(name_lbl)

            if not is_running and os.path.exists(file_path):
                btn = Gtk.Button(label="↺")
                btn.add_css_class("flat")
                btn.set_valign(Gtk.Align.CENTER)
                btn.set_tooltip_text("Relaunch")
                btn.connect(
                    "clicked",
                    lambda _, e=exec_cmd, f=file_path: self._relaunch_app(e, f),
                )
                row.append(btn)

            self._open_apps_box.append(row)

    def _relaunch_app(self, exec_cmd: str, file_path: str):
        """Relaunch a stale open-app entry and update its recorded PID."""
        project_id = self._current_project.get("id") if self._current_project else None
        project_dir = self._current_project.get("directory") if self._current_project else None
        launched = self._launch_and_track(
            [exec_cmd, file_path], project_dir or os.path.dirname(file_path)
        )
        if launched is not None and self._on_file_opened and project_id:
            self._on_file_opened(
                project_id, exec_cmd, file_path, getattr(launched, "pid", None)
            )
        self._rebuild_open_apps()

    # ── project update ────────────────────────────────────────────────────────

    def update_project(self, project: dict | None):
        self._reset_tree_hover_scroll()
        self._clear_default_icon_cache()
        self._current_project = project
        self._proj_settings_btn.set_sensitive(project is not None)

        if self._tree_refresh_source is not None:
            GLib.source_remove(self._tree_refresh_source)
            self._tree_refresh_source = None

        if project:
            self._proj_stack.set_visible_child_name("tree")
            self._rebuild_file_tree()
            self._load_colors()
            self._rebuild_open_apps()
            self._tree_refresh_source = GLib.timeout_add(5000, self._on_tree_tick)
        else:
            self._file_store.clear()
            self._proj_stack.set_visible_child_name("placeholder")
            self._rebuild_open_apps()

    # ── project file tree ─────────────────────────────────────────────────────

    def _on_tree_tick(self) -> bool:
        self._rebuild_file_tree()
        self._rebuild_open_apps()
        return True

    def _rebuild_file_tree(self):
        self._reset_tree_hover_scroll()
        expanded_paths: set[str] = set()
        def _collect(store, path, it, _data):
            if self._file_tree.row_expanded(path):
                expanded_paths.add(store.get_value(it, 2))
        self._file_store.foreach(_collect, None)

        # Detach model before clearing to suppress per-row view redraws.
        self._file_tree.set_model(None)
        self._file_store.clear()
        if self._current_project is None:
            self._file_tree.set_model(self._file_store)
            return
        directory = self._current_project.get("directory", "")
        if not os.path.isdir(directory):
            self._file_tree.set_model(self._file_store)
            return
        self._populate_dir(None, directory, at_root=True)
        self._file_tree.set_model(self._file_store)

        if expanded_paths:
            def _restore(store, path, it, _data):
                if store.get_value(it, 2) in expanded_paths:
                    self._file_tree.expand_row(path, False)
            self._file_store.foreach(_restore, None)

    def _populate_dir(self, parent_it, directory: str, at_root: bool = False):
        show_hidden = self._show_hidden
        show_standard = self._show_standard_files
        try:
            entries = sorted(
                os.scandir(directory),
                key=lambda e: (not e.is_dir(), pathlib.Path(e.name).suffix.lower(), e.name.lower()),
            )
        except OSError:
            return
        _always_skip = {".git", "open_apps.json", "project.json",
                        "project_default_apps.json", ".eldrun_colors.json"}
        for entry in entries:
            if entry.name in _always_skip:
                continue
            if at_root and not show_standard and entry.name in _STANDARD_PROJECT_FILES:
                continue
            if entry.name.startswith(".") and not show_hidden:
                continue
            is_dir = entry.is_dir()
            icon = self._icon_for_tree_entry(entry.path, is_dir)
            it = self._file_store.append(
                parent_it, [icon, entry.name, entry.path, is_dir]
            )
            if is_dir:
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

    def _set_context_menu_open(self, is_open: bool):
        if self._context_menu_open == is_open:
            return
        self._context_menu_open = is_open
        if self._on_context_menu_open_changed:
            self._on_context_menu_open_changed(is_open)

    def _on_context_popover_closed(self, popover):
        if self._context_popover is not popover:
            return
        self._context_popover = None
        self._set_context_menu_open(False)

    def _new_context_popover(self, parent, x, y):
        if self._context_popover is not None:
            previous = self._context_popover
            self._context_popover = None
            previous.popdown()

        popover = Gtk.Popover()
        popover.set_parent(parent)
        popover.set_has_arrow(False)

        rect = Gdk.Rectangle()
        rect.x = int(x)
        rect.y = int(y)
        rect.width = 1
        rect.height = 1
        popover.set_pointing_to(rect)

        popover.connect("closed", self._on_context_popover_closed)
        self._context_popover = popover
        self._set_context_menu_open(True)
        return popover

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
        popover = self._new_context_popover(self._file_tree, x, y)

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

        if self._ollama_client is not None:
            box.append(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL))
            box.append(btn("Ask Ollama…", lambda: self._ask_ollama_about(path)))

        popover.set_child(box)
        popover.popup()

    def _on_tree_bg_right_click(self, gesture, _n, x, y):
        proj_dir = (self._current_project.get("directory")
                    if self._current_project else None)
        if proj_dir is None:
            return
        popover = self._new_context_popover(self._tree_scrolled, x, y)

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

    def _launch_and_track(self, argv: list[str], cwd: str | None):
        root = self.get_root()
        anchor_window = root if isinstance(root, Gtk.Window) else None
        return launch_on_other_monitor(argv, cwd=cwd, anchor_window=anchor_window)

    def _open_file(self, path: str):
        project_dir = self._current_project.get("directory") if self._current_project else None
        project_id = self._current_project.get("id") if self._current_project else None
        app = None
        if self._dam is not None:
            app = self._dam.get_app_for_file(path, project_dir)

        if app is None:
            app = self._resolve_default_handler(path)

        if app is not None:
            launched = self._launch_and_track([app, path], project_dir or os.path.dirname(path))
            if launched is not None:
                if self._on_file_opened and project_id:
                    self._on_file_opened(
                        project_id, app, path, getattr(launched, "pid", None)
                    )
                return
            launched = self._launch_and_track(["xdg-open", path], None)
            if launched is not None:
                if self._on_file_opened and project_id:
                    self._on_file_opened(
                        project_id, "xdg-open", path, getattr(launched, "pid", None)
                    )
                return
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
                self._refresh_default_app_icons()
            elif save_global.get_active() and self._dam and ext:
                self._dam.set_global_app(ext, cmd)
                self._refresh_default_app_icons()
            launched = self._launch_and_track([cmd, path], project_dir or os.path.dirname(path))
            if launched is not None and self._on_file_opened and self._current_project:
                p_id = self._current_project.get("id")
                if p_id:
                    self._on_file_opened(
                        p_id, cmd, path, getattr(launched, "pid", None)
                    )
            win.close()

        open_btn.connect("clicked", on_open)
        app_entry.connect("activate", on_open)

        win.set_child(box)
        win.present()

    def _show_app_picker(self, callback, parent=None, for_file: str | None = None):
        if parent is None:
            root = self.get_root()
            parent = root if isinstance(root, Gtk.Window) else None
        from app_picker import show_app_picker
        show_app_picker(callback, parent=parent, for_file=for_file)

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
        self._launch_and_track(["xdg-open", target], None)

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

    def _ask_ollama_about(self, path: str):
        if self._ollama_client is None:
            return
        filename = os.path.basename(path)
        root = self.get_root()
        model = self._current_project.get("ollama_model") if self._current_project else None
        from ollama_dialog import OllamaDialog
        dlg = OllamaDialog(root, self._ollama_client,
                           initial_prompt=f"About {filename}: ",
                           model=model or None)
        dlg.present()

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

        hdr = Gtk.Label(label=project["name"])
        hdr.add_css_class("heading")
        hdr.set_xalign(0)
        outer.append(hdr)

        outer.append(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL))

        # Show standard project files toggle
        standard_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        standard_lbl = Gtk.Label(label="Show standard project files")
        standard_lbl.set_hexpand(True)
        standard_lbl.set_xalign(0)
        standard_row.append(standard_lbl)
        standard_sw = Gtk.Switch()
        standard_sw.set_active(self._show_standard_files)
        standard_sw.set_valign(Gtk.Align.CENTER)

        def _on_standard_toggled(sw, _pspec):
            self._show_standard_files = sw.get_active()
            self._rebuild_file_tree()

        standard_sw.connect("notify::active", _on_standard_toggled)
        standard_row.append(standard_sw)
        outer.append(standard_row)

        # Show hidden files toggle
        hidden_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        hidden_lbl = Gtk.Label(label="Show hidden files")
        hidden_lbl.set_hexpand(True)
        hidden_lbl.set_xalign(0)
        hidden_row.append(hidden_lbl)
        hidden_sw = Gtk.Switch()
        hidden_sw.set_active(self._show_hidden)
        hidden_sw.set_valign(Gtk.Align.CENTER)

        def _on_hidden_toggled(sw, _pspec):
            self._show_hidden = sw.get_active()
            self._rebuild_file_tree()

        hidden_sw.connect("notify::active", _on_hidden_toggled)
        hidden_row.append(hidden_sw)
        outer.append(hidden_row)

        outer.append(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL))

        # Per-project Ollama model (G5.2)
        model_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        model_lbl = Gtk.Label(label="Local AI model")
        model_lbl.set_hexpand(True)
        model_lbl.set_xalign(0)
        model_row.append(model_lbl)
        model_entry = Gtk.Entry()
        model_entry.set_text(project.get("ollama_model", ""))
        model_entry.set_placeholder_text("e.g. mistral (overrides global)")
        model_entry.set_width_chars(20)

        def _save_model(_w=None):
            m = model_entry.get_text().strip()
            project["ollama_model"] = m
            if self._pm is not None:
                self._pm._save_local(project)

        model_entry.connect("activate", _save_model)
        model_entry.connect("focus-out-event", _save_model)
        model_row.append(model_entry)
        outer.append(model_row)

        outer.append(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL))

        ft_hdr = Gtk.Label(label="Default apps for file types")
        ft_hdr.add_css_class("heading")
        ft_hdr.set_xalign(0)
        outer.append(ft_hdr)

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
                    self._refresh_default_app_icons()

            ext_entry.connect("activate", save_row)
            app_entry.connect("activate", save_row)
            ext_entry.connect("focus-out-event", save_row)
            app_entry.connect("focus-out-event", save_row)

            def rm_row(_btn, r=row, ee=ext_entry):
                ext_val = ee.get_text().strip().lower()
                if ext_val and self._dam:
                    self._dam.remove_project_app(project_dir, ext_val)
                    self._refresh_default_app_icons()
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
