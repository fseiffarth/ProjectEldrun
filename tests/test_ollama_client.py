import io
import json
import sys
import unittest
from unittest.mock import MagicMock, patch

# Stub out gi / GLib before importing the module under test
gi_mock = MagicMock()
sys.modules.setdefault("gi", gi_mock)
sys.modules.setdefault("gi.repository", gi_mock.repository)
glib_mock = MagicMock()
sys.modules["gi.repository"].GLib = glib_mock

import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

# GLib.idle_add must run the callback synchronously for tests
def _idle_add_sync(fn, *args):
    fn(*args)
    return False

glib_mock.idle_add.side_effect = _idle_add_sync

from ollama_client import OllamaClient  # noqa: E402


def _make_ndjson_response(*dicts):
    lines = "\n".join(json.dumps(d) for d in dicts) + "\n"
    return io.BytesIO(lines.encode())


def _make_settings(host="http://localhost:11434", model="mistral"):
    s = MagicMock()
    s.get.side_effect = lambda key: {"ollama_host": host, "ollama_model": model}.get(key, "")
    return s


class TestOllamaClientStreaming(unittest.TestCase):
    def setUp(self):
        self.settings = _make_settings()
        self.client = OllamaClient(self.settings)

    def _run_ask(self, response_body):
        chunks = []
        done_called = []
        errors = []

        with patch("urllib.request.urlopen", return_value=response_body):
            self.client.ask(
                "hello",
                on_chunk=chunks.append,
                on_done=lambda: done_called.append(True),
                on_error=errors.append,
            )
            # Thread is daemon; join it
            import threading
            for t in threading.enumerate():
                if t.daemon and t != threading.main_thread():
                    t.join(timeout=2)

        return chunks, done_called, errors

    def test_chunks_arrive_in_order(self):
        body = _make_ndjson_response(
            {"response": "Hello", "done": False},
            {"response": " world", "done": False},
            {"response": "!", "done": True},
        )
        chunks, done_called, errors = self._run_ask(body)
        self.assertEqual(chunks, ["Hello", " world", "!"])
        self.assertEqual(done_called, [True])
        self.assertEqual(errors, [])

    def test_on_done_called_at_eof(self):
        body = _make_ndjson_response(
            {"response": "hi", "done": True},
        )
        _, done_called, errors = self._run_ask(body)
        self.assertEqual(done_called, [True])
        self.assertEqual(errors, [])

    def test_empty_response_fields_skipped(self):
        body = _make_ndjson_response(
            {"response": "", "done": False},
            {"response": "ok", "done": True},
        )
        chunks, _, _ = self._run_ask(body)
        self.assertEqual(chunks, ["ok"])

    def test_on_error_called_on_connection_refused(self):
        import urllib.error
        chunks = []
        done_called = []
        errors = []

        with patch("urllib.request.urlopen",
                   side_effect=urllib.error.URLError("Connection refused")):
            self.client.ask("hi", chunks.append,
                            lambda: done_called.append(True), errors.append)
            import threading
            for t in threading.enumerate():
                if t.daemon and t != threading.main_thread():
                    t.join(timeout=2)

        self.assertEqual(chunks, [])
        self.assertEqual(done_called, [])
        self.assertTrue(len(errors) == 1)
        self.assertIn("Connection refused", errors[0])

    def test_settings_read_at_call_time(self):
        calls = []
        body = _make_ndjson_response({"response": "x", "done": True})
        settings = MagicMock()
        settings.get.side_effect = lambda key: {
            "ollama_host": "http://myhost:11434",
            "ollama_model": "llama3",
        }.get(key, "")
        client = OllamaClient(settings)

        original_urlopen = __import__("urllib.request", fromlist=["urlopen"]).urlopen

        def capturing_urlopen(req, **kw):
            calls.append(req.full_url)
            return body

        with patch("urllib.request.urlopen", side_effect=capturing_urlopen):
            client.ask("hi", lambda t: None, lambda: None, lambda e: None)
            import threading
            for t in threading.enumerate():
                if t.daemon and t != threading.main_thread():
                    t.join(timeout=2)

        self.assertTrue(any("myhost" in url for url in calls))

    def test_explicit_model_overrides_settings_model_in_request_payload(self):
        requests = []
        body = _make_ndjson_response({"response": "x", "done": True})

        def capturing_urlopen(req, **kw):
            requests.append(req)
            return body

        with patch("urllib.request.urlopen", side_effect=capturing_urlopen):
            self.client.ask(
                "hi",
                lambda _chunk: None,
                lambda: None,
                lambda _error: None,
                model="llama3.1",
            )
            import threading
            for t in threading.enumerate():
                if t.daemon and t != threading.main_thread():
                    t.join(timeout=2)

        payload = json.loads(requests[0].data.decode())
        self.assertEqual(payload["model"], "llama3.1")
        self.assertEqual(payload["prompt"], "hi")
        self.assertIs(payload["stream"], True)

    def test_list_models_returns_ollama_model_names(self):
        body = io.BytesIO(json.dumps({
            "models": [
                {"name": "mistral:latest"},
                {"name": "llama3.1:8b"},
            ],
        }).encode())

        with patch("urllib.request.urlopen", return_value=body) as urlopen:
            self.assertEqual(
                self.client.list_models(),
                ["mistral:latest", "llama3.1:8b"],
            )

        urlopen.assert_called_once_with("http://localhost:11434/api/tags", timeout=1)

    def test_list_models_returns_empty_list_when_server_unavailable(self):
        import urllib.error

        with patch(
            "urllib.request.urlopen",
            side_effect=urllib.error.URLError("Connection refused"),
        ):
            self.assertEqual(self.client.list_models(), [])


class TestOllamaClientIsReady(unittest.TestCase):
    """Phase 4a (G5.1) — async Ollama availability check."""

    def setUp(self):
        self.client = OllamaClient(_make_settings())

    def _run_is_ready(self, urlopen_side_effect):
        results: list = []

        with patch("urllib.request.urlopen", side_effect=urlopen_side_effect):
            self.client.is_ready(results.append)
            import threading
            for t in threading.enumerate():
                if t.daemon and t != threading.main_thread():
                    t.join(timeout=2)

        return results

    def test_returns_true_when_server_responds(self):
        results = self._run_is_ready(lambda *_, **__: MagicMock())
        self.assertEqual(results, [True])

    def test_returns_false_when_server_unavailable(self):
        import urllib.error
        results = self._run_is_ready(
            lambda *_: (_ for _ in ()).throw(urllib.error.URLError("refused"))
        )
        self.assertEqual(results, [False])

    def test_returns_false_on_generic_error(self):
        results = self._run_is_ready(lambda *_: (_ for _ in ()).throw(OSError("no route")))
        self.assertEqual(results, [False])


if __name__ == "__main__":
    unittest.main()
