import { describe, it, expect } from "vitest";
import {
  extractLocalLinkTargets,
  buildMdGraph,
  layoutMdGraph,
  isMdPath,
} from "../lib/viewers/mdGraph";

describe("extractLocalLinkTargets", () => {
  it("collects relative and absolute local link targets, in order", () => {
    const src = [
      "See the [guide](docs/guide.md) and [notes](./notes.md).",
      "Also [abs](/home/u/proj/x.md) and an image ![d](assets/d.png).",
    ].join("\n");
    expect(extractLocalLinkTargets(src)).toEqual([
      "docs/guide.md",
      "./notes.md",
      "/home/u/proj/x.md",
      "assets/d.png",
    ]);
  });

  it("excludes external URLs, mailto, and pure anchors", () => {
    const src =
      "[a](https://example.com) [b](mailto:x@y.z) [c](#section) [d](tel:123)";
    expect(extractLocalLinkTargets(src)).toEqual([]);
  });

  it("strips fragments and queries from local targets", () => {
    expect(extractLocalLinkTargets("[a](docs/guide.md#setup)")).toEqual([
      "docs/guide.md",
    ]);
    expect(extractLocalLinkTargets("[a](docs/guide.md?x=1)")).toEqual([
      "docs/guide.md",
    ]);
  });

  it("decodes percent-encoded targets", () => {
    expect(extractLocalLinkTargets("[a](my%20file.md)")).toEqual(["my file.md"]);
  });

  it("skips links inside fenced code blocks and inline code", () => {
    const src = [
      "```",
      "[fenced](in-fence.md)",
      "```",
      "prose `[inline](in-code.md)` and [real](real.md)",
    ].join("\n");
    expect(extractLocalLinkTargets(src)).toEqual(["real.md"]);
  });

  it("deduplicates repeated targets", () => {
    expect(
      extractLocalLinkTargets("[a](x.md) again [b](x.md)"),
    ).toEqual(["x.md"]);
  });

  it("strips line hints before deduplicating graph targets", () => {
    expect(extractLocalLinkTargets("[line](./x.ts:12) [file](./x.ts)")).toEqual(["./x.ts"]);
  });
});

describe("buildMdGraph", () => {
  const fs = (files: Record<string, string>) => (path: string) =>
    Promise.resolve(files[path] ?? null);

  it("crawls markdown links breadth-first with depths", async () => {
    const g = await buildMdGraph(
      "/p/PROJECT.md",
      fs({
        "/p/PROJECT.md": "[readme](README.md) [todo](./TODO.md)",
        "/p/README.md": "[deep](docs/deep.md)",
        "/p/TODO.md": "no links",
        "/p/docs/deep.md": "",
      }),
    );
    const byPath = new Map(g.nodes.map((n) => [n.path, n]));
    expect(byPath.get("/p/PROJECT.md")?.depth).toBe(0);
    expect(byPath.get("/p/README.md")?.depth).toBe(1);
    expect(byPath.get("/p/TODO.md")?.depth).toBe(1);
    expect(byPath.get("/p/docs/deep.md")?.depth).toBe(2);
    expect(g.edges).toContainEqual({ from: "/p/PROJECT.md", to: "/p/README.md" });
    expect(g.edges).toContainEqual({ from: "/p/README.md", to: "/p/docs/deep.md" });
    expect(g.truncated).toBe(false);
  });

  it("treats non-markdown targets as leaves without reading them", async () => {
    const reads: string[] = [];
    const g = await buildMdGraph("/p/a.md", (path) => {
      reads.push(path);
      return Promise.resolve(
        path === "/p/a.md" ? "[img](shot.png) [code](src/main.rs)" : null,
      );
    });
    expect(reads).toEqual(["/p/a.md"]); // leaves never read
    const kinds = new Map(g.nodes.map((n) => [n.path, n.kind]));
    expect(kinds.get("/p/shot.png")).toBe("file");
    expect(kinds.get("/p/src/main.rs")).toBe("file");
  });

  it("marks an unreadable markdown target as missing, but not the start", async () => {
    const g = await buildMdGraph(
      "/p/a.md",
      fs({ "/p/a.md": "[gone](gone.md)" }),
    );
    const kinds = new Map(g.nodes.map((n) => [n.path, n.kind]));
    expect(kinds.get("/p/gone.md")).toBe("missing");
    expect(kinds.get("/p/a.md")).toBe("md");

    const broken = await buildMdGraph("/p/b.md", fs({}));
    expect(broken.nodes[0].kind).toBe("md");
  });

  it("survives link cycles and drops self-links", async () => {
    const g = await buildMdGraph(
      "/p/a.md",
      fs({
        "/p/a.md": "[b](b.md) [self](a.md)",
        "/p/b.md": "[back](a.md)",
      }),
    );
    expect(g.nodes).toHaveLength(2);
    expect(g.edges).toEqual([
      { from: "/p/a.md", to: "/p/b.md" },
      { from: "/p/b.md", to: "/p/a.md" },
    ]);
  });

  it("caps the node count and reports truncation", async () => {
    const files: Record<string, string> = {
      "/p/a.md": Array.from({ length: 10 }, (_, i) => `[x](f${i}.md)`).join(" "),
    };
    const g = await buildMdGraph("/p/a.md", fs(files), { maxNodes: 4 });
    expect(g.nodes).toHaveLength(4);
    expect(g.truncated).toBe(true);
    // No edge points at a node that was not admitted.
    const admitted = new Set(g.nodes.map((n) => n.path));
    for (const e of g.edges) {
      expect(admitted.has(e.from)).toBe(true);
      expect(admitted.has(e.to)).toBe(true);
    }
  });

  it("normalises .. segments so one file is one node", async () => {
    const g = await buildMdGraph(
      "/p/docs/a.md",
      fs({
        "/p/docs/a.md": "[up](../README.md)",
        "/p/README.md": "",
      }),
    );
    expect(g.nodes.map((n) => n.path)).toContain("/p/README.md");
  });
});

describe("isMdPath", () => {
  it("recognises markdown extensions case-insensitively", () => {
    expect(isMdPath("/x/README.md")).toBe(true);
    expect(isMdPath("/x/README.MD")).toBe(true);
    expect(isMdPath("/x/notes.markdown")).toBe(true);
    expect(isMdPath("/x/main.rs")).toBe(false);
  });
});

describe("layoutMdGraph", () => {
  const graph = (n: number) => ({
    start: "/p/a.md",
    nodes: [
      { path: "/p/a.md", label: "a.md", kind: "md" as const, depth: 0 },
      ...Array.from({ length: n }, (_, i) => ({
        path: `/p/f${i}.md`,
        label: `f${i}.md`,
        kind: "md" as const,
        depth: 1,
      })),
    ],
    edges: Array.from({ length: n }, (_, i) => ({
      from: "/p/a.md",
      to: `/p/f${i}.md`,
    })),
    truncated: false,
  });

  it("positions every node inside the reported box", () => {
    const layout = layoutMdGraph(graph(6));
    expect(layout.positions.size).toBe(7);
    for (const { x, y } of layout.positions.values()) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(layout.width);
      expect(y).toBeLessThanOrEqual(layout.height);
    }
  });

  it("is deterministic and gives distinct positions", () => {
    const a = layoutMdGraph(graph(8));
    const b = layoutMdGraph(graph(8));
    expect([...a.positions.entries()]).toEqual([...b.positions.entries()]);
    const seen = new Set(
      [...a.positions.values()].map(({ x, y }) => `${x.toFixed(3)},${y.toFixed(3)}`),
    );
    expect(seen.size).toBe(a.positions.size);
  });

  it("widens a crowded ring instead of overlapping labels", () => {
    const sparse = layoutMdGraph(graph(3));
    const crowded = layoutMdGraph(graph(40));
    expect(crowded.width).toBeGreaterThan(sparse.width);
  });
});
