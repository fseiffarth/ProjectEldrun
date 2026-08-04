/**
 * The diverged (orange) list's direction badge. The verdict comes from the
 * backend's per-side base comparison (`host_diverged`/`local_diverged`), never
 * from comparing the two machines' mtimes against each other — clock skew
 * between a host and the local machine must not be able to pick the wrong
 * authority. The mtimes stay display metadata (the tooltip's "modified when").
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve([])) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { mtimeDivergenceCue } from "../components/files/ProjectFilesView";
import type { TranslationKey } from "../lib/i18n";

// The cue's text is asserted as the raw key — the wording is i18n's business.
const t = (key: TranslationKey) => key as string;

describe("mtimeDivergenceCue", () => {
  it("both sides gone, host actually checked → goneBothSides, neutral", () => {
    const cue = mtimeDivergenceCue(t, null, null, false, true, true);
    expect(cue.text).toBe("projectFilesView.goneBothSides");
    expect(cue.tone).toBe("neutral");
  });

  it("both mtimes null but host NOT checked → deleted-locally badge, never a host claim", () => {
    // A cold pool reports every host mtime as null without asking the host;
    // "gone on both sides" would assert a deletion nobody verified.
    const cue = mtimeDivergenceCue(t, null, null, false, true, false);
    expect(cue.text).toBe("projectFilesView.localGoneHostUnchecked");
    expect(cue.tone).toBe("neutral");
  });

  it("host gone → localOnly, local tone", () => {
    const cue = mtimeDivergenceCue(t, null, 100, false, true, true);
    expect(cue.text).toBe("projectFilesView.localOnly");
    expect(cue.tone).toBe("local");
  });

  it("local gone → remoteOnly, remote tone", () => {
    const cue = mtimeDivergenceCue(t, 100, null, true, false, true);
    expect(cue.text).toBe("projectFilesView.remoteOnly");
    expect(cue.tone).toBe("remote");
  });

  it("both present, only the host moved → remote", () => {
    const cue = mtimeDivergenceCue(t, 100, 200, true, false, true);
    expect(cue.text).toBe("projectFilesView.remoteNewer");
    expect(cue.tone).toBe("remote");
  });

  it("both present, only the local moved → local", () => {
    const cue = mtimeDivergenceCue(t, 200, 100, false, true, true);
    expect(cue.text).toBe("projectFilesView.localNewer");
    expect(cue.tone).toBe("local");
  });

  it("both moved → bothChanged, neutral", () => {
    const cue = mtimeDivergenceCue(t, 100, 200, true, true, true);
    expect(cue.text).toBe("projectFilesView.bothChanged");
    expect(cue.tone).toBe("neutral");
  });

  it("the direction wins even when the mtime comparison says the opposite", () => {
    // Clock skew: the host's clock runs ahead (hostMtime > localMtime), but only
    // the LOCAL side moved from its recorded base — the badge must say local.
    const cue = mtimeDivergenceCue(t, 5000, 100, false, true, true);
    expect(cue.text).toBe("projectFilesView.localNewer");
    expect(cue.tone).toBe("local");
  });

  it("neither flagged (self-heal race) → sameTime, neutral", () => {
    const cue = mtimeDivergenceCue(t, 100, 100, false, false, true);
    expect(cue.text).toBe("projectFilesView.sameTime");
    expect(cue.tone).toBe("neutral");
  });
});
