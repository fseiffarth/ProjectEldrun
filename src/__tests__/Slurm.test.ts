/**
 * The SLURM (HPC) text helpers (`lib/slurm.ts`), all pure — the directive form is
 * a *view on the text*, exactly like the YAML/table viewers: every edit splices the
 * script's `#SBATCH` lines rather than re-serializing, so unrelated lines, comments
 * and the flag spelling the author used all survive. These tests pin that bargain
 * plus the command builders for the log tail and the interactive `srun` shell.
 */
import { describe, it, expect } from "vitest";
import {
  isSlurmScript,
  parseSbatchDirectives,
  directiveValue,
  spliceDirective,
  buildInteractiveCommand,
  buildTailCommand,
} from "../lib/slurm";

const SCRIPT = `#!/bin/bash
#SBATCH --job-name=train
#SBATCH --time=01:00:00
#SBATCH -c 4
# a normal comment
module load python
srun python train.py
`;

describe("isSlurmScript", () => {
  it("is true only when a #SBATCH directive is present", () => {
    expect(isSlurmScript(SCRIPT)).toBe(true);
    expect(isSlurmScript("#!/bin/bash\necho hi\n")).toBe(false);
    // A bare `#SBATCH` comment with no flag is not a directive.
    expect(isSlurmScript("#SBATCH\n")).toBe(false);
  });
});

describe("parseSbatchDirectives", () => {
  it("normalizes short flags to their long key", () => {
    const fields = parseSbatchDirectives(SCRIPT);
    expect(directiveValue(fields, "job-name")).toBe("train");
    expect(directiveValue(fields, "time")).toBe("01:00:00");
    // `-c 4` folds into `cpus-per-task`.
    expect(directiveValue(fields, "cpus-per-task")).toBe("4");
  });

  it("returns empty for an absent key", () => {
    expect(directiveValue(parseSbatchDirectives(SCRIPT), "mem")).toBe("");
  });
});

describe("spliceDirective", () => {
  it("rewrites an existing directive in place, keeping the flag spelling", () => {
    const next = spliceDirective(SCRIPT, "time", "02:30:00");
    expect(next).toContain("#SBATCH --time=02:30:00");
    expect(next).not.toContain("01:00:00");
    // The short-flag directive keeps its short form when edited by long key.
    const next2 = spliceDirective(SCRIPT, "cpus-per-task", "8");
    expect(next2).toContain("#SBATCH -c 8");
  });

  it("leaves every other line byte-identical", () => {
    const next = spliceDirective(SCRIPT, "time", "02:30:00");
    // Only the one directive line changed; the comment, module load and srun stay.
    expect(next).toContain("# a normal comment");
    expect(next).toContain("module load python");
    expect(next).toContain("srun python train.py");
    expect(next.split("\n").length).toBe(SCRIPT.split("\n").length);
  });

  it("inserts a new directive after the last existing one", () => {
    const next = spliceDirective(SCRIPT, "mem", "16G");
    const lines = next.split("\n");
    const memIdx = lines.findIndex((l) => l.includes("--mem=16G"));
    const cIdx = lines.findIndex((l) => l.includes("-c 4"));
    expect(memIdx).toBeGreaterThan(-1);
    // Grouped with the other directives (right after the last one), not at the end.
    expect(memIdx).toBe(cIdx + 1);
  });

  it("inserts after a shebang when there are no directives yet", () => {
    const next = spliceDirective("#!/bin/bash\necho hi\n", "time", "00:10:00");
    const lines = next.split("\n");
    expect(lines[0]).toBe("#!/bin/bash");
    expect(lines[1]).toBe("#SBATCH --time=00:10:00");
  });

  it("removes the directive when the value is cleared", () => {
    const next = spliceDirective(SCRIPT, "time", "");
    expect(next).not.toContain("--time");
    // The others remain.
    expect(next).toContain("--job-name=train");
  });
});

describe("command builders", () => {
  it("tails the log by name with retry", () => {
    expect(buildTailCommand("/home/a/p/slurm-42.out")).toBe(
      "tail -n +1 -F '/home/a/p/slurm-42.out'",
    );
  });

  it("builds an srun --pty command from the set resources only", () => {
    expect(
      buildInteractiveCommand({ time: "01:00:00", cpus: "4", mem: "8G", gpus: "1" }),
    ).toBe("srun --pty --time=01:00:00 --cpus-per-task=4 --mem=8G --gres=gpu:1 bash -l");
    // Empty fields are omitted; a bare session still lands on bash -l.
    expect(buildInteractiveCommand({})).toBe("srun --pty bash -l");
  });
});
