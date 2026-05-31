"""Semantic project search via Ollama embeddings (G5.5).

Usage:
    from ai_search import semantic_search
    semantic_search(ollama_client, projects, "my query", callback)
    # callback is called with a list of (score, project_id) tuples, highest first.
"""

from __future__ import annotations

import json
import math
import pathlib
import threading
import urllib.request


def cosine_similarity(v1: list[float], v2: list[float]) -> float:
    """Cosine similarity between two equal-length embedding vectors."""
    if not v1 or not v2 or len(v1) != len(v2):
        return 0.0
    dot = sum(a * b for a, b in zip(v1, v2))
    n1 = math.sqrt(sum(a * a for a in v1))
    n2 = math.sqrt(sum(b * b for b in v2))
    if n1 == 0.0 or n2 == 0.0:
        return 0.0
    return dot / (n1 * n2)


def get_embedding(host: str, model: str, text: str) -> list[float] | None:
    """Fetch an embedding vector from Ollama /api/embeddings.  Returns None on error."""
    url = f"{host.rstrip('/')}/api/embeddings"
    payload = json.dumps({"model": model, "prompt": text}).encode()
    req = urllib.request.Request(
        url, data=payload, method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
            emb = data.get("embedding")
            return emb if isinstance(emb, list) else None
    except Exception:
        return None


def _project_search_text(project: dict) -> str:
    """Build the text that represents a project for embedding."""
    name = project.get("name", "")
    directory = project.get("directory", "")
    status_preview = ""
    if directory:
        try:
            status_path = pathlib.Path(directory) / "STATUS.md"
            status_preview = status_path.read_text(encoding="utf-8", errors="replace")[:200]
        except Exception:
            pass
    return f"{name}: {status_preview}".strip()


def semantic_search(
    ollama_client,
    projects: list[dict],
    query: str,
    callback,
    top_k: int = 3,
) -> None:
    """Rank projects by semantic similarity to query using Ollama embeddings.

    Runs in a background thread.  Calls callback(results) on the GLib main loop,
    where results is a list of (score: float, project_id: str) tuples, highest first.
    Falls back to callback([]) if embeddings are unavailable.
    """
    settings = getattr(ollama_client, "_settings", None)
    if settings is None:
        try:
            from gi.repository import GLib
            GLib.idle_add(callback, [])
        except Exception:
            pass
        return

    host = settings.get("ollama_host") or "http://localhost:11434"
    model = settings.get("ollama_model") or "mistral"

    def _run():
        from gi.repository import GLib

        q_emb = get_embedding(host, model, query)
        if q_emb is None:
            GLib.idle_add(callback, [])
            return

        scored: list[tuple[float, str]] = []
        for p in projects:
            pid = p.get("id", "")
            if not pid:
                continue
            text = _project_search_text(p)
            p_emb = get_embedding(host, model, text)
            if p_emb is None:
                continue
            score = cosine_similarity(q_emb, p_emb)
            scored.append((score, pid))

        scored.sort(reverse=True)
        GLib.idle_add(callback, scored[:top_k])

    threading.Thread(target=_run, daemon=True).start()
