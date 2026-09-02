/**
 * Drag-to-move across trees, and the box view's per-member file source.
 *
 * Two live-found bugs this locks against regression (2026-08-28):
 *
 * 1. Cross-project drag-and-drop in the box multi-root view "strangely moved"
 *    folders: the drag's hit-test (`document.elementFromPoint`) sees EVERY
 *    mounted tree's `[data-move-rel]` targets, but the commit assumed the
 *    target belonged to the source tree — so a drop onto project B's folder
 *    moved the file *within project A* to a rel path copied from B (creating
 *    lookalike folders in A), and never into B. Targets now carry their tree's
 *    identity (`data-move-root`/`data-move-remote`) and `resolveMoveTarget`
 *    decides same-tree move / cross-root move / nothing.
 *
 * 2. A remote member in a box scope had NO Remote/Local switch: `BoxRootSection`
 *    passed no `syncSource`, so the tree always listed the host and a
 *    disconnected member was a dead Connect prompt with no way to browse the
 *    mirror. The section now shares the project-wide side (`useFileSource`) and
 *    derives its tree dir via `remoteMemberTreeDir`.
 */
import { describe, it, expect } from "vitest";
// @ts-expect-error node:fs has no type declarations in this project (no @types/node)
import { readFileSync } from "node:fs";
import {
  moveDestRel,
  movedEntryAbs,
  remoteMemberTreeDir,
  resolveMoveTarget,
} from "../lib/fileMove";

const LOCAL_A = { root: "/home/u/eldrun/projects/a", folderRel: "src", remote: false };

describe("resolveMoveTarget", () => {
  it("same root: an ordinary folder is a plain move", () => {
    const r = resolveMoveTarget(
      { rel: "docs", root: LOCAL_A.root, remote: false },
      LOCAL_A,
    );
    expect(r).toEqual({ root: LOCAL_A.root, rel: "docs", crossRoot: false });
  });

  it("same root: the file's own folder is a no-op (no target)", () => {
    expect(
      resolveMoveTarget({ rel: "src", root: LOCAL_A.root, remote: false }, LOCAL_A),
    ).toBeNull();
  });

  it("no element under the cursor resolves to nothing", () => {
    expect(resolveMoveTarget(null, LOCAL_A)).toBeNull();
  });

  it("cross root, both local: resolves to the OTHER project's root (the bug)", () => {
    // Regression core: this used to commit against the SOURCE root with the
    // target's rel path — the "strangely moved folders" report.
    const r = resolveMoveTarget(
      { rel: "data", root: "/home/u/eldrun/projects/b", remote: false },
      LOCAL_A,
    );
    expect(r).toEqual({ root: "/home/u/eldrun/projects/b", rel: "data", crossRoot: true });
  });

  it("cross root: the SAME rel path in another project is still a real move", () => {
    // `rel === folderRel` only means "no-op" within one tree; across roots it
    // is a genuine destination.
    const r = resolveMoveTarget(
      { rel: "src", root: "/home/u/eldrun/projects/b", remote: false },
      LOCAL_A,
    );
    expect(r).toEqual({ root: "/home/u/eldrun/projects/b", rel: "src", crossRoot: true });
  });

  it("cross root refuses a remote target (move_path is local-fs only)", () => {
    expect(
      resolveMoveTarget(
        { rel: "data", root: "/home/u/eldrun/projects/r", remote: true },
        LOCAL_A,
      ),
    ).toBeNull();
  });

  it("cross root refuses a remote SOURCE tree", () => {
    expect(
      resolveMoveTarget(
        { rel: "data", root: "/home/u/eldrun/projects/b", remote: false },
        { root: "/home/u/eldrun/projects/r", folderRel: "", remote: true },
      ),
    ).toBeNull();
  });

  it("a remote tree still moves within itself (same-root path unchanged)", () => {
    const r = resolveMoveTarget(
      { rel: "out", root: "/home/u/eldrun/projects/r", remote: true },
      { root: "/home/u/eldrun/projects/r", folderRel: "", remote: true },
    );
    expect(r).toEqual({ root: "/home/u/eldrun/projects/r", rel: "out", crossRoot: false });
  });
});

describe("moveDestRel / movedEntryAbs", () => {
  it("joins the destination rel, treating '' as the root", () => {
    expect(moveDestRel("docs", "a.md")).toBe("docs/a.md");
    expect(moveDestRel("", "a.md")).toBe("a.md");
  });

  it("same-root move keeps the historical tail-swap", () => {
    expect(
      movedEntryAbs({
        sourceAbs: "/p/a/src/a.md",
        sourceRel: "src/a.md",
        destRel: "docs/a.md",
        destRoot: "/p/a",
        crossRoot: false,
      }),
    ).toBe("/p/a/docs/a.md");
  });

  it("cross-root move rebuilds from the destination root", () => {
    expect(
      movedEntryAbs({
        sourceAbs: "/p/a/src/a.md",
        sourceRel: "src/a.md",
        destRel: "data/a.md",
        destRoot: "/p/b/",
        crossRoot: true,
      }),
    ).toBe("/p/b/data/a.md");
  });
});

describe("remoteMemberTreeDir (box member Remote/Local switch)", () => {
  const stateDir = "/home/u/eldrun/projects/r";

  it("remote side lists the state dir (backend resolves it to the host)", () => {
    expect(remoteMemberTreeDir(stateDir, "/mnt/mirror", "remote")).toBe(stateDir);
  });

  it("local side prefers the persisted mirror override", () => {
    expect(remoteMemberTreeDir(stateDir, "/mnt/mirror", "local")).toBe("/mnt/mirror");
  });

  it("local side falls back to <state_dir>/mirror for legacy projects", () => {
    expect(remoteMemberTreeDir(`${stateDir}/`, null, "local")).toBe(`${stateDir}/mirror`);
  });
});

/**
 * Source tripwires: the fix only holds while every drop target carries its
 * tree's identity and the commit routes by it. These read the components'
 * source (the pattern `BrowserTripwire.test.ts` established) so deleting one
 * half of the mechanism fails a test instead of silently reviving the bug.
 */
describe("FileTree source tripwires", () => {
  const SRC: string = readFileSync("src/components/files/FileTree.tsx", "utf8");
  const lines = SRC.split("\n");

  it("every data-move-rel target also stamps the tree's identity attrs", () => {
    const sites = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => /^\s*data-move-rel=/.test(l));
    expect(sites.length).toBeGreaterThanOrEqual(4); // up button, ⌂, crumbs, dir rows
    for (const { i } of sites) {
      const following = lines.slice(i + 1, i + 3).join("\n");
      expect(
        following.includes("moveTargetAttrs"),
        `data-move-rel at FileTree.tsx:${i + 1} lacks the moveTargetAttrs spread`,
      ).toBe(true);
    }
  });

  it("the move commit routes to the TARGET root, not the source tree's", () => {
    // Scoped to the drag-to-move commit — the clipboard paste sites legitimately
    // use `destProjectDir: projectDir` (their destination IS this tree).
    const start = SRC.indexOf("async function moveEntryToFolder");
    expect(start).toBeGreaterThan(-1);
    const body = SRC.slice(start, SRC.indexOf("\n  }", start));
    expect(body).toContain("destProjectDir: target.root");
    expect(body).not.toContain("destProjectDir: projectDir");
    // The collision pre-check must ask the destination project too.
    expect(body).toContain("projectDir: target.root");
  });
});

describe("BoxRootSection source tripwires", () => {
  const SRC: string = readFileSync("src/components/files/ProjectFilesPane.tsx", "utf8");

  it("a remote member's tree follows the file-source side", () => {
    expect(SRC).toContain("remoteMemberTreeDir(");
    expect(SRC).toContain("syncSource={remote ? source : undefined}");
    // The source flip must remount the tree (dir is the tree's identity).
    expect(SRC).toMatch(/key=\{`\$\{rootId\}\|\$\{treeDir\}`\}/);
  });
});
