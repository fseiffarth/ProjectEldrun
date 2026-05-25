import json
import pathlib

import gi
gi.require_version("Gtk", "4.0")
from gi.repository import Gtk, Pango


class ProjectRow(Gtk.ListBoxRow):
    def __init__(self, project: dict, on_close):
        super().__init__()
        self.project_id = project["id"]
        self.project_name = project["name"]
        self.get_style_context().add_class("project-row")

        vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)

        box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        box.set_margin_start(10)
        box.set_margin_end(4)
        box.set_margin_top(6)
        box.set_margin_bottom(2)

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

        self._time_bar = Gtk.ProgressBar()
        self._time_bar.add_css_class("project-time-bar")
        self._time_bar.set_fraction(0.0)
        self._time_bar.set_visible(False)
        self._time_bar.set_margin_start(10)
        self._time_bar.set_margin_end(10)
        self._time_bar.set_margin_bottom(4)
        vbox.append(self._time_bar)

        self.set_child(vbox)

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

    def update_time_bar(self, fraction: float, tooltip: str):
        if fraction > 0:
            self._time_bar.set_fraction(min(1.0, fraction))
            self._time_bar.set_tooltip_text(tooltip)
            self._time_bar.set_visible(True)
        else:
            self._time_bar.set_visible(False)


_TERMINAL_OPTIONS = ["claude", "codex"]


class RightPanel(Gtk.Box):
    def __init__(self, project_manager, center_panel, on_new_project, on_import_project,
                 settings_manager=None, default_apps_manager=None, on_toggle_theme=None):
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
        self._project_rows: dict[str, ProjectRow] = {}
        self._active_project_id: str | None = None
        self._popover: Gtk.Popover | None = None

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
        box.append(scrolled)

        win.set_child(box)
        win.present()

    # ── search entry ──────────────────────────────────────────────────────────

    def _build_search(self):
        self._search_entry = Gtk.SearchEntry()
        self._search_entry.set_placeholder_text("Search projects…")
        self._search_entry.set_margin_start(8)
        self._search_entry.set_margin_end(8)
        self._search_entry.set_margin_top(4)
        self._search_entry.set_margin_bottom(4)
        self._search_entry.connect("search-changed", self._on_search_changed)
        self._search_entry.connect("activate", self._on_search_activate)
        self.append(self._search_entry)

        sep = Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL)
        sep.set_margin_top(2)
        sep.set_margin_bottom(4)
        self.append(sep)

    def _on_search_changed(self, _entry):
        self._listbox.invalidate_filter()

    def _on_search_activate(self, entry):
        query = entry.get_text().lower().strip()
        if not query:
            return
        matching = [
            row for row in self._project_rows.values()
            if query in row.project_name.lower()
        ]
        if len(matching) == 1:
            self._listbox.select_row(matching[0])
            self._on_row_selected(self._listbox, matching[0])
            entry.set_text("")

    def _row_filter(self, row: Gtk.ListBoxRow) -> bool:
        if not isinstance(row, ProjectRow):
            return True
        query = self._search_entry.get_text().lower().strip()
        if not query:
            return True
        return query in row.project_name.lower()

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
        self._listbox.set_filter_func(self._row_filter)
        self._listbox.connect("row-selected", self._on_row_selected)
        scrolled.set_child(self._listbox)
        self.append(scrolled)

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
        row = ProjectRow(project, on_close=self._on_project_close)
        self._listbox.append(row)
        self._project_rows[project["id"]] = row
        self._listbox.select_row(row)

    def remove_project_row(self, project_id: str):
        row = self._project_rows.pop(project_id, None)
        if row is not None:
            self._listbox.remove(row)

    def set_active_project(self, project_id: str | None):
        self._active_project_id = project_id
        for pid, row in self._project_rows.items():
            row.set_active(pid == project_id)

    def set_project_warm(self, project_id: str, warm: bool):
        row = self._project_rows.get(project_id)
        if row:
            row.set_warm(warm)

    def refresh_warm_states(self, projects: list):
        for p in projects:
            proj_dir = p.get("directory", "")
            path = pathlib.Path(proj_dir) / "open_apps.json"
            warm = False
            if path.exists():
                try:
                    data = json.loads(path.read_text())
                    warm = bool(data)
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
                row.update_time_bar(fraction, f"{h}h {m}m today")
            else:
                row.update_time_bar(0, "")

    # ── callbacks ─────────────────────────────────────────────────────────────

    def _on_row_selected(self, _listbox, row):
        if row is not None and isinstance(row, ProjectRow):
            if hasattr(self._center, "show_project_terminal"):
                self._center.show_project_terminal(row.project_id)

    def _on_project_close(self, project_id: str):
        self.remove_project_row(project_id)
        if hasattr(self._center, "remove_project_terminal"):
            self._center.remove_project_terminal(project_id)
        self._pm.remove_project(project_id)
