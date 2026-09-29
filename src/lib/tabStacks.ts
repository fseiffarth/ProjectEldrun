/**
 * Tab groups inside one tab bar ("stacks" in code — "group" already names a
 * subwindow here). A tab joins one by carrying the group's NAME in
 * `TabEntry.stack`; every tab of a bar that carries the same name collapses into
 * a single chip, and hovering that chip lists them to pick one.
 *
 * The membership lives on the tab rather than on the layout node on purpose:
 * a tab dragged to another subwindow, popped out, or restored after a relaunch
 * keeps its group without any of those paths knowing groups exist.
 */

/** Longest name kept; the layout file is on disk, so a stored one is capped. */
export const MAX_STACK_NAME = 40;

/** A usable group name, or `undefined` for "no group". Applied to everything
 *  that reaches `TabEntry.stack` — a typed name and a persisted one alike. */
export function normalizeStackName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.replace(/\s+/g, " ").trim().slice(0, MAX_STACK_NAME).trim();
  return name || undefined;
}

export interface StripTab<T> {
  tab: T;
  /** Position in the bar's ordered tabs (the layout group's `tabKeys`). */
  index: number;
}

/** One slot of the tab strip: a plain tab, or a group chip standing for all of
 *  its members. The chip sits where its FIRST member sits. */
export type StripItem<T> =
  | ({ type: "tab" } & StripTab<T>)
  | { type: "stack"; name: string; index: number; members: StripTab<T>[] };

/** Fold a bar's ordered tabs into strip slots. */
export function stripItems<T extends { stack?: string }>(tabs: readonly T[]): StripItem<T>[] {
  const items: StripItem<T>[] = [];
  const stacks = new Map<string, Extract<StripItem<T>, { type: "stack" }>>();
  tabs.forEach((tab, index) => {
    const name = tab.stack;
    if (!name) {
      items.push({ type: "tab", tab, index });
      return;
    }
    const existing = stacks.get(name);
    if (existing) {
      existing.members.push({ tab, index });
      return;
    }
    const item = { type: "stack" as const, name, index, members: [{ tab, index }] };
    stacks.set(name, item);
    items.push(item);
  });
  return items;
}

/** The distinct group names of a bar, in strip order. */
export function stackNames(tabs: readonly { stack?: string }[]): string[] {
  const names: string[] = [];
  for (const tab of tabs) {
    if (tab.stack && !names.includes(tab.stack)) names.push(tab.stack);
  }
  return names;
}

/**
 * Where `key` should sit in `tabKeys` after joining `stack`: right after the
 * group's last other member, so a group's members stay side by side and
 * Ctrl+Tab walks through them in a row. `null` when nothing needs to move
 * (a new group, or already adjacent).
 */
export function stackJoinOrder(
  tabKeys: readonly string[],
  key: string,
  stack: string,
  stackOf: (key: string) => string | undefined,
): string[] | null {
  const from = tabKeys.indexOf(key);
  if (from < 0) return null;
  let last = -1;
  tabKeys.forEach((k, i) => {
    if (k !== key && stackOf(k) === stack) last = i;
  });
  if (last < 0) return null;
  const rest = tabKeys.filter((k) => k !== key);
  const at = rest.indexOf(tabKeys[last]) + 1;
  const next = [...rest.slice(0, at), key, ...rest.slice(at)];
  return next.every((k, i) => k === tabKeys[i]) ? null : next;
}
