import gi
gi.require_version("Gtk", "4.0")
from gi.repository import Gtk, Pango


class ProjectRow(Gtk.ListBoxRow):
    def __init__(self, project: dict, on_close):
        super().__init__()
        self.project_id = project["id"]
        self.project_name = project["name"]
        self.get_style_context().add_class("project-row")

        box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        box.set_margin_start(10)
        box.set_margin_end(4)
        box.set_margin_top(6)
        box.set_margin_bottom(6)

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

        self.set_child(box)


_TERMINAL_OPTIONS = ["claude", "codex"]


class RightPanel(Gtk.Box):
    def __init__(self, project_manager, center_panel, on_new_project, on_import_project,
                 settings_manager=None):
        super().__init__(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        self.get_style_context().add_class("panel-right")
        self.set_size_request(280, -1)

        self._pm = project_manager
        self._center = center_panel
        self._settings = settings_manager
        self._on_new_project = on_new_project
        self._on_import_project = on_import_project
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

        # Terminal command row
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
            if pid == project_id:
                row.get_style_context().add_class("project-row-active")
            else:
                row.get_style_context().remove_class("project-row-active")

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
