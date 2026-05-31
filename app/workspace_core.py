"""Core abstractions for desktop workspace integration.

ProjectSpaceBackend — ABC for compositor/desktop adapters.
ProjectWindowRegistry — maps X11 XIDs to owning project IDs.
"""

from abc import ABC, abstractmethod


class ProjectSpaceBackend(ABC):
    """Desktop-agnostic interface for project workspace isolation.

    Core logic (project model, switch logic, state) never calls X11/DBus
    directly; it always goes through this interface.  Each compositor or
    desktop environment is a separate subclass in app/backends/.
    """

    @abstractmethod
    def is_available(self) -> bool:
        """Return True if this backend can operate on the current session."""

    def prepare(self) -> None:
        """Set up backend-level state (e.g. two-workspace model for Cinnamon)."""

    def open_project(self, project_id: str) -> None:
        """Register a newly opened project with the backend."""

    def close_project(self, project_id: str) -> None:
        """Unregister a closed project; does not kill user app windows."""

    def activate_project(
        self,
        project_id: str,
        previous_project_id: str | None,
        eldrun_xid: int | None = None,
        protected_names: set[str] | None = None,
    ) -> None:
        """Show the target project's windows; park the previous project's.

        Args:
            project_id: The project being activated.
            previous_project_id: The project being deactivated, or None.
            eldrun_xid: X11 window ID of the Eldrun window (excluded from moves).
            protected_names: Set of exec basenames for global app windows.
        """

    def assign_window_to_project(self, window_id: int, project_id: str) -> None:
        """Bind a launched app window to the owning project."""

    def save_project_layout(self, project_id: str) -> None:
        """Persist project window layout for later restore."""

    def restore_project_layout(self, project_id: str) -> None:
        """Restore a previously saved project window layout."""

    def make_global_window(self, window_id: int) -> None:
        """Mark a window as sticky / excluded from project moves."""

    def has_managed_windows(self) -> bool:
        """Return True if any project windows are currently being tracked."""
        return False

    def cleanup(self) -> None:
        """Release all managed state; restore desktop to its original condition."""


class ProjectWindowRegistry:
    """Maps X11 XIDs to project IDs for best-effort window ownership tracking."""

    def __init__(self):
        self._xid_to_project: dict[int, str] = {}

    def assign(self, xid: int, project_id: str) -> None:
        self._xid_to_project[xid] = project_id

    def remove(self, xid: int) -> None:
        self._xid_to_project.pop(xid, None)

    def get_project(self, xid: int) -> str | None:
        return self._xid_to_project.get(xid)

    def get_xids(self, project_id: str) -> list[int]:
        return [xid for xid, pid in self._xid_to_project.items() if pid == project_id]

    def clear_project(self, project_id: str) -> None:
        self._xid_to_project = {
            xid: pid
            for xid, pid in self._xid_to_project.items()
            if pid != project_id
        }

    def __len__(self) -> int:
        return len(self._xid_to_project)
