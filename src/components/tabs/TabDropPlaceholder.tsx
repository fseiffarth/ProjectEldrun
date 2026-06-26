/**
 * The dashed accent slot previewing where a dragged tab will land, rendered in a
 * tab bar at the resolved insertion index. Shared by the main-window `TabBar` and
 * the detached popout's tab bar (`DetachedCenterPanel`) so the merge/reorder drop
 * preview — the `.drop-target` bar wash plus this spring-opening slot — is byte
 * for byte identical in both. Sized like a tab so the surrounding tabs slide to
 * make exactly the room the dragged tab will occupy.
 */
export function TabDropPlaceholder({ label }: { label: string }) {
  return (
    <div className="tab tab-drop-placeholder" aria-hidden="true">
      <span className="tab-drop-placeholder-label">{label || "New tab"}</span>
    </div>
  );
}
