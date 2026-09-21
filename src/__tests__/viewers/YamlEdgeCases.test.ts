/**
 * Edge cases for `lib/viewers/yaml.ts`'s ENCODERS, beyond `YamlModel.test.ts`.
 *
 * The bug this pins: `needsQuoting` had no notion of the context a value was
 * being written into, so a scalar spliced into a FLOW collection (`[a, b]`,
 * `{k: v}` — i.e. every JSON-shaped region) went in unquoted. Retyping one item
 * of `hosts: [a, b]` as `x, y` made it TWO items; as `a]b` it closed the
 * collection early and the file stopped parsing, collapsing the tree to Source.
 * `.json` was never affected — strict mode quotes everything — so this was
 * invisible in exactly the dialect that gets the most test coverage.
 *
 * The same family as M#840 (`table.ts`'s mid-field quote, `bib.ts`'s CRLF
 * delete), and the fix is the shape this repo already chose twice:
 * `bibLiteral(value, delim)` and `encodeCell(v, delimiter)` take the context as
 * an argument and keep the author's form while it can hold the value.
 *
 * The block-context cases below are not decoration. They are what stops the fix
 * from becoming "quote `,[]{}` everywhere", which would rewrite ordinary plain
 * scalars like `k: a, b` on any edit and break the viewer's one promise — that
 * bytes it did not aim at come back exactly as they were.
 */
import { describe, expect, it } from "vitest";
import {
  addChild,
  encodeKey,
  encodeScalar,
  literalFor,
  needsQuoting,
  parseYaml,
  setValue,
  type YamlNode,
} from "../../lib/viewers/yaml";

/** The node at `path`, the `YamlModel.test.ts` idiom. */
function at(text: string, path: (string | number)[], strict = false): YamlNode {
  const doc = parseYaml(text, { strict });
  let node: YamlNode | undefined = doc.docs[0];
  for (const step of path) {
    const kids: YamlNode[] = node?.children ?? [];
    node =
      typeof step === "number" ? kids[step] : kids.find((c) => c.key === step);
    if (!node) throw new Error(`no node at ${JSON.stringify(path)}`);
  }
  return node;
}

function edit(text: string, path: (string | number)[], next: string): string {
  return setValue(text, parseYaml(text), at(text, path), next);
}

/**
 * Values that are ordinary text in BLOCK context and structural in FLOW. These
 * are the ones the bug was about: `k: a, b` is a perfectly good plain scalar,
 * while `[a, b]` is two items.
 */
const FLOW_ONLY = ["a, b", "a]b", "a}b", "x[0]", "a,b,c", "1, 2"];

/**
 * Values that need quoting in BOTH contexts, and so must not be used to argue
 * anything about the flag. A leading `[`/`{` opens a flow collection even in
 * block context, and `": "` makes the line a mapping — both were already caught
 * by `SPECIAL_FIRST` and the `": "` rule long before this fix.
 */
const ALWAYS = ["{k: v}", "[nested]", "a: b"];

describe("needsQuoting knows its context", () => {
  it("leaves flow-structural characters alone in block context", () => {
    for (const v of FLOW_ONLY) expect(needsQuoting(v, false)).toBe(false);
  });

  it("quotes them inside a flow collection", () => {
    for (const v of FLOW_ONLY) expect(needsQuoting(v, true)).toBe(true);
  });

  it("keeps quoting what was always unsafe, in both contexts", () => {
    for (const v of ALWAYS) {
      expect(needsQuoting(v, false)).toBe(true);
      expect(needsQuoting(v, true)).toBe(true);
    }
  });

  it("still quotes what block context has always quoted", () => {
    for (const v of ["", " lead", "trail ", "a: b", "a #c", "#hash"]) {
      expect(needsQuoting(v, false)).toBe(true);
    }
  });
});

describe("a flow item survives being retyped", () => {
  it("keeps one item as one item", () => {
    const text = "hosts: [a, b]\n";
    const out = edit(text, ["hosts", 0], "x, y");
    // The bug: `hosts: [x, y, b]` — one item silently became two.
    expect(parseYaml(out).error).toBeNull();
    const items = at(out, ["hosts"]).children.map((c) => c.value);
    expect(items).toEqual(["x, y", "b"]);
  });

  it("does not let a value close the collection", () => {
    const text = "hosts: [a, b]\n";
    const out = edit(text, ["hosts", 0], "a]b");
    expect(parseYaml(out).error).toBeNull();
    expect(at(out, ["hosts"]).children.map((c) => c.value)).toEqual(["a]b", "b"]);
  });

  it("round-trips the whole corpus, leaving the sibling's bytes alone", () => {
    for (const v of [...FLOW_ONLY, ...ALWAYS]) {
      const out = edit("hosts: [a, b]\n", ["hosts", 0], v);
      expect(parseYaml(out).error).toBeNull();
      const items = at(out, ["hosts"]).children.map((c) => c.value);
      expect(items).toEqual([v, "b"]);
    }
  });

  it("does the same inside a flow mapping", () => {
    for (const v of [...FLOW_ONLY, ...ALWAYS]) {
      const out = edit("svc: {a: 1, b: 2}\n", ["svc", "a"], v);
      expect(parseYaml(out).error).toBeNull();
      expect(at(out, ["svc", "a"]).value).toBe(v);
      expect(at(out, ["svc", "b"]).value).toBe("2");
    }
  });
});

describe("block context is left exactly as the author wrote it", () => {
  it("does not quote a value that needs no quoting in block", () => {
    // The regression guard against "just quote `,[]{}` everywhere".
    expect(edit("k: old\n", ["k"], "a, b")).toBe("k: a, b\n");
    expect(edit("k: old\n", ["k"], "x[0]")).toBe("k: x[0]\n");
  });

  it("leaves every other byte of the document untouched", () => {
    const text = "# lead\nk: old # trailing\nother: keep\n";
    expect(edit(text, ["k"], "a, b")).toBe("# lead\nk: a, b # trailing\nother: keep\n");
  });
});

describe("a key is a scalar too", () => {
  it("quotes a flow key that would otherwise end the pair", () => {
    expect(encodeKey("x,y", false, true)).toBe('"x,y"');
    expect(encodeKey("x,y", false, false)).toBe("x,y");
  });

  it("adds a key to a flow mapping without tearing it", () => {
    const text = "svc: {a: 1}\n";
    const parent = at(text, ["svc"]);
    const out = addChild(
      text,
      parseYaml(text),
      parent,
      "key",
      "x,y",
      literalFor("text", "2", false, true),
    );
    expect(parseYaml(out).error).toBeNull();
    expect(at(out, ["svc", "x,y"]).value).toBe("2");
  });
});

describe("the flag never changes what strict (JSON) already did", () => {
  it("double-quotes regardless, in both contexts", () => {
    for (const v of [...FLOW_ONLY, ...ALWAYS]) {
      expect(encodeScalar(v, "plain", true, false)).toBe(encodeScalar(v, "plain", true, true));
      expect(literalFor("text", v, true, false)).toBe(literalFor("text", v, true, true));
    }
  });
});
