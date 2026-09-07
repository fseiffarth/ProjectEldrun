/**
 * The global-app bar's two lists have to stay in step.
 *
 * A role Eldrun grew its own surface for is dropped from `GLOBAL_APP_ROLES`,
 * but that alone does not remove it from the bar: an existing `settings.json`
 * (or a seeded platform default) still holds the entry, and `orderedGlobalApps`
 * deliberately renders *unknown* roles so a hand-added one is not swallowed. A
 * retired role therefore comes back as an unnamed "●" button unless it is also
 * in `RETIRED_GLOBAL_APP_ROLES` — which is exactly what happened to
 * `print_manager`: the comment above the set named it as retired and the set
 * did not contain it.
 *
 * These tests pin the three behaviours that gap sat between: a live role
 * renders, a retired one does not, and a role belonging to neither list still
 * does (the property that makes the retirement list necessary in the first
 * place).
 */
import { describe, it, expect } from "vitest";
import { GLOBAL_APP_ROLES, orderedGlobalApps } from "../components/layout/GlobalAppBar";
import type { GlobalAppEntry } from "../types";

/** Every role Eldrun replaced with a surface of its own. Kept as a literal
 *  rather than imported: a test that reads the value under test proves
 *  nothing. */
const RETIRED = [
  "mail",
  "calendar",
  "file_manager",
  "print_manager",
  "system_monitor",
  "notes",
  "media_player",
];

function settings(...roles: string[]): Record<string, GlobalAppEntry> {
  return Object.fromEntries(roles.map((role) => [role, { exec: `/usr/bin/${role}`, visible: true }]));
}

function rolesIn(apps: Record<string, GlobalAppEntry>): string[] {
  return orderedGlobalApps(apps).map(([role]) => role);
}

describe("global app roles", () => {
  it("renders a live role", () => {
    expect(rolesIn(settings("browser"))).toEqual(["browser"]);
  });

  it.each(RETIRED)("does not render the retired %s role", (role) => {
    expect(rolesIn(settings(role))).toEqual([]);
  });

  it("drops every retired role while keeping the live ones", () => {
    const apps = settings("browser", "screenshot", ...RETIRED);
    expect(rolesIn(apps)).toEqual(["browser", "screenshot"]);
  });

  it("still renders a role in neither list", () => {
    // The reason the retirement list has to exist: an unknown role is rendered
    // so a hand-added one is not silently swallowed.
    expect(rolesIn(settings("torrent_client"))).toEqual(["torrent_client"]);
  });

  it("no role is both live and retired", () => {
    const live = GLOBAL_APP_ROLES.map((role) => role.key);
    expect(live.filter((role) => RETIRED.includes(role))).toEqual([]);
  });

  it("orders live roles by the registry, unknown ones alphabetically after", () => {
    const apps = settings("screenshot", "browser", "zzz_tool", "aaa_tool");
    expect(rolesIn(apps)).toEqual(["browser", "screenshot", "aaa_tool", "zzz_tool"]);
  });
});
