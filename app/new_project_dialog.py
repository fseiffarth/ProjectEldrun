import threading

import gi
gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
from gi.repository import Gtk, Gdk, GLib

from project_manager import sanitize_name, PROJECTS_ROOT, create_remote_repo


class NewProjectDialog(Gtk.Window):
    def __init__(self, parent, project_manager, on_created, settings_manager=None):
        super().__init__()
        self.set_title("New Project")
        self.set_transient_for(parent)
        self.set_modal(True)
        self.set_resizable(False)
        self.set_default_size(440, -1)

        self._pm = project_manager
        self._on_created = on_created
        self._settings = settings_manager
        self._created_project = None  # set on partial success (remote failed)

        self._build_ui()

        ctrl = Gtk.EventControllerKey()
        ctrl.connect("key-pressed", self._on_key_pressed)
        self.add_controller(ctrl)

    def _build_ui(self):
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        box.set_margin_start(24)
        box.set_margin_end(24)
        box.set_margin_top(24)
        box.set_margin_bottom(24)
        self.set_child(box)

        # Name entry
        name_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        name_lbl = Gtk.Label(label="Project name", xalign=0)
        self._name_entry = Gtk.Entry()
        self._name_entry.set_placeholder_text("my-project")
        self._name_entry.connect("changed", self._on_name_changed)
        self._name_entry.connect("activate", self._on_activate)
        name_box.append(name_lbl)
        name_box.append(self._name_entry)
        box.append(name_box)

        # Type dropdown
        type_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        type_lbl = Gtk.Label(label="Visibility", xalign=0)
        self._type_dropdown = Gtk.DropDown.new_from_strings(["private", "public"])
        self._type_dropdown.set_hexpand(True)
        type_box.append(type_lbl)
        type_box.append(self._type_dropdown)
        box.append(type_box)

        # Remote repository checkbox
        remote_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        self._remote_check = Gtk.CheckButton(label="Create remote repository")
        self._remote_check.set_active(False)
        has_hosting = bool(
            self._settings and self._settings.get("git_profile_url")
            and self._settings.get("git_token")
        )
        self._remote_check.set_sensitive(has_hosting)
        if not has_hosting:
            self._remote_check.set_tooltip_text(
                "Set a Git hosting account in Settings to enable this"
            )
        remote_row.append(self._remote_check)
        box.append(remote_row)

        # Live path preview
        self._path_lbl = Gtk.Label(label="", xalign=0)
        self._path_lbl.add_css_class("dim-label")
        self._path_lbl.set_wrap(True)
        box.append(self._path_lbl)

        # Warning / status label
        self._warn_lbl = Gtk.Label(label="", xalign=0)
        self._warn_lbl.set_visible(False)
        self._warn_lbl.set_wrap(True)
        box.append(self._warn_lbl)

        # Buttons
        btn_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        btn_row.set_halign(Gtk.Align.END)
        btn_row.set_margin_top(8)

        cancel_btn = Gtk.Button(label="Cancel")
        cancel_btn.connect("clicked", lambda _: self.close())

        self._create_btn = Gtk.Button(label="Create")
        self._create_btn.add_css_class("suggested-action")
        self._create_btn.set_sensitive(False)
        self._create_btn.connect("clicked", self._on_create_clicked)

        btn_row.append(cancel_btn)
        btn_row.append(self._create_btn)
        box.append(btn_row)

        self._update_state("")

    def _on_key_pressed(self, _ctrl, keyval, _code, _state):
        if keyval == Gdk.KEY_Escape:
            self.close()
            return True
        return False

    def _on_activate(self, _entry):
        if self._create_btn.get_sensitive():
            self._on_create_clicked(None)

    def _on_name_changed(self, entry):
        self._update_state(entry.get_text())

    def _update_state(self, name: str):
        safe = sanitize_name(name) if name.strip() else ""
        if not safe:
            self._path_lbl.set_text("")
            self._warn_lbl.set_visible(False)
            self._create_btn.set_sensitive(False)
            return

        path = PROJECTS_ROOT / safe
        self._path_lbl.set_text(f"Path: {path}")

        if path.exists():
            self._warn_lbl.set_text("Folder already exists")
            self._warn_lbl.add_css_class("error")
            self._warn_lbl.remove_css_class("dim-label")
            self._warn_lbl.set_visible(True)
            self._create_btn.set_sensitive(False)
        else:
            self._warn_lbl.set_visible(False)
            self._create_btn.set_sensitive(True)

    def _on_create_clicked(self, _btn):
        # "Close" mode after partial success (remote failed)
        if self._created_project is not None:
            self.close()
            self._on_created(self._created_project)
            return

        name = self._name_entry.get_text().strip()
        git_type = "public" if self._type_dropdown.get_selected() == 1 else "private"
        want_remote = self._remote_check.get_active()
        profile_url = self._settings.get("git_profile_url") if self._settings else ""
        token = self._settings.get("git_token") if self._settings else ""

        self._create_btn.set_sensitive(False)
        self._name_entry.set_sensitive(False)
        self._warn_lbl.set_text("Creating project…")
        self._warn_lbl.remove_css_class("error")
        self._warn_lbl.add_css_class("dim-label")
        self._warn_lbl.set_visible(True)

        def worker():
            try:
                project = self._pm.create_project(name, git_type)
            except Exception as exc:
                GLib.idle_add(self._finish, None, str(exc), None)
                return

            remote_warning = None
            if want_remote and profile_url and token:
                try:
                    from project_manager import sanitize_name as _san
                    create_remote_repo(
                        project["directory"],
                        _san(name),
                        git_type,
                        profile_url,
                        token,
                    )
                except Exception as exc:
                    remote_warning = str(exc)

            GLib.idle_add(self._finish, project, None, remote_warning)

        threading.Thread(target=worker, daemon=True).start()

    def _finish(self, project, error, remote_warning=None):
        if error:
            self._warn_lbl.set_text(f"Error: {error}")
            self._warn_lbl.add_css_class("error")
            self._warn_lbl.remove_css_class("dim-label")
            self._warn_lbl.set_visible(True)
            self._create_btn.set_sensitive(True)
            self._name_entry.set_sensitive(True)
        elif remote_warning:
            self._warn_lbl.set_text(f"Project created locally.\nRemote failed: {remote_warning}")
            self._warn_lbl.add_css_class("error")
            self._warn_lbl.remove_css_class("dim-label")
            self._warn_lbl.set_visible(True)
            self._create_btn.set_label("Close")
            self._create_btn.set_sensitive(True)
            self._created_project = project
        else:
            self.close()
            self._on_created(project)
        return False
