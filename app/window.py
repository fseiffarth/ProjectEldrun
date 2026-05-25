import gi
gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")
gi.require_version("Gdk", "4.0")
from gi.repository import Gtk, Adw, Gdk, GLib

from project_manager import ProjectManager
from settings_manager import SettingsManager
from panels.center_panel import CenterPanel, _MASTER_PAGE
from panels.left_panel import LeftPanel
from panels.right_panel import RightPanel

_LEFT_WIDTH = 220
_RIGHT_WIDTH = 280


class EldrunWindow(Adw.ApplicationWindow):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)

        self.set_title("Eldrun")
        self.set_default_size(1440, 900)
        self.set_decorated(False)

        self._fullscreen = False
        self.project_manager = ProjectManager()
        self.settings_manager = SettingsManager()
        self._add_key_controller()
        self._build_layout()

        self.connect("notify::maximized", self._on_maximized_notify)

    # ── keyboard ──────────────────────────────────────────────────────────────

    def _add_key_controller(self):
        ctrl = Gtk.EventControllerKey()
        ctrl.connect("key-pressed", self._on_key_pressed)
        self.add_controller(ctrl)

    def _on_key_pressed(self, _ctrl, keyval, _keycode, _state):
        if keyval == Gdk.KEY_F11:
            if self._fullscreen:
                self.unfullscreen()
            else:
                self.fullscreen()
            self._fullscreen = not self._fullscreen
            return True
        return False

    # ── header bar ────────────────────────────────────────────────────────────

    def _build_header(self) -> Gtk.WindowHandle:
        header_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL)
        header_box.add_css_class("app-header")

        title = Gtk.Label(label="ELDRUN")
        title.add_css_class("app-title")
        title.set_hexpand(True)
        title.set_halign(Gtk.Align.CENTER)
        header_box.append(title)

        btn_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=0)
        btn_box.set_valign(Gtk.Align.CENTER)
        btn_box.set_margin_end(8)

        min_btn = Gtk.Button()
        min_btn.add_css_class("flat")
        min_btn.add_css_class("wm-btn")
        min_btn.add_css_class("wm-minimize")
        min_btn.set_tooltip_text("Minimize")
        min_btn.connect("clicked", lambda _: self.minimize())
        btn_box.append(min_btn)

        self._max_btn = Gtk.Button()
        self._max_btn.add_css_class("flat")
        self._max_btn.add_css_class("wm-btn")
        self._max_btn.add_css_class("wm-maximize")
        self._max_btn.set_tooltip_text("Maximize")
        self._max_btn.connect("clicked", self._on_maximize_clicked)
        btn_box.append(self._max_btn)

        close_btn = Gtk.Button()
        close_btn.add_css_class("flat")
        close_btn.add_css_class("wm-btn")
        close_btn.add_css_class("wm-close")
        close_btn.set_tooltip_text("Close")
        close_btn.connect("clicked", lambda _: self.get_application().quit())
        btn_box.append(close_btn)

        header_box.append(btn_box)

        handle = Gtk.WindowHandle()
        handle.set_child(header_box)
        return handle

    def _on_maximize_clicked(self, _btn):
        if self.is_maximized():
            self.unmaximize()
        else:
            self.maximize()

    def _on_maximized_notify(self, win, _pspec):
        self._max_btn.set_tooltip_text("Restore" if win.is_maximized() else "Maximize")

    # ── layout ────────────────────────────────────────────────────────────────

    def _build_layout(self):
        root = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        self.set_content(root)

        root.append(self._build_header())

        self._center_panel = CenterPanel(
            self.project_manager,
            on_page_changed=self._on_center_page_changed,
            settings_manager=self.settings_manager,
        )
        self._left_panel  = LeftPanel(center_panel=self._center_panel)
        self._right_panel = RightPanel(
            self.project_manager,
            self._center_panel,
            on_new_project=self._on_new_project_clicked,
            on_import_project=self._on_import_project_clicked,
            settings_manager=self.settings_manager,
        )

        self._inner_paned = Gtk.Paned(orientation=Gtk.Orientation.HORIZONTAL)
        self._inner_paned.set_start_child(self._center_panel)
        self._inner_paned.set_end_child(self._right_panel)
        self._inner_paned.set_resize_start_child(True)
        self._inner_paned.set_shrink_start_child(False)
        self._inner_paned.set_resize_end_child(False)
        self._inner_paned.set_shrink_end_child(False)

        self._outer_paned = Gtk.Paned(orientation=Gtk.Orientation.HORIZONTAL)
        self._outer_paned.set_start_child(self._left_panel)
        self._outer_paned.set_end_child(self._inner_paned)
        self._outer_paned.set_resize_start_child(False)
        self._outer_paned.set_shrink_start_child(False)
        self._outer_paned.set_resize_end_child(True)
        self._outer_paned.set_shrink_end_child(False)
        self._outer_paned.set_hexpand(True)
        self._outer_paned.set_vexpand(True)

        root.append(self._outer_paned)
        self.connect("map", self._on_map)

    def _on_map(self, *_):
        w = self.get_allocated_width() or 1440
        self._outer_paned.set_position(_LEFT_WIDTH)
        self._inner_paned.set_position(max(400, w - _LEFT_WIDTH - _RIGHT_WIDTH))
        for p in self.project_manager.projects:
            self._center_panel.add_project_terminal(p)
            self._right_panel.add_project_row(p)
        self._center_panel.open_master_terminal()

    # ── left panel visibility + project context ───────────────────────────────

    def _on_center_page_changed(self, page_name: str):
        show_left = page_name.startswith("project-")
        self._left_panel.set_visible(show_left)
        if show_left:
            self._outer_paned.set_position(_LEFT_WIDTH)
            project_id = page_name[len("project-"):]
            project = self.project_manager.get_project(project_id)
            self._left_panel.update_project(project)
            self._right_panel.set_active_project(project_id)
        else:
            self._left_panel.update_project(None)
            self._right_panel.set_active_project(None)

    # ── project dialog handlers ───────────────────────────────────────────────

    def _on_new_project_clicked(self):
        from new_project_dialog import NewProjectDialog
        NewProjectDialog(
            parent=self,
            project_manager=self.project_manager,
            on_created=self._on_project_created,
        ).present()

    def _on_import_project_clicked(self):
        from import_project_dialog import ImportProjectDialog
        ImportProjectDialog(
            parent=self,
            project_manager=self.project_manager,
            on_imported=self._on_project_created,
        ).present()

    def _on_project_created(self, project: dict):
        self._center_panel.add_project_terminal(project)
        self._right_panel.add_project_row(project)
