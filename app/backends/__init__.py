"""Backend registry and auto-detection for project workspace isolation."""

try:
    from workspace_core import ProjectSpaceBackend
except ModuleNotFoundError:
    from app.workspace_core import ProjectSpaceBackend


def detect_backend() -> ProjectSpaceBackend:
    """Probe the current session and return the best available backend.

    Detection order:
      1. KDE Plasma (X11 or Wayland) → KDEKWinBackend if KWin DBus responds.
      2. Non-KDE X11 → CinnamonX11Backend (handles Cinnamon, GNOME, wmctrl).
      3. Wayland non-KDE → NullBackend.
      4. Fallback → NullBackend.
    """
    import os

    desktop = os.environ.get("XDG_CURRENT_DESKTOP", "").lower()

    # KDE Plasma — must be checked before Cinnamon since KDE/X11 also has wmctrl
    if "kde" in desktop or "plasma" in desktop:
        if __package__ == "app.backends":
            from app.backends.kde_kwin import KDEKWinBackend
        else:
            from backends.kde_kwin import KDEKWinBackend
        b = KDEKWinBackend()
        if b.is_available():
            return b

    # Non-KDE X11 (Cinnamon, GNOME fallback, wmctrl)
    if not os.environ.get("WAYLAND_DISPLAY"):
        if __package__ == "app.backends":
            from app.backends.cinnamon_x11 import CinnamonX11Backend
        else:
            from backends.cinnamon_x11 import CinnamonX11Backend
        b = CinnamonX11Backend()
        if b.is_available():
            return b

    if __package__ == "app.backends":
        from app.backends.null import NullBackend
    else:
        from backends.null import NullBackend
    return NullBackend()
