"""No-op workspace backend for unsupported compositors and Wayland sessions."""

from workspace_core import ProjectSpaceBackend


class NullBackend(ProjectSpaceBackend):
    """Passes all workspace calls silently.  Used when no supported backend is available."""

    def is_available(self) -> bool:
        return True
