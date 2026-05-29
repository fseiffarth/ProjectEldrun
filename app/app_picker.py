import gi
gi.require_version("Gtk", "4.0")
from gi.repository import Gtk


def show_app_picker(callback, parent=None, for_file: str | None = None):
    from default_apps_manager import get_installed_apps, get_mime_for_file
    apps = get_installed_apps()

    suggested_execs: set[str] = set()
    if for_file:
        mime = get_mime_for_file(for_file)
        if mime:
            suggested_execs = {
                a["exec"] for a in apps
                if mime in a.get("mime_types", [])
            }

    win = Gtk.Window()
    win.set_title("Choose Application")
    win.set_modal(True)
    win.set_default_size(360, 440)
    if parent:
        win.set_transient_for(parent)

    vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)

    search = Gtk.SearchEntry()
    search.set_placeholder_text("Search apps…")
    search.set_margin_start(8)
    search.set_margin_end(8)
    search.set_margin_top(8)
    search.set_margin_bottom(4)
    vbox.append(search)

    scrolled = Gtk.ScrolledWindow()
    scrolled.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
    scrolled.set_vexpand(True)

    listbox = Gtk.ListBox()
    listbox.set_selection_mode(Gtk.SelectionMode.SINGLE)

    def row_filter(r):
        q = search.get_text().lower().strip()
        if not q:
            return True
        return q in getattr(r, "app_name", "").lower() or q in getattr(r, "app_exec", "").lower()

    listbox.set_filter_func(row_filter)
    search.connect("search-changed", lambda _: listbox.invalidate_filter())

    def make_app_row(a: dict) -> Gtk.ListBoxRow:
        r = Gtk.ListBoxRow()
        r.app_name = a["name"]
        r.app_exec = a["exec"]
        row_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        row_box.set_margin_start(8)
        row_box.set_margin_top(4)
        row_box.set_margin_bottom(4)
        icon = Gtk.Image.new_from_icon_name(
            a.get("icon", "application-x-executable-symbolic")
        )
        icon.set_pixel_size(16)
        row_box.append(icon)
        lbl = Gtk.Label(label=a["name"], xalign=0)
        lbl.set_hexpand(True)
        row_box.append(lbl)
        r.set_child(row_box)
        return r

    def add_header(text: str):
        hr = Gtk.ListBoxRow()
        hr.set_selectable(False)
        hr.app_name = ""
        hr.app_exec = ""
        hl = Gtk.Label(label=text, xalign=0)
        hl.add_css_class("dim-label")
        hl.set_margin_start(8)
        hl.set_margin_top(6)
        hl.set_margin_bottom(2)
        hr.set_child(hl)
        listbox.append(hr)

    def add_separator():
        sr = Gtk.ListBoxRow()
        sr.set_selectable(False)
        sr.app_name = ""
        sr.app_exec = ""
        sr.set_child(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL))
        listbox.append(sr)

    if suggested_execs:
        suggested = [a for a in apps if a["exec"] in suggested_execs]
        others = [a for a in apps if a["exec"] not in suggested_execs]
        add_header("Suggested")
        for a in suggested:
            listbox.append(make_app_row(a))
        add_separator()
        add_header("All Applications")
        for a in others:
            listbox.append(make_app_row(a))
    else:
        for a in apps:
            listbox.append(make_app_row(a))

    def on_activated(_lb, r):
        if getattr(r, "app_exec", ""):
            callback(r.app_exec)
            win.close()

    listbox.connect("row-activated", on_activated)
    scrolled.set_child(listbox)
    vbox.append(scrolled)

    win.set_child(vbox)
    win.present()
