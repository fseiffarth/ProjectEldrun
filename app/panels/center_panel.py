import os
import signal
import pathlib

import gi
gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
gi.require_version("Vte", "3.91")
from gi.repository import Gtk, Gdk, GLib, Vte, Pango

from Xlib import display as Xdisplay, X
from Xlib.protocol import event as Xevent

_WORKSPACE_ROOT = str(pathlib.Path.home() / "eldrun")
from project_manager import ROOT_DIR as _ROOT_DIR_PATH
_ROOT_DIR = str(_ROOT_DIR_PATH)
_MASTER_PAGE = "__master__"
_TERMINAL_TAB = "__terminal__"

_OWN_PID = os.getpid()


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


def _light_palette():
    ansi = [
        "#073642", "#dc322f", "#859900", "#b58900",
        "#268bd2", "#d33682", "#2aa198", "#eee8d5",
        "#002b36", "#cb4b16", "#586e75", "#657b83",
        "#839496", "#6c71c4", "#93a1a1", "#fdf6e3",
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
        self._on_page_changed = on_page_changed
        scheme = settings_manager.get("color_scheme") if settings_manager else "dark"
        self._is_dark = scheme != "light"
        self._last_terminal_page = "empty"
        self._terminal_pids: dict[str, int] = {}
        self._terminals: dict[str, Vte.Terminal] = {}

        # App tab tracking
        self._app_counter = 0
        self._app_info: dict[str, dict] = {}  # page_name → {name,pid,xid,project_id,proc}
        self._tab_widgets: dict[str, Gtk.Box] = {}  # tab_key → tab widget
        self._current_tab: str = _TERMINAL_TAB
        self._embedded_xid: int | None = None
        self._embedded_page: str | None = None

        # Extra agent tab tracking
        self._agent_info: dict[str, dict] = {}  # page_key → {cmd, directory}

        # Xlib connection (lazy)
        self._disp = None
        self._root_win = None
        self._atoms: dict[str, int] = {}

        # ── tab bar ───────────────────────────────────────────────────────────
        tab_bar_scroll = Gtk.ScrolledWindow()
        tab_bar_scroll.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.NEVER)
        tab_bar_scroll.set_min_content_height(38)
        tab_bar_scroll.set_hexpand(True)
        tab_bar_scroll.add_css_class("center-tab-bar-scroll")

        self._tab_bar = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=0)
        self._tab_bar.add_css_class("center-tab-bar")
        self._tab_bar.set_margin_start(4)
        tab_bar_scroll.set_child(self._tab_bar)
        self.append(tab_bar_scroll)

        # Create the default Agent tab (closeable and renameable like any other)
        self._add_tab(_TERMINAL_TAB, "Agent", icon="utilities-terminal-symbolic",
                      closeable=True,
                      on_rename=self._show_agent_rename_popover,
                      on_close=self._close_default_agent_tab)

        # Right-click on tab bar to add a new agent tab
        tab_rclick = Gtk.GestureClick()
        tab_rclick.set_button(3)
        tab_rclick.connect("pressed", self._on_tabbar_right_click)
        self._tab_bar.add_controller(tab_rclick)

        # ── stack + offline overlay ───────────────────────────────────────────
        self._stack = Gtk.Stack()
        self._stack.set_transition_type(Gtk.StackTransitionType.NONE)
        self._stack.set_hexpand(True)
        self._stack.set_vexpand(True)
        self._stack.connect("notify::width", self._on_stack_resize)
        self._stack.connect("notify::height", self._on_stack_resize)

        placeholder = Gtk.Label(label="No project selected.\nPress  +  to create one.")
        placeholder.get_style_context().add_class("placeholder-label")
        self._stack.add_named(placeholder, "empty")

        no_tabs_lbl = Gtk.Label(
            label="No terminal open.\nRight-click the tab bar to add an agent or terminal."
        )
        no_tabs_lbl.get_style_context().add_class("placeholder-label")
        self._stack.add_named(no_tabs_lbl, "no-tabs")

        overlay = Gtk.Overlay()
        overlay.set_hexpand(True)
        overlay.set_vexpand(True)
        overlay.set_child(self._stack)

        self._offline_banner = Gtk.Label(label="⚠  No internet connection")
        self._offline_banner.add_css_class("offline-banner")
        self._offline_banner.set_halign(Gtk.Align.CENTER)
        self._offline_banner.set_valign(Gtk.Align.START)
        self._offline_banner.set_visible(False)
        overlay.add_overlay(self._offline_banner)

        self._terminal_back_btn = Gtk.Button(label="⬛  Agent")
        self._terminal_back_btn.add_css_class("terminal-back-btn")
        self._terminal_back_btn.set_halign(Gtk.Align.START)
        self._terminal_back_btn.set_valign(Gtk.Align.END)
        self._terminal_back_btn.set_visible(False)
        self._terminal_back_btn.connect("clicked", self._on_terminal_back_clicked)
        overlay.add_overlay(self._terminal_back_btn)

        self.append(overlay)

    def set_offline(self, offline: bool):
        self._offline_banner.set_visible(offline)

    def _cmd(self) -> list[str]:
        name = self._settings.get("terminal_command") if self._settings else "claude"
        return _resolve_command(name)

    # ── tab bar ───────────────────────────────────────────────────────────────

    def _add_tab(self, tab_key: str, label: str, icon: str | None = None,
                 closeable: bool = True, on_rename=None, on_close=None) -> Gtk.Box:
        box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=4)
        box.add_css_class("center-tab")
        box.set_margin_top(4)
        box.set_margin_bottom(0)
        box.set_margin_start(2)
        box.set_margin_end(2)

        if icon:
            img = Gtk.Image.new_from_icon_name(icon)
            img.set_pixel_size(14)
            img.set_valign(Gtk.Align.CENTER)
            box.append(img)

        lbl = Gtk.Label(label=label, xalign=0)
        lbl.set_max_width_chars(18)
        lbl.set_ellipsize(Pango.EllipsizeMode.END)
        lbl.set_valign(Gtk.Align.CENTER)
        box.append(lbl)

        if closeable:
            close_btn = Gtk.Button(label="×")
            close_btn.add_css_class("flat")
            close_btn.add_css_class("close-btn")
            close_btn.set_valign(Gtk.Align.CENTER)
            if on_close:
                close_btn.connect("clicked", lambda _: on_close())
            else:
                close_btn.connect("clicked", lambda _, k=tab_key: self._close_app_tab(k))
            box.append(close_btn)

        gesture = Gtk.GestureClick()
        gesture.set_button(1)
        gesture.connect("pressed", lambda *_, k=tab_key: self._on_tab_clicked(k))
        box.add_controller(gesture)

        if on_rename:
            rclick = Gtk.GestureClick()
            rclick.set_button(3)
            rclick.connect("pressed", lambda g, _n, _x, _y, k=tab_key: (
                g.set_state(Gtk.EventSequenceState.CLAIMED),
                self._show_agent_rename_popover(k),
            ))
            box.add_controller(rclick)

        self._tab_widgets[tab_key] = box
        self._tab_bar.append(box)
        return box

    def _remove_tab(self, tab_key: str):
        widget = self._tab_widgets.pop(tab_key, None)
        if widget is not None:
            self._tab_bar.remove(widget)

    def _set_active_tab(self, stack_page: str):
        # Map terminal stack pages to the shared Agent tab key
        if stack_page in (_MASTER_PAGE, "empty") or stack_page.startswith("project-"):
            tab_key = _TERMINAL_TAB
        else:
            tab_key = stack_page
        for key, widget in self._tab_widgets.items():
            if key == tab_key:
                widget.add_css_class("center-tab-active")
            else:
                widget.remove_css_class("center-tab-active")
        self._current_tab = tab_key
        # Back button only for app tabs, not for agent/terminal tabs
        is_app_tab = (tab_key != _TERMINAL_TAB
                      and not tab_key.startswith("agent-")
                      and not tab_key.startswith("term-"))
        self._terminal_back_btn.set_visible(is_app_tab)

    def _on_terminal_back_clicked(self, _btn):
        self._release_embedded()
        self._show_terminal(self._last_terminal_page)

    # ── agent tab management ──────────────────────────────────────────────────

    def _on_tabbar_right_click(self, gesture, _n_press, x, y):
        gesture.set_state(Gtk.EventSequenceState.CLAIMED)
        popover = Gtk.Popover()
        popover.set_parent(self._tab_bar)
        popover.set_has_arrow(False)
        popover.set_autohide(True)

        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        box.set_margin_start(8)
        box.set_margin_end(8)
        box.set_margin_top(6)
        box.set_margin_bottom(6)

        # Row 1: New agent + inline command dropdown
        agent_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        agent_row.set_valign(Gtk.Align.CENTER)

        agent_lbl = Gtk.Label(label="New agent")
        agent_lbl.set_xalign(0)
        agent_lbl.set_hexpand(True)
        agent_row.append(agent_lbl)

        cmd_dropdown = Gtk.DropDown.new_from_strings(["claude", "codex"])
        cmd_dropdown.set_valign(Gtk.Align.CENTER)
        agent_row.append(cmd_dropdown)

        add_btn = Gtk.Button(label="+")
        add_btn.add_css_class("suggested-action")
        add_btn.set_valign(Gtk.Align.CENTER)

        def _on_add_agent(_b):
            idx = cmd_dropdown.get_selected()
            cmd = ["claude", "codex"][idx if 0 <= idx <= 1 else 0]
            popover.popdown()
            self._add_agent_terminal(cmd)

        add_btn.connect("clicked", _on_add_agent)
        agent_row.append(add_btn)
        box.append(agent_row)

        # Row 2: New plain terminal
        term_btn = Gtk.Button(label="New terminal")
        term_btn.add_css_class("flat")
        term_btn.set_halign(Gtk.Align.START)
        term_btn.connect("clicked", lambda _: (popover.popdown(), self._add_plain_terminal()))
        box.append(term_btn)

        popover.set_child(box)
        rect = Gdk.Rectangle()
        rect.x = int(x)
        rect.y = int(y)
        rect.width = 1
        rect.height = 1
        popover.set_pointing_to(rect)
        popover.popup()

    def _current_agent_directory(self) -> str:
        page = self._last_terminal_page
        if page.startswith("project-"):
            project_id = page[len("project-"):]
            project = self._pm.get_project(project_id)
            if project and project.get("directory"):
                return project["directory"]
        return _ROOT_DIR

    def _next_agent_number(self) -> int:
        used = {int(k[len("agent-"):]) for k in self._agent_info if k.startswith("agent-")
                and k[len("agent-"):].isdigit()}
        n = 1
        while n in used:
            n += 1
        return n

    def _next_term_number(self) -> int:
        used = {int(k[len("term-"):]) for k in self._agent_info if k.startswith("term-")
                and k[len("term-"):].isdigit()}
        n = 1
        while n in used:
            n += 1
        return n

    def _add_plain_terminal(self):
        n = self._next_term_number()
        page_key = f"term-{n}"
        label = f"Terminal{n}"
        directory = self._current_agent_directory()
        shell = "bash" if GLib.find_program_in_path("bash") else "sh"

        terminal = self._make_terminal()
        self._terminals[page_key] = terminal
        self._stack.add_named(terminal, page_key)
        self._agent_info[page_key] = {"cmd": shell, "directory": directory}

        def on_spawned(_term, pid, _error):
            if pid and pid > 0:
                self._terminal_pids[page_key] = pid

        _spawn(terminal, directory, _resolve_command(shell), on_spawned)
        terminal.connect("child-exited", self._on_agent_exited, page_key)

        self._add_tab(page_key, label, icon="utilities-terminal-symbolic",
                      closeable=True,
                      on_rename=self._show_agent_rename_popover,
                      on_close=lambda k=page_key: self._close_agent_tab(k))

        self._stack.set_visible_child_name(page_key)
        self._notify_page(page_key)

    def _close_default_agent_tab(self):
        self._remove_tab(_TERMINAL_TAB)
        if self._current_tab == _TERMINAL_TAB:
            self._switch_to_best_tab()

    def _switch_to_best_tab(self):
        if not self._tab_widgets:
            self._stack.set_visible_child_name("no-tabs")
            self._notify_page("no-tabs")
        elif _TERMINAL_TAB in self._tab_widgets:
            self._show_terminal(self._last_terminal_page)
        else:
            first_key = next(iter(self._tab_widgets))
            self._on_tab_clicked(first_key)

    def _add_agent_terminal(self, cmd: str):
        n = self._next_agent_number()
        page_key = f"agent-{n}"
        label = f"Agent{n}"
        directory = self._current_agent_directory()

        terminal = self._make_terminal()
        self._terminals[page_key] = terminal
        self._stack.add_named(terminal, page_key)

        self._agent_info[page_key] = {"cmd": cmd, "directory": directory}

        def on_spawned(_term, pid, _error):
            if pid and pid > 0:
                self._terminal_pids[page_key] = pid

        _spawn(terminal, directory, _resolve_command(cmd), on_spawned)
        terminal.connect("child-exited", self._on_agent_exited, page_key)

        self._add_tab(page_key, label, icon="utilities-terminal-symbolic",
                      closeable=True,
                      on_rename=self._show_agent_rename_popover,
                      on_close=lambda k=page_key: self._close_agent_tab(k))

        self._stack.set_visible_child_name(page_key)
        self._notify_page(page_key)

    def _on_agent_exited(self, terminal, _status, page_key: str):
        if page_key not in self._agent_info:
            return
        self._terminal_pids.pop(page_key, None)
        info = self._agent_info[page_key]

        def on_respawn(_term, pid, _error):
            if pid and pid > 0:
                self._terminal_pids[page_key] = pid

        _spawn(terminal, info["directory"], _resolve_command(info["cmd"]), on_respawn)

    def _close_agent_tab(self, page_key: str):
        if page_key not in self._agent_info:
            return
        pid = self._terminal_pids.pop(page_key, None)
        if pid:
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        self._terminals.pop(page_key, None)
        self._agent_info.pop(page_key, None)
        self._remove_tab(page_key)
        child = self._stack.get_child_by_name(page_key)
        if child is not None:
            self._stack.remove(child)
        if self._current_tab == page_key:
            self._switch_to_best_tab()

    def _show_agent_rename_popover(self, page_key: str):
        widget = self._tab_widgets.get(page_key)
        if widget is None:
            return

        current_label = ""
        for child in list(widget):
            if isinstance(child, Gtk.Label):
                current_label = child.get_label()
                break

        popover = Gtk.Popover()
        popover.set_parent(widget)
        popover.set_has_arrow(True)
        popover.set_autohide(True)

        box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        box.set_margin_start(6)
        box.set_margin_end(6)
        box.set_margin_top(6)
        box.set_margin_bottom(6)

        entry = Gtk.Entry()
        entry.set_text(current_label)
        entry.set_width_chars(12)
        box.append(entry)

        ok_btn = Gtk.Button(label="OK")
        ok_btn.add_css_class("suggested-action")
        box.append(ok_btn)

        def confirm(_=None):
            new_name = entry.get_text().strip()
            if new_name:
                self._rename_agent_tab(page_key, new_name)
            popover.popdown()

        entry.connect("activate", confirm)
        ok_btn.connect("clicked", confirm)

        popover.set_child(box)
        popover.popup()
        entry.grab_focus()

    def _rename_agent_tab(self, page_key: str, new_label: str):
        widget = self._tab_widgets.get(page_key)
        if widget is None:
            return
        for child in list(widget):
            if isinstance(child, Gtk.Label):
                child.set_label(new_label)
                break

    def _update_terminal_tab_label(self, label: str):
        widget = self._tab_widgets.get(_TERMINAL_TAB)
        if widget is None:
            return
        for child in list(widget):
            if isinstance(child, Gtk.Label):
                child.set_label(label)
                break

    def _on_tab_clicked(self, tab_key: str):
        if tab_key == _TERMINAL_TAB:
            self._release_embedded()
            self._show_terminal(self._last_terminal_page)
        elif (tab_key.startswith("agent-") or tab_key.startswith("term-")) \
                and tab_key in self._agent_info:
            self._release_embedded()
            self._stack.set_visible_child_name(tab_key)
            self._notify_page(tab_key)
        elif tab_key in self._app_info:
            self._show_app_tab(tab_key)

    def cycle_tabs(self):
        """Advance to the next tab, wrapping around."""
        keys = list(self._tab_widgets.keys())
        if len(keys) < 2:
            return
        try:
            idx = keys.index(self._current_tab)
        except ValueError:
            idx = -1
        self._on_tab_clicked(keys[(idx + 1) % len(keys)])

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

        self._update_terminal_tab_label("Root")
        self._last_terminal_page = _MASTER_PAGE
        self._stack.set_visible_child_name(_MASTER_PAGE)
        self._notify_page(_MASTER_PAGE)

    def _on_master_spawned(self, _term, pid, _error):
        if pid and pid > 0:
            self._terminal_pids[_MASTER_PAGE] = pid

    def _on_master_exited(self, terminal, _status):
        self._terminal_pids.pop(_MASTER_PAGE, None)
        _spawn(terminal, _ROOT_DIR, self._cmd(), self._on_master_spawned)

    # ── project terminals ─────────────────────────────────────────────────────

    def add_project_terminal(self, project: dict, show: bool = True):
        child_name = "project-" + project["id"]
        if self._stack.get_child_by_name(child_name) is not None:
            if show:
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
        if show:
            self._show_terminal(child_name)

    def show_project_terminal(self, project_id: str):
        name = "project-" + project_id
        if self._stack.get_child_by_name(name) is not None:
            self._show_terminal(name)

    def remove_project_terminal(self, project_id: str):
        # Close any app tabs belonging to this project first
        for page_name in list(self._app_info.keys()):
            if self._app_info[page_name].get("project_id") == project_id:
                self._close_app_tab(page_name)

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

    # ── app tabs ──────────────────────────────────────────────────────────────

    def add_app_tab(self, name: str, proc, project_id: str | None,
                    on_standalone=None):
        """Called by LeftPanel when a file is opened; creates a tab for the app."""
        self._app_counter += 1
        page_name = f"app-{self._app_counter}"

        # Stack page: placeholder shown while app window loads
        placeholder = Gtk.Label(label=f"Opening {name}…")
        placeholder.add_css_class("placeholder-label")
        self._stack.add_named(placeholder, page_name)

        # Tab button
        self._add_tab(page_name, name, icon="application-x-executable-symbolic",
                      closeable=True)

        pid = proc.pid if proc else None
        self._app_info[page_name] = {
            "name": name,
            "pid": pid,
            "xid": None,
            "project_id": project_id,
            "proc": proc,
            "on_standalone": on_standalone,
        }

        # Switch to the new tab immediately
        self._stack.set_visible_child_name(page_name)
        self._notify_page(page_name)

        # Poll for the app's X11 window
        if pid is not None:
            GLib.timeout_add(400, self._poll_for_app_window, page_name, pid, 8)

    def _show_app_tab(self, page_name: str):
        if page_name not in self._app_info:
            return
        # Release any different embedded app first
        if self._embedded_page and self._embedded_page != page_name:
            self._release_embedded()
        self._stack.set_visible_child_name(page_name)
        self._notify_page(page_name)
        # Re-embed if we already know the XID
        xid = self._app_info[page_name].get("xid")
        if xid and self._embedded_page != page_name:
            GLib.idle_add(self._try_embed, page_name, xid)

    def _close_app_tab(self, page_name: str):
        if page_name not in self._app_info:
            return
        if self._embedded_page == page_name:
            self._release_embedded()
        self._remove_tab(page_name)
        child = self._stack.get_child_by_name(page_name)
        if child is not None:
            self._stack.remove(child)
        self._app_info.pop(page_name, None)
        if self._current_tab == page_name:
            self._show_terminal(self._last_terminal_page)

    # ── X11 window polling + embedding ────────────────────────────────────────

    def _ensure_display(self):
        if self._disp is not None:
            return
        try:
            self._disp = Xdisplay.Display()
            self._root_win = self._disp.screen().root
        except Exception:
            pass

    def _atom(self, name: str) -> int:
        if name not in self._atoms:
            self._atoms[name] = self._disp.intern_atom(name)
        return self._atoms[name]

    def _get_win_pid(self, win) -> int | None:
        try:
            prop = win.get_full_property(self._atom("_NET_WM_PID"), X.AnyPropertyType)
            if prop and prop.value and hasattr(prop.value, "__getitem__"):
                return prop.value[0]
        except Exception:
            pass
        return None

    def _poll_for_app_window(self, page_name: str, pid: int, attempts: int) -> bool:
        """Polls EWMH client list for the launched PID; schedules next poll if not found."""
        if page_name not in self._app_info:
            return False

        self._ensure_display()
        if self._disp is None:
            return False

        try:
            prop = self._root_win.get_full_property(
                self._atom("_NET_CLIENT_LIST"), X.AnyPropertyType
            )
            xids = list(prop.value) if (prop and prop.value) else []
        except Exception:
            xids = []

        for xid in xids:
            try:
                win = self._disp.create_resource_object("window", xid)
                win_pid = self._get_win_pid(win)
                if win_pid == pid:
                    self._app_info[page_name]["xid"] = xid
                    GLib.idle_add(self._try_embed, page_name, xid)
                    return False
            except Exception:
                continue

        if attempts > 1:
            GLib.timeout_add(400, self._poll_for_app_window, page_name, pid, attempts - 1)
        return False

    def _try_embed(self, page_name: str, xid: int) -> bool:
        """Attempt to embed the app window. Falls back to standalone on failure."""
        if page_name not in self._app_info:
            return False
        if self._stack.get_visible_child_name() != page_name:
            return False

        embed_ok = False
        try:
            gi.require_version("GdkX11", "4.0")
            from gi.repository import GdkX11

            root_widget = self.get_root()
            if root_widget is None:
                raise RuntimeError("no root widget")
            surface = root_widget.get_surface()
            if not isinstance(surface, GdkX11.X11Surface):
                raise RuntimeError("not an X11 surface")
            parent_xid = surface.get_xid()

            coords = self._stack.translate_coordinates(root_widget, 0, 0)
            if coords is None:
                raise RuntimeError("translate_coordinates failed")
            if isinstance(coords, (list, tuple)) and len(coords) >= 2:
                tx, ty = coords[0], coords[1]
            else:
                raise RuntimeError("unexpected translate_coordinates result")
            alloc = self._stack.get_allocation()
            w, h = alloc.width, alloc.height
            if w <= 0 or h <= 0:
                raise RuntimeError("stack not allocated")

            self._ensure_display()
            if self._disp is None:
                raise RuntimeError("no Xlib display")

            parent_win = self._disp.create_resource_object("window", parent_xid)
            app_win = self._disp.create_resource_object("window", xid)

            # Strip decorations before reparenting; treat any exception as
            # "embed not viable" and route to the standalone path instead.
            mwm_atom = self._atom("_MOTIF_WM_HINTS")
            app_win.change_property(mwm_atom, mwm_atom, 32, [2, 0, 0, 0, 0])
            self._disp.flush()

            app_win.reparent(parent_win, int(tx), int(ty))
            app_win.configure(width=int(w), height=int(h))
            app_win.map()
            self._disp.flush()

            self._embedded_xid = xid
            self._embedded_page = page_name
            embed_ok = True

        except Exception:
            pass

        if not embed_ok:
            # Standalone path: remove the loading tab, notify left panel
            info = self._app_info.get(page_name, {})
            on_standalone = info.get("on_standalone")
            self._close_app_tab(page_name)
            if on_standalone:
                GLib.idle_add(on_standalone, xid)
            else:
                self._raise_window_ewmh(xid)

        return False

    def _release_embedded(self):
        """Un-reparent the embedded window back to the root X11 window."""
        if self._embedded_xid is None:
            return
        self._ensure_display()
        if self._disp is not None:
            try:
                app_win = self._disp.create_resource_object("window", self._embedded_xid)
                root = self._disp.screen().root
                app_win.reparent(root, 50, 50)
                app_win.map()
                self._disp.flush()
            except Exception:
                pass
        self._embedded_xid = None
        self._embedded_page = None

    def _on_stack_resize(self, widget, _pspec=None):
        """Keep an embedded app window sized/positioned to match the stack allocation."""
        if self._embedded_xid is None or self._embedded_page is None:
            return
        if self._stack.get_visible_child_name() != self._embedded_page:
            return
        self._ensure_display()
        if self._disp is None:
            return
        try:
            root_widget = self.get_root()
            if root_widget is None:
                return
            coords = self._stack.translate_coordinates(root_widget, 0, 0)
            if coords is None:
                return
            tx, ty = coords[0], coords[1]
            app_win = self._disp.create_resource_object("window", self._embedded_xid)
            app_win.configure(
                x=int(tx), y=int(ty),
                width=max(1, self._stack.get_width()), height=max(1, self._stack.get_height()),
            )
            self._disp.flush()
        except Exception:
            pass

    def _raise_window_ewmh(self, xid: int):
        self._ensure_display()
        if self._disp is None:
            return
        try:
            win = self._disp.create_resource_object("window", xid)
            ev = Xevent.ClientMessage(
                window=win,
                client_type=self._atom("_NET_ACTIVE_WINDOW"),
                data=(32, [2, X.CurrentTime, 0, 0, 0]),
            )
            mask = X.SubstructureRedirectMask | X.SubstructureNotifyMask
            self._root_win.send_event(ev, event_mask=mask)
            self._disp.flush()
        except Exception:
            pass

    # ── helpers ───────────────────────────────────────────────────────────────

    def _show_terminal(self, page_name: str):
        self._last_terminal_page = page_name
        self._stack.set_visible_child_name(page_name)
        self._update_terminal_tab_label(
            "Root" if page_name == _MASTER_PAGE else "Agent"
        )
        self._notify_page(page_name)

    def _make_terminal(self) -> Vte.Terminal:
        terminal = Vte.Terminal()
        terminal.set_scrollback_lines(10000)
        terminal.set_font(Pango.FontDescription("Monospace 11"))
        self._apply_terminal_colors(terminal)
        return terminal

    def _apply_terminal_colors(self, terminal: Vte.Terminal):
        if self._is_dark:
            bg_str, fg_str = "#0d1117", "#e6edf3"
            palette = _dark_palette()
        else:
            bg_str, fg_str = "#ffffff", "#24292f"
            palette = _light_palette()
        bg = Gdk.RGBA()
        bg.parse(bg_str)
        fg = Gdk.RGBA()
        fg.parse(fg_str)
        terminal.set_colors(fg, bg, palette)

    def apply_theme(self, is_dark: bool):
        self._is_dark = is_dark
        for terminal in self._terminals.values():
            self._apply_terminal_colors(terminal)

    def _notify_page(self, page_name: str):
        self._set_active_tab(page_name)
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
        for page_name, pid in list(self._terminal_pids.items()):
            terminal = self._terminals.get(page_name)
            if terminal:
                terminal.reset(True, True)
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        self._terminal_pids.clear()
        # Re-spawn agent terminals with their original commands
        for page_key, info in list(self._agent_info.items()):
            terminal = self._terminals.get(page_key)
            if terminal:
                def on_respawn(_term, pid, _error, k=page_key):
                    if pid and pid > 0:
                        self._terminal_pids[k] = pid
                _spawn(terminal, info["directory"], _resolve_command(info["cmd"]), on_respawn)
