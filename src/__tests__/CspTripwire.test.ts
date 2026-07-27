/**
 * The app CSP — the perimeter, asserted so it cannot be loosened silently.
 *
 * A security review of the agent-tab sandbox tried to reach the privileged
 * renderer from every hostile-content surface Eldrun renders (markdown, notebook,
 * compare and ODT viewers' `dangerouslySetInnerHTML` sinks, a mail body, an
 * HTML/SVG preview) and could not: `script-src 'self' blob:` with **no**
 * `unsafe-inline` is what stops an injected `<script>` or `onerror=` from running,
 * and `withGlobalTauri` being off is what keeps `window.__TAURI__` out of reach.
 *
 * That matters more than a normal hardening line item, because the main webview
 * holds the whole ~300-command IPC surface (`pty_spawn`, `run_script_detached`,
 * `credential_paste_to_pty`) with no per-command gating. The CSP is therefore
 * *load-bearing*: one `'unsafe-inline'` added for convenience turns any of those
 * sinks into host code execution. Nothing else in the tree fails when it is
 * removed, so nothing else would notice — hence this test.
 *
 * These are invariants, not preferences. If a change genuinely needs one of them
 * relaxed, that is a decision to take deliberately, with this file as the record
 * of what it costs.
 */
import { describe, it, expect } from "vitest";
// @ts-expect-error node:fs has no type declarations in this project (no @types/node)
import { readFileSync } from "node:fs";

type TauriConf = {
  app?: {
    security?: { csp?: string | null; dangerousDisableAssetCspModification?: unknown };
    withGlobalTauri?: unknown;
  };
};

const CONF: TauriConf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
const CSP: string = CONF.app?.security?.csp ?? "";

/** The value of one CSP directive, e.g. `script-src` → `["'self'", "blob:"]`. */
function directive(name: string): string[] {
  const found = CSP.split(";")
    .map((d) => d.trim())
    .find((d) => d === name || d.startsWith(`${name} `));
  if (found === undefined) return [];
  return found.slice(name.length).trim().split(/\s+/).filter(Boolean);
}

describe("the app CSP is present and restrictive", () => {
  it("defines a CSP at all", () => {
    // A null/absent csp disables the policy entirely rather than defaulting to
    // something safe — the one failure that would make every test below vacuous.
    expect(CSP).not.toBe("");
    expect(CONF.app?.security?.csp).toBeTypeOf("string");
  });

  it("defaults to 'self'", () => {
    expect(directive("default-src")).toEqual(["'self'"]);
  });

  it("never allows inline or eval'd script", () => {
    // The tokens that would re-open every dangerouslySetInnerHTML sink. Checked
    // against the whole policy, not just `script-src`: `default-src` is the
    // fallback for any script directive a future edit might drop, so an
    // `'unsafe-inline'` parked there would be just as exploitable.
    for (const unsafe of ["'unsafe-inline'", "'unsafe-eval'", "'unsafe-hashes'"]) {
      expect(directive("script-src")).not.toContain(unsafe);
      expect(directive("default-src")).not.toContain(unsafe);
      expect(directive("worker-src")).not.toContain(unsafe);
    }
  });

  it("restricts script-src to app-origin and blob:", () => {
    // `blob:` is needed (worker/PDF plumbing) and is the one documented residual:
    // any code path turning attacker bytes into a blob URL *loaded as a script*
    // would bypass this. No such path exists today; adding a remote host here
    // would be a much larger hole, so the allowlist is pinned exactly.
    expect(directive("script-src").sort()).toEqual(["'self'", "blob:"]);
  });

  it("never allows a wildcard script source", () => {
    for (const token of directive("script-src")) {
      expect(token).not.toBe("*");
      expect(token.startsWith("http://")).toBe(false);
      expect(token.startsWith("https://")).toBe(false);
    }
  });

  it("does not disable Tauri's asset-CSP modification", () => {
    expect(CONF.app?.security?.dangerousDisableAssetCspModification).toBeUndefined();
  });
});

describe("the global Tauri IPC object is not exposed", () => {
  it("leaves withGlobalTauri off", () => {
    // With it on, `window.__TAURI__` hands the full command surface to any script
    // that manages to run — turning a renderer bug straight into host exec.
    expect(CONF.app?.withGlobalTauri ?? false).toBe(false);
  });
});
