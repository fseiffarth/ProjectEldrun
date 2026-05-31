import json
import threading
import urllib.error
import urllib.request

from gi.repository import GLib


class OllamaClient:
    def __init__(self, settings_manager):
        self._settings = settings_manager

    def ask(self, prompt: str, on_chunk, on_done, on_error, model: str | None = None):
        host = self._settings.get("ollama_host") or "http://localhost:11434"
        model = model or self._settings.get("ollama_model") or "mistral"
        t = threading.Thread(
            target=self._stream,
            args=(host, model, prompt, on_chunk, on_done, on_error),
            daemon=True,
        )
        t.start()

    def is_ready(self, callback) -> None:
        """Async Ollama availability check; calls callback(bool) on the GLib main loop."""
        host = self._settings.get("ollama_host") or "http://localhost:11434"
        url = f"{host.rstrip('/')}/api/tags"

        def _check():
            try:
                with urllib.request.urlopen(url, timeout=2):
                    ok = True
            except Exception:
                ok = False
            GLib.idle_add(callback, ok)

        threading.Thread(target=_check, daemon=True).start()

    def list_models(self) -> list[str]:
        host = self._settings.get("ollama_host") or "http://localhost:11434"
        url = f"{host.rstrip('/')}/api/tags"
        try:
            with urllib.request.urlopen(url, timeout=1) as resp:
                data = json.loads(resp.read())
                return [m["name"] for m in data.get("models", [])]
        except Exception:
            return []

    def _stream(self, host, model, prompt, on_chunk, on_done, on_error):
        url = f"{host.rstrip('/')}/api/generate"
        payload = json.dumps({"model": model, "prompt": prompt, "stream": True}).encode()
        req = urllib.request.Request(
            url, data=payload, method="POST",
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                for raw_line in resp:
                    line = raw_line.strip()
                    if not line:
                        continue
                    try:
                        chunk = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    text = chunk.get("response", "")
                    if text:
                        GLib.idle_add(on_chunk, text)
                    if chunk.get("done"):
                        break
        except urllib.error.URLError as exc:
            GLib.idle_add(on_error, str(exc.reason))
            return
        except Exception as exc:
            GLib.idle_add(on_error, str(exc))
            return
        GLib.idle_add(on_done)
