import { ApiError, api, type TabRow } from "./api";

const LAST_TAB_KEY = "eldrun.mobile.lastTab";

export interface LastTabRef {
  projectId: string;
  tabId: string;
}

type LastTabStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

export function readLastTab(storage?: LastTabStorage): LastTabRef | null {
  try {
    const value = JSON.parse((storage ?? localStorage).getItem(LAST_TAB_KEY) ?? "null") as Partial<LastTabRef> | null;
    return value && validId(value.projectId) && validId(value.tabId)
      ? { projectId: value.projectId, tabId: value.tabId }
      : null;
  } catch {
    return null;
  }
}

export function rememberLastTab(projectId: string, tabId: string, storage?: LastTabStorage): void {
  try {
    (storage ?? localStorage).setItem(LAST_TAB_KEY, JSON.stringify({ projectId, tabId } satisfies LastTabRef));
  } catch {
    // Storage can be unavailable in a private browser; navigation still works
    // for the current session.
  }
}

export function forgetLastTab(storage?: LastTabStorage): void {
  try {
    (storage ?? localStorage).removeItem(LAST_TAB_KEY);
  } catch {
    // See rememberLastTab.
  }
}

export async function restoreLastTab(): Promise<{ projectId: string; tab: TabRow } | null> {
  const saved = readLastTab();
  if (!saved) return null;
  try {
    const { tab } = await api<{ tab: TabRow }>(`/api/v1/tabs/${encodeURIComponent(saved.tabId)}`);
    if (!tab.available) {
      forgetLastTab();
      return null;
    }
    return { projectId: saved.projectId, tab };
  } catch (reason) {
    // A removed tab should not become a permanent dead startup route. Keep the
    // reference on transient host/catalog failures so a later restart can retry.
    if (reason instanceof ApiError && reason.status === 404) forgetLastTab();
    return null;
  }
}
