import { describe, expect, it } from "vitest";
import { execMatchesApp } from "../components/files/SetDefaultAppDialog";

describe("execMatchesApp", () => {
  it("matches an exact single-word exec", () => {
    expect(execMatchesApp("gimp-3.2", "gimp-3.2")).toBe(true);
    expect(execMatchesApp("vim", "gimp-3.2")).toBe(false);
  });

  it("matches when the saved exec is the app's command plus trailing args", () => {
    // sharun AppImage: the saved exec carries the `kicad` binary selector the
    // `.desktop` Exec lacks — re-selecting KiCad must still count as a match.
    expect(
      execMatchesApp(
        "/opt/kicad-10.0.3-x86_64.AppImage kicad",
        "/opt/kicad-10.0.3-x86_64.AppImage",
      ),
    ).toBe(true);
  });

  it("matches a full multi-word launcher line exactly (Flatpak)", () => {
    const line =
      "/usr/bin/flatpak run --branch=stable com.prusa3d.PrusaSlicer";
    expect(execMatchesApp(line, line)).toBe(true);
  });

  it("does not match when the app command is longer than the saved exec", () => {
    expect(
      execMatchesApp(
        "/opt/kicad-10.0.3-x86_64.AppImage",
        "/opt/kicad-10.0.3-x86_64.AppImage kicad",
      ),
    ).toBe(false);
  });

  it("does not match a different program", () => {
    expect(
      execMatchesApp("/opt/kicad-10.0.3-x86_64.AppImage kicad", "/usr/bin/gimp"),
    ).toBe(false);
  });

  it("treats an empty saved exec as no match", () => {
    expect(execMatchesApp("", "gimp-3.2")).toBe(false);
    expect(execMatchesApp("   ", "gimp-3.2")).toBe(false);
  });

  it("ignores surrounding and repeated whitespace", () => {
    expect(
      execMatchesApp("  /opt/app.AppImage   kicad ", "/opt/app.AppImage"),
    ).toBe(true);
  });
});
