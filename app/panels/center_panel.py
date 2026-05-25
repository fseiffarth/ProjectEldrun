import os
import signal
import pathlib

import gi
gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
gi.require_version("Vte", "3.91")
from gi.repository import Gtk, Gdk, GLib, Vte, Pango

_WORKSPACE_ROOT = str(pathlib.Path.home() / "eldrun")
_ROOT_DIR = str(pathlib.Path.home() / "eldrun" / "root")
_MASTER_PAGE   = "__master__"
_APP_PAGE      = "__app__"


def _dark_palette():
    ansi = [
        "#1a1a2e", "#e06c75", "#98c379", "#e5c07b",
        "#61afef", "#c678dd", "#56b6c2", "#abb2bf",
        "#4b5263", "#e06c75", "#98c379", "#e5c07b",
        "#61afef", "#c678dd", "#56b6c2", "#ffffff",
    ]
    palette = []
    for h in ansi:
        c = Gdk.RGBA()
        c.parse(h)
        palette.append(c)
    return palette


def _resolve_command(name: str) -> list[str]:
    prog = GLib.find_program_in_path(name)
    if prog:
        return [prog]
    shell = GLib.find_program_in_path("bash") or GLib.find_program_in_path("sh") or "/bin/sh"
    return [shell]


def _spawn(terminal: Vte.Terminal, directory: str, cmd: list[str], on_done):
    terminal.spawn_async(
        Vte.PtyFlags.DEFAULT,
        directory,
        cmd,
        None,
        GLib.SpawnFlags.DEFAULT,
        None, None, -1, None,
        on_done,
    )


class CenterPanel(Gtk.Box):
    def __init__(self, project_manager, on_page_changed=None, settings_manager=None):
        super().__init__(orientation=Gtk.Orientation.VERTICAL)
        self._pm = project_manager
        self._settings = settings_manager
        self._on_page_changed = on_page_changed  # callable(page_name: str) | None
        self._last_terminal_page = "empty"
        self._embedded_xid: int | None = None
        self._terminal_pids: dict[str, int] = {}     # page_name -> child PID
        self._terminals: dict[str, Vte.Terminal] = {}  # page_name -> widget

        self._stack = Gtk.Stack()
        self._stack.set_transition_type(Gtk.StackTransitionType.NONE)
        self._stack.set_hexpand(True)
        self._stack.set_vexpand(True)

        placeholder = Gtk.Label(label="No project selected.\nPress  +  to create one.")
        placeholder.get_style_context().add_class("placeholder-label")
        self._stack.add_named(placeholder, "empty")

        # ── overlay: stack + "Back to terminal" button ────────────────────────
        overlay = Gtk.Overlay()
        overlay.set_hexpand(True)
        overlay.set_vexpand(True)
        overlay.set_child(self._stack)

        self._back_btn = Gtk.Button(label="⬛  Terminal")
        self._back_btn.add_css_class("suggested-action")
        self._back_btn.set_halign(Gtk.Align.CENTER)
        self._back_btn.set_valign(Gtk.Align.END)
        self._back_btn.set_margin_bottom(16)
        self._back_btn.set_visible(False)
        self._back_btn.connect("clicked", self._on_back_to_terminal)
        overlay.add_overlay(self._back_btn)

        self._offline_banner = Gtk.Label(label="⚠  No internet connection")
        self._offline_banner.add_css_class("offline-banner")
        self._offline_banner.set_halign(Gtk.Align.CENTER)
        self._offline_banner.set_valign(Gtk.Align.START)
        self._offline_banner.set_visible(False)
        overlay.add_overlay(self._offline_banner)

        self.append(overlay)

    def set_offline(self, offline: bool):
        """Show or hide the 'No internet connection' banner overlay."""
        self._offline_banner.set_visible(offline)

    def _cmd(self) -> list[str]:
        name = self._settings.get("terminal_command") if self._settings else "claude"
        return _resolve_command(name)

    # ── master terminal ───────────────────────────────────────────────────────

    def open_master_terminal(self):
        workspace = pathlib.Path(_WORKSPACE_ROOT)
        workspace.mkdir(parents=True, exist_ok=True)
        (workspace / "projects").mkdir(exist_ok=True)
        pathlib.Path(_ROOT_DIR).mkdir(exist_ok=True)
        if self._stack.get_child_by_name(_MASTER_PAGE) is None:
            terminal = self._make_terminal()
            self._terminals[_MASTER_PAGE] = terminal
            self._stack.add_named(terminal, _MASTER_PAGE)
            _spawn(terminal, _ROOT_DIR, self._cmd(), self._on_master_spawned)
            terminal.connect("child-exited", self._on_master_exited)

        self._last_terminal_page = _MASTER_PAGE
        self._stack.set_visible_child_name(_MASTER_PAGE)
        self._back_btn.set_visible(False)
        self._notify_page(_MASTER_PAGE)

    def _on_master_spawned(self, _term, pid, _error):
        if pid and pid > 0:
            self._terminal_pids[_MASTER_PAGE] = pid

    def _on_master_exited(self, terminal, _status):
        self._terminal_pids.pop(_MASTER_PAGE, None)
        _spawn(terminal, _ROOT_DIR, self._cmd(), self._on_master_spawned)

    # ── project terminals ─────────────────────────────────────────────────────

    def add_project_terminal(self, project: dict):
        child_name = "project-" + project["id"]
        if self._stack.get_child_by_name(child_name) is not None:
            self._show_terminal(child_name)
            return

        terminal = self._make_terminal()
        self._terminals[child_name] = terminal
        self._stack.add_named(terminal, child_name)

        page = child_name

        def on_spawn_done(term, pid, _error):
            if pid and pid > 0:
                self._pm.set_shell_pid(project["id"], pid)
                self._terminal_pids[page] = pid

        _spawn(terminal, project["directory"], self._cmd(), on_spawn_done)
        terminal.connect("child-exited", self._on_child_exited,
                         project["id"], project["directory"])
        self._show_terminal(child_name)

    def show_project_terminal(self, project_id: str):
        name = "project-" + project_id
        if self._stack.get_child_by_name(name) is not None:
            self._show_terminal(name)

    def remove_project_terminal(self, project_id: str):
        name = "project-" + project_id
        child = self._stack.get_child_by_name(name)
        if child is None:
            return
        project = self._pm.get_project(project_id)
        if project and project.get("shell_pid"):
            try:
                os.kill(project["shell_pid"], signal.SIGTERM)
            except ProcessLookupError:
                pass
        if self._stack.get_visible_child_name() == name:
            self._stack.set_visible_child_name("empty")
            self._last_terminal_page = "empty"
        if self._last_terminal_page == name:
            self._last_terminal_page = "empty"
        self._terminal_pids.pop(name, None)
        self._terminals.pop(name, None)
        self._stack.remove(child)

    # ── app window embedding (Phase 6.B) ──────────────────────────────────────

    def show_app_window(self, xid: int):
        """Embed an X window in the center via XReparentWindow."""
        try:
            import gi as _gi
            _gi.require_version("GdkX11", "4.0")
            from gi.repository import GdkX11
            from Xlib import display as Xdisplay, X

            # Get the GDK native surface and its X11 window ID
            native = self.get_native()
            if native is None:
                return
            surface = native.get_surface()
            if not isinstance(surface, GdkX11.X11Surface):
                return
            center_xid = GdkX11.X11Surface.get_xid(surface)

            disp = Xdisplay.Display()
            app_win  = disp.create_resource_object("window", xid)
            host_win = disp.create_resource_object("window", center_xid)

            alloc = self._stack.get_allocation()
            w = max(alloc.width,  400)
            h = max(alloc.height, 300)

            app_win.unmap()
            app_win.reparent(host_win, 0, 0)
            app_win.configure(width=w, height=h)
            app_win.map()
            disp.flush()

            self._embedded_xid = xid
        except Exception as exc:
            print(f"[eldrun] show_app_window failed: {exc}")
            return

        # Remember which terminal was last active before switching
        current = self._stack.get_visible_child_name() or "empty"
        if current not in (_APP_PAGE,):
            self._last_terminal_page = current

        # Add a placeholder page so the stack has something to show
        if self._stack.get_child_by_name(_APP_PAGE) is None:
            placeholder = Gtk.Label(label="")
            self._stack.add_named(placeholder, _APP_PAGE)

        self._stack.set_visible_child_name(_APP_PAGE)
        self._back_btn.set_visible(True)

    def _release_app_window(self):
        if self._embedded_xid is None:
            return
        try:
            from Xlib import display as Xdisplay
            disp = Xdisplay.Display()
            app_win = disp.create_resource_object("window", self._embedded_xid)
            app_win.unmap()
            app_win.reparent(disp.screen().root, 0, 0)
            app_win.map()
            disp.flush()
        except Exception as exc:
            print(f"[eldrun] _release_app_window failed: {exc}")
        self._embedded_xid = None

    # ── back to terminal ──────────────────────────────────────────────────────

    def _on_back_to_terminal(self, _btn):
        self._release_app_window()
        target = self._last_terminal_page
        if target != "empty" and self._stack.get_child_by_name(target) is not None:
            self._stack.set_visible_child_name(target)
        else:
            target = "empty"
            self._stack.set_visible_child_name("empty")
        self._back_btn.set_visible(False)
        self._notify_page(target)

    # ── helpers ───────────────────────────────────────────────────────────────

    def _show_terminal(self, page_name: str):
        self._release_app_window()
        self._last_terminal_page = page_name
        self._stack.set_visible_child_name(page_name)
        self._back_btn.set_visible(False)
        self._notify_page(page_name)

    def _make_terminal(self) -> Vte.Terminal:
        terminal = Vte.Terminal()
        terminal.set_scrollback_lines(10000)
        terminal.set_font(Pango.FontDescription("Monospace 11"))

        bg = Gdk.RGBA()
        bg.parse("#0d1117")
        fg = Gdk.RGBA()
        fg.parse("#e6edf3")
        terminal.set_color_background(bg)
        terminal.set_color_foreground(fg)
        terminal.set_colors(fg, bg, _dark_palette())
        return terminal

    def _notify_page(self, page_name: str):
        if self._on_page_changed is not None:
            self._on_page_changed(page_name)

    def _on_child_exited(self, terminal, _status, project_id: str, directory: str):
        page = "project-" + project_id
        self._terminal_pids.pop(page, None)

        def on_respawn(_term, pid, _error):
            if pid and pid > 0:
                self._pm.set_shell_pid(project_id, pid)
                self._terminal_pids[page] = pid

        _spawn(terminal, directory, self._cmd(), on_respawn)

    def respawn_all(self):
        """Clear and kill all running terminals; child-exited handlers restart with the current command."""
        for page_name, pid in list(self._terminal_pids.items()):
            terminal = self._terminals.get(page_name)
            if terminal:
                terminal.reset(True, True)
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        self._terminal_pids.clear()
