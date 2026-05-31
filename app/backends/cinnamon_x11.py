"""Cinnamon / X11 workspace backend.

Wraps WorkspaceManager to expose the ProjectSpaceBackend interface.
Handles Cinnamon DBus, GNOME Shell DBus, and wmctrl — all X11 paths.
"""

from workspace_core import ProjectSpaceBackend


class CinnamonX11Backend(ProjectSpaceBackend):
    """Adapter that delegates to WorkspaceManager for all X11 workspace control."""

    def __init__(self):
        from workspace_manager import WorkspaceManager
        self._wm = WorkspaceManager()

    def is_available(self) -> bool:
        return self._wm.is_available()

    def prepare(self) -> None:
        self._wm.setup_two_workspaces()

    def close_project(self, project_id: str) -> None:
        self._wm.on_project_closed(project_id)

    def activate_project(
        self,
        project_id: str,
        previous_project_id: str | None,
        eldrun_xid: int | None = None,
        protected_names: set[str] | None = None,
    ) -> None:
        self._wm.switch_project(
            previous_project_id, project_id, eldrun_xid, protected_names
        )

    def has_managed_windows(self) -> bool:
        return bool(self._wm._project_windows)

    def cleanup(self) -> None:
        self._wm.release_all()
