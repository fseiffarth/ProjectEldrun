import atexit
import datetime as _dt
import os
import signal
import subprocess
import time

import gi
gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")
gi.require_version("Gdk", "4.0")
from gi.repository import Gtk, Adw, Gdk, GLib

from project_manager import ProjectManager
from settings_manager import SettingsManager
from default_apps_manager import DefaultAppsManager
from network_monitor import NetworkMonitor
from time_tracker import TimeTracker
from workspace_manager import WorkspaceManager
from panels.center_panel import CenterPanel, _MASTER_PAGE
from panels.right_panel import FileTreePanel
from panels.bottom_panel import BottomPanel, project_has_open_apps
from eldrun import set_theme

_LEFT_WIDTH = 220
_BOTTOM_HEIGHT = 40

_SUPER_KEY_BINDINGS: list[tuple[str, str]] = [
    ("org.gnome.shell.keybindings",    "overlay-key"),
    ("org.cinnamon.desktop.keybindings", "panel-main-menu"),
]


def _detect_super_binding() -> tuple[str, str] | None:
    for schema, key in _SUPER_KEY_BINDINGS:
        try:
            r = subprocess.run(
                ["gsettings", "get", schema, key],
                capture_output=True, text=True, timeout=2,
            )
            if r.returncode == 0:
                return schema, key
        except Exception:
            pass
    return None


_SUPER_BINDING = _detect_super_binding()


def _get_super_key_value() -> str:
    if _SUPER_BINDING is None:
        return ""
    schema, key = _SUPER_BINDING
    try:
        r = subprocess.run(
            ["gsettings", "get", schema, key],
            capture_output=True, text=True, timeout=2,
        )
        return r.stdout.strip().strip("'\"")
    except Exception:
        return ""


def _set_super_key_value(value: str) -> None:
    if _SUPER_BINDING is None:
        return
    schema, key = _SUPER_BINDING
    try:
        subprocess.Popen(
            ["gsettings", "set", schema, key, value],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    except Exception:
        pass


class EldrunWindow(Adw.ApplicationWindow):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)

        self.set_title("Eldrun")
        self.set_default_size(1440, 900)
        self.set_decorated(False)

        self._fullscreen = False
        self._panels_hidden = False
        self._file_tree_hidden = False
        self._active_project_id: str | None = None
        self.project_manager = ProjectManager()
        self.settings_manager = SettingsManager()
        self.default_apps_manager = DefaultAppsManager()
        self._time_tracker = TimeTracker()
        self._workspace_manager = WorkspaceManager()
        set_theme(self.settings_manager.get("color_scheme") != "light")
        GLib.idle_add(self._bootstrap_default_apps)
        self._add_key_controller()
        self._build_layout()
        self.maximize()
        self._network_monitor = NetworkMonitor(self._on_network_status_changed)
        GLib.timeout_add(60_000, self._on_time_tick)
        GLib.timeout_add_seconds(30, self._update_clock)

        self._original_super_value = _get_super_key_value()
        atexit.register(self._restore_super_key)
        self.connect("notify::is-active", self._on_active_changed)
        self.connect("notify::maximized", self._on_maximized_notify)
        self.connect("destroy", self._on_destroy)

    # ── Super-key interception ────────────────────────────────────────────────

    def _on_active_changed(self, win, _pspec):
        if win.is_active():
            _set_super_key_value("[]" if _SUPER_BINDING and
                                 _SUPER_BINDING[0].startswith("org.cinnamon") else "")
        else:
            self._restore_super_key()

    def _restore_super_key(self):
        _set_super_key_value(self._original_super_value)

    def _on_destroy(self, _win):
        self._restore_super_key()
        self.project_manager.set_all_inactive()
        if self._wm_enabled:
            self._workspace_manager.release_all()

    # ── keyboard ──────────────────────────────────────────────────────────────

    def _add_key_controller(self):
        ctrl = Gtk.EventControllerKey()
        ctrl.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
        ctrl.connect("key-pressed", self._on_key_pressed)
        self.add_controller(ctrl)

    def _on_key_pressed(self, _ctrl, keyval, keycode, state):
        if keyval == Gdk.KEY_F11:
            if self._fullscreen:
                self.unfullscreen()
            else:
                self.fullscreen()
            self._fullscreen = not self._fullscreen
            return True

        if keyval in (Gdk.KEY_Super_L, Gdk.KEY_Super_R):
            self._toggle_panels()
            return True

        return False

    # ── header bar ────────────────────────────────────────────────────────────

    def _build_header(self) -> Gtk.WindowHandle:
        center_box = Gtk.CenterBox()
        center_box.add_css_class("app-header")

        left_status = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=2)
        left_status.set_valign(Gtk.Align.CENTER)

        self._status_lamp = Gtk.Label(label="●")
        self._status_lamp.add_css_class("status-lamp")
        self._status_lamp.add_css_class("status-online")
        self._status_lamp.set_tooltip_text("Online")
        self._status_lamp.set_valign(Gtk.Align.CENTER)
        left_status.append(self._status_lamp)

        self._conn_icon = Gtk.Image()
        self._conn_icon.set_pixel_size(14)
        self._conn_icon.set_valign(Gtk.Align.CENTER)
        self._conn_icon.add_css_class("conn-type-label")
        self._conn_icon.set_visible(False)
        left_status.append(self._conn_icon)

        center_box.set_start_widget(left_status)

        self._header_clock = Gtk.Label()
        self._header_clock.add_css_class("app-title")
        self._tick_header_clock()
        GLib.timeout_add_seconds(1, self._tick_header_clock)
        center_box.set_center_widget(self._header_clock)

        right_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        right_box.set_valign(Gtk.Align.CENTER)
        right_box.set_margin_end(8)

        btn_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=0)
        btn_box.set_valign(Gtk.Align.CENTER)

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

        right_box.append(btn_box)
        center_box.set_end_widget(right_box)

        handle = Gtk.WindowHandle()
        handle.set_child(center_box)
        return handle

    def _on_maximize_clicked(self, _btn):
        if self.is_maximized():
            self.unmaximize()
        else:
            self.maximize()

    def _on_maximized_notify(self, win, _pspec):
        self._max_btn.set_tooltip_text("Restore" if win.is_maximized() else "Maximize")

    def _tick_header_clock(self) -> bool:
        self._header_clock.set_label(_dt.datetime.now().strftime("%H:%M"))
        return True

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
        self._center_panel.set_hexpand(True)
        self._center_panel.set_vexpand(True)
        self._center_panel.set_margin_bottom(_BOTTOM_HEIGHT)

        self._file_tree_panel = FileTreePanel(
            center_panel=self._center_panel,
            default_apps_manager=self.default_apps_manager,
        )
        self._file_tree_panel.set_halign(Gtk.Align.END)
        self._file_tree_panel.set_valign(Gtk.Align.FILL)
        self._file_tree_panel.set_margin_bottom(_BOTTOM_HEIGHT)

        self._bottom_panel = BottomPanel(
            on_root=self._on_root_clicked,
            on_new_project=self._on_new_project_clicked,
            on_import_project=self._on_import_project_clicked,
            on_toggle_file_tree_panel=self._toggle_file_tree_panel,
            on_activate_project=self._on_pill_activate,
            on_close_project=self._on_pill_close,
            project_manager=self.project_manager,
            settings_manager=self.settings_manager,
            default_apps_manager=self.default_apps_manager,
            on_toggle_theme=self._on_toggle_theme,
            on_terminal_changed=self._on_terminal_changed,
            on_search_project=self._on_search_project_selected,
        )

        overlay = Gtk.Overlay()
        overlay.set_child(self._center_panel)
        overlay.add_overlay(self._file_tree_panel)
        overlay.add_overlay(self._bottom_panel)
        overlay.set_hexpand(True)
        overlay.set_vexpand(True)

        root.append(overlay)
        self.connect("map", self._on_map)

    @property
    def _wm_enabled(self) -> bool:
        return bool(self.settings_manager.get("workspace_management"))

    def _on_map(self, *_):
        from project_stats import scan_project_background
        visible = self.project_manager.get_visible_projects()
        current_id = next(
            (p["id"] for p in visible if p.get("status") == "current"),
            None,
        )
        for p in visible:
            self._center_panel.add_project_terminal(p, show=False)
            self._bottom_panel.add_project_pill(p)
            scan_project_background(p)
        for p in self.project_manager.projects:
            if p.get("status") == "inactive":
                scan_project_background(p)
        if current_id:
            self._center_panel.show_project_terminal(current_id)
        else:
            self._center_panel.open_master_terminal()
        self._bottom_panel.refresh_warm_states(visible)
        if self._wm_enabled:
            GLib.idle_add(self._setup_workspaces)

    # ── workspace management ──────────────────────────────────────────────────

    def _setup_workspaces(self) -> bool:
        """Called once after map: make Eldrun sticky, allocate workspaces for visible projects."""
        try:
            import gi as _gi
            _gi.require_version("GdkX11", "4.0")
            from gi.repository import GdkX11
            surface = self.get_surface()
            if isinstance(surface, GdkX11.X11Surface):
                self._workspace_manager.make_eldrun_sticky(surface.get_xid())
        except Exception:
            pass
        for p in self.project_manager.get_visible_projects():
            self._workspace_manager.allocate(p["id"], p["name"])
        return False

    # ── panel toggle ──────────────────────────────────────────────────────────

    def _update_toggle_btn(self, show_panel: bool):
        self._bottom_panel.set_left_panel_shown(show_panel)

    def _on_center_page_changed(self, page_name: str):
        self._apply_panel_visibility()

    def _apply_panel_visibility(self):
        page = self._center_panel._stack.get_visible_child_name() or "empty"
        is_project_page = page.startswith("project-")
        is_agent_page = page.startswith("agent-") or page.startswith("term-") or page == "no-tabs"

        if not is_agent_page:
            if is_project_page:
                project_id = page[len("project-"):]
                self._active_project_id = project_id
                project = self.project_manager.get_project(project_id)
                self._file_tree_panel.update_project(project)
                self._bottom_panel.set_active_project(project_id)
                self._bottom_panel.set_root_active(False)
                if project:
                    self._time_tracker.on_project_activated(project)
                self._refresh_time_bars()
            else:
                self._active_project_id = None
                self._file_tree_panel.update_project(None)
                self._bottom_panel.set_active_project(None)
                self._bottom_panel.set_root_active(page == _MASTER_PAGE)
                self._time_tracker.on_project_deactivated()
                self._refresh_time_bars()

        show_panel = (self._active_project_id is not None
                      and not self._file_tree_hidden
                      and not self._panels_hidden)
        self._file_tree_panel.set_visible(show_panel)
        self._update_toggle_btn(show_panel)
        self._bottom_panel.set_panel_toggle_visible(self._active_project_id is not None)

    def _toggle_panels(self):
        self._panels_hidden = not self._panels_hidden
        self._apply_panel_visibility()

    def _toggle_file_tree_panel(self):
        self._file_tree_hidden = not self._file_tree_hidden
        self._apply_panel_visibility()

    def _on_toggle_theme(self, is_dark: bool):
        set_theme(is_dark)
        self.settings_manager.set("color_scheme", "dark" if is_dark else "light")
        self._center_panel.apply_theme(is_dark)

    def _on_terminal_changed(self):
        if hasattr(self._center_panel, "respawn_all"):
            self._center_panel.respawn_all()

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
        from project_stats import scan_project_background
        self._bottom_panel.add_project_pill(project)
        self._center_panel.add_project_terminal(project)
        scan_project_background(project)
        if self._wm_enabled:
            self._workspace_manager.allocate(project["id"], project["name"])

    def _on_search_project_selected(self, project_id: str):
        project = self.project_manager.get_project(project_id)
        if project is None:
            return
        if project.get("status") == "inactive":
            self.project_manager.set_project_status(project_id, "active")
            project["status"] = "active"
        if not self._bottom_panel.has_project_pill(project_id):
            from project_stats import scan_project_background
            self._bottom_panel.add_project_pill(project)
            scan_project_background(project)
        self._center_panel.add_project_terminal(project)
        self._bottom_panel.refresh_warm_states(self.project_manager.get_visible_projects())
        if self._wm_enabled:
            self._workspace_manager.allocate(project["id"], project["name"])
            self._workspace_manager.activate(project_id)

    def _on_root_clicked(self):
        self._center_panel.open_master_terminal()

    def _on_pill_activate(self, project_id: str):
        self._center_panel.show_project_terminal(project_id)
        if self._wm_enabled:
            self._workspace_manager.activate(project_id)

    def _on_pill_close(self, project_id: str):
        project = self.project_manager.get_project(project_id)
        project_name = project["name"] if project else "project"
        project_dir = project.get("directory", "") if project else ""

        has_open_apps = bool(project_dir and project and project_has_open_apps(project))

        if has_open_apps:
            self._confirm_close_project(project_id, project_name)
        else:
            self._do_close_project(project_id)

    def _confirm_close_project(self, project_id: str, project_name: str):
        win = Gtk.Window()
        win.set_title("Close Project")
        win.set_modal(True)
        win.set_resizable(False)
        win.set_transient_for(self)

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
        close_btn.connect(
            "clicked", lambda _: (win.close(), self._do_close_project(project_id))
        )

        btn_row.append(cancel_btn)
        btn_row.append(close_btn)
        box.append(btn_row)

        win.set_child(box)
        win.present()

    def _do_close_project(self, project_id: str):
        was_active = (self._active_project_id == project_id)
        self._bottom_panel.remove_project_pill(project_id)
        if hasattr(self._center_panel, "remove_project_terminal"):
            self._center_panel.remove_project_terminal(project_id)
        self.project_manager.deactivate_project(project_id)
        if self._wm_enabled:
            self._workspace_manager.release(project_id)
        if was_active:
            self._active_project_id = None
            self._on_root_clicked()

    def _bootstrap_default_apps(self) -> bool:
        self.default_apps_manager.bootstrap_from_system()
        return False

    # ── network status ────────────────────────────────────────────────────────

    _CONN_ICONS = {
        "wlan": "network-wireless-symbolic",
        "lan": "network-wired-symbolic",
    }

    def _on_network_status_changed(self, is_online: bool,
                                   last_success_ts: float | None,
                                   connection_type: str = "disconnected"):
        lamp = self._status_lamp
        if is_online:
            lamp.remove_css_class("status-offline")
            lamp.add_css_class("status-online")
            lamp.set_tooltip_text("Online")
        else:
            lamp.remove_css_class("status-online")
            lamp.add_css_class("status-offline")
            ts_str = ""
            if last_success_ts is not None:
                import datetime as _dt
                ts_str = " — last online " + _dt.datetime.fromtimestamp(
                    last_success_ts
                ).strftime("%H:%M:%S")
            lamp.set_tooltip_text(f"Offline{ts_str}")
        self._center_panel.set_offline(not is_online)

        icon_name = self._CONN_ICONS.get(connection_type)
        if icon_name:
            self._conn_icon.set_from_icon_name(icon_name)
            self._conn_icon.set_visible(True)
        else:
            self._conn_icon.set_visible(False)

    # ── time tracking ─────────────────────────────────────────────────────────

    def _update_clock(self) -> bool:
        return True

    def _on_time_tick(self) -> bool:
        self._refresh_time_bars()
        return True

    def _refresh_time_bars(self):
        totals = self._time_tracker.get_today_totals()
        self._bottom_panel.update_time_bars(totals)
