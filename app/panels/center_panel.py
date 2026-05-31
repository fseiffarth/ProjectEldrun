import os
import signal
import pathlib
from datetime import datetime, timezone

import gi
gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
gi.require_version("Vte", "3.91")
from gi.repository import Gtk, Gdk, GLib, GObject, Vte, Pango


_WORKSPACE_ROOT = str(pathlib.Path.home() / "eldrun")
from project_manager import ROOT_DIR as _ROOT_DIR_PATH
_ROOT_DIR = str(_ROOT_DIR_PATH)
_MASTER_PAGE = "__master__"
_TERMINAL_TAB = "__terminal__"
_PROJECT_SANDBOX_DIRNAME = ".eldrun"
_PROJECT_SANDBOX_SUBDIRS = ("config", "cache", "data", "state", "tmp")
_TASK_PREVIEW_WORDS = 50

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


def _fancy_dark_palette():
    ansi = [
        "#101624", "#ff5c8a", "#7ee787", "#ffd166",
        "#36c5f0", "#b388ff", "#2dd4bf", "#d8e2f3",
        "#44506a", "#ff7a9f", "#9cffb1", "#ffe08a",
        "#5edcff", "#c9a7ff", "#5ff0db", "#ffffff",
    ]
    palette = []
    for h in ansi:
        c = Gdk.RGBA()
        c.parse(h)
        palette.append(c)
    return palette


def _fancy_light_palette():
    ansi = [
        "#f7fbff", "#d7256f", "#22863a", "#b7791f",
        "#0969da", "#8250df", "#008b8b", "#2f3a4f",
        "#8c9bb3", "#bf1d5a", "#1f883d", "#9a6700",
        "#218bff", "#a475f9", "#179c9c", "#0f172a",
    ]
    palette = []
    for h in ansi:
        c = Gdk.RGBA()
        c.parse(h)
        palette.append(c)
    return palette


def _normalize_scheme(scheme) -> str:
    if isinstance(scheme, bool):
        return "dark" if scheme else "light"
    if scheme == "fancy":
        return "fancy_dark"
    if scheme in ("dark", "light", "fancy_dark", "fancy_light"):
        return scheme
    return "dark"


def _resolve_command(name: str) -> list[str]:
    prog = GLib.find_program_in_path(name)
    if prog:
        return [prog]
    shell = GLib.find_program_in_path("bash") or GLib.find_program_in_path("sh") or "/bin/sh"
    return [shell]


def _next_numbered_label(base: str, used_indices: set[int]) -> tuple[str, int]:
    idx = 0
    while idx in used_indices:
        idx += 1
    return (base if idx == 0 else f"{base}{idx}", idx)


def _agent_label_base(cmd: str) -> str:
    if cmd == "claude":
        return "Claude"
    if cmd == "codex":
        return "Codex"
    if cmd == "gemini":
        return "Gemini"
    return "Agent"


def _terminal_command_name(settings_manager) -> str:
    return settings_manager.get("terminal_command") if settings_manager else "claude"


def _normalize_task_title(text: str) -> str:
    return " ".join((text or "").split())


def _task_preview(text: str, word_limit: int = _TASK_PREVIEW_WORDS) -> str:
    words = _normalize_task_title(text).split()
    if len(words) <= word_limit:
        return " ".join(words)
    return " ".join(words[:word_limit]) + "..."


def _task_stdin_text(text: str) -> str:
    title = _normalize_task_title(text)
    return f"{title}\n" if title else ""


def _task_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _project_sandbox_envv(directory: str) -> list[str] | None:
    """Return a project-scoped child environment for best-effort sandboxing."""
    if os.path.abspath(directory) == os.path.abspath(_ROOT_DIR):
        return None

    sandbox_root = pathlib.Path(directory) / _PROJECT_SANDBOX_DIRNAME / "sandbox"
    for name in _PROJECT_SANDBOX_SUBDIRS:
        try:
            (sandbox_root / name).mkdir(parents=True, exist_ok=True)
        except Exception:
            # Best-effort: the terminal should still launch even if sandbox
            # directories cannot be created yet.
            pass

    env = os.environ.copy()
    env.update({
        "ELDRUN_PROJECT_DIR": directory,
        "ELDRUN_SANDBOX_MODE": "project",
        "XDG_CONFIG_HOME": str(sandbox_root / "config"),
        "XDG_CACHE_HOME": str(sandbox_root / "cache"),
        "XDG_DATA_HOME": str(sandbox_root / "data"),
        "XDG_STATE_HOME": str(sandbox_root / "state"),
        "TMPDIR": str(sandbox_root / "tmp"),
        "TEMP": str(sandbox_root / "tmp"),
        "TMP": str(sandbox_root / "tmp"),
        "PYTHONPYCACHEPREFIX": str(sandbox_root / "cache" / "pycache"),
    })
    return [f"{key}={value}" for key, value in env.items()]


def _spawn(terminal: Vte.Terminal, directory: str, cmd: list[str], on_done, envv=None):
    terminal.spawn_async(
        Vte.PtyFlags.DEFAULT,
        directory,
        cmd,
        envv,
        GLib.SpawnFlags.DEFAULT,
        None, None, -1, None,
        on_done,
    )


class CenterPanel(Gtk.Box):
    def __init__(self, project_manager, on_page_changed=None, settings_manager=None,
                 ollama_client=None, global_apps_manager=None):
        super().__init__(orientation=Gtk.Orientation.VERTICAL)
        self._pm = project_manager
        self._settings = settings_manager
        self._ollama_client = ollama_client
        self._on_page_changed = on_page_changed
        self._global_apps_manager = global_apps_manager
        scheme = settings_manager.get("color_scheme") if settings_manager else "dark"
        self._color_scheme = _normalize_scheme(scheme)
        self._last_terminal_page = "empty"
        self._focus_request_serial = 0
        self._terminal_pids: dict[str, int] = {}
        self._terminals: dict[str, Vte.Terminal] = {}

        self._tab_widgets: dict[str, Gtk.Box] = {}  # tab_key → tab widget
        self._current_tab: str = _TERMINAL_TAB

        # Extra agent tab tracking
        self._agent_info: dict[str, dict] = {}  # page_key → {cmd, directory}
        self._tab_project: dict[str, str | None] = {}  # page_key → project_id (None = root)
        self._task_state: dict[str, dict] = {}  # page_key → task metadata

        # X11 embedding tracking (G4.8 Stage 2)
        self._embedded_pages: dict[str, int] = {}  # page_key → xid

        # Tab layout persistence (G2a / G2b)
        self._restored_tab_layouts: set[str] = set()  # project_ids already restored
        self._restoring_tab_layout: bool = False

        # ── tab bar ───────────────────────────────────────────────────────────
        tab_bar_scroll = Gtk.ScrolledWindow()
        tab_bar_scroll.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.NEVER)
        tab_bar_scroll.set_hexpand(True)
        tab_bar_scroll.set_vexpand(True)
        tab_bar_scroll.add_css_class("center-tab-bar-scroll")

        self._tab_bar = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=0)
        self._tab_bar.add_css_class("center-tab-bar")
        self._tab_bar.set_valign(Gtk.Align.FILL)
        tab_bar_scroll.set_child(self._tab_bar)
        self._tab_bar_scroll = tab_bar_scroll
        # Note: _tab_bar_scroll is NOT appended here; window.py places it in the header

        # Create the default agent tab (closeable and renameable like any other)
        self._add_tab(_TERMINAL_TAB, self._default_agent_label(), icon="utilities-terminal-symbolic",
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

        # Terminal hint strip (G5.4)
        hint_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        hint_box.add_css_class("terminal-hint-strip")
        hint_box.set_margin_start(8)
        hint_box.set_margin_end(8)
        hint_box.set_margin_bottom(4)

        hint_lock = Gtk.Image.new_from_icon_name("security-high-symbolic")
        hint_lock.set_pixel_size(12)
        hint_lock.set_valign(Gtk.Align.CENTER)
        hint_box.append(hint_lock)

        self._hint_label = Gtk.Label()
        self._hint_label.set_hexpand(True)
        self._hint_label.set_xalign(0)
        self._hint_label.set_ellipsize(Pango.EllipsizeMode.END)
        self._hint_label.set_max_width_chars(80)
        self._hint_label.add_css_class("dim-label")
        hint_box.append(self._hint_label)

        hint_close = Gtk.Button(label="×")
        hint_close.add_css_class("flat")
        hint_close.add_css_class("close-btn")
        hint_close.set_valign(Gtk.Align.CENTER)
        hint_close.connect("clicked", lambda _: self._hide_hint_strip())
        hint_box.append(hint_close)

        self._hint_revealer = Gtk.Revealer()
        self._hint_revealer.set_transition_type(Gtk.RevealerTransitionType.SLIDE_UP)
        self._hint_revealer.set_transition_duration(150)
        self._hint_revealer.set_reveal_child(False)
        self._hint_revealer.set_halign(Gtk.Align.FILL)
        self._hint_revealer.set_valign(Gtk.Align.END)
        self._hint_revealer.set_child(hint_box)
        overlay.add_overlay(self._hint_revealer)

        self._hint_idle_source: int | None = None

        self.append(overlay)

    def set_offline(self, offline: bool):
        self._offline_banner.set_visible(offline)

    # ── terminal hint strip (G5.4) ────────────────────────────────────────────

    def _hide_hint_strip(self):
        self._hint_revealer.set_reveal_child(False)
        if self._hint_idle_source is not None:
            GLib.source_remove(self._hint_idle_source)
            self._hint_idle_source = None

    def _show_hint(self, text: str):
        self._hint_label.set_label(text)
        self._hint_revealer.set_reveal_child(True)

    def _schedule_hint_check(self):
        """Schedule an Ollama hint check after 5 s of terminal idle."""
        if self._hint_idle_source is not None:
            GLib.source_remove(self._hint_idle_source)
        self._hint_idle_source = GLib.timeout_add(5_000, self._check_terminal_hints)

    def _check_terminal_hints(self) -> bool:
        """Read terminal scrollback and ask Ollama for a hint if errors detected."""
        self._hint_idle_source = None
        if self._ollama_client is None:
            return False

        terminal = self._terminals.get(self._last_terminal_page)
        if terminal is None:
            return False

        text = self._read_terminal_scrollback(terminal, lines=50)
        if not text or not self._has_error_pattern(text):
            return False

        def on_chunk(chunk):
            current = self._hint_label.get_label()
            if not current:
                self._show_hint(chunk.split("\n")[0])
            return False

        def on_done():
            return False

        def on_error(_msg):
            return False

        self._ollama_client.ask(
            f"In one sentence, suggest what's wrong with this terminal output:\n\n{text[-1000:]}",
            on_chunk, on_done, on_error,
        )
        return False

    @staticmethod
    def _read_terminal_scrollback(terminal, lines: int = 50) -> str:
        """Best-effort read of VTE terminal scrollback text."""
        try:
            row_count = terminal.get_row_count()
            start = max(0, row_count - lines)
            text = terminal.get_text_range(start, 0, row_count - 1, -1, None, None)
            if isinstance(text, tuple):
                text = text[0]
            return text or ""
        except Exception:
            return ""

    @staticmethod
    def _has_error_pattern(text: str) -> bool:
        """Return True if text contains common error/warning keywords."""
        lower = text.lower()
        return any(kw in lower for kw in ("error", "traceback", "exception",
                                           "failed", "fatal", "warning:"))

    def _cmd(self) -> list[str]:
        return _resolve_command(_terminal_command_name(self._settings))

    def _default_agent_label(self) -> str:
        return _agent_label_base(_terminal_command_name(self._settings))

    # ── tab bar ───────────────────────────────────────────────────────────────

    def _add_tab(self, tab_key: str, label: str, icon: str | None = None,
                 closeable: bool = True, on_rename=None, on_close=None) -> Gtk.Box:
        box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=4)
        box.add_css_class("center-tab")

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
                self._show_agent_tab_menu(k),
            ))
            box.add_controller(rclick)

        # Drag source: allow dragging this tab to reorder
        drag_src = Gtk.DragSource()
        drag_src.set_actions(Gdk.DragAction.MOVE)
        drag_src.connect("prepare", lambda _s, _x, _y, k=tab_key: Gdk.ContentProvider.new_for_value(k))
        drag_src.connect("drag-begin", lambda _s, _d, w=box: (
            w.add_css_class("center-tab-dragging"),
            _s.set_icon(Gtk.WidgetPaintable.new(w), w.get_width() // 2, w.get_height() // 2),
        ))
        drag_src.connect("drag-end", lambda _s, _d, _ok, w=box: w.remove_css_class("center-tab-dragging"))
        box.add_controller(drag_src)

        # Drop target: accept another tab key and reorder
        drop_tgt = Gtk.DropTarget.new(GObject.TYPE_STRING, Gdk.DragAction.MOVE)
        drop_tgt.connect("drop", lambda _t, val, x, _y, k=tab_key, w=box: self._on_tab_drop(val, k, x < w.get_width() / 2))
        drop_tgt.connect("motion", lambda _t, x, _y, w=box: self._on_tab_drop_motion(w, x))
        drop_tgt.connect("leave", lambda _t, w=box: self._on_tab_drop_leave(w))
        box.add_controller(drop_tgt)

        self._tab_widgets[tab_key] = box
        self._tab_bar.append(box)
        self._refresh_tab_tooltip(tab_key)
        return box

    def _remove_tab(self, tab_key: str):
        widget = self._tab_widgets.pop(tab_key, None)
        if widget is not None:
            self._tab_bar.remove(widget)

    def _on_tab_drop(self, source_key: str, target_key: str, before: bool) -> bool:
        self._on_tab_drop_leave(self._tab_widgets.get(target_key))
        if source_key == target_key or source_key not in self._tab_widgets or target_key not in self._tab_widgets:
            return False
        keys = list(self._tab_widgets.keys())
        keys.pop(keys.index(source_key))
        tgt_idx = keys.index(target_key)
        if not before:
            tgt_idx += 1
        keys.insert(tgt_idx, source_key)
        self._tab_widgets = {k: self._tab_widgets[k] for k in keys}
        child = self._tab_bar.get_first_child()
        while child:
            nxt = child.get_next_sibling()
            self._tab_bar.remove(child)
            child = nxt
        for w in self._tab_widgets.values():
            self._tab_bar.append(w)
        self._save_tab_layout()
        return True

    def _on_tab_drop_motion(self, widget: Gtk.Box, x: float) -> Gdk.DragAction:
        widget.remove_css_class("tab-drag-over-left")
        widget.remove_css_class("tab-drag-over-right")
        if x < widget.get_width() / 2:
            widget.add_css_class("tab-drag-over-left")
        else:
            widget.add_css_class("tab-drag-over-right")
        return Gdk.DragAction.MOVE

    def _on_tab_drop_leave(self, widget):
        if widget:
            widget.remove_css_class("tab-drag-over-left")
            widget.remove_css_class("tab-drag-over-right")

    def _set_active_tab(self, stack_page: str):
        # Map terminal stack pages to the shared Agent tab key
        if stack_page in (_MASTER_PAGE, "empty") or stack_page.startswith("project-"):
            tab_key = _TERMINAL_TAB
        else:
            tab_key = stack_page
        tab_widgets = getattr(self, "_tab_widgets", {})
        for key, widget in tab_widgets.items():
            if key == tab_key:
                widget.add_css_class("center-tab-active")
            else:
                widget.remove_css_class("center-tab-active")
        self._current_tab = tab_key

    def _focus_visible_terminal(self, stack_page: str):
        terminal = self._terminals.get(stack_page)
        if terminal is None:
            return

        if not hasattr(self, "_focus_request_serial"):
            self._focus_request_serial = 0
        self._focus_request_serial += 1
        request_serial = self._focus_request_serial

        def _do_focus():
            if request_serial != self._focus_request_serial:
                return False
            if self._stack.get_visible_child_name() != stack_page:
                return False
            terminal.grab_focus()
            return False

        GLib.idle_add(_do_focus)

    # ── agent task metadata ───────────────────────────────────────────────────

    def _task_page_for_tab(self, tab_key: str) -> str:
        return self._last_terminal_page if tab_key == _TERMINAL_TAB else tab_key

    def _project_id_for_task_page(self, page_key: str) -> str | None:
        if page_key.startswith("project-"):
            return page_key[len("project-"):]
        return self._tab_project.get(page_key)

    def _tab_label(self, tab_key: str) -> str:
        widget = self._tab_widgets.get(tab_key)
        if widget is None:
            return ""
        for child in list(widget):
            if isinstance(child, Gtk.Label):
                return child.get_label()
        return ""

    def _load_project_task_state(self, page_key: str):
        if not page_key.startswith("project-") or page_key in self._task_state:
            return
        project_id = self._project_id_for_task_page(page_key)
        project = self._pm.get_project(project_id) if project_id else None
        tasks = project.get("agent_tasks", []) if project else []
        if not isinstance(tasks, list):
            return
        for task in tasks:
            if isinstance(task, dict) and task.get("task_key") == page_key:
                if _normalize_task_title(task.get("task_title", "")):
                    self._task_state[page_key] = dict(task)
                return

    def _task_for_tab(self, tab_key: str) -> dict | None:
        page_key = self._task_page_for_tab(tab_key)
        self._load_project_task_state(page_key)
        return self._task_state.get(page_key)

    def _refresh_tab_tooltip(self, tab_key: str):
        widget = self._tab_widgets.get(tab_key)
        if widget is None:
            return
        task = self._task_for_tab(tab_key)
        title = _normalize_task_title(task.get("task_title", "")) if task else ""
        if not title:
            widget.set_tooltip_text("No task set")
            return
        status = task.get("task_status", "active").title()
        tooltip = f"{status} task: {_task_preview(title)}"
        updated = task.get("task_updated_at")
        if updated:
            tooltip += f"\nUpdated: {updated}"
        widget.set_tooltip_text(tooltip)

    def _persist_task_state(self, page_key: str):
        project_id = self._project_id_for_task_page(page_key)
        task = self._task_state.get(page_key)
        if project_id and task and hasattr(self._pm, "set_agent_task"):
            self._pm.set_agent_task(project_id, dict(task))

    def _clear_persisted_task_state(self, page_key: str):
        project_id = self._project_id_for_task_page(page_key)
        if project_id and hasattr(self._pm, "clear_agent_task"):
            self._pm.clear_agent_task(project_id, page_key)

    def _set_agent_task(self, tab_key: str, title: str, status: str = "active"):
        title = _normalize_task_title(title)
        page_key = self._task_page_for_tab(tab_key)
        if not title or page_key == "empty":
            self._clear_agent_task(tab_key)
            return
        info = self._agent_info.get(page_key, {})
        self._task_state[page_key] = {
            "task_key": page_key,
            "task_title": title,
            "task_status": status,
            "task_updated_at": _task_timestamp(),
            "tab_label": self._tab_label(tab_key),
            "command": info.get("cmd") or (
                "root" if page_key == _MASTER_PAGE else _terminal_command_name(self._settings)
            ),
        }
        self._persist_task_state(page_key)
        self._refresh_tab_tooltip(tab_key)

    def _mark_agent_task_done(self, tab_key: str):
        page_key = self._task_page_for_tab(tab_key)
        task = self._task_state.get(page_key)
        if not task:
            return
        task["task_status"] = "done"
        task["task_updated_at"] = _task_timestamp()
        task["tab_label"] = self._tab_label(tab_key)
        self._persist_task_state(page_key)
        self._refresh_tab_tooltip(tab_key)

    def _clear_agent_task(self, tab_key: str):
        page_key = self._task_page_for_tab(tab_key)
        self._task_state.pop(page_key, None)
        self._clear_persisted_task_state(page_key)
        self._refresh_tab_tooltip(tab_key)

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

        # Timer-based fallback autohide — guards against the DropDown child
        # stealing/losing focus in ways that leave the popover stuck open.
        _hide_src: list[int | None] = [None]

        def _arm_hide(delay_ms=4000):
            if _hide_src[0] is not None:
                GLib.source_remove(_hide_src[0])
            def _do_hide():
                _hide_src[0] = None
                popover.popdown()
                return False
            _hide_src[0] = GLib.timeout_add(delay_ms, _do_hide)

        def _disarm_hide():
            if _hide_src[0] is not None:
                GLib.source_remove(_hide_src[0])
                _hide_src[0] = None

        motion = Gtk.EventControllerMotion()
        motion.connect("enter", lambda *_: _disarm_hide())
        motion.connect("leave", lambda *_: _arm_hide())
        box.add_controller(motion)
        popover.connect("closed", lambda *_: _disarm_hide())

        # Row 1: New agent + inline command dropdown (claude, codex, gemini, + local Ollama models)
        ollama_models: list[str] = (
            self._ollama_client.list_models() if self._ollama_client is not None else []
        )
        cli_agents = ["claude", "codex", "gemini"]
        agent_labels = cli_agents + [f"{m} (local)" for m in ollama_models]

        agent_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        agent_row.set_valign(Gtk.Align.CENTER)

        agent_lbl = Gtk.Label(label="New agent")
        agent_lbl.set_xalign(0)
        agent_lbl.set_hexpand(True)
        agent_row.append(agent_lbl)

        cmd_dropdown = Gtk.DropDown.new_from_strings(agent_labels)
        cmd_dropdown.set_valign(Gtk.Align.CENTER)
        agent_row.append(cmd_dropdown)

        add_btn = Gtk.Button(label="+")
        add_btn.add_css_class("suggested-action")
        add_btn.set_valign(Gtk.Align.CENTER)

        task_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        task_row.set_valign(Gtk.Align.CENTER)

        task_lbl = Gtk.Label(label="Task")
        task_lbl.set_xalign(0)
        task_row.append(task_lbl)

        task_entry = Gtk.Entry()
        task_entry.set_placeholder_text("Optional prompt")
        task_entry.set_width_chars(30)
        task_entry.set_hexpand(True)
        task_row.append(task_entry)

        def _on_add_agent(_b, _om=ollama_models, _cli=cli_agents, _dd=cmd_dropdown):
            idx = _dd.get_selected()
            task_title = task_entry.get_text()
            popover.popdown()
            if idx < len(_cli):
                self._add_agent_terminal(_cli[idx], task_title=task_title)
            else:
                model = _om[idx - len(_cli)]
                from ollama_dialog import OllamaDialog
                OllamaDialog(self.get_root(), self._ollama_client,
                             initial_prompt=task_title, model=model).present()

        add_btn.connect("clicked", _on_add_agent)
        task_entry.connect("activate", _on_add_agent)
        agent_row.append(add_btn)
        box.append(agent_row)
        box.append(task_row)

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
        _arm_hide()

    def _current_project_id(self) -> str | None:
        page = self._last_terminal_page
        if page.startswith("project-"):
            return page[len("project-"):]
        return None

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

    def _used_tab_label_indices(self, base: str, project_id: str | None = "__all__") -> set[int]:
        return {
            info["label_index"]
            for key, info in self._agent_info.items()
            if info.get("label_base") == base
            and isinstance(info.get("label_index"), int)
            and (project_id == "__all__" or self._tab_project.get(key) == project_id)
        }

    def _add_plain_terminal(self, _show: bool = True, _restore_cmd: str = "",
                             _restore_dir: str = "", _restore_label: str = ""):
        n = self._next_term_number()
        page_key = f"term-{n}"
        project_id = self._current_project_id()
        if _restore_label:
            label = _restore_label
            label_index = n
        else:
            label, label_index = _next_numbered_label(
                "Terminal", self._used_tab_label_indices("Terminal", project_id)
            )
        directory = _restore_dir or self._current_agent_directory()
        self._tab_project[page_key] = project_id
        shell = _restore_cmd or ("bash" if GLib.find_program_in_path("bash") else "sh")

        terminal = self._make_terminal()
        self._terminals[page_key] = terminal
        self._stack.add_named(terminal, page_key)
        self._agent_info[page_key] = {
            "cmd": shell,
            "directory": directory,
            "label_base": "Terminal",
            "label_index": label_index,
        }

        def on_spawned(_term, pid, _error):
            if pid and pid > 0:
                self._terminal_pids[page_key] = pid

        _spawn(terminal, directory, _resolve_command(shell), on_spawned, envv=_project_sandbox_envv(directory))
        terminal.connect("child-exited", self._on_agent_exited, page_key)

        self._add_tab(page_key, label, icon="utilities-terminal-symbolic",
                      closeable=True,
                      on_rename=self._show_agent_rename_popover,
                      on_close=lambda k=page_key: self._close_agent_tab(k))

        if _show:
            self._stack.set_visible_child_name(page_key)
            self._notify_page(page_key)
        self._save_tab_layout()

    def _close_default_agent_tab(self):
        self._remove_tab(_TERMINAL_TAB)
        if self._current_tab == _TERMINAL_TAB:
            self._switch_to_best_tab()

    def _switch_to_best_tab(self):
        visible_keys = [k for k, w in self._tab_widgets.items() if w.get_visible()]
        if not visible_keys:
            self._stack.set_visible_child_name("no-tabs")
            self._notify_page("no-tabs")
        elif _TERMINAL_TAB in visible_keys:
            self._show_terminal(self._last_terminal_page)
        else:
            self._on_tab_clicked(visible_keys[0])

    def _feed_agent_task(self, terminal: Vte.Terminal, text: str) -> bool:
        stdin_text = _task_stdin_text(text)
        if stdin_text:
            terminal.feed_child(stdin_text.encode("utf-8"))
        return False

    def _add_agent_terminal(self, cmd: str, task_title: str = "", _show: bool = True,
                             _restore_dir: str = "", _restore_label: str = ""):
        n = self._next_agent_number()
        page_key = f"agent-{n}"
        label_base = _agent_label_base(cmd)
        project_id = self._current_project_id()
        if _restore_label:
            label = _restore_label
            label_index = n
        else:
            label, label_index = _next_numbered_label(
                label_base, self._used_tab_label_indices(label_base, project_id)
            )
        directory = _restore_dir or self._current_agent_directory()
        self._tab_project[page_key] = project_id

        terminal = self._make_terminal()
        self._terminals[page_key] = terminal
        self._stack.add_named(terminal, page_key)

        self._agent_info[page_key] = {
            "cmd": cmd,
            "directory": directory,
            "label_base": label_base,
            "label_index": label_index,
        }

        normalized_task = _normalize_task_title(task_title)

        def on_spawned(_term, pid, _error):
            if pid and pid > 0:
                self._terminal_pids[page_key] = pid
                if normalized_task:
                    GLib.timeout_add(
                        350,
                        self._feed_agent_task,
                        terminal,
                        normalized_task,
                    )

        _spawn(terminal, directory, _resolve_command(cmd), on_spawned, envv=_project_sandbox_envv(directory))
        terminal.connect("child-exited", self._on_agent_exited, page_key)

        self._add_tab(page_key, label, icon="utilities-terminal-symbolic",
                      closeable=True,
                      on_rename=self._show_agent_rename_popover,
                      on_close=lambda k=page_key: self._close_agent_tab(k))
        if normalized_task:
            self._set_agent_task(page_key, normalized_task, "active")

        if _show:
            self._stack.set_visible_child_name(page_key)
            self._notify_page(page_key)
        self._save_tab_layout()

    def _on_agent_exited(self, terminal, _status, page_key: str):
        if page_key not in self._agent_info:
            return
        self._terminal_pids.pop(page_key, None)
        info = self._agent_info[page_key]

        def on_respawn(_term, pid, _error):
            if pid and pid > 0:
                self._terminal_pids[page_key] = pid

        _spawn(
            terminal,
            info["directory"],
            _resolve_command(info["cmd"]),
            on_respawn,
            envv=_project_sandbox_envv(info["directory"]),
        )

    def _close_agent_tab(self, page_key: str):
        if page_key not in self._agent_info:
            return
        project_id = self._tab_project.get(page_key)
        self._task_state.pop(page_key, None)
        self._clear_persisted_task_state(page_key)
        self._tab_project.pop(page_key, None)
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
        self._save_tab_layout(project_id)

    def _show_agent_tab_menu(self, page_key: str):
        widget = self._tab_widgets.get(page_key)
        if widget is None:
            return

        popover = Gtk.Popover()
        popover.set_parent(widget)
        popover.set_has_arrow(True)
        popover.set_autohide(True)

        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        box.set_margin_start(6)
        box.set_margin_end(6)
        box.set_margin_top(6)
        box.set_margin_bottom(6)

        def add_button(label, callback, sensitive=True):
            btn = Gtk.Button(label=label)
            btn.add_css_class("flat")
            btn.set_halign(Gtk.Align.FILL)
            btn.set_sensitive(sensitive)
            btn.connect("clicked", lambda _: (popover.popdown(), callback()))
            box.append(btn)

        task = self._task_for_tab(page_key)
        has_task = bool(task and _normalize_task_title(task.get("task_title", "")))
        is_done = bool(task and task.get("task_status") == "done")

        add_button("Rename tab", lambda: self._show_agent_rename_popover(page_key))
        add_button("Set task", lambda: self._show_agent_task_popover(page_key))
        add_button("Mark task done", lambda: self._mark_agent_task_done(page_key), has_task and not is_done)
        add_button("Clear task", lambda: self._clear_agent_task(page_key), has_task)

        popover.set_child(box)
        popover.popup()

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

    def _show_agent_task_popover(self, page_key: str):
        widget = self._tab_widgets.get(page_key)
        if widget is None:
            return

        task = self._task_for_tab(page_key)
        current_title = task.get("task_title", "") if task else ""

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
        entry.set_text(current_title)
        entry.set_width_chars(32)
        box.append(entry)

        ok_btn = Gtk.Button(label="OK")
        ok_btn.add_css_class("suggested-action")
        box.append(ok_btn)

        def confirm(_=None):
            self._set_agent_task(page_key, entry.get_text(), "active")
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
        task_page = self._task_page_for_tab(page_key)
        task = self._task_state.get(task_page)
        if task:
            task["tab_label"] = new_label
            task["task_updated_at"] = _task_timestamp()
            self._persist_task_state(task_page)
        self._refresh_tab_tooltip(page_key)
        self._save_tab_layout()

    def _update_terminal_tab_label(self, label: str):
        widget = self._tab_widgets.get(_TERMINAL_TAB)
        if widget is None:
            return
        for child in list(widget):
            if isinstance(child, Gtk.Label):
                child.set_label(label)
                break
        self._refresh_tab_tooltip(_TERMINAL_TAB)

    def _on_tab_clicked(self, tab_key: str):
        if tab_key == _TERMINAL_TAB:
            self._show_terminal(self._last_terminal_page)
        elif (tab_key.startswith("agent-") or tab_key.startswith("term-")) \
                and tab_key in self._agent_info:
            self._stack.set_visible_child_name(tab_key)
            self._notify_page(tab_key)

    def cycle_tabs(self):
        """Advance to the next tab, wrapping around."""
        keys = [k for k, w in self._tab_widgets.items() if w.get_visible()]
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

        self._last_terminal_page = _MASTER_PAGE
        self._update_terminal_tab_label("Root")
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

        _spawn(
            terminal,
            project["directory"],
            self._cmd(),
            on_spawn_done,
            envv=_project_sandbox_envv(project["directory"]),
        )
        terminal.connect("child-exited", self._on_child_exited,
                         project["id"], project["directory"])
        if show:
            self._show_terminal(child_name)

    def show_project_terminal(self, project_id: str):
        name = "project-" + project_id
        if self._stack.get_child_by_name(name) is not None:
            self._show_terminal(name)
        if project_id not in self._restored_tab_layouts:
            self._restored_tab_layouts.add(project_id)
            GLib.idle_add(self._restore_tab_layout, project_id)

    # ── tab layout persistence (G2a / G2b) ───────────────────────────────────

    def _save_tab_layout(self, project_id: str | None = None):
        """Persist the current extra-tab set for the given (or current) project."""
        if getattr(self, "_restoring_tab_layout", False):
            return
        pm = getattr(self, "_pm", None)
        if pm is None:
            return
        if project_id is None:
            project_id = self._current_project_id()
        if project_id is None:
            return
        project = pm.get_project(project_id)
        if project is None:
            return

        layout = []
        for key in self._tab_widgets.keys():
            if key == _TERMINAL_TAB:
                continue
            if not (key.startswith("agent-") or key.startswith("term-")):
                continue
            if self._tab_project.get(key) != project_id:
                continue
            info = self._agent_info.get(key)
            if info is None:
                continue
            label = self._tab_label(key)
            layout.append({
                "key": key,
                "label": label,
                "cmd": info.get("cmd", ""),
                "cwd": info.get("directory", ""),
            })

        project["tab_layout"] = layout
        pm._save_local(project)

    def _restore_tab_layout(self, project_id: str) -> bool:
        """Recreate saved agent/terminal tabs for the given project (called once per project)."""
        project = self._pm.get_project(project_id)
        if project is None:
            return False
        layout = project.get("tab_layout")
        if not isinstance(layout, list) or not layout:
            return False

        self._restoring_tab_layout = True
        try:
            for entry in layout:
                if not isinstance(entry, dict):
                    continue
                key = entry.get("key", "")
                cmd = entry.get("cmd", "")
                label = entry.get("label", "")
                cwd = entry.get("cwd", "")
                if not cmd:
                    continue
                if key.startswith("agent-"):
                    self._add_agent_terminal(
                        cmd, _show=False,
                        _restore_dir=cwd, _restore_label=label,
                    )
                elif key.startswith("term-"):
                    self._add_plain_terminal(
                        _show=False, _restore_cmd=cmd,
                        _restore_dir=cwd, _restore_label=label,
                    )
        finally:
            self._restoring_tab_layout = False
        return False

    def remove_project_terminal(self, project_id: str):
        # Close agent/terminal tabs belonging to this project
        for page_key in [k for k, v in self._tab_project.items() if v == project_id]:
            self._close_agent_tab(page_key)

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

    # ── helpers ───────────────────────────────────────────────────────────────

    def _ensure_terminal_tab(self):
        if _TERMINAL_TAB not in self._tab_widgets:
            self._add_tab(_TERMINAL_TAB, self._default_agent_label(), icon="utilities-terminal-symbolic",
                          closeable=True,
                          on_rename=self._show_agent_rename_popover,
                          on_close=self._close_default_agent_tab)

    def _update_tab_visibility(self, project_id: str | None):
        for key, widget in self._tab_widgets.items():
            if key == _TERMINAL_TAB:
                widget.set_visible(True)
            elif key.startswith("agent-") or key.startswith("term-"):
                widget.set_visible(self._tab_project.get(key) == project_id)
        current_widget = self._tab_widgets.get(self._current_tab)
        if current_widget is not None and not current_widget.get_visible():
            self._set_active_tab(_TERMINAL_TAB)

    def _show_terminal(self, page_name: str):
        self._ensure_terminal_tab()
        self._last_terminal_page = page_name
        self._stack.set_visible_child_name(page_name)
        self._update_terminal_tab_label(
            "Root" if page_name == _MASTER_PAGE else self._default_agent_label()
        )
        if page_name.startswith("project-"):
            self._update_tab_visibility(page_name[len("project-"):])
        else:
            self._update_tab_visibility(None)
        self._notify_page(page_name)

    def _on_terminal_uri_activated(self, terminal, uri, _event=None):
        """Route Ctrl+click terminal URIs through the global apps manager (G6.7)."""
        if not uri or self._global_apps_manager is None:
            return False
        scheme = uri.split(":")[0].lower() if ":" in uri else ""
        if scheme in ("http", "https", "mailto", "webcal"):
            try:
                root = self.get_root()
            except Exception:
                root = None
            return bool(self._global_apps_manager.launch_role_for_uri(
                scheme, uri, anchor_window=root
            ))
        return False

    def _make_terminal(self) -> Vte.Terminal:
        terminal = Vte.Terminal()
        terminal.set_scrollback_lines(10000)
        terminal.set_font(Pango.FontDescription("Monospace 11"))
        self._apply_terminal_colors(terminal)
        try:
            terminal.connect("open-hyperlink", self._on_terminal_uri_activated)
        except Exception:
            pass
        return terminal

    def _apply_terminal_colors(self, terminal: Vte.Terminal):
        if self._color_scheme == "fancy_dark":
            bg_str, fg_str = "#101624", "#f4f8ff"
            palette = _fancy_dark_palette()
        elif self._color_scheme == "fancy_light":
            bg_str, fg_str = "#f7fbff", "#172033"
            palette = _fancy_light_palette()
        elif self._color_scheme == "dark":
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

    def apply_theme(self, scheme):
        self._color_scheme = _normalize_scheme(scheme)
        for terminal in self._terminals.values():
            self._apply_terminal_colors(terminal)
        self.propagate_theme(scheme)

    def _notify_page(self, page_name: str):
        self._set_active_tab(page_name)
        self._focus_visible_terminal(page_name)
        if self._on_page_changed is not None:
            self._on_page_changed(page_name)

    def _on_child_exited(self, terminal, _status, project_id: str, directory: str):
        page = "project-" + project_id
        self._terminal_pids.pop(page, None)

        def on_respawn(_term, pid, _error):
            if pid and pid > 0:
                self._pm.set_shell_pid(project_id, pid)
                self._terminal_pids[page] = pid

        _spawn(
            terminal,
            directory,
            self._cmd(),
            on_respawn,
            envv=_project_sandbox_envv(directory),
        )

    # ── X11 window embedding (G4.8) ───────────────────────────────────────────

    def _try_embed_window(self, xid: int, page_key: str, _attempt: int = 0) -> bool:
        """Retry embedding X11 window xid into page_key up to 5×, 300 ms apart.

        Always leaves the panel in a valid state: on exhausted retries it restores
        the last known terminal page.  Returns False (GLib callback: do not repeat).
        """
        _MAX_ATTEMPTS = 5
        _RETRY_MS = 300

        if page_key not in self._embedded_pages:
            return False  # embedding was cancelled externally

        try:
            success = self._do_embed_window(xid, page_key)
        except Exception:
            success = False

        if success:
            return False

        if _attempt + 1 < _MAX_ATTEMPTS:
            GLib.timeout_add(
                _RETRY_MS, self._try_embed_window, xid, page_key, _attempt + 1
            )
        else:
            self._embedded_pages.pop(page_key, None)
            self._show_terminal(self._last_terminal_page)
        return False

    def _do_embed_window(self, xid: int, page_key: str) -> bool:
        """Embed X11 window xid into the named stack page. Returns True on success.

        Stage 2 placeholder (G4.8): implement via Gtk.Socket.add_id(xid) once the
        socket is mapped and xid is confirmed valid.  Raises NotImplementedError
        until the embedding infrastructure is wired up and live-session validated.
        """
        raise NotImplementedError

    def propagate_theme(self, scheme: str):
        """Propagate theme to embedded app windows via XSETTINGS (G3.5 stub).

        Iterates open embed pages and sends Net/ThemeName via python-xlib.
        No-op until X11 embedding is live-session validated (Phase 2d).
        """
        pass  # Stage 3: iterate _embedded_pages, send XSETTINGS Net/ThemeName

    def respawn_all(self):
        if _TERMINAL_TAB in self._tab_widgets:
            label = "Root" if self._last_terminal_page == _MASTER_PAGE else self._default_agent_label()
            self._update_terminal_tab_label(label)
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
                _spawn(
                    terminal,
                    info["directory"],
                    _resolve_command(info["cmd"]),
                    on_respawn,
                    envv=_project_sandbox_envv(info["directory"]),
                )
