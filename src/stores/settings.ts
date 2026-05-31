import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import type { Settings, Theme } from "../types";

function applyTheme(scheme: string) {
  document.documentElement.setAttribute("data-theme", scheme);
}

interface SettingsStore {
  settings: Settings | null;
  loaded: boolean;
  load: () => Promise<void>;
  setTheme: (theme: Theme) => Promise<void>;
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  settings: null,
  loaded: false,

  load: async () => {
    const settings = await invoke<Settings>("get_settings");
    applyTheme(settings.color_scheme ?? "fancy_dark");
    set({ settings, loaded: true });
  },

  setTheme: async (theme) => {
    const current = get().settings ?? {};
    const updated = { ...current, color_scheme: theme };
    await invoke<void>("save_settings", { settings: updated });
    applyTheme(theme);
    set({ settings: updated as Settings });
  },
}));
