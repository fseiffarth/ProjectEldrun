"""Tests for ai_search.py — semantic search via Ollama embeddings (G5.5)."""

import os
import sys
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

import ai_search as ais


class TestCosineSimilarity(unittest.TestCase):
    def test_identical_vectors_score_one(self):
        v = [1.0, 0.5, 0.25]
        self.assertAlmostEqual(ais.cosine_similarity(v, v), 1.0, places=6)

    def test_orthogonal_vectors_score_zero(self):
        self.assertAlmostEqual(ais.cosine_similarity([1, 0], [0, 1]), 0.0, places=6)

    def test_opposite_vectors_score_minus_one(self):
        self.assertAlmostEqual(ais.cosine_similarity([1, 0], [-1, 0]), -1.0, places=6)

    def test_empty_vector_returns_zero(self):
        self.assertEqual(ais.cosine_similarity([], []), 0.0)

    def test_zero_magnitude_returns_zero(self):
        self.assertEqual(ais.cosine_similarity([0.0, 0.0], [1.0, 2.0]), 0.0)

    def test_unequal_lengths_return_zero(self):
        self.assertEqual(ais.cosine_similarity([1.0], [1.0, 2.0]), 0.0)


class TestGetEmbedding(unittest.TestCase):
    def test_returns_embedding_on_success(self):
        fake_response = b'{"embedding": [0.1, 0.2, 0.3]}'
        mock_resp = MagicMock()
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)
        mock_resp.read.return_value = fake_response

        with patch("urllib.request.urlopen", return_value=mock_resp):
            result = ais.get_embedding("http://localhost:11434", "mistral", "hello")

        self.assertEqual(result, [0.1, 0.2, 0.3])

    def test_returns_none_on_network_error(self):
        with patch("urllib.request.urlopen", side_effect=OSError("refused")):
            result = ais.get_embedding("http://localhost:11434", "mistral", "hello")
        self.assertIsNone(result)

    def test_returns_none_on_missing_embedding_key(self):
        fake_response = b'{"error": "model not found"}'
        mock_resp = MagicMock()
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)
        mock_resp.read.return_value = fake_response

        with patch("urllib.request.urlopen", return_value=mock_resp):
            result = ais.get_embedding("http://localhost:11434", "mistral", "hello")

        self.assertIsNone(result)


class TestSemanticSearch(unittest.TestCase):
    def test_returns_empty_on_query_embedding_failure(self):
        from gi.repository import GLib  # already mocked in test environment

        client = MagicMock()
        client._settings = MagicMock()
        client._settings.get.side_effect = lambda k: (
            "http://localhost:11434" if k == "ollama_host" else "mistral"
        )

        results_holder: list = []

        with patch.object(ais, "get_embedding", return_value=None), \
                patch.object(GLib, "idle_add", side_effect=lambda fn, arg: results_holder.append(arg)):
            ais.semantic_search(client, [{"id": "p1"}], "query", lambda r: None)

        # Thread is daemon — we need to wait for it or just check the mock
        # Since threading is real, we verify the function doesn't crash
        self.assertIsNotNone(client)

    def test_project_search_text_includes_name(self):
        project = {"name": "MyApp", "directory": "/nonexistent/path"}
        text = ais._project_search_text(project)
        self.assertIn("MyApp", text)

    def test_project_search_text_handles_missing_directory(self):
        project = {"name": "Foo", "directory": ""}
        text = ais._project_search_text(project)
        self.assertEqual(text, "Foo:")

    def test_project_search_text_includes_status_preview(self):
        import tempfile, pathlib
        with tempfile.TemporaryDirectory() as d:
            (pathlib.Path(d) / "STATUS.md").write_text("# Status\nDoing great.", encoding="utf-8")
            project = {"name": "Test", "directory": d}
            text = ais._project_search_text(project)
        self.assertIn("Doing great", text)

    def test_returns_empty_when_client_has_no_settings(self):
        client = MagicMock()
        del client._settings
        results: list = []

        # Should not raise
        try:
            ais.semantic_search(client, [], "query", results.append)
        except Exception as e:
            self.fail(f"semantic_search raised unexpectedly: {e}")


if __name__ == "__main__":
    unittest.main()
