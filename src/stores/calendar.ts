import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import type { CalendarEvent } from "../types";

interface CalendarStore {
  events: CalendarEvent[];
  loaded: boolean;
  /** Load the global event list (once; safe to call repeatedly). */
  load: () => Promise<void>;
  createEvent: (
    date: string,
    time: string,
    title: string,
    notes: string,
  ) => Promise<CalendarEvent>;
  updateEvent: (
    id: string,
    date: string,
    time: string,
    title: string,
    notes: string,
  ) => Promise<void>;
  deleteEvent: (id: string) => Promise<void>;
}

export const useCalendarStore = create<CalendarStore>((set) => ({
  events: [],
  loaded: false,

  load: async () => {
    const events = await invoke<CalendarEvent[]>("get_events").catch(
      () => [] as CalendarEvent[],
    );
    set({ events, loaded: true });
  },

  createEvent: async (date, time, title, notes) => {
    const event = await invoke<CalendarEvent>("create_event", {
      date,
      time,
      title,
      notes,
    });
    set((state) => ({ events: [...state.events, event] }));
    return event;
  },

  updateEvent: async (id, date, time, title, notes) => {
    const updated = await invoke<CalendarEvent>("update_event", {
      id,
      date,
      time,
      title,
      notes,
    });
    set((state) => ({
      events: state.events.map((e) => (e.id === id ? updated : e)),
    }));
  },

  deleteEvent: async (id) => {
    await invoke<void>("delete_event", { id });
    set((state) => ({ events: state.events.filter((e) => e.id !== id) }));
  },
}));
