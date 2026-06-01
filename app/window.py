import atexit
import datetime as _dt
import os
import pathlib
import signal
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
from backends import detect_backend
from panels.center_panel import CenterPanel, _MASTER_PAGE
from panels.right_panel import FileTreePanel
from panels.bottom_panel import BottomPanel
from eldrun import set_theme
from downloads_manager import apply_browser_download_dir, update_project_downloads
import launch_helpers as _launch_helpers

_LEFT_WIDTH = 220
_HEADER_HEIGHT = 40
_BOTTOM_HEIGHT = 48

class EldrunWindow(Adw.ApplicationWindow):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)

        self.set_title("Eldrun")
        self.set_default_size(1440, 900)
        self.set_decorated(False)

        self._fullscreen = True
        self._panels_hidden = False
        self._file_tree_hidden = True
        self._file_tree_auto_shown = False
        self._file_tree_pointer_inside = False
        self._file_tree_context_menu_open = False
        self._bottom_auto_shown = False
        self._bottom_pointer_inside = False
        self._bottom_context_menu_open = False
        self._bottom_panel_motion = None
        self._toolbar_ptr_inside = False
        self._toolbar_popover_open = False
        self._toolbar_hide_source: int | None = None
        self._file_tree_strip_hide_src: int | None = None
        self._bottom_strip_hide_src: int | None = None
        self._active_project_id: str | None = None
        self._downloads_active_dir: object = object()  # sentinel: force first update
        self.project_manager = ProjectManager()
        self.settings_manager = SettingsManager()
        self.default_apps_manager = DefaultAppsManager()
        self._time_tracker = TimeTracker()
        self._project_space_backend = detect_backend()
        atexit.register(self._project_space_backend.cleanup)
        self._global_apps_manager = GlobalAppsManager(self.settings_manager)
        initial_scheme = self.settings_manager.get("color_scheme") or "dark"
        set_theme(initial_scheme)
        _launch_helpers.set_dark_mode("dark" in str(initial_scheme))
        from eldrun import set_debug
        set_debug(bool(self.settings_manager.get("debug")))
        GLib.idle_add(self._bootstrap_default_apps)
        GLib.idle_add(self._bootstrap_global_apps)
        self._add_key_controller()
        self._build_layout()
        self._debug_badge.set_visible(bool(self.settings_manager.get("debug")))
        apply_browser_download_dir()
        self.fullscreen()
        self._network_monitor = NetworkMonitor(self._on_network_status_changed)
        GLib.timeout_add(60_000, self._on_time_tick)
        GLib.timeout_add_seconds(30, self._update_clock)
        self.connect("destroy", self._on_destroy)
        self.connect("close-request", self._on_close_request)

    def _on_destroy(self, _win):
        self.project_manager.set_all_inactive()
        if self._wm_enabled:
            self._project_space_backend.cleanup()

    # ── close / quit flow ─────────────────────────────────────────────────────

    def _on_close_request(self, _win) -> bool:
        self._confirm_quit()
        return True  # suppress default destroy

    def _get_own_xid(self) -> int | None:
        try:
            import gi as _gi
            _gi.require_version("GdkX11", "4.0")
            from gi.repository import GdkX11
            surface = self.get_surface()
            if isinstance(surface, GdkX11.X11Surface):
                return surface.get_xid()
        except Exception:
            pass
        return None

    def _confirm_quit(self):
        dlg = Gtk.Window()
        dlg.set_title("Close Eldrun?")
        dlg.set_modal(True)
        dlg.set_transient_for(self)
        dlg.set_resizable(False)
        dlg.set_default_size(400, -1)

        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        box.set_margin_start(28)
        box.set_margin_end(28)
        box.set_margin_top(28)
        box.set_margin_bottom(22)

        icon = Gtk.Image.new_from_icon_name("dialog-warning-symbolic")
        icon.set_pixel_size(48)
        icon.set_halign(Gtk.Align.CENTER)
        box.append(icon)

        heading = Gtk.Label(label="Close Eldrun?")
        heading.add_css_class("title-2")
        heading.set_halign(Gtk.Align.CENTER)
        heading.set_margin_top(4)
        box.append(heading)

        lines = ["All open project terminals will be closed."]
        if self._wm_enabled and self._project_space_backend.has_managed_windows():
            lines.append(
                "Apps on the hidden workspace will be moved to the default workspace."
            )
        lines.append("Make sure your work is saved before continuing.")

        body = Gtk.Label(label="\n".join(lines))
        body.set_wrap(True)
        body.set_halign(Gtk.Align.CENTER)
        body.set_justify(Gtk.Justification.CENTER)
        body.set_margin_top(4)
        box.append(body)

        btn_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
        btn_row.set_halign(Gtk.Align.CENTER)
        btn_row.set_margin_top(10)

        cancel_btn = Gtk.Button(label="Cancel")
        cancel_btn.add_css_class("pill")
        cancel_btn.connect("clicked", lambda _: dlg.destroy())
        btn_row.append(cancel_btn)

        quit_btn = Gtk.Button(label="Close Eldrun")
        quit_btn.add_css_class("pill")
        quit_btn.add_css_class("destructive-action")
        quit_btn.connect("clicked", lambda _: self._do_quit(dlg))
        btn_row.append(quit_btn)

        box.append(btn_row)

        dlg.set_child(box)
        dlg.present()

    def _do_quit(self, dlg: Gtk.Window):
        dlg.destroy()
        self.get_application().quit()

    # ── screenshot helpers ────────────────────────────────────────────────────

    def _get_active_project_dir(self) -> str | None:
        if self._active_project_id:
            project = self.project_manager.get_project(self._active_project_id)
            if project and project.get("directory"):
                return project["directory"]
        return None

    def _get_active_screenshots_dir(self) -> str:
        if self._active_project_id:
            project = self.project_manager.get_project(self._active_project_id)
            if project and project.get("directory"):
                return os.path.join(project["directory"], "tmp", "screenshots")
        return str(pathlib.Path.home() / "eldrun" / "root" / "tmp" / "screenshots")

    def _show_screenshot_toast(self, filepath: str):
        short = os.path.basename(filepath)

        icon = Gtk.Image.new_from_icon_name("camera-photo-symbolic")
        icon.set_pixel_size(16)

        lbl = Gtk.Label(label=f"Screenshot saved: {short}")

        toast = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        toast.add_css_class("screenshot-toast")
        toast.set_halign(Gtk.Align.CENTER)
        toast.set_valign(Gtk.Align.END)
        toast.set_margin_bottom(_BOTTOM_HEIGHT + 12)
        toast.append(icon)
        toast.append(lbl)

        self._overlay.add_overlay(toast)

        def _remove():
            self._overlay.remove_overlay(toast)
            return False

        GLib.timeout_add(3000, _remove)

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
            self._max_btn.set_tooltip_text("Restore" if self._fullscreen else "Fullscreen")
            return True

        if keyval in (Gdk.KEY_Super_L, Gdk.KEY_Super_R):
            self._toggle_panels()
            return True

        return False

    # ── header bar ────────────────────────────────────────────────────────────

    def _build_header(self) -> Gtk.WindowHandle:
        center_box = Gtk.CenterBox()
        center_box.add_css_class("app-header")
        center_box.set_size_request(-1, _HEADER_HEIGHT)
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
        self._max_btn.set_tooltip_text("Restore")
        self._max_btn.connect("clicked", self._on_fullscreen_clicked)
        btn_box.append(self._max_btn)

        close_btn = Gtk.Button()
        close_btn.add_css_class("flat")
        close_btn.add_css_class("wm-btn")
        close_btn.add_css_class("wm-close")
        close_btn.set_tooltip_text("Close")
        close_btn.connect("clicked", lambda _: self._confirm_quit())
        btn_box.append(close_btn)

        right_box.append(btn_box)
        center_box.set_end_widget(right_box)

        handle = Gtk.WindowHandle()
        handle.set_child(center_box)
        return handle

    def _on_fullscreen_clicked(self, _btn):
        if self._fullscreen:
            self.unfullscreen()
        else:
            self.fullscreen()
        self._fullscreen = not self._fullscreen
        self._max_btn.set_tooltip_text("Restore" if self._fullscreen else "Fullscreen")

    def _tick_header_clock(self) -> bool:
        new_label = _dt.datetime.now().strftime("%H:%M")
        if self._header_clock.get_label() != new_label:
            self._header_clock.set_label(new_label)
        return True

    # ── layout ────────────────────────────────────────────────────────────────

    def _build_layout(self):
        header = self._build_header()
        header.set_halign(Gtk.Align.FILL)
        header.set_valign(Gtk.Align.START)
        header.set_hexpand(True)

        # G6.6: slim toolbar strip between header and center panel
        self._global_apps_area = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        self._global_apps_area.set_halign(Gtk.Align.FILL)
        self._global_apps_area.set_valign(Gtk.Align.START)
        self._global_apps_area.set_margin_top(_HEADER_HEIGHT)
        self._global_apps_area.set_hexpand(True)
        self._global_apps_area.set_visible(False)

        self._global_apps_toggle_bar = Gtk.Box()
        self._global_apps_toggle_bar.add_css_class("global-apps-toggle-bar")
        self._global_apps_toggle_bar.set_size_request(-1, 5)
        self._global_apps_area.append(self._global_apps_toggle_bar)

        self._global_apps_revealer = Gtk.Revealer()
        self._global_apps_revealer.set_transition_type(
            Gtk.RevealerTransitionType.SLIDE_DOWN
        )
        self._global_apps_revealer.set_transition_duration(150)
        self._global_apps_revealer.set_reveal_child(False)

        self._global_apps_toolbar_box = Gtk.Box(
            orientation=Gtk.Orientation.HORIZONTAL, spacing=0
        )
        self._global_apps_toolbar_box.add_css_class("global-apps-toolbar")
        self._global_apps_toolbar_box.set_halign(Gtk.Align.CENTER)
        self._global_apps_toolbar_box.set_valign(Gtk.Align.CENTER)
        self._global_apps_toolbar_box.set_margin_top(4)
        self._global_apps_toolbar_box.set_margin_bottom(4)

        self._global_apps_revealer.set_child(self._global_apps_toolbar_box)
        self._global_apps_area.append(self._global_apps_revealer)

        self._refresh_global_apps_toolbar()

        def _toolbar_enter(_ctrl, _x, _y):
            self._toolbar_ptr_inside = True
            if self._toolbar_hide_source is not None:
                GLib.source_remove(self._toolbar_hide_source)
                self._toolbar_hide_source = None
            self._global_apps_revealer.set_reveal_child(True)
            self._global_apps_toggle_bar.add_css_class("panel-open")

        def _toolbar_leave(_ctrl):
            self._toolbar_ptr_inside = False
            def _hide():
                if not self._toolbar_ptr_inside and not self._toolbar_popover_open:
                    self._global_apps_revealer.set_reveal_child(False)
                    self._global_apps_toggle_bar.remove_css_class("panel-open")
                self._toolbar_hide_source = None
                return False
            if self._toolbar_hide_source is not None:
                GLib.source_remove(self._toolbar_hide_source)
            self._toolbar_hide_source = GLib.timeout_add(250, _hide)

        bar_motion = Gtk.EventControllerMotion()
        bar_motion.connect("enter", _toolbar_enter)
        bar_motion.connect("leave", _toolbar_leave)
        self._global_apps_toggle_bar.add_controller(bar_motion)

        tb_motion = Gtk.EventControllerMotion()
        tb_motion.connect("enter", _toolbar_enter)
        tb_motion.connect("leave", _toolbar_leave)
        self._global_apps_toolbar_box.add_controller(tb_motion)

        self._center_panel = CenterPanel(
            self.project_manager,
            on_page_changed=self._on_center_page_changed,
            settings_manager=self.settings_manager,
            global_apps_manager=self._global_apps_manager,
        )
        self._center_panel.set_hexpand(True)
        self._center_panel.set_vexpand(True)
        self._center_panel.set_margin_top(_HEADER_HEIGHT)
        self._center_panel.set_margin_bottom(0)

        # Place the tab bar inside the header's center slot
        self._header_center_box.set_center_widget(self._center_panel._tab_bar_scroll)

        self._file_tree_panel = FileTreePanel(
            center_panel=self._center_panel,
            default_apps_manager=self.default_apps_manager,
            settings_manager=self.settings_manager,
            on_context_menu_open_changed=self._on_file_tree_context_menu_open_changed,
            on_file_opened=self._on_file_opened,
            project_manager=self.project_manager,
        )
        self._file_tree_panel.set_valign(Gtk.Align.FILL)
        self._file_tree_panel.set_margin_bottom(0)

        self._file_tree_revealer = Gtk.Revealer()
        self._file_tree_revealer.set_transition_type(Gtk.RevealerTransitionType.SLIDE_LEFT)
        self._file_tree_revealer.set_transition_duration(200)
        self._file_tree_revealer.set_reveal_child(False)
        self._file_tree_revealer.set_vexpand(True)
        self._file_tree_revealer.set_child(self._file_tree_panel)

        self._file_tree_strip = Gtk.Box()
        self._file_tree_strip.add_css_class("file-tree-toggle-strip")
        self._file_tree_strip.set_size_request(8, -1)

        self._file_tree_revealer.set_halign(Gtk.Align.END)
        self._file_tree_revealer.set_hexpand(False)
        # Keep the right panel overlay only as wide as the panel/hover strip.
        # A full-window overlay here intercepts terminal wheel events.
        self._file_tree_container = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL)
        self._file_tree_container.set_halign(Gtk.Align.END)
        self._file_tree_container.set_vexpand(True)
        self._file_tree_container.set_margin_top(_HEADER_HEIGHT)
        self._file_tree_container.set_margin_bottom(0)
        self._file_tree_strip.set_halign(Gtk.Align.END)
        self._file_tree_strip.set_valign(Gtk.Align.FILL)
        self._file_tree_strip.set_hexpand(False)
        self._file_tree_strip.set_vexpand(True)
        self._file_tree_container.append(self._file_tree_revealer)
        self._file_tree_container.append(self._file_tree_strip)

        self._bottom_panel = BottomPanel(
            on_root=self._on_root_clicked,
            on_new_project=self._on_new_project_clicked,
            on_import_project=self._on_import_project_clicked,
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
            on_context_menu_open_changed=self._on_bottom_context_menu_open_changed,
        )
        self._bottom_revealer = Gtk.Revealer()
        self._bottom_revealer.set_transition_type(Gtk.RevealerTransitionType.SLIDE_UP)
        self._bottom_revealer.set_transition_duration(200)
        self._bottom_revealer.set_reveal_child(False)
        self._bottom_revealer.set_hexpand(True)
        self._bottom_revealer.set_child(self._bottom_panel)

        self._bottom_strip = Gtk.Box()
        self._bottom_strip.add_css_class("bottom-toggle-strip")
        self._bottom_strip.set_size_request(-1, 16)
        self._bottom_strip.set_hexpand(True)
        self._bottom_strip.set_halign(Gtk.Align.FILL)
        self._bottom_strip.set_vexpand(False)

        # A bottom-only Box (not a full-height Overlay) so it does not intercept
        # pointer events at mid-window height, which would block the right-side
        # file-tree strip from receiving its hover events.
        self._bottom_container = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        self._bottom_container.set_hexpand(True)
        self._bottom_container.set_valign(Gtk.Align.END)
        self._bottom_container.set_margin_bottom(0)
        self._bottom_container.append(self._bottom_revealer)
        self._bottom_container.append(self._bottom_strip)

        overlay = Gtk.Overlay()
        self._overlay = overlay
        self.set_content(overlay)
        overlay.set_child(self._center_panel)
        overlay.add_overlay(self._file_tree_container)
        overlay.add_overlay(self._bottom_container)
        overlay.add_overlay(self._global_apps_area)
        overlay.add_overlay(header)
        overlay.set_hexpand(True)
        overlay.set_vexpand(True)

        def _on_file_tree_strip_enter(_ctrl, _x, _y):
            if self._file_tree_strip_hide_src is not None:
                GLib.source_remove(self._file_tree_strip_hide_src)
                self._file_tree_strip_hide_src = None
            if self._active_project_id is None or self._panels_hidden:
                return
            self._file_tree_pointer_inside = True
            self._file_tree_auto_shown = True
            self._apply_panel_visibility()

        def _on_file_tree_strip_leave(_ctrl):
            def _hide():
                self._file_tree_strip_hide_src = None
                if not self._file_tree_pointer_inside:
                    self._file_tree_auto_shown = False
                    self._apply_panel_visibility()
                return False
            if self._file_tree_strip_hide_src is not None:
                GLib.source_remove(self._file_tree_strip_hide_src)
            self._file_tree_strip_hide_src = GLib.timeout_add(250, _hide)

        file_tree_strip_motion = Gtk.EventControllerMotion()
        file_tree_strip_motion.connect("enter", _on_file_tree_strip_enter)
        file_tree_strip_motion.connect("leave", _on_file_tree_strip_leave)
        self._file_tree_strip.add_controller(file_tree_strip_motion)

        def _on_bottom_strip_enter(_ctrl, _x, _y):
            if self._bottom_strip_hide_src is not None:
                GLib.source_remove(self._bottom_strip_hide_src)
                self._bottom_strip_hide_src = None
            if self._panels_hidden:
                return
            self._bottom_pointer_inside = True
            self._bottom_auto_shown = True
            self._apply_panel_visibility()

        def _on_bottom_strip_leave(_ctrl):
            def _hide():
                self._bottom_strip_hide_src = None
                if not self._bottom_pointer_inside:
                    self._bottom_auto_shown = False
                    self._apply_panel_visibility()
                return False
            if self._bottom_strip_hide_src is not None:
                GLib.source_remove(self._bottom_strip_hide_src)
            self._bottom_strip_hide_src = GLib.timeout_add(250, _hide)

        bottom_strip_motion = Gtk.EventControllerMotion()
        bottom_strip_motion.connect("enter", _on_bottom_strip_enter)
        bottom_strip_motion.connect("leave", _on_bottom_strip_leave)
        self._bottom_strip.add_controller(bottom_strip_motion)

        panel_motion = Gtk.EventControllerMotion()
        panel_motion.connect("enter", self._on_file_tree_panel_enter)
        panel_motion.connect("leave", self._on_file_tree_panel_leave)
        self._file_tree_panel.add_controller(panel_motion)

        bottom_panel_motion = Gtk.EventControllerMotion()
        bottom_panel_motion.connect("enter", self._on_bottom_panel_enter)
        bottom_panel_motion.connect("leave", self._on_bottom_panel_leave)
        self._bottom_panel_motion = bottom_panel_motion
        self._bottom_panel.add_controller(bottom_panel_motion)

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
        if current_id:
            # Delay until after GTK4's initial frame-clock rendering cycle.
            # Calling get_monitor_at_surface() from the first idle callback can
            # re-enter the main loop via gdk_display_sync(), firing the frame
            # clock before layout is complete and causing a SIGSEGV.
            GLib.timeout_add(500, self._restore_project_apps, current_id)
        GLib.idle_add(self._suggest_startup_projects)

    def _suggest_startup_projects(self) -> bool:
        # Placeholder — suggest activating an inactive project at startup (not yet implemented).
        return False

    # ── workspace management ──────────────────────────────────────────────────

    def _setup_workspaces(self) -> bool:
        """Ensure two named workspaces exist: workspace 0 (current) and 1 (hidden)."""
        self._project_space_backend.prepare()
        return False

    def _switch_project_workspace(self, old_project_id: str | None, new_project_id: str):
        """Move app windows between workspace 0 and 1 when the current project changes."""
        if not self._wm_enabled:
            return
        xid = self._get_own_xid()
        protected = self._global_apps_manager.get_exec_names()
        self._project_space_backend.activate_project(
            new_project_id, old_project_id,
            eldrun_xid=xid, protected_names=protected,
        )

    # ── open apps (per-project file tracking) ────────────────────────────────

    def _on_file_opened(self, project_id: str, exec_cmd: str, file_path: str,
                        pid: int | None = None):
        """Callback from the file tree when a file is opened with an external app."""
        self.project_manager.add_open_app(project_id, exec_cmd, file_path, pid=pid)

    def _restore_project_apps(self, project_id: str) -> bool:
        """Re-launch saved standalone open apps for the given project at startup."""
        from launch_helpers import launch_on_other_monitor
        apps = self.project_manager.get_open_apps(project_id)
        for app in apps:
            mode = app.get("mode") or "standalone"
            if mode != "standalone":
                continue
            exec_cmd = app.get("exec")
            file_path = app.get("file")
            if exec_cmd and file_path and os.path.exists(file_path):
                launch_on_other_monitor([exec_cmd, file_path], anchor_window=self)
        return False

    # ── panel toggle ──────────────────────────────────────────────────────────

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
                new_dl_dir = project.get("directory") if project else None
            else:
                self._active_project_id = None
                self._file_tree_panel.update_project(None)
                self._bottom_panel.set_active_project(None)
                self._bottom_panel.set_root_active(page == _MASTER_PAGE)
                self._time_tracker.on_project_deactivated()
                self._refresh_time_bars()
                new_dl_dir = None
            if new_dl_dir != self._downloads_active_dir:
                self._downloads_active_dir = new_dl_dir
                update_project_downloads(new_dl_dir)

        reveal_file_tree = (self._active_project_id is not None
                            and not self._panels_hidden
                            and (not self._file_tree_hidden or self._file_tree_auto_shown))
        self._file_tree_revealer.set_reveal_child(reveal_file_tree)
        self._file_tree_strip.set_visible(
            self._active_project_id is not None and not self._panels_hidden
        )
        if reveal_file_tree:
            self._file_tree_strip.add_css_class("panel-open")
        else:
            self._file_tree_strip.remove_css_class("panel-open")

        reveal_bottom = not self._panels_hidden and self._bottom_auto_shown
        self._bottom_revealer.set_reveal_child(reveal_bottom)
        self._bottom_strip.set_visible(not self._panels_hidden)
        if reveal_bottom:
            self._bottom_strip.add_css_class("panel-open")
        else:
            self._bottom_strip.remove_css_class("panel-open")
        self._center_panel.set_margin_bottom(0)
        self._file_tree_panel.set_margin_bottom(0)

    def _on_file_tree_panel_enter(self, _ctrl, _x, _y):
        if self._file_tree_strip_hide_src is not None:
            GLib.source_remove(self._file_tree_strip_hide_src)
            self._file_tree_strip_hide_src = None
        self._file_tree_pointer_inside = True

    def _on_file_tree_panel_leave(self, _ctrl):
        self._file_tree_pointer_inside = False
        if self._file_tree_context_menu_open:
            return
        if self._file_tree_auto_shown:
            self._file_tree_auto_shown = False
            self._apply_panel_visibility()

    def _on_file_tree_context_menu_open_changed(self, is_open: bool):
        self._file_tree_context_menu_open = is_open
        if is_open:
            return
        if self._file_tree_auto_shown and not self._file_tree_pointer_inside:
            self._file_tree_auto_shown = False
            self._apply_panel_visibility()

    def _on_bottom_panel_enter(self, _ctrl, _x, _y):
        if self._bottom_strip_hide_src is not None:
            GLib.source_remove(self._bottom_strip_hide_src)
            self._bottom_strip_hide_src = None
        self._bottom_pointer_inside = True

    def _bottom_panel_contains_pointer(self) -> bool:
        motion = getattr(self, "_bottom_panel_motion", None)
        if motion is None:
            return False
        contains_pointer = getattr(motion, "contains_pointer", None)
        if contains_pointer is None:
            return False
        return bool(contains_pointer())

    def _on_bottom_panel_leave(self, _ctrl):
        self._bottom_pointer_inside = False
        if self._bottom_context_menu_open:
            return
        if self._bottom_auto_shown:
            self._bottom_auto_shown = False
            self._apply_panel_visibility()

    def _on_bottom_context_menu_open_changed(self, is_open: bool):
        self._bottom_context_menu_open = is_open
        if is_open:
            return
        if self._bottom_panel_contains_pointer():
            self._bottom_pointer_inside = True
            return
        if self._bottom_auto_shown and not self._bottom_pointer_inside:
            self._bottom_auto_shown = False
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
        _launch_helpers.set_dark_mode("dark" in scheme)

    def _on_debug_toggled(self, enabled: bool):
        from eldrun import set_debug
        set_debug(enabled)
        self._debug_badge.set_visible(enabled)
        self._bottom_panel.set_debug_mode(enabled)

    def _on_workspace_toggled(self, enabled: bool):
        if enabled:
            GLib.idle_add(self._setup_workspaces)
        else:
            self._project_space_backend.cleanup()

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
            settings_manager=self.settings_manager,
        ).present()

    def _on_import_project_clicked(self):
        from import_project_dialog import ImportProjectDialog
        ImportProjectDialog(
            parent=self,
            project_manager=self.project_manager,
            on_imported=self._on_project_created,
            settings_manager=self.settings_manager,
        ).present()

    def _on_project_created(self, project: dict):
        from project_stats import scan_project_background
        self._bottom_panel.add_project_pill(project)
        self._center_panel.add_project_terminal(project, show=False)
        scan_project_background(project)
        old_id = self._active_project_id
        self._switch_project_workspace(old_id, project["id"])
        self._center_panel.show_project_terminal(project["id"])

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
        self._center_panel.add_project_terminal(project, show=False)
        old_id = self._active_project_id
        self._switch_project_workspace(old_id, project_id)
        self._center_panel.show_project_terminal(project_id)

    def _on_root_clicked(self):
        self._center_panel.open_master_terminal()

    def _on_pill_activate(self, project_id: str):
        old_id = self._active_project_id
        self._switch_project_workspace(old_id, project_id)
        self._center_panel.show_project_terminal(project_id)

    def _on_pill_close(self, project_id: str):
        self._do_close_project(project_id)

    def _do_close_project(self, project_id: str):
        was_active = (self._active_project_id == project_id)
        self._bottom_panel.remove_project_pill(project_id)
        if hasattr(self._center_panel, "remove_project_terminal"):
            self._center_panel.remove_project_terminal(project_id)
        self.project_manager.deactivate_project(project_id)
        if self._wm_enabled:
            self._project_space_backend.close_project(project_id)
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
            btn.set_tooltip_text(f"{role['label']} · Right-click to configure")
            if exec_cmd:
                gam = self._global_apps_manager
                if key == "screenshot":
                    btn.connect("clicked", lambda _: gam.launch_screenshot_region(
                        output_dir=self._get_active_screenshots_dir(),
                        on_saved=self._show_screenshot_toast,
                        anchor_window=self,
                    ))
                elif key == "file_manager":
                    btn.connect("clicked", lambda _, k=key: gam.launch_or_raise(
                        k,
                        path=self._get_active_project_dir(),
                        anchor_window=self,
                    ))
                else:
                    btn.connect("clicked", lambda _, k=key: gam.launch_or_raise(
                        k,
                        anchor_window=self,
                    ))
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

        self._global_apps_area.set_visible(any_visible)
        if not any_visible:
            self._global_apps_revealer.set_reveal_child(False)

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

        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        box.set_margin_start(12)
        box.set_margin_end(12)
        box.set_margin_top(10)
        box.set_margin_bottom(10)

        # Title row: icon + role name
        title_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        title_row.set_valign(Gtk.Align.CENTER)
        title_icon = Gtk.Image.new_from_icon_name(
            widget.get_icon_name() or "application-x-executable-symbolic"
        )
        title_icon.set_pixel_size(18)
        title_row.append(title_icon)
        title_lbl = Gtk.Label(label=label)
        title_lbl.add_css_class("heading")
        title_lbl.set_xalign(0)
        title_row.append(title_lbl)
        box.append(title_row)

        if current_exec:
            cur_lbl = Gtk.Label(label=os.path.basename(current_exec))
            cur_lbl.add_css_class("dim-label")
            cur_lbl.set_xalign(0)
            box.append(cur_lbl)

        # Command entry + browse button
        cmd_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=4)
        entry = Gtk.Entry()
        entry.set_text(current_exec or "")
        entry.set_placeholder_text("Command path, e.g. /usr/bin/firefox")
        entry.set_width_chars(28)
        entry.set_hexpand(True)
        cmd_row.append(entry)

        browse_btn = Gtk.Button(label="…")
        browse_btn.set_tooltip_text("Browse for executable")
        cmd_row.append(browse_btn)
        box.append(cmd_row)

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

        def _browse(_):
            from app_picker import show_app_picker
            show_app_picker(lambda cmd: entry.set_text(cmd), parent=self)

        entry.connect("activate", _apply)
        ok_btn.connect("clicked", _apply)
        clear_btn.connect("clicked", _clear)
        browse_btn.connect("clicked", _browse)

        def _on_popover_closed(_p):
            self._toolbar_popover_open = False
            if not self._toolbar_ptr_inside:
                self._global_apps_revealer.set_reveal_child(False)

        popover.connect("closed", _on_popover_closed)
        popover.set_child(box)
        self._toolbar_popover_open = True
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

