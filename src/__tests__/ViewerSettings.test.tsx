/**
 * Tests for per-file-type native-viewer settings (#48):
 *  - VIEWER_PREF_TYPES exposes the supported native viewers, flagging which
 *    support opt-in local autocomplete (#45).
 */
import { describe, it, expect } from "vitest";
import { VIEWER_PREF_TYPES } from "../components/files/fileUtils";

describe("VIEWER_PREF_TYPES metadata (#48)", () => {
  it("lists the native viewer types with the right capability flags", () => {
    const byId = Object.fromEntries(VIEWER_PREF_TYPES.map((t) => [t.id, t]));
    // Editable text types support autocomplete (#45); image/pdf do not.
    expect(byId.text.autocomplete).toBe(true);
    expect(byId.tex.autocomplete).toBe(true);
    expect(byId.markdown.autocomplete).toBe(true);
    expect(byId.image.autocomplete).toBe(false);
    expect(byId.pdf.autocomplete).toBe(false);
  });
});
