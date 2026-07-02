/**
 * Placeholder shown in a remote (SSH) project's REMOTE pane while its pooled
 * connection is down. Mounting the real terminal/SFTP view here would spawn
 * `ssh -tt` against a dead pool and freeze the window, so the pane is held until
 * the project connects (then it re-renders and the live view takes over). Local
 * panes and the file browser are NOT held — they work on the mirror offline.
 *
 * Shared by both the remote terminal pane (CenterPanel) and the remote file
 * viewer (FileViewerPane, for a remote-native file), so a disconnected remote
 * shows ONE unified "Not connected" card instead of each viewer flashing its own
 * red read error.
 */
export function RemotePaneHold({ host, onConnect }: { host: string; onConnect: () => void }) {
  return (
    <div className="center-placeholder" style={{ height: "100%" }}>
      <div className="center-placeholder-card">
        <div className="center-placeholder-title">Not connected</div>
        <div className="center-placeholder-hint">
          This tab runs on {host || "the remote host"}. Connect to start it — your
          local tabs keep working on the mirror meanwhile.
        </div>
        <div className="project-dialog-actions" style={{ justifyContent: "center" }}>
          <button type="button" className="btn-primary" onClick={onConnect}>
            Connect
          </button>
        </div>
      </div>
    </div>
  );
}
