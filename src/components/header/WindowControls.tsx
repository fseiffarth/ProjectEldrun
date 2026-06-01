import { getCurrentWindow } from "@tauri-apps/api/window";

export function WindowControls() {
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
