/**
 * `bodyLooksUnsafe` — the mail body tripwire.
 *
 * It is NOT a sanitizer. The backend's `ammonia` pass is what makes a message
 * body inert; this asserts the invariant the render path depends on, and refuses
 * to render at all if the backend ever regressed.
 *
 * Both directions matter, and the second one is why these tests exist. A
 * tripwire that misses a live `onerror=` lets app-origin XSS reach a WebView
 * holding the full Tauri IPC surface. But a tripwire that fires on the sentence
 * "set x = 1" replaces ordinary mail with an error card — and in a mail client
 * shipped inside a *developer tool*, mail that discusses HTML and code is the
 * normal case, so a false alarm that common is how a real one gets ignored.
 * Hence: markup is evidence, text is not.
 */
import { describe, it, expect } from "vitest";
import { bodyLooksUnsafe } from "../lib/mail";

describe("bodyLooksUnsafe — fires on live markup", () => {
  const hostile: [string, string][] = [
    ["script element", "<p>hi</p><script>alert(1)</script>"],
    ["iframe", '<iframe src="https://evil.example"></iframe>'],
    ["object", '<object data="x"></object>'],
    ["embed", '<embed src="x">'],
    ["form", '<form action="https://evil.example"></form>'],
    ["base", '<base href="https://evil.example/">'],
    ["link", '<link rel="stylesheet" href="x.css">'],
    ["event handler", '<img src="data:," onerror="alert(1)">'],
    ["event handler, spaced", '<img src="data:," onerror = "alert(1)">'],
    ["surviving href", '<a href="https://evil.example">click</a>'],
    ["srcdoc", '<div srcdoc="x"></div>'],
    ["srcset", '<img srcset="https://evil.example/a 1x">'],
    ["formaction", '<button formaction="https://evil.example">go</button>'],
    ["javascript: in a tag", '<a data-lid="0" title="javascript:alert(1)">t</a>'],
    ["vbscript: in a tag", '<a data-lid="0" title="vbscript:msgbox">t</a>'],
  ];
  for (const [name, html] of hostile) {
    it(`fires on ${name}`, () => {
      expect(bodyLooksUnsafe(html)).toBe(true);
    });
  }
});

describe("bodyLooksUnsafe — does not fire on text", () => {
  // Each of these is a body the sanitizer did its job on. Every one of them
  // tripped the original whole-string scan.
  const benign: [string, string][] = [
    ["an equation in prose", "<p>if one = two then the build is wrong</p>"],
    ["prose starting with 'on'", "<p>online = offline in this test</p>"],
    ["'once' before an equals", "<p>run it once = done</p>"],
    ["escaped attribute talk", "<p>set the href= attribute on the anchor</p>"],
    ["escaped tag talk", "<p>use &lt;script&gt; carefully</p>"],
    ["a code sample as text", "<pre>const onClick = () =&gt; go()</pre>"],
    ["the word javascript in prose", "<p>I prefer javascript: the good parts</p>"],
    ["a sanitized anchor", '<a data-lid="0" class="mail-link">www.example.com</a>'],
    ["an inlined image", '<img src="data:image/png;base64,iVBORw0KGgo=" alt="logo">'],
    ["a styled table", '<table><tr><td style="color:#06c">cell</td></tr></table>'],
    ["empty", ""],
  ];
  for (const [name, html] of benign) {
    it(`stays quiet on ${name}`, () => {
      expect(bodyLooksUnsafe(html)).toBe(false);
    });
  }
});

describe("bodyLooksUnsafe — the attribute scan is tag-scoped", () => {
  it("fires on a handler in a tag even when prose above it looks similar", () => {
    const html = "<p>one = two, and one = three</p><img onload='x()'>";
    expect(bodyLooksUnsafe(html)).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(bodyLooksUnsafe('<IMG SRC="data:," ONERROR="alert(1)">')).toBe(true);
    expect(bodyLooksUnsafe("<A HREF='https://evil.example'>x</A>")).toBe(true);
  });
});
