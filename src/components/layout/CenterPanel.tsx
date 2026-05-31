import { TerminalView } from "../terminal/TerminalView";

export function CenterPanel() {
  // Phase 3: root terminal proves xterm.js + PTY before the full tab model.
  // An empty cwd tells the Rust backend to resolve the user's HOME directory.
  // Phase 5 will replace this with the full tab bar and tab lifecycle.
  return (
    <div className="center-panel">
      <TerminalView
        id="root"
        cmd="bash"
        args={["--login"]}
        cwd=""
        active={true}
      />
    </div>
  );
}
