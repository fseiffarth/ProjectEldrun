import { api, type TabRow } from "./api";

/**
 * The key predates sections, when this slot held a bare `{ projectId, tabId }`
 * terminal route; a value in that old shape still reads back as the terminal it
 * named, so an update does not lose the phone's place.
 */
const LAST_PLACE_KEY = "eldrun.mobile.lastTab";

/** The tab bar's four sections — App's `Tab`, defined here because this module validates it. */
export const MOBILE_SECTIONS = ["projects", "todo", "calendar", "mail"] as const;
export type MobileSection = (typeof MOBILE_SECTIONS)[number];

/**
 * Where the reader was standing when the app was last put down. A PWA is
 * unlocked and re-authenticated from scratch on every cold open, so without
 * this every return lands on the project list.
 *
 * `projectId`/`tabId` only mean anything under `projects`: the project whose
 * tab list was open, and the terminal open on top of it, if any.
 */
export interface LastPlace {
  section: MobileSection;
  projectId?: string;
  tabId?: string;
}

/** What `restoreLastPlace` resolved that reference to, with the tab re-read from the host. */
export interface RestoredPlace {
  section: MobileSection;
  projectId?: string;
  tab?: TabRow;
}

type LastPlaceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

function isSection(value: unknown): value is MobileSection {
  return MOBILE_SECTIONS.includes(value as MobileSection);
}

export function readLastPlace(storage?: LastPlaceStorage): LastPlace | null {
  try {
    const value = JSON.parse((storage ?? localStorage).getItem(LAST_PLACE_KEY) ?? "null") as Partial<LastPlace> | null;
    if (!value || typeof value !== "object") return null;
    // No section at all is the pre-sections shape: a terminal route under Projects.
    const section = value.section === undefined ? "projects" : value.section;
    if (!isSection(section)) return null;
    if (section !== "projects" || !validId(value.projectId)) return { section };
    return validId(value.tabId)
      ? { section, projectId: value.projectId, tabId: value.tabId }
      : { section, projectId: value.projectId };
  } catch {
    return null;
  }
}

export function rememberLastPlace(place: LastPlace, storage?: LastPlaceStorage): void {
  try {
    (storage ?? localStorage).setItem(LAST_PLACE_KEY, JSON.stringify(place));
  } catch {
    // Storage can be unavailable in a private browser; navigation still works
    // for the current session.
  }
}

export function forgetLastPlace(storage?: LastPlaceStorage): void {
  try {
    (storage ?? localStorage).removeItem(LAST_PLACE_KEY);
  } catch {
    // See rememberLastPlace.
  }
}

/**
 * Resolve the saved place against the host. Only the terminal needs the round
 * trip — a section is the phone's own business, and the tab's label and state
 * must come from the host rather than from a stale copy in storage.
 *
 * A tab that is gone, or that the host cannot answer for right now, degrades to
 * that project's tab list rather than to nothing: the reader still arrives one
 * tap from where they were, and the caller records the narrowed place as it
 * would any other navigation.
 */
export async function restoreLastPlace(): Promise<RestoredPlace | null> {
  const saved = readLastPlace();
  if (!saved) return null;
  if (saved.section !== "projects" || !saved.projectId) return { section: saved.section };
  const place: RestoredPlace = { section: "projects", projectId: saved.projectId };
  if (!saved.tabId) return place;
  try {
    const { tab } = await api<{ tab: TabRow }>(`/api/v1/tabs/${encodeURIComponent(saved.tabId)}`);
    return tab.available ? { ...place, tab } : place;
  } catch {
    return place;
  }
}
