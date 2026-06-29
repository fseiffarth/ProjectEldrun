import { getCurrentWindow } from "@tauri-apps/api/window";
import { IS_MAC } from "../../lib/platform";

export function WindowControls() {
  // macOS draws native traffic-light buttons (top-left) via the Overlay title-bar
  // style configured in tauri.macos.conf.json, so Eldrun's own controls would be
  // redundant — and on the wrong side. Render nothing there.
  if (IS_MAC) return null;

  const win = getCurrentWindow();

  return (
    <div className="wm-controls no-drag">
      <button
        className="wm-btn wm-minimize"
        onClick={() => win.minimize()}
        title="Minimize"
      />
      <button
        className="wm-btn wm-maximize"
        onClick={() => win.toggleMaximize()}
        title="Maximize"
      />
      <button
        className="wm-btn wm-close"
        onClick={() => win.close()}
        title="Close"
      />
    </div>
  );
}
