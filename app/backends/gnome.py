"""GNOME Shell workspace backend stub.

Full implementation: use DBus `org.gnome.Shell.Eval` and gsettings to control
workspace count and window placement.  Currently the GNOME branch is handled
inside WorkspaceManager (via CinnamonX11Backend).  This class is reserved for
a dedicated GNOME-only adapter that does not go through WorkspaceManager.
"""

from workspace_core import ProjectSpaceBackend


class GnomeBackend(ProjectSpaceBackend):
    """GNOME Shell workspace adapter (stub — not yet wired into detect_backend)."""

    def is_available(self) -> bool:
        try:
            import subprocess
            result = subprocess.run(
                ["gsettings", "get", "org.gnome.mutter", "dynamic-workspaces"],
                capture_output=True, timeout=2,
            )
            return result.returncode == 0
        except Exception:
            return False
