import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface KeyboardOptions {
  onTogglePanels: () => void;
}

export function useKeyboard({ onTogglePanels }: KeyboardOptions) {
  useEffect(() => {
    const win = getCurrentWindow();

    async function onKeyDown(e: KeyboardEvent) {
      // F11 — fullscreen toggle
      if (e.key === "F11") {
        e.preventDefault();
        const isFs = await win.isFullscreen();
        win.setFullscreen(!isFs);
        return;
      }

      // Super key — toggle right panel (same as Python app's Super behavior)
      if (e.key === "Meta" || e.key === "Super") {
        e.preventDefault();
        onTogglePanels();
        return;
      }

      // Escape — close any open overlay (handled by child components via stopPropagation)
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onTogglePanels]);
}
