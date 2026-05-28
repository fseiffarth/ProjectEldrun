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
from global_apps_manager import GlobalAppsManager, ROLES, select_role_icon
from network_monitor import NetworkMonitor
from time_tracker import TimeTracker
from workspace_manager import WorkspaceManager
from panels.center_panel import CenterPanel, _MASTER_PAGE
from panels.right_panel import FileTreePanel
from panels.bottom_panel import BottomPanel
from eldrun import set_theme

_LEFT_WIDTH = 220
_BOTTOM_HEIGHT = 48

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
        self._file_tree_hidden = True
        self._file_tree_auto_shown = False
        self._active_project_id: str | None = None
        self.project_manager = ProjectManager()
        self.settings_manager = SettingsManager()
        self.default_apps_manager = DefaultAppsManager()
        self._time_tracker = TimeTracker()
        self._workspace_manager = WorkspaceManager()
        atexit.register(self._workspace_manager.release_all)
        self._global_apps_manager = GlobalAppsManager(self.settings_manager)
        set_theme(self.settings_manager.get("color_scheme"))
        from eldrun import set_debug
        set_debug(bool(self.settings_manager.get("debug")))
        GLib.idle_add(self._bootstrap_default_apps)
        GLib.idle_add(self._bootstrap_global_apps)
        self._add_key_controller()
        self._build_layout()
        self._debug_badge.set_visible(bool(self.settings_manager.get("debug")))
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
        self._header_center_box = center_box  # tab bar inserted here after center panel is created

        left_status = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        left_status.set_valign(Gtk.Align.CENTER)
        left_status.set_margin_start(12)
        left_status.set_margin_end(14)

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

        from eldrun import __version__
        version_stack = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        version_stack.set_valign(Gtk.Align.CENTER)
        version_stack.set_margin_start(6)

        version_lbl = Gtk.Label(label=f"v{__version__}")
        version_lbl.add_css_class("app-version-label")
        version_lbl.set_xalign(0.5)
        version_lbl.set_halign(Gtk.Align.CENTER)
        version_stack.append(version_lbl)

        self._debug_badge = Gtk.Label(label="DEBUG")
        self._debug_badge.add_css_class("debug-badge")
        self._debug_badge.set_xalign(0.5)
        self._debug_badge.set_halign(Gtk.Align.CENTER)
        version_stack.append(self._debug_badge)
        left_status.append(version_stack)

        center_box.set_start_widget(left_status)
        # center widget is left empty here; tab bar is wired in after _center_panel is created

        right_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        right_box.set_valign(Gtk.Align.CENTER)
        right_box.set_margin_end(8)

        self._header_clock = Gtk.Label()
        self._header_clock.add_css_class("app-title")
        self._tick_header_clock()
        GLib.timeout_add_seconds(1, self._tick_header_clock)
        self._header_clock.set_margin_end(4)
        right_box.append(self._header_clock)

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
        new_label = _dt.datetime.now().strftime("%H:%M")
        if self._header_clock.get_label() != new_label:
            self._header_clock.set_label(new_label)
        return True

    # ── layout ────────────────────────────────────────────────────────────────

    def _build_layout(self):
        root = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        self.set_content(root)

        root.append(self._build_header())

        # G6.6: slim toolbar row between header and center panel
        self._global_apps_toolbar_box = Gtk.Box(
            orientation=Gtk.Orientation.HORIZONTAL, spacing=2
        )
        self._global_apps_toolbar_box.add_css_class("global-apps-toolbar")
        self._global_apps_toolbar_box.set_halign(Gtk.Align.CENTER)
        root.append(self._global_apps_toolbar_box)
        self._refresh_global_apps_toolbar()

        self._center_panel = CenterPanel(
            self.project_manager,
            on_page_changed=self._on_center_page_changed,
            settings_manager=self.settings_manager,
        )
        self._center_panel.set_hexpand(True)
        self._center_panel.set_vexpand(True)
        self._center_panel.set_margin_bottom(_BOTTOM_HEIGHT)

        # Place the tab bar inside the header's center slot
        self._header_center_box.set_center_widget(self._center_panel._tab_bar_scroll)

        self._file_tree_panel = FileTreePanel(
            center_panel=self._center_panel,
            default_apps_manager=self.default_apps_manager,
            settings_manager=self.settings_manager,
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
            global_apps_manager=self._global_apps_manager,
            on_toggle_theme=self._on_toggle_theme,
            on_terminal_changed=self._on_terminal_changed,
            on_search_project=self._on_search_project_selected,
            on_workspace_toggled=self._on_workspace_toggled,
            on_debug_toggled=self._on_debug_toggled,
            on_global_apps_changed=self._refresh_global_apps_toolbar,
            on_default_apps_changed=self._file_tree_panel._refresh_default_app_icons,
        )

        overlay = Gtk.Overlay()
        overlay.set_child(self._center_panel)
        overlay.add_overlay(self._file_tree_panel)
        overlay.add_overlay(self._bottom_panel)
        overlay.set_hexpand(True)
        overlay.set_vexpand(True)

        overlay_motion = Gtk.EventControllerMotion()
        overlay_motion.connect("motion", self._on_overlay_motion)
        overlay.add_controller(overlay_motion)

        panel_motion = Gtk.EventControllerMotion()
        panel_motion.connect("leave", self._on_file_tree_panel_leave)
        self._file_tree_panel.add_controller(panel_motion)

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
        if self._wm_enabled:
            GLib.idle_add(self._setup_workspaces)

    # ── workspace management ──────────────────────────────────────────────────

    def _setup_workspaces(self) -> bool:
        """Make Eldrun sticky and map visible projects to workspaces in pill order."""
        try:
            import gi as _gi
            _gi.require_version("GdkX11", "4.0")
            from gi.repository import GdkX11
            surface = self.get_surface()
            if isinstance(surface, GdkX11.X11Surface):
                self._workspace_manager.make_eldrun_sticky(surface.get_xid())
        except Exception:
            pass
        assignments = self._workspace_manager.reconcile(
            self.project_manager.get_visible_projects()
        )
        self._refresh_workspace_badges(assignments)
        if self._active_project_id:
            self._workspace_manager.activate(self._active_project_id)
        return False

    def _refresh_workspace_badges(self, assignments: dict[str, int] | None = None):
        if assignments is None:
            assignments = {
                pid: self._workspace_manager.get_assignment(pid)
                for pid in self._bottom_panel._pills
            }
        for pid in list(self._bottom_panel._pills):
            idx = assignments.get(pid)
            self._bottom_panel.update_pill_workspace_id(
                pid,
                None if idx is None else idx + 1,
            )

    def _reconcile_workspaces_now(self):
        if not self._wm_enabled:
            return
        assignments = self._workspace_manager.reconcile(
            self.project_manager.get_visible_projects()
        )
        self._refresh_workspace_badges(assignments)

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
                      and not self._panels_hidden
                      and (not self._file_tree_hidden or self._file_tree_auto_shown))
        self._file_tree_panel.set_visible(show_panel)
        self._update_toggle_btn(show_panel)
        self._bottom_panel.set_panel_toggle_visible(self._active_project_id is not None)

    def _on_overlay_motion(self, ctrl, x, _y):
        width = ctrl.get_widget().get_width()
        if x >= width - 4 and not self._file_tree_auto_shown:
            if self._active_project_id is not None and not self._panels_hidden:
                self._file_tree_auto_shown = True
                self._apply_panel_visibility()

    def _on_file_tree_panel_leave(self, _ctrl):
        if self._file_tree_auto_shown:
            self._file_tree_auto_shown = False
            self._apply_panel_visibility()

    def _toggle_panels(self):
        self._panels_hidden = not self._panels_hidden
        self._apply_panel_visibility()

    def _toggle_file_tree_panel(self):
        self._file_tree_hidden = not self._file_tree_hidden
        self._apply_panel_visibility()

    def _on_toggle_theme(self, scheme: str):
        set_theme(scheme)
        self.settings_manager.set("color_scheme", scheme)
        self._center_panel.apply_theme(scheme)
        self._file_tree_panel.apply_theme(scheme)

    def _on_debug_toggled(self, enabled: bool):
        from eldrun import set_debug
        set_debug(enabled)
        self._debug_badge.set_visible(enabled)
        self._bottom_panel.set_debug_mode(enabled)

    def _on_workspace_toggled(self, enabled: bool):
        if enabled:
            GLib.idle_add(self._setup_workspaces)
        else:
            self._workspace_manager.release_all()
            for pid in list(self._bottom_panel._pills):
                self._bottom_panel.update_pill_workspace_id(pid, None)

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
            self._reconcile_workspaces_now()

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
        if self._wm_enabled:
            self._reconcile_workspaces_now()
            self._workspace_manager.activate(project_id)

    def _on_root_clicked(self):
        self._center_panel.open_master_terminal()

    def _on_pill_activate(self, project_id: str):
        self._center_panel.show_project_terminal(project_id)
        if self._wm_enabled:
            self._workspace_manager.activate(project_id)

    def _on_pill_close(self, project_id: str):
        self._do_close_project(project_id)

    def _do_close_project(self, project_id: str):
        was_active = (self._active_project_id == project_id)
        self._bottom_panel.remove_project_pill(project_id)
        if hasattr(self._center_panel, "remove_project_terminal"):
            self._center_panel.remove_project_terminal(project_id)
        self.project_manager.deactivate_project(project_id)
        if self._wm_enabled:
            self._reconcile_workspaces_now()
        if was_active:
            self._active_project_id = None
            self._on_root_clicked()

    def _bootstrap_default_apps(self) -> bool:
        self.default_apps_manager.bootstrap_from_system()
        return False

    def _bootstrap_global_apps(self) -> bool:
        self._global_apps_manager.populate_missing()
        self._refresh_global_apps_toolbar()
        return False

    def _refresh_global_apps_toolbar(self):
        """Rebuild the global-apps toolbar from current registry (G6.6)."""
        toolbar = self._global_apps_toolbar_box
        child = toolbar.get_first_child()
        while child:
            nxt = child.get_next_sibling()
            toolbar.remove(child)
            child = nxt

        registry = self._global_apps_manager.get_registry()
        any_visible = False
        for role in ROLES:
            key = role["key"]
            entry = registry.get(key, {})
            if not entry.get("visible", True):
                continue
            any_visible = True
            exec_cmd = entry.get("exec")
            btn = Gtk.Button()
            btn.set_icon_name(select_role_icon(role, self._icon_theme_has_icon))
            btn.add_css_class("flat")
            btn.add_css_class("global-app-btn")
            btn.set_tooltip_text(role["label"])
            if exec_cmd:
                gam = self._global_apps_manager
                btn.connect("clicked", lambda _, k=key: gam.launch_or_raise(k))
            else:
                btn.set_sensitive(False)

            rclick = Gtk.GestureClick()
            rclick.set_button(3)
            rclick.connect(
                "pressed",
                lambda g, _n, _x, _y, k=key, r=role, e=exec_cmd: (
                    g.set_state(Gtk.EventSequenceState.CLAIMED),
                    self._show_global_app_edit_popover(g.get_widget(), k, r["label"], e),
                ),
            )
            btn.add_controller(rclick)
            toolbar.append(btn)

        toolbar.set_visible(any_visible)

    def _icon_theme_has_icon(self, icon_name: str) -> bool:
        display = Gdk.Display.get_default()
        if display is None:
            return False
        return Gtk.IconTheme.get_for_display(display).has_icon(icon_name)

    def _show_global_app_edit_popover(self, widget, key: str, label: str, current_exec: str | None):
        popover = Gtk.Popover()
        popover.set_parent(widget)
        popover.set_has_arrow(True)
        popover.set_autohide(True)

        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        box.set_margin_start(10)
        box.set_margin_end(10)
        box.set_margin_top(8)
        box.set_margin_bottom(8)

        title = Gtk.Label(label=label)
        title.add_css_class("heading")
        title.set_xalign(0)
        box.append(title)

        entry = Gtk.Entry()
        entry.set_text(current_exec or "")
        entry.set_placeholder_text("Command path, e.g. /usr/bin/firefox")
        entry.set_width_chars(30)
        box.append(entry)

        btn_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        btn_row.set_halign(Gtk.Align.END)

        clear_btn = Gtk.Button(label="Clear")
        clear_btn.add_css_class("flat")
        btn_row.append(clear_btn)

        ok_btn = Gtk.Button(label="Set")
        ok_btn.add_css_class("suggested-action")
        btn_row.append(ok_btn)
        box.append(btn_row)

        def _apply(_=None):
            new_cmd = entry.get_text().strip() or None
            self._global_apps_manager.set_exec(key, new_cmd)
            self._refresh_global_apps_toolbar()
            popover.popdown()

        def _clear(_):
            self._global_apps_manager.set_exec(key, None)
            self._refresh_global_apps_toolbar()
            popover.popdown()

        entry.connect("activate", _apply)
        ok_btn.connect("clicked", _apply)
        clear_btn.connect("clicked", _clear)

        popover.set_child(box)
        popover.popup()
        entry.grab_focus()

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
