import json
import pathlib

import gi
gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
from gi.repository import Gtk, Gdk, GLib, GObject, Pango


class ProjectRow(Gtk.ListBoxRow):
    def __init__(self, project: dict, on_close, on_drop=None, on_activate=None):
        super().__init__()
        self.project_id = project["id"]
        self.project_name = project["name"]
        self.status = project.get("status", "active")
        self.position = project.get("position", 0)
        self._project_dir = project.get("directory", "")
        self._on_drop_cb = on_drop
        self._on_activate_cb = on_activate
        self._hover_timer_id: int | None = None
        self._stats_popover: Gtk.Popover | None = None
        self.get_style_context().add_class("project-row")

        vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)

        box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        box.set_margin_start(4)
        box.set_margin_end(4)
        box.set_margin_top(6)
        box.set_margin_bottom(2)

        # Drag handle — DragSource lives here so it doesn't block row clicks
        drag_handle = Gtk.Image.new_from_icon_name("open-menu-symbolic")
        drag_handle.set_pixel_size(12)
        drag_handle.set_opacity(0.4)
        drag_handle.set_tooltip_text("Drag to reorder")
        self._drag_handle = drag_handle
        box.append(drag_handle)

        icon = Gtk.Image.new_from_icon_name("folder-symbolic")
        box.append(icon)

        label = Gtk.Label(label=project["name"], xalign=0.0)
        label.set_ellipsize(Pango.EllipsizeMode.END)
        label.set_max_width_chars(16)
        label.set_hexpand(True)
        box.append(label)

        close_btn = Gtk.Button(label="×")
        close_btn.add_css_class("flat")
        close_btn.get_style_context().add_class("close-btn")
        close_btn.connect("clicked", lambda _: on_close(project["id"]))
        box.append(close_btn)

        vbox.append(box)

        bar_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=4)
        bar_row.set_margin_start(10)
        bar_row.set_margin_end(6)
        bar_row.set_margin_bottom(4)
        bar_row.set_visible(False)
        self._time_bar_row = bar_row

        self._time_bar = Gtk.ProgressBar()
        self._time_bar.add_css_class("project-time-bar")
        self._time_bar.set_fraction(0.0)
        self._time_bar.set_hexpand(True)
        bar_row.append(self._time_bar)

        self._time_label = Gtk.Label(label="")
        self._time_label.add_css_class("project-time-label")
        self._time_label.set_valign(Gtk.Align.CENTER)
        self._time_label.set_width_chars(5)
        self._time_label.set_xalign(1.0)
        bar_row.append(self._time_label)

        vbox.append(bar_row)
        self.set_child(vbox)

        self._setup_hover()
        self._setup_right_click()
        self._setup_drag_and_drop()

    # ── hover popover ─────────────────────────────────────────────────────────

    def _setup_hover(self):
        motion = Gtk.EventControllerMotion()
        motion.connect("enter", self._on_hover_enter)
        motion.connect("leave", self._on_hover_leave)
        self.add_controller(motion)

    def _on_hover_enter(self, _ctrl, _x, _y):
        if self._hover_timer_id is not None:
            GLib.source_remove(self._hover_timer_id)
        self._hover_timer_id = GLib.timeout_add(500, self._show_stats_popover_hover)

    def _on_hover_leave(self, _ctrl):
        if self._hover_timer_id is not None:
            GLib.source_remove(self._hover_timer_id)
            self._hover_timer_id = None
        if self._stats_popover and self._stats_popover.get_visible():
            self._stats_popover.popdown()

    def _show_stats_popover_hover(self) -> bool:
        self._hover_timer_id = None
        self._open_stats_popover(pinned=False)
        return False

    # ── right-click stats ─────────────────────────────────────────────────────

    def _setup_right_click(self):
        gesture = Gtk.GestureClick()
        gesture.set_button(3)
        gesture.connect("pressed", self._on_right_click)
        self.add_controller(gesture)

    def _on_right_click(self, _gesture, _n, _x, _y):
        self._open_stats_popover(pinned=True)

    # ── shared popover builder ────────────────────────────────────────────────

    def _ensure_popover(self):
        """Create the popover once and keep it for the lifetime of the row."""
        if self._stats_popover is not None:
            return
        popover = Gtk.Popover()
        popover.set_parent(self)
        popover.set_autohide(True)
        popover.set_has_arrow(True)
        self._stats_popover = popover

    def _open_stats_popover(self, pinned: bool):
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
            info_lbl = Gtk.Label(label="Stats loading… open a project to trigger scan.", xalign=0)
            info_lbl.add_css_class("dim-label")
            info_lbl.set_wrap(True)
            info_lbl.set_max_width_chars(26)
            box.append(info_lbl)
        else:
            # Time
            today_s = stats.get("time_today_s", 0)
            total_s = stats.get("time_total_s", 0)
            th, tm = int(today_s // 3600), int((today_s % 3600) // 60)
            tot_h, tot_m = int(total_s // 3600), int((total_s % 3600) // 60)
            today_str = (f"{th}h {tm}m" if th else f"{tm}m") if today_s > 0 else "—"
            total_str = (f"{tot_h}h {tot_m}m" if tot_h else f"{tot_m}m") if total_s > 0 else "—"
            time_lbl = Gtk.Label(label=f"Today: {today_str}   Total: {total_str}", xalign=0)
            time_lbl.add_css_class("dim-label")
            box.append(time_lbl)

            # File type bar + legend
            fts = stats.get("file_type_stats", {})
            if fts:
                total_bytes = sum(v["bytes"] for v in fts.values())
                if total_bytes > 0:
                    from project_stats import ext_color_hex
                    sorted_types = sorted(fts.items(), key=lambda x: x[1]["bytes"], reverse=True)

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

    # ── drag-and-drop ─────────────────────────────────────────────────────────

    def _setup_drag_and_drop(self):
        # DragSource on the handle only — keeps it away from the row's click area
        drag_source = Gtk.DragSource()
        drag_source.set_actions(Gdk.DragAction.MOVE)
        drag_source.connect("prepare", self._on_drag_prepare)
        drag_source.connect("drag-begin", self._on_drag_begin)
        drag_source.connect("drag-end", self._on_drag_end)
        self._drag_handle.add_controller(drag_source)

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
        self.remove_css_class("drag-over-top")
        self.remove_css_class("drag-over-bottom")

    def _on_drop(self, _target, value, _x, y) -> bool:
        self.remove_css_class("drag-over-top")
        self.remove_css_class("drag-over-bottom")
        if self._on_drop_cb and isinstance(value, str) and value != self.project_id:
            before = y < self.get_height() / 2
            self._on_drop_cb(value, self.project_id, before)
        return True

    def _on_drop_motion(self, _target, _x, y):
        self.remove_css_class("drag-over-top")
        self.remove_css_class("drag-over-bottom")
        if y < self.get_height() / 2:
            self.add_css_class("drag-over-top")
        else:
            self.add_css_class("drag-over-bottom")
        return Gdk.DragAction.MOVE

    def _on_drop_leave(self, _target):
        self.remove_css_class("drag-over-top")
        self.remove_css_class("drag-over-bottom")

    # ── state helpers ─────────────────────────────────────────────────────────

    def set_active(self, active: bool):
        ctx = self.get_style_context()
        if active:
            ctx.add_class("project-row-active")
        else:
            ctx.remove_class("project-row-active")

    def set_warm(self, warm: bool):
        ctx = self.get_style_context()
        if warm:
            ctx.add_class("project-row-warm")
        else:
            ctx.remove_class("project-row-warm")

    def update_time_bar(self, fraction: float, tooltip: str, label_text: str = ""):
        if fraction > 0:
            self._time_bar.set_fraction(min(1.0, fraction))
            self._time_bar_row.set_tooltip_text(tooltip)
            self._time_label.set_text(label_text)
            self._time_bar_row.set_visible(True)
        else:
            self._time_bar_row.set_visible(False)


_TERMINAL_OPTIONS = ["claude", "codex"]


class RightPanel(Gtk.Box):
    def __init__(self, project_manager, center_panel, on_new_project, on_import_project,
                 settings_manager=None, default_apps_manager=None, on_toggle_theme=None,
                 on_activate_project=None):
        super().__init__(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        self.get_style_context().add_class("panel-right")
        self.set_size_request(220, -1)

        self._pm = project_manager
        self._center = center_panel
        self._settings = settings_manager
        self._dam = default_apps_manager
        self._on_new_project = on_new_project
        self._on_import_project = on_import_project
        self._on_toggle_theme = on_toggle_theme
        self._on_activate_project = on_activate_project
        self._project_rows: dict[str, ProjectRow] = {}
        self._active_project_id: str | None = None
        self._popover: Gtk.Popover | None = None
        self._search_popover: Gtk.Popover | None = None

        self._build_root_btn()
        self._build_search()
        self._build_project_list()
        self._build_add_btn()

    # ── root button ───────────────────────────────────────────────────────────

    def _build_root_btn(self):
        row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=4)
        row.set_margin_start(8)
        row.set_margin_end(8)
        row.set_margin_top(10)
        row.set_margin_bottom(4)

        btn = Gtk.Button(label="Root")
        btn.add_css_class("destructive-action")
        btn.set_hexpand(True)
        btn.connect("clicked", self._on_root_clicked)
        row.append(btn)

        gear_btn = Gtk.Button()
        gear_btn.set_icon_name("preferences-system-symbolic")
        gear_btn.add_css_class("flat")
        gear_btn.set_tooltip_text("Settings")
        gear_btn.connect("clicked", self._on_settings_clicked)
        row.append(gear_btn)

        self._gear_btn = gear_btn
        self.append(row)

    def _on_root_clicked(self, _btn):
        # Deselect any project row so re-selecting it later works properly
        self._listbox.select_row(None)
        if hasattr(self._center, "open_master_terminal"):
            self._center.open_master_terminal()

    def _on_settings_clicked(self, _btn):
        popover = Gtk.Popover()
        popover.set_autohide(True)
        popover.set_parent(self._gear_btn)

        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        box.set_margin_start(12)
        box.set_margin_end(12)
        box.set_margin_top(12)
        box.set_margin_bottom(12)

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

        ft_btn = Gtk.Button(label="File Type Apps…")
        ft_btn.add_css_class("flat")
        ft_btn.set_halign(Gtk.Align.START)
        ft_btn.connect("clicked", lambda _: (popover.popdown(),
                                              self._show_filetype_settings()))
        box.append(ft_btn)

        motion = Gtk.EventControllerMotion()
        motion.connect("leave", lambda _: popover.popdown())
        box.add_controller(motion)

        popover.set_child(box)
        popover.popup()

    def _on_terminal_changed(self, dropdown, _pspec):
        if self._settings is None:
            return
        idx = dropdown.get_selected()
        if 0 <= idx < len(_TERMINAL_OPTIONS):
            self._settings.set("terminal_command", _TERMINAL_OPTIONS[idx])
            if hasattr(self._center, "respawn_all"):
                self._center.respawn_all()

    def _on_theme_switched(self, sw, _pspec):
        is_dark = sw.get_active()
        if self._settings:
            self._settings.set("color_scheme", "dark" if is_dark else "light")
        if self._on_toggle_theme:
            self._on_toggle_theme(is_dark)

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

    # ── search entry (global, all projects) ───────────────────────────────────

    def _build_search(self):
        self._search_entry = Gtk.SearchEntry()
        self._search_entry.set_placeholder_text("Search all projects…")
        self._search_entry.set_margin_start(8)
        self._search_entry.set_margin_end(8)
        self._search_entry.set_margin_top(4)
        self._search_entry.set_margin_bottom(4)
        self._search_entry.connect("search-changed", self._on_search_changed)
        self.append(self._search_entry)

        sep = Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL)
        sep.set_margin_top(2)
        sep.set_margin_bottom(4)
        self.append(sep)

        results_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        results_box.set_size_request(198, -1)

        self._search_results = Gtk.ListBox()
        self._search_results.set_selection_mode(Gtk.SelectionMode.SINGLE)
        self._search_results.connect("row-activated", self._on_search_result_activated)
        results_box.append(self._search_results)

        self._search_popover = Gtk.Popover()
        self._search_popover.set_parent(self._search_entry)
        self._search_popover.set_autohide(True)
        self._search_popover.set_has_arrow(False)
        self._search_popover.set_child(results_box)

    def _on_search_changed(self, entry):
        query = entry.get_text().lower().strip()
        child = self._search_results.get_first_child()
        while child is not None:
            nxt = child.get_next_sibling()
            self._search_results.remove(child)
            child = nxt

        if not query:
            self._search_popover.popdown()
            return

        matches = [p for p in self._pm.projects if query in p["name"].lower()]
        if not matches:
            row = Gtk.ListBoxRow()
            row.set_selectable(False)
            lbl = Gtk.Label(label="No projects found")
            lbl.add_css_class("dim-label")
            lbl.set_margin_start(8)
            lbl.set_margin_top(6)
            lbl.set_margin_bottom(6)
            row.set_child(lbl)
            self._search_results.append(row)
        else:
            for p in matches:
                row = Gtk.ListBoxRow()
                row.project_id = p["id"]
                row.project_status = p.get("status", "inactive")
                box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
                box.set_margin_start(8)
                box.set_margin_end(8)
                box.set_margin_top(6)
                box.set_margin_bottom(4)
                name_lbl = Gtk.Label(label=p["name"], xalign=0)
                path_lbl = Gtk.Label(label=p.get("directory", ""), xalign=0)
                path_lbl.add_css_class("dim-label")
                path_lbl.set_ellipsize(Pango.EllipsizeMode.START)
                path_lbl.set_max_width_chars(22)
                box.append(name_lbl)
                box.append(path_lbl)
                row.set_child(box)
                self._search_results.append(row)

        self._search_popover.popup()
        GLib.idle_add(self._reclaim_search_focus)

    def _reclaim_search_focus(self) -> bool:
        self._search_entry.grab_focus()
        return False

    def _on_search_result_activated(self, _lb, row):
        if not hasattr(row, "project_id"):
            return
        pid = row.project_id
        self._search_popover.popdown()
        self._search_entry.set_text("")

        if pid in self._project_rows:
            if hasattr(self._center, "show_project_terminal"):
                self._center.show_project_terminal(pid)
        else:
            project = self._pm.get_project(pid)
            if project and self._on_activate_project:
                self._pm.set_project_status(pid, "active")
                project["status"] = "active"
                self._on_activate_project(project)

    # ── project list ──────────────────────────────────────────────────────────

    def _build_project_list(self):
        header = Gtk.Label(label="PROJECTS")
        header.get_style_context().add_class("panel-header")
        header.set_xalign(0)
        header.set_margin_start(8)
        header.set_margin_top(4)
        header.set_margin_bottom(4)
        self.append(header)

        scrolled = Gtk.ScrolledWindow()
        scrolled.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        scrolled.set_vexpand(True)
        self._listbox = Gtk.ListBox()
        self._listbox.set_selection_mode(Gtk.SelectionMode.SINGLE)
        self._listbox.set_sort_func(self._sort_rows)
        self._listbox.set_header_func(self._header_func)
        self._listbox.connect("row-selected", self._on_row_selected)
        self._listbox.connect("row-activated", self._on_row_activated)
        scrolled.set_child(self._listbox)
        self.append(scrolled)

    _STATUS_WEIGHT = {"current": 0, "active": 1}

    def _sort_rows(self, row1: Gtk.ListBoxRow, row2: Gtk.ListBoxRow) -> int:
        w1 = self._STATUS_WEIGHT.get(getattr(row1, "status", "active"), 1)
        w2 = self._STATUS_WEIGHT.get(getattr(row2, "status", "active"), 1)
        if w1 != w2:
            return -1 if w1 < w2 else 1
        p1 = getattr(row1, "position", 0)
        p2 = getattr(row2, "position", 0)
        return -1 if p1 < p2 else (1 if p1 > p2 else 0)

    def _header_func(self, row: Gtk.ListBoxRow, before: Gtk.ListBoxRow | None):
        if before is None:
            row.set_header(None)
            return
        before_status = getattr(before, "status", "active")
        row_status = getattr(row, "status", "active")
        if before_status == "current" and row_status == "active":
            sep = Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL)
            sep.set_margin_top(3)
            sep.set_margin_bottom(3)
            row.set_header(sep)
        else:
            row.set_header(None)

    # ── add button (popover) ──────────────────────────────────────────────────

    def _build_add_btn(self):
        self._add_btn = Gtk.Button(label="+")
        self._add_btn.get_style_context().add_class("new-project-btn")
        self._add_btn.set_margin_start(8)
        self._add_btn.set_margin_end(8)
        self._add_btn.set_margin_top(8)
        self._add_btn.set_margin_bottom(8)
        self._add_btn.connect("clicked", self._on_add_clicked)
        self.append(self._add_btn)

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
            new_item.connect("clicked", lambda _: (popover.popdown(), self._on_new_project()))

            import_item = Gtk.Button(label="Import Project")
            import_item.add_css_class("flat")
            import_item.connect("clicked", lambda _: (popover.popdown(), self._on_import_project()))

            box.append(new_item)
            box.append(import_item)
            popover.set_child(box)
            self._popover = popover

        self._popover.popup()

    # ── public API ────────────────────────────────────────────────────────────

    def add_project_row(self, project: dict):
        row = ProjectRow(project, on_close=self._on_project_close,
                         on_drop=self._on_project_dropped,
                         on_activate=self._activate_project)
        self._listbox.append(row)
        self._project_rows[project["id"]] = row
        self._listbox.select_row(row)

    def remove_project_row(self, project_id: str):
        row = self._project_rows.pop(project_id, None)
        if row is not None:
            self._listbox.remove(row)

    def set_active_project(self, project_id: str | None):
        old = self._active_project_id
        if old and old != project_id:
            self._pm.set_project_status(old, "active")
            row = self._project_rows.get(old)
            if row:
                row.status = "active"
        if project_id:
            self._pm.set_project_status(project_id, "current")
            row = self._project_rows.get(project_id)
            if row:
                row.status = "current"

        self._active_project_id = project_id
        for pid, row in self._project_rows.items():
            row.set_active(pid == project_id)
        self._listbox.invalidate_sort()
        self._listbox.invalidate_headers()

    def set_project_warm(self, project_id: str, warm: bool):
        row = self._project_rows.get(project_id)
        if row:
            row.set_warm(warm)

    def refresh_warm_states(self, projects: list):
        for p in projects:
            proj_dir = p.get("directory", "")
            local_file = p.get("local_file") or str(pathlib.Path(proj_dir) / "project.json")
            warm = False
            path = pathlib.Path(local_file)
            if path.exists():
                try:
                    data = json.loads(path.read_text())
                    warm = bool(data.get("open_apps"))
                except Exception:
                    pass
            row = self._project_rows.get(p["id"])
            if row:
                row.set_warm(warm)

    def update_time_bars(self, totals: dict):
        """Update all per-project time bars. totals: {project_id: seconds_today}."""
        max_time = max(totals.values(), default=0)
        for pid, row in self._project_rows.items():
            secs = totals.get(pid, 0.0)
            if secs > 0 and max_time > 0:
                fraction = secs / max_time
                h = int(secs // 3600)
                m = int((secs % 3600) // 60)
                label_text = f"{h}h {m}m" if h > 0 else f"{m}m"
                row.update_time_bar(fraction, f"{h}h {m}m today", label_text)
            else:
                row.update_time_bar(0, "", "")

    # ── drag-and-drop reorder ─────────────────────────────────────────────────

    def _on_project_dropped(self, source_id: str, target_id: str, before: bool):
        source_row = self._project_rows.get(source_id)
        target_row = self._project_rows.get(target_id)
        if not source_row or not target_row or source_id == target_id:
            return

        # Collect all active rows sorted by current position
        rows = sorted(self._project_rows.values(), key=lambda r: r.position)
        rows_without_src = [r for r in rows if r.project_id != source_id]

        # Find insertion index
        target_idx = next(
            (i for i, r in enumerate(rows_without_src) if r.project_id == target_id),
            len(rows_without_src) - 1,
        )
        if not before:
            target_idx += 1
        rows_without_src.insert(target_idx, source_row)

        # Reassign positions (multiples of 10)
        for i, row in enumerate(rows_without_src):
            new_pos = i * 10
            row.position = new_pos
            self._pm.set_project_position(row.project_id, new_pos)

        self._listbox.invalidate_sort()

    # ── callbacks ─────────────────────────────────────────────────────────────

    def _on_row_selected(self, _listbox, row):
        pass

    def _on_row_activated(self, _listbox, row):
        if isinstance(row, ProjectRow):
            self._activate_project(row.project_id)

    def _activate_project(self, project_id: str):
        if hasattr(self._center, "show_project_terminal"):
            self._center.show_project_terminal(project_id)

    def _on_project_close(self, project_id: str):
        project = self._pm.get_project(project_id)
        project_name = project["name"] if project else "project"
        project_dir = project.get("directory", "") if project else ""

        has_open_apps = False
        if project_dir:
            local_file = (project.get("local_file") if project else None) or str(
                pathlib.Path(project_dir) / "project.json"
            )
            path = pathlib.Path(local_file)
            if path.exists():
                try:
                    data = json.loads(path.read_text())
                    has_open_apps = bool(data.get("open_apps"))
                except Exception:
                    pass

        if has_open_apps:
            self._confirm_close_project(project_id, project_name)
        else:
            self._do_close_project(project_id)

    def _confirm_close_project(self, project_id: str, project_name: str):
        win = Gtk.Window()
        win.set_title("Close Project")
        win.set_modal(True)
        win.set_resizable(False)
        root = self._gear_btn.get_root()
        if isinstance(root, Gtk.Window):
            win.set_transient_for(root)

        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        box.set_margin_start(20)
        box.set_margin_end(20)
        box.set_margin_top(20)
        box.set_margin_bottom(16)

        lbl = Gtk.Label(
            label=f"Close {project_name}?\n\nAny unsaved work in open applications may be lost.",
            xalign=0,
        )
        lbl.set_wrap(True)
        box.append(lbl)

        btn_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        btn_row.set_halign(Gtk.Align.END)

        cancel_btn = Gtk.Button(label="Cancel")
        cancel_btn.add_css_class("flat")
        cancel_btn.connect("clicked", lambda _: win.close())

        close_btn = Gtk.Button(label="Close Project")
        close_btn.add_css_class("destructive-action")
        close_btn.connect("clicked", lambda _: (win.close(), self._do_close_project(project_id)))

        btn_row.append(cancel_btn)
        btn_row.append(close_btn)
        box.append(btn_row)

        win.set_child(box)
        win.present()

    def _do_close_project(self, project_id: str):
        if project_id == self._active_project_id:
            self._active_project_id = None
        self.remove_project_row(project_id)
        if hasattr(self._center, "remove_project_terminal"):
            self._center.remove_project_terminal(project_id)
        self._pm.deactivate_project(project_id)
