import { Clock } from "../header/Clock";
import { StatusLamp } from "../header/StatusLamp";
import { WindowControls } from "../header/WindowControls";

export function HeaderBar() {
  return (
    <header className="app-header">
      <WindowControls />
      <span className="app-title" style={{ flex: 1 }}>Eldrun</span>
      <StatusLamp online={true} workspaceLabel="workspace" />
      <Clock />
    </header>
  );
}
