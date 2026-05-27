import json
import pathlib

import gi
gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
from gi.repository import Gtk, Gdk, GLib, GObject, Pango


_TERMINAL_OPTIONS = ["claude", "codex"]


class ProjectPill(Gtk.Box):
    """Compact pill widget for a single project in the bottom bar."""
    def __init__(self, project: dict, on_click, on_close, on_drop=None):
        super().__init__(orientation=Gtk.Orientation.HORIZONTAL, spacing=0)
        self.project_id = project["id"]
        self.project_name = project["name"]
        self._project_dir = project.get("directory", "")
        self.position = project.get("position", 0)
        self._on_drop_cb = on_drop
        self._stats_popover: Gtk.Popover | None = None
        self._hover_timer_id: int | None = None
        self.add_css_class("project-pill")

        self._dot = Gtk.Label(label="●")
        self._dot.add_css_class("pill-dot")
        self._dot.set_valign(Gtk.Align.CENTER)
        self._dot.set_margin_start(6)
        self._dot.set_margin_end(4)
        self.append(self._dot)

        lbl = Gtk.Label(label=project["name"])
        lbl.set_ellipsize(Pango.EllipsizeMode.END)
        lbl.set_max_width_chars(14)
        lbl.set_margin_end(6)
        self.append(lbl)

        close_btn = Gtk.Button(label="×")
        close_btn.add_css_class("flat")
        close_btn.add_css_class("close-btn")
        close_btn.set_valign(Gtk.Align.CENTER)
        close_btn.set_margin_end(2)
        close_btn.connect("clicked", lambda _: on_close(self.project_id))
        self.append(close_btn)

        click = Gtk.GestureClick()
        click.set_button(1)
        click.connect("released", lambda _g, _n, _x, _y: on_click(self.project_id))
        self.add_controller(click)

        rclick = Gtk.GestureClick()
        rclick.set_button(3)
        rclick.connect("pressed", self._on_right_click)
        self.add_controller(rclick)

        motion = Gtk.EventControllerMotion()
        motion.connect("enter", self._on_hover_enter)
        motion.connect("leave", self._on_hover_leave)
        self.add_controller(motion)

        self._setup_drag_and_drop()

    # ── drag-and-drop ─────────────────────────────────────────────────────────

    def _setup_drag_and_drop(self):
        drag_source = Gtk.DragSource()
        drag_source.set_actions(Gdk.DragAction.MOVE)
        drag_source.connect("prepare", self._on_drag_prepare)
        drag_source.connect("drag-begin", self._on_drag_begin)
        drag_source.connect("drag-end", self._on_drag_end)
        self.add_controller(drag_source)

        drop_target = Gtk.DropTarget.new(GObject.TYPE_STRING, Gdk.DragAction.MOVE)
        drop_target.connect("drop", self._on_drop)
        drop_target.connect("motion", self._on_drop_motion)
        drop_target.connect("leave", self._on_drop_leave)
        self.add_controller(drop_target)

    def _on_drag_prepare(self, _src, _x, _y):
        return Gdk.ContentProvider.new_for_value(self.project_id)

    def _on_drag_begin(self, _src, _drag):
        self.add_css_class("project-row-dragging")

    def _on_drag_end(self, _src, _drag, _success):
        self.remove_css_class("project-row-dragging")
        self.remove_css_class("drag-over-left")
        self.remove_css_class("drag-over-right")

    def _on_drop(self, _target, value, x, _y) -> bool:
        self.remove_css_class("drag-over-left")
        self.remove_css_class("drag-over-right")
        if self._on_drop_cb and isinstance(value, str) and value != self.project_id:
            before = x < self.get_width() / 2
            self._on_drop_cb(value, self.project_id, before)
        return True

    def _on_drop_motion(self, _target, x, _y):
        self.remove_css_class("drag-over-left")
        self.remove_css_class("drag-over-right")
        if x < self.get_width() / 2:
            self.add_css_class("drag-over-left")
        else:
            self.add_css_class("drag-over-right")
        return Gdk.DragAction.MOVE

    def _on_drop_leave(self, _target):
        self.remove_css_class("drag-over-left")
        self.remove_css_class("drag-over-right")

    # ── hover / right-click stats ─────────────────────────────────────────────

    def _on_hover_enter(self, _ctrl, _x, _y):
        if self._hover_timer_id is not None:
            GLib.source_remove(self._hover_timer_id)
        self._hover_timer_id = GLib.timeout_add(500, self._show_stats_hover)

    def _on_hover_leave(self, _ctrl):
        if self._hover_timer_id is not None:
            GLib.source_remove(self._hover_timer_id)
            self._hover_timer_id = None
        if self._stats_popover and self._stats_popover.get_visible():
            self._stats_popover.popdown()

    def _show_stats_hover(self) -> bool:
        self._hover_timer_id = None
        self._open_stats_popover()
        return False

    def _on_right_click(self, _gesture, _n, _x, _y):
        if self._hover_timer_id is not None:
            GLib.source_remove(self._hover_timer_id)
            self._hover_timer_id = None
        self._open_stats_popover()

    def _ensure_popover(self):
        if self._stats_popover is not None:
            return
        popover = Gtk.Popover()
        popover.set_parent(self)
        popover.set_autohide(True)
        popover.set_has_arrow(True)
        self._stats_popover = popover

    def _open_stats_popover(self):
        self._ensure_popover()
        popover = self._stats_popover

        from project_stats import get_project_stats
        project = {"id": self.project_id, "directory": self._project_dir}
        stats = get_project_stats(project)

        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        box.set_margin_start(10)
        box.set_margin_end(10)
        box.set_margin_top(8)
        box.set_margin_bottom(8)
        box.set_size_request(210, -1)

        name_lbl = Gtk.Label(label=self.project_name, xalign=0)
        name_lbl.add_css_class("heading")
        box.append(name_lbl)

        box.append(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL))

        if stats is None:
            info_lbl = Gtk.Label(
                label="Stats loading… open a project to trigger scan.", xalign=0
            )
            info_lbl.add_css_class("dim-label")
            info_lbl.set_wrap(True)
            info_lbl.set_max_width_chars(26)
            box.append(info_lbl)
        else:
            today_s = stats.get("time_today_s", 0)
            total_s = stats.get("time_total_s", 0)
            th, tm = int(today_s // 3600), int((today_s % 3600) // 60)
            tot_h, tot_m = int(total_s // 3600), int((total_s % 3600) // 60)
            today_str = (f"{th}h {tm}m" if th else f"{tm}m") if today_s > 0 else "—"
            total_str = (f"{tot_h}h {tot_m}m" if tot_h else f"{tot_m}m") if total_s > 0 else "—"
            time_lbl = Gtk.Label(
                label=f"Today: {today_str}   Total: {total_str}", xalign=0
            )
            time_lbl.add_css_class("dim-label")
            box.append(time_lbl)

            fts = stats.get("file_type_stats", {})
            if fts:
                total_bytes = sum(v["bytes"] for v in fts.values())
                if total_bytes > 0:
                    from project_stats import ext_color_hex
                    sorted_types = sorted(
                        fts.items(), key=lambda x: x[1]["bytes"], reverse=True
                    )
                    bar_data = [
                        (ext_color_hex(ext), info["bytes"] / total_bytes)
                        for ext, info in sorted_types
                    ]
                    area = Gtk.DrawingArea()
                    area.set_size_request(190, 10)
                    area.set_draw_func(self._draw_filetype_bar, bar_data)
                    box.append(area)
                    legend_parts = [
                        f"{ext} {int(info['bytes']/total_bytes*100)}%"
                        for ext, info in sorted_types[:4]
                    ]
                    legend_lbl = Gtk.Label(label="  ".join(legend_parts), xalign=0)
                    legend_lbl.add_css_class("dim-label")
                    legend_lbl.set_wrap(True)
                    legend_lbl.set_max_width_chars(30)
                    box.append(legend_lbl)

        popover.set_child(box)
        popover.popup()

    @staticmethod
    def _draw_filetype_bar(area, cr, w, h, bar_data):
        x = 0.0
        for hex_color, frac in bar_data:
            r = int(hex_color[1:3], 16) / 255
            g = int(hex_color[3:5], 16) / 255
            b = int(hex_color[5:7], 16) / 255
            cr.set_source_rgb(r, g, b)
            seg_w = frac * w
            cr.rectangle(x, 0, seg_w, h)
            cr.fill()
            x += seg_w

    # ── state helpers ─────────────────────────────────────────────────────────

    def set_active(self, active: bool):
        if active:
            self.add_css_class("project-pill-active")
        else:
            self.remove_css_class("project-pill-active")

    def set_warm(self, warm: bool):
        if warm:
            self.add_css_class("project-pill-warm")
        else:
            self.remove_css_class("project-pill-warm")

    def update_time(self, secs: float):
        if secs > 0:
            h = int(secs // 3600)
            m = int((secs % 3600) // 60)
            time_str = f"{h}h {m}m today" if h > 0 else f"{m}m today"
            self.set_tooltip_text(f"{self.project_name} — {time_str}")
        else:
            self.set_tooltip_text(self.project_name)


class BottomPanel(Gtk.Box):
    def __init__(self, on_root, on_new_project, on_import_project,
                 on_toggle_file_tree_panel,
                 on_activate_project, on_close_project,
                 project_manager=None, settings_manager=None,
                 default_apps_manager=None, on_toggle_theme=None,
                 on_terminal_changed=None):
        super().__init__(orientation=Gtk.Orientation.HORIZONTAL, spacing=0)
        self.add_css_class("bottom-panel")
        self.set_valign(Gtk.Align.END)
        self.set_hexpand(True)

        self._on_close = on_close_project
        self._on_activate = on_activate_project
        self._new_project_cb = on_new_project
        self._import_project_cb = on_import_project
        self._pm = project_manager
        self._settings = settings_manager
        self._dam = default_apps_manager
        self._on_toggle_theme = on_toggle_theme
        self._on_terminal_changed_ext = on_terminal_changed
        self._pills: dict[str, ProjectPill] = {}
        self._active_project_id: str | None = None
        self._popover: Gtk.Popover | None = None

        # Root button
        root_btn = Gtk.Button(label="Root")
        root_btn.add_css_class("destructive-action")
        root_btn.add_css_class("bottom-root-btn")
        root_btn.set_valign(Gtk.Align.CENTER)
        root_btn.set_margin_top(5)
        root_btn.set_margin_bottom(5)
        root_btn.connect("clicked", lambda _: on_root())
        self.append(root_btn)

        # Project search
        self._search_entry = Gtk.SearchEntry()
        self._search_entry.set_placeholder_text("Search…")
        self._search_entry.set_valign(Gtk.Align.CENTER)
        self._search_entry.set_margin_start(6)
        self._search_entry.set_margin_top(5)
        self._search_entry.set_margin_bottom(5)
        self._search_entry.set_max_width_chars(14)
        self._search_entry.connect("search-changed", self._on_search_changed)
        self._search_entry.connect("activate", self._on_search_activate)
        self.append(self._search_entry)

        sep1 = Gtk.Separator(orientation=Gtk.Orientation.VERTICAL)
        sep1.set_margin_top(8)
        sep1.set_margin_bottom(8)
        sep1.set_margin_start(4)
        self.append(sep1)

        # Project pills (scrollable, centre)
        scroll = Gtk.ScrolledWindow()
        scroll.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.NEVER)
        scroll.set_hexpand(True)
        scroll.set_valign(Gtk.Align.FILL)

        self._pills_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=4)
        self._pills_box.set_margin_start(6)
        self._pills_box.set_margin_end(6)
        self._pills_box.set_margin_top(5)
        self._pills_box.set_margin_bottom(5)
        self._pills_box.set_valign(Gtk.Align.CENTER)
        scroll.set_child(self._pills_box)
        self.append(scroll)

        sep2 = Gtk.Separator(orientation=Gtk.Orientation.VERTICAL)
        sep2.set_margin_top(8)
        sep2.set_margin_bottom(8)
        sep2.set_margin_end(4)
        self.append(sep2)

        # Settings gear
        self._gear_btn = Gtk.Button()
        self._gear_btn.set_icon_name("preferences-system-symbolic")
        self._gear_btn.add_css_class("flat")
        self._gear_btn.add_css_class("bottom-toggle-btn")
        self._gear_btn.set_tooltip_text("Settings")
        self._gear_btn.set_valign(Gtk.Align.CENTER)
        self._gear_btn.set_margin_end(4)
        self._gear_btn.connect("clicked", self._on_settings_clicked)
        self.append(self._gear_btn)

        # + button
        self._add_btn = Gtk.Button(label="+")
        self._add_btn.add_css_class("bottom-add-btn")
        self._add_btn.set_valign(Gtk.Align.CENTER)
        self._add_btn.set_margin_top(5)
        self._add_btn.set_margin_bottom(5)
        self._add_btn.connect("clicked", self._on_add_clicked)
        self.append(self._add_btn)

        # Panel toggle — rightmost, controls file-tree overlay
        self._panel_toggle = Gtk.Button(label="›")
        self._panel_toggle.add_css_class("flat")
        self._panel_toggle.add_css_class("bottom-toggle-btn")
        self._panel_toggle.set_tooltip_text("Hide panel")
        self._panel_toggle.set_valign(Gtk.Align.CENTER)
        self._panel_toggle.set_margin_start(2)
        self._panel_toggle.set_margin_end(8)
        self._panel_toggle.connect("clicked", lambda _: on_toggle_file_tree_panel())
        self.append(self._panel_toggle)

    def _on_add_clicked(self, btn):
        if self._popover is None:
            popover = Gtk.Popover()
            popover.set_parent(btn)

            box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
            box.set_margin_start(4)
            box.set_margin_end(4)
            box.set_margin_top(4)
            box.set_margin_bottom(4)

            new_item = Gtk.Button(label="New Project")
            new_item.add_css_class("flat")
            new_item.connect("clicked",
                             lambda _: (popover.popdown(), self._new_project_cb()))

            import_item = Gtk.Button(label="Import Project")
            import_item.add_css_class("flat")
            import_item.connect("clicked",
                                lambda _: (popover.popdown(), self._import_project_cb()))

            box.append(new_item)
            box.append(import_item)
            popover.set_child(box)
            self._popover = popover

        self._popover.popup()

    # ── settings ──────────────────────────────────────────────────────────────

    def _on_settings_clicked(self, _btn):
        win = Gtk.Window()
        win.set_title("Settings")
        win.set_modal(True)
        win.set_resizable(False)
        win.set_default_size(320, -1)
        root = self._gear_btn.get_root()
        if isinstance(root, Gtk.Window):
            win.set_transient_for(root)

        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        box.set_margin_start(16)
        box.set_margin_end(16)
        box.set_margin_top(16)
        box.set_margin_bottom(16)

        title = Gtk.Label(label="Settings")
        title.add_css_class("heading")
        title.set_xalign(0)
        box.append(title)

        box.append(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL))

        term_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        term_lbl = Gtk.Label(label="Terminal")
        term_lbl.set_hexpand(True)
        term_lbl.set_xalign(0)
        term_row.append(term_lbl)

        term_dropdown = Gtk.DropDown.new_from_strings(_TERMINAL_OPTIONS)
        current = self._settings.get("terminal_command") if self._settings else "claude"
        idx = _TERMINAL_OPTIONS.index(current) if current in _TERMINAL_OPTIONS else 0
        term_dropdown.set_selected(idx)
        term_dropdown.connect("notify::selected", self._on_terminal_changed)
        term_row.append(term_dropdown)

        box.append(term_row)

        box.append(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL))

        theme_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        theme_lbl = Gtk.Label(label="Dark mode")
        theme_lbl.set_hexpand(True)
        theme_lbl.set_xalign(0)
        theme_row.append(theme_lbl)

        theme_switch = Gtk.Switch()
        current_scheme = self._settings.get("color_scheme") if self._settings else "dark"
        theme_switch.set_active(current_scheme != "light")
        theme_switch.set_valign(Gtk.Align.CENTER)
        theme_switch.connect("notify::active", self._on_theme_switched)
        theme_row.append(theme_switch)

        box.append(theme_row)

        box.append(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL))

        ws_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        ws_lbl = Gtk.Label(label="Manage workspaces")
        ws_lbl.set_hexpand(True)
        ws_lbl.set_xalign(0)
        ws_row.append(ws_lbl)

        ws_switch = Gtk.Switch()
        current_ws = self._settings.get("workspace_management") if self._settings else False
        ws_switch.set_active(bool(current_ws))
        ws_switch.set_valign(Gtk.Align.CENTER)
        ws_switch.connect("notify::active", self._on_workspace_switched)
        ws_row.append(ws_switch)

        box.append(ws_row)

        box.append(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL))

        ft_btn = Gtk.Button(label="File Type Apps…")
        ft_btn.add_css_class("flat")
        ft_btn.set_halign(Gtk.Align.START)
        ft_btn.connect("clicked", lambda _: (win.close(), self._show_filetype_settings()))
        box.append(ft_btn)

        win.set_child(box)
        win.present()

    def _on_terminal_changed(self, dropdown, _pspec):
        if self._settings is None:
            return
        idx = dropdown.get_selected()
        if 0 <= idx < len(_TERMINAL_OPTIONS):
            self._settings.set("terminal_command", _TERMINAL_OPTIONS[idx])
            if self._on_terminal_changed_ext:
                self._on_terminal_changed_ext()

    def _on_theme_switched(self, sw, _pspec):
        is_dark = sw.get_active()
        if self._settings:
            self._settings.set("color_scheme", "dark" if is_dark else "light")
        if self._on_toggle_theme:
            self._on_toggle_theme(is_dark)

    def _on_workspace_switched(self, sw, _pspec):
        if self._settings:
            self._settings.set("workspace_management", sw.get_active())

    # ── filetype settings window ──────────────────────────────────────────────

    def _show_filetype_settings(self):
        win = Gtk.Window()
        win.set_title("File Type Apps")
        win.set_modal(True)
        win.set_default_size(420, 380)
        root = self._gear_btn.get_root()
        if isinstance(root, Gtk.Window):
            win.set_transient_for(root)

        outer = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        outer.set_margin_start(16)
        outer.set_margin_end(16)
        outer.set_margin_top(16)
        outer.set_margin_bottom(16)

        hdr = Gtk.Label(label="Default apps for file types")
        hdr.add_css_class("heading")
        hdr.set_xalign(0)
        outer.append(hdr)

        desc = Gtk.Label(
            label="Double-clicking a project file opens it with the app below."
        )
        desc.set_xalign(0)
        desc.set_wrap(True)
        desc.add_css_class("dim-label")
        outer.append(desc)

        outer.append(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL))

        scrolled = Gtk.ScrolledWindow()
        scrolled.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        scrolled.set_vexpand(True)

        self._ft_listbox = Gtk.ListBox()
        self._ft_listbox.set_selection_mode(Gtk.SelectionMode.NONE)
        scrolled.set_child(self._ft_listbox)
        outer.append(scrolled)

        self._ft_win = win
        self._ft_populate()

        add_btn = Gtk.Button(label="+ Add Entry")
        add_btn.add_css_class("flat")
        add_btn.set_halign(Gtk.Align.START)
        add_btn.connect("clicked", lambda _: self._ft_add_row("", ""))
        outer.append(add_btn)

        win.set_child(outer)
        win.present()

    def _ft_populate(self):
        if self._dam is None:
            return
        gmap = self._dam.get_global_map()
        for ext, app in sorted(gmap.items()):
            self._ft_add_row(ext, app)

    def _ft_add_row(self, ext: str, app: str):
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
            self._ft_show_app_picker(cb, self._ft_win)

        browse_btn = Gtk.Button(label="⋯")
        browse_btn.add_css_class("flat")
        browse_btn.connect("clicked", browse)
        box.append(browse_btn)

        def save_row(_w, ee=ext_entry, ae=app_entry, old_ext=ext):
            new_ext = ee.get_text().strip().lower()
            new_app = ae.get_text().strip()
            if not new_ext or not new_app:
                return
            if old_ext and old_ext != new_ext and self._dam:
                self._dam.remove_global_app(old_ext)
            if self._dam:
                self._dam.set_global_app(new_ext, new_app)

        ext_entry.connect("activate", save_row)
        app_entry.connect("activate", save_row)
        ext_entry.connect("focus-out-event", save_row)
        app_entry.connect("focus-out-event", save_row)

        def rm_row(_btn, r=row, ee=ext_entry):
            ext_val = ee.get_text().strip().lower()
            if ext_val and self._dam:
                self._dam.remove_global_app(ext_val)
            self._ft_listbox.remove(r)

        rm_btn = Gtk.Button(label="×")
        rm_btn.add_css_class("flat")
        rm_btn.get_style_context().add_class("close-btn")
        rm_btn.connect("clicked", rm_row)
        box.append(rm_btn)

        row.set_child(box)
        self._ft_listbox.append(row)

    def _ft_show_app_picker(self, callback, parent=None):
        from default_apps_manager import get_installed_apps
        apps = get_installed_apps()

        win = Gtk.Window()
        win.set_title("Choose Application")
        win.set_modal(True)
        win.set_default_size(360, 440)
        if parent:
            win.set_transient_for(parent)

        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)

        search = Gtk.SearchEntry()
        search.set_placeholder_text("Search apps…")
        search.set_margin_start(8)
        search.set_margin_end(8)
        search.set_margin_top(8)
        search.set_margin_bottom(4)
        box.append(search)

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
            listbox.append(r)

        def on_activated(_lb, r):
            callback(r.app_exec)
            win.close()

        listbox.connect("row-activated", on_activated)
        scrolled.set_child(listbox)
        box.append(scrolled)

        win.set_child(box)
        win.present()

    # ── public API ─────────────────────────────────────────────────────────────

    def add_project_pill(self, project: dict):
        pill = ProjectPill(
            project,
            on_click=self._on_activate,
            on_close=self._on_close,
            on_drop=self._on_pill_dropped,
        )
        self._pills_box.append(pill)
        self._pills[project["id"]] = pill

    def remove_project_pill(self, project_id: str):
        pill = self._pills.pop(project_id, None)
        if pill:
            self._pills_box.remove(pill)

    def set_active_project(self, project_id: str | None):
        if self._pm and self._active_project_id and self._active_project_id != project_id:
            self._pm.set_project_status(self._active_project_id, "active")
        if self._pm and project_id:
            self._pm.set_project_status(project_id, "current")
        self._active_project_id = project_id
        for pid, pill in self._pills.items():
            pill.set_active(pid == project_id)

    def select_project(self, project_id: str):
        self.set_active_project(project_id)

    def deselect_all(self):
        self.set_active_project(None)

    def set_project_warm(self, project_id: str, warm: bool):
        pill = self._pills.get(project_id)
        if pill:
            pill.set_warm(warm)

    def refresh_warm_states(self, projects: list):
        for p in projects:
            proj_dir = p.get("directory", "")
            local_file = p.get("local_file") or str(
                pathlib.Path(proj_dir) / "project.json"
            )
            warm = False
            path = pathlib.Path(local_file)
            if path.exists():
                try:
                    data = json.loads(path.read_text())
                    warm = bool(data.get("open_apps"))
                except Exception:
                    pass
            pill = self._pills.get(p["id"])
            if pill:
                pill.set_warm(warm)

    def update_time_bars(self, totals: dict):
        for pid, pill in self._pills.items():
            pill.update_time(totals.get(pid, 0.0))

    def set_panel_shown(self, shown: bool):
        self._panel_toggle.set_label("›" if shown else "‹")
        self._panel_toggle.set_tooltip_text(
            "Hide panel" if shown else "Show panel"
        )

    def set_left_panel_shown(self, shown: bool):
        self.set_panel_shown(shown)

    def set_panel_toggle_visible(self, visible: bool):
        self._panel_toggle.set_visible(visible)

    # ── project search ────────────────────────────────────────────────────────

    def _on_search_changed(self, entry):
        q = entry.get_text().strip().lower()
        for pill in self._pills.values():
            pill.set_visible(not q or q in pill.project_name.lower())

    def _on_search_activate(self, entry):
        q = entry.get_text().strip().lower()
        if not q:
            return
        visible = [p for p in self._pills.values() if q in p.project_name.lower()]
        if len(visible) == 1:
            entry.set_text("")
            self._on_activate(visible[0].project_id)

    # ── drag-and-drop reorder ─────────────────────────────────────────────────

    def _on_pill_dropped(self, source_id: str, target_id: str, before: bool):
        source_pill = self._pills.get(source_id)
        target_pill = self._pills.get(target_id)
        if not source_pill or not target_pill or source_id == target_id:
            return

        pills = sorted(self._pills.values(), key=lambda p: p.position)
        pills_without_src = [p for p in pills if p.project_id != source_id]

        target_idx = next(
            (i for i, p in enumerate(pills_without_src) if p.project_id == target_id),
            len(pills_without_src) - 1,
        )
        if not before:
            target_idx += 1
        pills_without_src.insert(target_idx, source_pill)

        for i, pill in enumerate(pills_without_src):
            new_pos = i * 10
            pill.position = new_pos
            if self._pm:
                self._pm.set_project_position(pill.project_id, new_pos)

        for pill in pills_without_src:
            self._pills_box.remove(pill)
            self._pills_box.append(pill)
