/**
 * The user-facing project "type" labels/badges. A project's type is the product
 * of two independent axes — the git axis (6 label states: no-git, local, and
 * remote-private/remote-public each forking by GitHub/GitLab provider) and the
 * connection axis (local files vs an SSH host, i.e. `project.remote` set) — for
 * 12 combinations in all. A transient "no scaffold" warning stacks on top as a
 * separate axis. These tests lock the derivation in `projectTypeTags` /
 * `gitTypeLabel` / `providerName` (pure, extracted from `ProjectPill.tsx`).
 */
import { describe, it, expect } from "vitest";

import { providerName, gitTypeLabel, projectTypeTags } from "../components/projects/projectTypeTags";
import { formatRemoteTarget, type ProjectEntry, type RemoteSpec } from "../types";

const SSH: RemoteSpec = { user: "ada", host: "box.example", remote_path: "/srv/app" };

/** Minimal entry carrying only the fields the tag logic reads. `git_type` rides
 *  the `[key: string]: unknown` index signature, so it is set via `extra`. */
function entry(extra: Partial<ProjectEntry> & Record<string, unknown> = {}): ProjectEntry {
  return {
    id: "p1",
    name: "Proj",
    status: "inactive",
    position: 0,
    local_file: "proj",
    ...extra,
  };
}

/** Compare only the load-bearing facets of each tag (key/label/color); static
 *  tooltip wording is asserted separately where it carries logic. */
function facets(tags: ReturnType<typeof projectTypeTags>) {
  return tags.map((t) => ({ key: t.key, label: t.label, color: t.color }));
}

const GIT = { key: "git", label: "git", color: "#3fb950" };
const NO_GIT = { key: "git", label: "no git", color: "#8b949e" };
const GITHUB = { key: "provider", label: "GitHub", color: "#a371f7" };
const GITLAB = { key: "provider", label: "GitLab", color: "#fc6d26" };
const SSH_TAG = { key: "ssh", label: "SSH", color: "#58a6ff" };

/** The 6 git-label states, each as (git_type, git_provider) → expected git-axis
 *  tag facets (before the connection axis is layered on). */
const GIT_STATES: Array<{ name: string; extra: Record<string, unknown>; tags: typeof GIT[] }> = [
  { name: "no git", extra: { git_type: "none" }, tags: [NO_GIT] },
  { name: "local", extra: { git_type: "local" }, tags: [GIT] },
  { name: "remote-private · GitHub", extra: { git_type: "remote-private", git_provider: "github" }, tags: [GIT, GITHUB] },
  { name: "remote-private · GitLab", extra: { git_type: "remote-private", git_provider: "gitlab" }, tags: [GIT, GITLAB] },
  { name: "remote-public · GitHub", extra: { git_type: "remote-public", git_provider: "github" }, tags: [GIT, GITHUB] },
  { name: "remote-public · GitLab", extra: { git_type: "remote-public", git_provider: "gitlab" }, tags: [GIT, GITLAB] },
];

describe("projectTypeTags — the 12 project combinations", () => {
  for (const state of GIT_STATES) {
    it(`${state.name} · local files`, () => {
      const tags = projectTypeTags(entry(state.extra), false);
      expect(facets(tags)).toEqual(state.tags);
    });

    it(`${state.name} · SSH host`, () => {
      const tags = projectTypeTags(entry({ ...state.extra, remote: SSH }), false);
      expect(facets(tags)).toEqual([...state.tags, SSH_TAG]);
      // The SSH tag's title carries the resolved host target.
      const ssh = tags.find((t) => t.key === "ssh");
      expect(ssh?.title).toContain(formatRemoteTarget(SSH));
    });
  }

  it("covers exactly 12 git×connection combinations", () => {
    expect(GIT_STATES.length * 2).toBe(12);
  });
});

describe("projectTypeTags — stacked / edge axes", () => {
  it("adds the amber 'no scaffold' tag when scaffold is missing", () => {
    const tags = projectTypeTags(entry({ git_type: "local" }), true);
    expect(facets(tags)).toContainEqual({ key: "scaffold", label: "no scaffold", color: "#d29922" });
  });

  it("stacks all independent axes: public GitHub on an SSH host with missing scaffold", () => {
    const tags = projectTypeTags(
      entry({ git_type: "remote-public", git_provider: "github", remote: SSH }),
      true,
    );
    expect(facets(tags)).toEqual([
      GIT,
      GITHUB,
      SSH_TAG,
      { key: "scaffold", label: "no scaffold", color: "#d29922" },
    ]);
  });

  it("defaults a non-string git_type to a local repo", () => {
    const tags = projectTypeTags(entry({ git_type: 42 }), false);
    expect(facets(tags)).toEqual([GIT]);
  });

  it("defaults missing git_type to a local repo", () => {
    expect(facets(projectTypeTags(entry(), false))).toEqual([GIT]);
  });

  it("treats a published project with no recorded provider as GitHub", () => {
    const tags = projectTypeTags(entry({ git_type: "remote-public" }), false);
    expect(facets(tags)).toEqual([GIT, GITHUB]);
  });
});

describe("gitTypeLabel", () => {
  it("labels remote states with provider · visibility", () => {
    expect(gitTypeLabel("remote-public", "github")).toBe("GitHub · public");
    expect(gitTypeLabel("remote-public", "gitlab")).toBe("GitLab · public");
    expect(gitTypeLabel("remote-private", "github")).toBe("GitHub · private");
    expect(gitTypeLabel("remote-private", "gitlab")).toBe("GitLab · private");
  });

  it("labels the no-git and local states", () => {
    expect(gitTypeLabel("none")).toBe("No git (no repo)");
    expect(gitTypeLabel("local")).toBe("Local repo (not pushed)");
  });

  it("falls through unknown/undefined git_type to the local-repo label", () => {
    expect(gitTypeLabel(undefined)).toBe("Local repo (not pushed)");
    expect(gitTypeLabel("weird")).toBe("Local repo (not pushed)");
  });
});

describe("providerName", () => {
  it("returns GitLab only for the gitlab id, GitHub otherwise", () => {
    expect(providerName("gitlab")).toBe("GitLab");
    expect(providerName("github")).toBe("GitHub");
    expect(providerName(undefined)).toBe("GitHub");
  });
});
