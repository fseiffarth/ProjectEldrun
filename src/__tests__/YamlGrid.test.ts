/**
 * The YAML grid model (#yaml-grid) — the pure detection + layout that turns a
 * collection of like-shaped records into rows × columns.
 *
 * The load-bearing properties pinned here: a grid is only offered for genuinely
 * tabular data (a flat config map is not a grid); columns are the union of the
 * records' keys; a missing key is an editable empty cell, not a hidden one; and —
 * because the grid is a view on the text like the tree — every edit it delegates
 * to `lib/viewers/yaml` leaves the file's comments and untouched bytes intact.
 */
import { describe, it, expect } from "vitest";
import { parseYaml, setValue, addChild, deleteNode, literalFor } from "../lib/viewers/yaml";
import {
  parseGridDoc,
  gridModelFor,
  gridCandidates,
  hasGrid,
  hasCards,
  isContainer,
  cellKind,
  nestedLabel,
} from "../lib/viewers/yamlGrid";

const LIST_OF_MAPS = `# services
- name: web
  port: 8080
  enabled: true
- name: db
  port: 5432
- name: cache
  port: 6379
  enabled: false
`;

const MAP_OF_MAPS = `hosts:
  alpha:
    ip: 10.0.0.1
    role: primary
  beta:
    ip: 10.0.0.2
    role: replica
`;

const FLAT_CONFIG = `name: my-app
version: 1.2.3
debug: false
port: 8080
`;

describe("grid detection", () => {
  it("finds a list of mappings and unions its keys as columns", () => {
    const { candidates } = parseGridDoc(LIST_OF_MAPS);
    expect(candidates).toHaveLength(1);
    const model = gridModelFor(candidates[0]);
    expect(model.shape).toBe("seq");
    // First-seen order across all rows: name, port, enabled.
    expect(model.columns).toEqual(["name", "port", "enabled"]);
    expect(model.rows).toHaveLength(3);
    expect(model.rows.map((r) => r.header)).toEqual(["0", "1", "2"]);
  });

  it("aligns cells to columns, leaving a missing key null", () => {
    const model = gridModelFor(parseGridDoc(LIST_OF_MAPS).candidates[0]);
    const db = model.rows[1]; // { name: db, port: 5432 } — no `enabled`
    expect(db.cells[0]?.value).toBe("db");
    expect(db.cells[1]?.value).toBe("5432");
    expect(db.cells[2]).toBeNull(); // missing → empty cell
  });

  it("finds a map of mappings, headed by the outer key", () => {
    const { candidates } = parseGridDoc(MAP_OF_MAPS);
    const model = gridModelFor(candidates[0]);
    expect(model.shape).toBe("map");
    expect(model.label).toBe("hosts");
    expect(model.columns).toEqual(["ip", "role"]);
    expect(model.rows.map((r) => r.header)).toEqual(["alpha", "beta"]);
  });

  it("does NOT treat a flat config map as a grid", () => {
    expect(hasGrid(FLAT_CONFIG)).toBe(false);
    expect(gridCandidates(parseYaml(FLAT_CONFIG))).toHaveLength(0);
  });

  it("ranks multiple tabular regions largest first", () => {
    const text = `small:
  a: {x: 1, y: 2}
  b: {x: 3, y: 4}
big:
  - id: 1
    a: 1
    b: 2
    c: 3
  - id: 2
    a: 4
    b: 5
    c: 6
  - id: 3
    a: 7
    b: 8
    c: 9
`;
    const cands = gridCandidates(parseYaml(text));
    expect(cands.length).toBeGreaterThanOrEqual(2);
    // `big` (3×4) outranks `small` (2×2).
    expect(gridModelFor(cands[0]).label).toBe("big");
  });

  it("reports no candidates for an unparseable file", () => {
    expect(hasGrid("\tbad: indent")).toBe(false);
  });
});

describe("card view gate (hasCards)", () => {
  it("shows cards when a collection nests another", () => {
    expect(hasCards(LIST_OF_MAPS)).toBe(true); // list of mappings
    expect(hasCards(MAP_OF_MAPS)).toBe(true); // map of mappings
    expect(hasCards("root:\n  child:\n    leaf: 1\n")).toBe(true); // deep nesting
  });

  it("hides cards for a wholly flat file", () => {
    expect(hasCards(FLAT_CONFIG)).toBe(false); // map of scalars
    expect(hasCards("- a\n- b\n- c\n")).toBe(false); // list of scalars
  });

  it("hides cards for an unparseable file", () => {
    expect(hasCards("\tbad: indent")).toBe(false);
  });

  it("isContainer distinguishes collections from scalars", () => {
    const doc = parseYaml(MAP_OF_MAPS);
    const hosts = doc.docs[0].children[0]; // hosts: {…}
    expect(isContainer(hosts)).toBe(true);
    const ip = hosts.children[0].children[0]; // alpha.ip
    expect(isContainer(ip)).toBe(false);
  });
});

describe("cell kinds", () => {
  it("classifies scalar, empty, nested and locked cells", () => {
    const text = `- name: web
  meta: {a: 1}
- name: db
`;
    const model = gridModelFor(parseGridDoc(text).candidates[0]);
    // columns: name, meta
    const web = model.rows[0];
    const db = model.rows[1];
    expect(cellKind(web.cells[0], web.map)).toBe("scalar"); // name: web
    expect(cellKind(web.cells[1], web.map)).toBe("nested"); // meta: {a: 1}
    expect(cellKind(db.cells[1], db.map)).toBe("empty"); // db has no meta
    expect(nestedLabel(web.cells[1]!)).toBe("{ 1 }");
  });
});

describe("grid edits are text splices (view on the text)", () => {
  it("edits a scalar cell, keeping the file's comment and other bytes", () => {
    const doc = parseYaml(LIST_OF_MAPS);
    const model = gridModelFor(gridCandidates(doc)[0]);
    const portCell = model.rows[0].cells[1]!; // web.port = 8080
    const next = setValue(LIST_OF_MAPS, doc, portCell, "9090");
    expect(next).toContain("port: 9090");
    expect(next).toContain("# services"); // the comment survives
    expect(next).toContain("name: db"); // untouched rows survive
    expect(next).not.toContain("port: 8080");
  });

  it("fills a missing cell by adding the key to that row's mapping", () => {
    const doc = parseYaml(LIST_OF_MAPS);
    const model = gridModelFor(gridCandidates(doc)[0]);
    const db = model.rows[1]; // no `enabled`
    const next = addChild(LIST_OF_MAPS, doc, db.map!, "key", "enabled", literalFor("text", "true", false));
    const reparsed = gridModelFor(gridCandidates(parseYaml(next))[0]);
    expect(reparsed.rows[1].cells[2]?.value).toBe("true");
    // The other rows are unchanged.
    expect(reparsed.rows[0].cells[2]?.value).toBe("true");
    expect(reparsed.rows[2].cells[2]?.value).toBe("false");
  });

  it("deletes a whole row", () => {
    const doc = parseYaml(LIST_OF_MAPS);
    const model = gridModelFor(gridCandidates(doc)[0]);
    const next = deleteNode(LIST_OF_MAPS, model.rows[1].map!); // drop `db`
    const reparsed = gridModelFor(gridCandidates(parseYaml(next))[0]);
    expect(reparsed.rows.map((r) => r.cells[0]?.value)).toEqual(["web", "cache"]);
  });
});
