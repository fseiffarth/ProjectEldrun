"""Backend registry and auto-detection for project workspace isolation."""

from workspace_core import ProjectSpaceBackend


def detect_backend() -> ProjectSpaceBackend:
    """Probe the current session and return the best available backend.

    Detection order:
      1. Wayland session → NullBackend (no X11 workspace control available).
      2. X11 session → CinnamonX11Backend if Cinnamon/GNOME/wmctrl is present.
      3. Fallback → NullBackend.
    """
    import os

    if os.environ.get("WAYLAND_DISPLAY"):
        from backends.null import NullBackend
        return NullBackend()

    from backends.cinnamon_x11 import CinnamonX11Backend
    b = CinnamonX11Backend()
    if b.is_available():
        return b

    from backends.null import NullBackend
    return NullBackend()
