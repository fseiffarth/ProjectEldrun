import os
import threading

import gi
gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
from gi.repository import Gtk, Gdk, GLib, Pango

from project_manager import sanitize_name, PROJECTS_ROOT


class ImportProjectDialog(Gtk.Window):
    def __init__(self, parent, project_manager, on_imported):
        super().__init__()
        self.set_title("Import Project")
        self.set_transient_for(parent)
        self.set_modal(True)
        self.set_resizable(False)
        self.set_default_size(460, -1)

        self._pm = project_manager
        self._on_imported = on_imported
        self._source_dir: str | None = None

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

        # Folder selection
        folder_outer = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        Gtk.Label(label="Source folder", xalign=0)
        folder_lbl = Gtk.Label(label="Source folder", xalign=0)
        folder_outer.append(folder_lbl)

        folder_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        self._folder_display = Gtk.Label(label="No folder selected", xalign=0.0)
        self._folder_display.add_css_class("dim-label")
        self._folder_display.set_hexpand(True)
        self._folder_display.set_ellipsize(Pango.EllipsizeMode.START)
        browse_btn = Gtk.Button(label="Browse…")
        browse_btn.connect("clicked", self._on_browse)
        folder_row.append(self._folder_display)
        folder_row.append(browse_btn)
        folder_outer.append(folder_row)
        box.append(folder_outer)

        # Name entry
        name_outer = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        name_outer.append(Gtk.Label(label="Project name", xalign=0))
        self._name_entry = Gtk.Entry()
        self._name_entry.set_placeholder_text("my-project")
        self._name_entry.connect("changed", self._on_name_changed)
        self._name_entry.connect("activate", self._on_activate)
        name_outer.append(self._name_entry)
        box.append(name_outer)

        # Visibility dropdown
        type_outer = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        type_outer.append(Gtk.Label(label="Visibility", xalign=0))
        self._type_dropdown = Gtk.DropDown.new_from_strings(["private", "public"])
        self._type_dropdown.set_hexpand(True)
        type_outer.append(self._type_dropdown)
        box.append(type_outer)

        # Import mode
        mode_outer = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        mode_outer.append(Gtk.Label(label="Import mode", xalign=0))
        self._mode_dropdown = Gtk.DropDown.new_from_strings([
            "Keep location (register in place)",
            "Copy to ~/eldrun/projects/",
            "Move to ~/eldrun/projects/",
        ])
        self._mode_dropdown.set_selected(0)
        self._mode_dropdown.set_hexpand(True)
        self._mode_dropdown.connect(
            "notify::selected",
            lambda *_: self._update_state(self._name_entry.get_text()),
        )
        mode_outer.append(self._mode_dropdown)
        box.append(mode_outer)

        # Destination preview
        self._path_lbl = Gtk.Label(label="", xalign=0)
        self._path_lbl.add_css_class("dim-label")
        self._path_lbl.set_wrap(True)
        box.append(self._path_lbl)

        # Status / warning label
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

        self._import_btn = Gtk.Button(label="Import")
        self._import_btn.add_css_class("suggested-action")
        self._import_btn.set_sensitive(False)
        self._import_btn.connect("clicked", self._on_import_clicked)

        btn_row.append(cancel_btn)
        btn_row.append(self._import_btn)
        box.append(btn_row)

    def _on_key_pressed(self, _ctrl, keyval, _code, _state):
        if keyval == Gdk.KEY_Escape:
            self.close()
            return True
        return False

    def _on_activate(self, _entry):
        if self._import_btn.get_sensitive():
            self._on_import_clicked(None)

    def _on_browse(self, _btn):
        self._chooser = Gtk.FileChooserNative.new(
            "Select folder to import",
            self,
            Gtk.FileChooserAction.SELECT_FOLDER,
            "Select",
            "Cancel",
        )
        self._chooser.connect("response", self._on_folder_chosen)
        self._chooser.show()

    def _on_folder_chosen(self, chooser, response):
        self._chooser = None
        if response == Gtk.ResponseType.ACCEPT:
            gfile = chooser.get_file()
            if gfile:
                path = gfile.get_path()
                self._source_dir = path
                self._folder_display.set_text(path)
                if not self._name_entry.get_text().strip():
                    self._name_entry.set_text(os.path.basename(path))
                self._update_state(self._name_entry.get_text())

    def _on_name_changed(self, entry):
        self._update_state(entry.get_text())

    def _get_mode(self) -> str:
        return ["keep", "copy", "move"][self._mode_dropdown.get_selected()]

    def _update_state(self, name: str):
        mode = self._get_mode()

        if mode == "keep":
            if not self._source_dir or not name.strip():
                self._path_lbl.set_text("")
                self._warn_lbl.set_visible(False)
                self._import_btn.set_sensitive(False)
                return
            self._path_lbl.set_text(f"Location: {self._source_dir}")
            self._warn_lbl.set_visible(False)
            self._import_btn.set_sensitive(True)
            return

        safe = sanitize_name(name) if name.strip() else ""
        if not safe or not self._source_dir:
            self._path_lbl.set_text("")
            self._warn_lbl.set_visible(False)
            self._import_btn.set_sensitive(False)
            return

        dest = PROJECTS_ROOT / safe
        self._path_lbl.set_text(f"Destination: {dest}")

        if dest.exists():
            self._warn_lbl.set_text("Destination already exists")
            self._warn_lbl.add_css_class("error")
            self._warn_lbl.remove_css_class("dim-label")
            self._warn_lbl.set_visible(True)
            self._import_btn.set_sensitive(False)
        else:
            self._warn_lbl.set_visible(False)
            self._import_btn.set_sensitive(True)

    def _on_import_clicked(self, _btn):
        name = self._name_entry.get_text().strip()
        git_type = "public" if self._type_dropdown.get_selected() == 1 else "private"
        mode = self._get_mode()
        source = self._source_dir

        self._import_btn.set_sensitive(False)
        self._name_entry.set_sensitive(False)
        self._warn_lbl.set_text("Importing project…")
        self._warn_lbl.remove_css_class("error")
        self._warn_lbl.add_css_class("dim-label")
        self._warn_lbl.set_visible(True)

        def worker():
            try:
                project = self._pm.import_project(source, name, git_type, mode)
                GLib.idle_add(self._finish, project, None)
            except Exception as exc:
                GLib.idle_add(self._finish, None, str(exc))

        threading.Thread(target=worker, daemon=True).start()

    def _finish(self, project, error):
        if error:
            self._warn_lbl.set_text(f"Error: {error}")
            self._warn_lbl.add_css_class("error")
            self._warn_lbl.remove_css_class("dim-label")
            self._warn_lbl.set_visible(True)
            self._import_btn.set_sensitive(True)
            self._name_entry.set_sensitive(True)
        else:
            self.close()
            self._on_imported(project)
        return False
