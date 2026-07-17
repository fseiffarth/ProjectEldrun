import { useWindowFocused } from "../../hooks/useWindowFocused";
import { allGroups, useGroup, useTabsStore } from "../../stores/tabs";
import { SubwindowFilesSidebar } from "../files/SubwindowFilesSidebar";
import { TabBar } from "./TabBar";

interface Props {
  groupId: string;
  projectCwd: string;
  /** Rendered pane region (the active tab's TerminalView/FileBrowser slot). */
  children: React.ReactNode;
}

/**
 * One tiling subwindow: a per-group tab bar atop the group's pane region.
 * Clicking the subwindow focuses its group. The split-preview overlay (shown
 * while a tab is dragged over this group) and the drop itself are both owned by
 * CenterPanel — the preview must paint ABOVE the flat pane layer, which lives in
 * a separate stacking context outside this subtree.
 *
 * When the group's `filesOpen` flag is set, a docked file-viewer column
 * (`SubwindowFilesSidebar`) renders on the body's right edge, NEXT TO the
 * measured pane slot — the slot shrinks, so CenterPanel's flat pane layer
 * (positioned over the slot's measured rect) never covers the sidebar.
 */
export function Subwindow({ groupId, projectCwd, children }: Props) {
  const focusGroup = useTabsStore((s) => s.focusGroup);
  const focusedGroupId = useTabsStore((s) => s.focusedGroupId);
  const scope = useTabsStore((s) => s.scope);
  // The per-subwindow file viewer's persisted state lives on the group NODE.
  const group = useGroup(groupId);
  const setGroupFilesWidth = useTabsStore((s) => s.setGroupFilesWidth);
  const setGroupFiles = useTabsStore((s) => s.setGroupFiles);
  const setGroupFilesFolder = useTabsStore((s) => s.setGroupFilesFolder);
  // The per-subwindow close button only makes sense with >1 subwindow.
  const groupCount = useTabsStore((s) => allGroups(s.layout).length);
  const showClose = groupCount > 1;

  // Only the OS-focused window paints an active subwindow, so a popout and the
  // main window never both highlight one at once (#42 ergonomics).
  const windowFocused = useWindowFocused();
  const isFocused = windowFocused && focusedGroupId === groupId;

  return (
    <div
      className={`subwindow${isFocused ? " focused" : ""}`}
      onMouseDownCapture={() => {
        if (!isFocused) focusGroup(groupId);
      }}
    >
      <TabBar groupId={groupId} projectCwd={projectCwd} showGroupClose={showClose} />
      <div className="subwindow-body">
        <div className="subwindow-pane-region">{children}</div>
        {group?.filesOpen && (
          <SubwindowFilesSidebar
            scope={scope}
            cwd={projectCwd}
            width={group.filesWidth}
            onWidthChange={(w) => setGroupFilesWidth(groupId, w)}
            folder={group.filesFolder}
            onFolderChange={(f) => setGroupFilesFolder(groupId, f)}
            onHide={() => setGroupFiles(groupId, false)}
            canOpenTabs
          />
        )}
      </div>
    </div>
  );
}
