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
from panels.center_panel import CenterPanel, _MASTER_PAGE
from panels.left_panel import LeftPanel
from panels.right_panel import RightPanel
from eldrun import set_theme

_LEFT_WIDTH = 220
_RIGHT_WIDTH = 220


class EldrunWindow(Adw.ApplicationWindow):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)

        self.set_title("Eldrun")
        self.set_default_size(1440, 900)
        self.set_decorated(False)

        self._fullscreen = False
        self._panels_hidden = False
        self._left_hidden = False
        self._right_hidden = False
        self.project_manager = ProjectManager()
        self.settings_manager = SettingsManager()
        self.default_apps_manager = DefaultAppsManager()
        self._time_tracker = TimeTracker()
        set_theme(self.settings_manager.get("color_scheme") != "light")
        GLib.idle_add(self._bootstrap_default_apps)
        self._add_key_controller()
        self._build_layout()
        self.maximize()
        self._network_monitor = NetworkMonitor(self._on_network_status_changed)
        GLib.timeout_add(60_000, self._on_time_tick)

        self.connect("notify::maximized", self._on_maximized_notify)

    # ── keyboard ──────────────────────────────────────────────────────────────

    def _add_key_controller(self):
        ctrl = Gtk.EventControllerKey()
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

        if keyval == Gdk.KEY_Tab and (state & Gdk.ModifierType.SHIFT_MASK):
            self._left_panel.cycle_next_app()
            return True

        return False

    # ── header bar ────────────────────────────────────────────────────────────

    def _build_header(self) -> Gtk.WindowHandle:
        center_box = Gtk.CenterBox()
        center_box.add_css_class("app-header")

        # Left: status lamp + connection type icon
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

        # Center: title
        title = Gtk.Label(label="ELDRUN")
        title.add_css_class("app-title")
        center_box.set_center_widget(title)

        # Right: WM buttons
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

        center_box.set_end_widget(btn_box)

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
        GLib.idle_add(self._init_inner_paned)

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
        self._left_panel = LeftPanel(
            center_panel=self._center_panel,
            default_apps_manager=self.default_apps_manager,
            on_warm_changed=self._on_project_warm_changed,
        )
        self._right_panel = RightPanel(
            self.project_manager,
            self._center_panel,
            on_new_project=self._on_new_project_clicked,
            on_import_project=self._on_import_project_clicked,
            settings_manager=self.settings_manager,
            default_apps_manager=self.default_apps_manager,
            on_toggle_theme=self._on_toggle_theme,
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

        self._left_toggle_btn = Gtk.Button(label="‹")
        self._left_toggle_btn.add_css_class("panel-edge-btn")
        self._left_toggle_btn.set_valign(Gtk.Align.CENTER)
        self._left_toggle_btn.set_halign(Gtk.Align.START)
        self._left_toggle_btn.set_margin_start(_LEFT_WIDTH - 16)
        self._left_toggle_btn.set_tooltip_text("Hide left panel")
        self._left_toggle_btn.connect("clicked", lambda _: self._toggle_left_panel())

        self._right_toggle_btn = Gtk.Button(label="›")
        self._right_toggle_btn.add_css_class("panel-edge-btn")
        self._right_toggle_btn.set_valign(Gtk.Align.CENTER)
        self._right_toggle_btn.set_halign(Gtk.Align.END)
        self._right_toggle_btn.set_margin_end(_RIGHT_WIDTH - 16)
        self._right_toggle_btn.set_tooltip_text("Hide right panel")
        self._right_toggle_btn.connect("clicked", lambda _: self._toggle_right_panel())

        overlay = Gtk.Overlay()
        overlay.set_child(self._outer_paned)
        overlay.add_overlay(self._left_toggle_btn)
        overlay.add_overlay(self._right_toggle_btn)
        overlay.set_hexpand(True)
        overlay.set_vexpand(True)

        root.append(overlay)
        self.connect("map", self._on_map)

    def _on_map(self, *_):
        self._outer_paned.set_position(_LEFT_WIDTH)
        for p in self.project_manager.projects:
            self._center_panel.add_project_terminal(p)
            self._right_panel.add_project_row(p)
        self._center_panel.open_master_terminal()
        self._right_panel.refresh_warm_states(self.project_manager.projects)
        GLib.idle_add(self._init_inner_paned)

    def _init_inner_paned(self):
        outer_w = self._outer_paned.get_allocated_width() or 1440
        page = self._center_panel._stack.get_visible_child_name() or "empty"
        show_left = (page.startswith("project-")
                     and not self._left_hidden and not self._panels_hidden)
        show_right = not self._right_hidden and not self._panels_hidden
        left_w = _LEFT_WIDTH if show_left else 0
        if show_right:
            self._inner_paned.set_position(max(400, outer_w - left_w - _RIGHT_WIDTH))
        return False

    # ── panel toggle (Super key + individual buttons) ─────────────────────────

    def _update_toggle_btns(self, show_left: bool, show_right: bool):
        if show_left:
            self._left_toggle_btn.set_label("‹")
            self._left_toggle_btn.set_margin_start(_LEFT_WIDTH - 16)
            self._left_toggle_btn.set_tooltip_text("Hide left panel")
        else:
            self._left_toggle_btn.set_label("›")
            self._left_toggle_btn.set_margin_start(2)
            self._left_toggle_btn.set_tooltip_text("Show left panel")

        if show_right:
            self._right_toggle_btn.set_label("›")
            self._right_toggle_btn.set_margin_end(_RIGHT_WIDTH - 16)
            self._right_toggle_btn.set_tooltip_text("Hide right panel")
        else:
            self._right_toggle_btn.set_label("‹")
            self._right_toggle_btn.set_margin_end(2)
            self._right_toggle_btn.set_tooltip_text("Show right panel")

    def _on_center_page_changed(self, page_name: str):
        self._apply_panel_visibility()

    def _apply_panel_visibility(self):
        page = self._center_panel._stack.get_visible_child_name() or "empty"
        show_left = (page.startswith("project-")
                     and not self._left_hidden
                     and not self._panels_hidden)
        show_right = not self._right_hidden and not self._panels_hidden

        self._left_panel.set_visible(show_left)
        self._right_panel.set_visible(show_right)
        self._update_toggle_btns(show_left, show_right)

        # GTK4 Paned does not auto-collapse when a child is hidden — positions
        # must be set explicitly to reclaim the space.
        self._outer_paned.set_position(_LEFT_WIDTH if show_left else 0)

        if not show_right:
            self._inner_paned.set_position(9999)  # clamped to paned max
        elif self._outer_paned.get_allocated_width() > 0:
            outer_w = self._outer_paned.get_allocated_width()
            left_w = _LEFT_WIDTH if show_left else 0
            self._inner_paned.set_position(max(400, outer_w - left_w - _RIGHT_WIDTH))

        if page.startswith("project-"):
            project_id = page[len("project-"):]
            project = self.project_manager.get_project(project_id)
            self._left_panel.update_project(project)
            self._right_panel.set_active_project(project_id)
            if project:
                self._time_tracker.on_project_activated(project)
            self._refresh_time_bars()
        else:
            self._left_panel.update_project(None)
            self._right_panel.set_active_project(None)
            self._time_tracker.on_project_deactivated()
            self._refresh_time_bars()

    def _toggle_panels(self):
        self._panels_hidden = not self._panels_hidden
        self._apply_panel_visibility()

    def _toggle_left_panel(self):
        self._left_hidden = not self._left_hidden
        self._apply_panel_visibility()

    def _toggle_right_panel(self):
        self._right_hidden = not self._right_hidden
        self._apply_panel_visibility()

    def _on_toggle_theme(self, is_dark: bool):
        set_theme(is_dark)
        self.settings_manager.set("color_scheme", "dark" if is_dark else "light")
        self._center_panel.apply_theme(is_dark)

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

    def _on_project_warm_changed(self, project_id: str, warm: bool):
        self._right_panel.set_project_warm(project_id, warm)

    def _bootstrap_default_apps(self) -> bool:
        self.default_apps_manager.bootstrap_from_system()
        return False

    # ── network status (Phase 14) ─────────────────────────────────────────────

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

    # ── time tracking (Phase 15) ──────────────────────────────────────────────

    def _on_time_tick(self) -> bool:
        self._refresh_time_bars()
        return True

    def _refresh_time_bars(self):
        totals = self._time_tracker.get_today_totals()
        self._right_panel.update_time_bars(totals)
