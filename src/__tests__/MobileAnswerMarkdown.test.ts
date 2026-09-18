import { describe, expect, it } from "vitest";
import { answerHtml } from "../../mobile-web/src/terminal/answerMarkdown";
import { pendingPrompt, withPending } from "../../mobile-web/src/terminal/pendingPrompts";

function dom(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host;
}

describe("Eldrun Mobile Focus formats an answer's Markdown", () => {
  it("keeps the formatting: headings, lists, emphasis, code, tables", () => {
    const host = dom(answerHtml([
      "## Done",
      "",
      "- **bold** and *italic*",
      "- `npm test`",
      "",
      "```ts",
      "const a = 1;",
      "```",
      "",
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
    ].join("\n")));
    expect(host.querySelector("h2")?.textContent).toBe("Done");
    expect(host.querySelector("h2")?.id).toBe("");
    expect(host.querySelectorAll("li")).toHaveLength(2);
    expect(host.querySelector("strong")?.textContent).toBe("bold");
    expect(host.querySelector("em")?.textContent).toBe("italic");
    expect(host.querySelector("li code")?.textContent).toBe("npm test");
    expect(host.querySelector("pre code")?.textContent).toContain("const a = 1;");
    expect(host.querySelector("table td")?.textContent).toBe("1");
  });

  it("opens and loads nothing: links are their label, images their alt text", () => {
    const host = dom(answerHtml([
      "See [the docs](https://example.com/x) and https://example.com/y and [a file](src/a.ts).",
      "",
      "![diagram](data:image/png;base64,AAAA) ![remote](https://example.com/p.png) ![local](shot.png)",
      "",
      "- [x] shipped",
      "- [ ] tested",
    ].join("\n")));
    expect(host.querySelector("a, img, input")).toBeNull();
    expect(host.querySelector("[href], [src], [data-md-src], [data-md-remote]")).toBeNull();
    expect(host.textContent).toContain("See the docs and https://example.com/y and a file.");
    expect(host.textContent).toContain("diagram");
    expect(host.textContent).toContain("local");
    expect([...host.querySelectorAll(".md-task")].map((box) => box.textContent)).toEqual(["☑", "☐"]);
  });

  it("shows an answer's own HTML as text", () => {
    const host = dom(answerHtml('<a href="https://evil.example">x</a> <img src=x onerror=alert(1)>'));
    expect(host.querySelector("a, img")).toBeNull();
    expect(host.textContent).toContain('<a href="https://evil.example">x</a>');
  });
});

describe("Eldrun Mobile Focus holds a sent prompt in its place", () => {
  const prompt = (text: string, at?: string) => ({ kind: "prompt" as const, text, at });
  const answer = (text: string, at?: string) => ({ kind: "answer" as const, text, at });
  const shape = (entries: { kind: string; text: string }[]) => entries.map((entry) => `${entry.kind}:${entry.text}`);

  it("sits after what the session held when sent, the answers to it below", () => {
    const before = [prompt("fix it", "2026-09-18T10:00:00Z"), answer("Done.", "2026-09-18T10:01:00Z")];
    const sent = pendingPrompt(1, "also  the\ntests ", before);
    expect(shape(withPending(before, [sent]))).toEqual(["prompt:fix it", "answer:Done.", "prompt:also  the\ntests"]);
    // The agent answered before the record of the prompt arrived.
    const working = [...before, answer("On it.", "2026-09-18T10:02:00Z")];
    expect(shape(withPending(working, [sent]))).toEqual(["prompt:fix it", "answer:Done.", "prompt:also  the\ntests", "answer:On it."]);
  });

  it("keeps its place and words when its record arrives later in the file, whitespace aside", () => {
    const before = [prompt("fix it", "2026-09-18T10:00:00Z"), answer("Checking.", "2026-09-18T10:01:00Z")];
    const sent = pendingPrompt(1, "also the tests", before);
    // Typed mid-turn: recorded only once taken in, after another message.
    const after = [...before, answer("Found it.", "2026-09-18T10:02:00Z"), prompt("also  the tests", "2026-09-18T10:01:30Z"), answer("Both fixed.", "2026-09-18T10:03:00Z")];
    expect(shape(withPending(after, [sent]))).toEqual(["prompt:fix it", "answer:Checking.", "prompt:also the tests", "answer:Found it.", "answer:Both fixed."]);
  });

  it("does not take an earlier copy of the same words for its record", () => {
    const before = [prompt("continue", "2026-09-18T10:00:00Z"), answer("More.", "2026-09-18T10:01:00Z")];
    const sent = pendingPrompt(1, "continue", before);
    expect(shape(withPending(before, [sent]))).toEqual(["prompt:continue", "answer:More.", "prompt:continue"]);
    const arrived = [...before, prompt("continue", "2026-09-18T10:03:00Z")];
    expect(shape(withPending(arrived, [sent]))).toEqual(["prompt:continue", "answer:More.", "prompt:continue"]);
    // The older copy left the window the phone reads: the newer stamp still
    // names the record.
    expect(shape(withPending([answer("More.", "2026-09-18T10:01:00Z"), prompt("continue", "2026-09-18T10:03:00Z")], [sent]))).toEqual(["answer:More.", "prompt:continue"]);
  });

  it("keeps two prompts sent in a row in their order", () => {
    const before = [answer("Ready.", "2026-09-18T10:00:00Z")];
    const first = pendingPrompt(1, "one", before);
    const second = pendingPrompt(2, "two", before);
    expect(shape(withPending(before, [first, second]))).toEqual(["answer:Ready.", "prompt:one", "prompt:two"]);
  });
});
