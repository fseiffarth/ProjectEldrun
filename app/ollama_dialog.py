import gi
gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
from gi.repository import Gtk, Gdk


class OllamaDialog(Gtk.Window):
    def __init__(self, parent, ollama_client, initial_prompt="", model: str | None = None):
        super().__init__()
        title = f"Ask Ollama — {model}" if model else "Ask Ollama"
        self.set_title(title)
        self.set_default_size(560, 420)
        if isinstance(parent, Gtk.Window):
            self.set_transient_for(parent)

        self._client = ollama_client
        self._model = model
        self._streaming = False

        outer = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        outer.set_margin_start(12)
        outer.set_margin_end(12)
        outer.set_margin_top(12)
        outer.set_margin_bottom(12)

        input_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)

        self._prompt_entry = Gtk.Entry()
        self._prompt_entry.set_placeholder_text("Ask Ollama…")
        self._prompt_entry.set_hexpand(True)
        if initial_prompt:
            self._prompt_entry.set_text(initial_prompt)
            self._prompt_entry.set_position(-1)
        self._prompt_entry.connect("activate", self._on_send)
        input_row.append(self._prompt_entry)

        self._send_btn = Gtk.Button(label="Send")
        self._send_btn.add_css_class("suggested-action")
        self._send_btn.connect("clicked", self._on_send)
        input_row.append(self._send_btn)

        outer.append(input_row)

        self._spinner = Gtk.Spinner()
        self._spinner.set_halign(Gtk.Align.CENTER)
        self._spinner.set_visible(False)
        outer.append(self._spinner)

        scrolled = Gtk.ScrolledWindow()
        scrolled.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC)
        scrolled.set_vexpand(True)

        self._response_view = Gtk.TextView()
        self._response_view.set_editable(False)
        self._response_view.set_cursor_visible(False)
        self._response_view.set_wrap_mode(Gtk.WrapMode.WORD_CHAR)
        self._response_view.add_css_class("ollama-response")
        scrolled.set_child(self._response_view)
        outer.append(scrolled)

        self.set_child(outer)

        key_ctrl = Gtk.EventControllerKey()
        key_ctrl.connect("key-pressed", self._on_key)
        self.add_controller(key_ctrl)

    def _on_key(self, _ctrl, keyval, _code, state):
        if keyval == Gdk.KEY_Escape:
            self.close()
            return True
        if keyval == Gdk.KEY_Return and (state & Gdk.ModifierType.CONTROL_MASK):
            self._on_send(None)
            return True
        return False

    def _on_send(self, _widget):
        if self._streaming:
            return
        prompt = self._prompt_entry.get_text().strip()
        if not prompt:
            return
        self._response_view.get_buffer().set_text("")
        self._set_streaming(True)
        self._client.ask(prompt, self._on_chunk, self._on_done, self._on_error,
                         model=self._model)

    def _set_streaming(self, active: bool):
        self._streaming = active
        self._send_btn.set_sensitive(not active)
        self._spinner.set_visible(active)
        if active:
            self._spinner.start()
        else:
            self._spinner.stop()

    def _on_chunk(self, text: str):
        buf = self._response_view.get_buffer()
        buf.insert(buf.get_end_iter(), text)
        adj = self._response_view.get_parent().get_vadjustment()
        adj.set_value(adj.get_upper() - adj.get_page_size())
        return False

    def _on_done(self):
        self._set_streaming(False)
        return False

    def _on_error(self, msg: str):
        self._response_view.get_buffer().set_text(f"Error: {msg}")
        self._set_streaming(False)
        return False
