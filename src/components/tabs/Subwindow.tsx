import { allGroups, useTabsStore } from "../../stores/tabs";
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
 */
export function Subwindow({ groupId, projectCwd, children }: Props) {
  const focusGroup = useTabsStore((s) => s.focusGroup);
  const focusedGroupId = useTabsStore((s) => s.focusedGroupId);
  // The per-subwindow close button only makes sense with >1 subwindow.
  const groupCount = useTabsStore((s) => allGroups(s.layout).length);
  const showClose = groupCount > 1;

  const isFocused = focusedGroupId === groupId;

  return (
    <div
      className={`subwindow${isFocused ? " focused" : ""}`}
      onMouseDownCapture={() => {
        if (!isFocused) focusGroup(groupId);
      }}
    >
      <TabBar groupId={groupId} projectCwd={projectCwd} showGroupClose={showClose} />
      <div className="subwindow-body">{children}</div>
    </div>
  );
}
