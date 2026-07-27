import { describe, expect, it } from "vitest";
import { shellScriptRunPlan } from "../lib/shellScriptRun";
import type { ProjectEntry } from "../types";

const remoteProject: ProjectEntry = {
  id: "demoproj",
  name: "demoproj",
  status: "active",
  position: 0,
  local_file: "/state/demoproj/project.json",
  directory: "/state/demoproj",
  remote: {
    user: "alice",
    host: "gpu",
    remote_path: "/home/alice/demoproj",
  },
};

describe("shell script run planning", () => {
  it("runs a remote-source script relative to the host project root", () => {
    const plan = shellScriptRunPlan({
      project: remoteProject,
      treeRoot: "/state/demoproj",
      syncSource: "remote",
      scriptPath: "/home/alice/demoproj/install.sh",
      interp: "bash",
    });

    expect(plan).toMatchObject({
      cwd: "/home/alice/demoproj",
      scriptRel: "install.sh",
      initialInput: "bash 'install.sh'",
      location: "remote",
    });
  });

  it("runs a local-source script relative to the mirror and pins local locality", () => {
    const plan = shellScriptRunPlan({
      project: remoteProject,
      treeRoot: "/state/demoproj/mirror",
      syncSource: "local",
      scriptPath: "/state/demoproj/mirror/install.sh",
      interp: "bash",
    });

    expect(plan).toMatchObject({
      cwd: "/state/demoproj/mirror",
      scriptRel: "install.sh",
      initialInput: "bash 'install.sh'",
      location: "local",
    });
  });

  it("runs on the chosen worker machine when a run-host preference is set", () => {
    const plan = shellScriptRunPlan({
      project: remoteProject,
      treeRoot: "/state/demoproj",
      syncSource: "remote",
      scriptPath: "/home/alice/demoproj/train.sh",
      interp: "bash",
      runHostPref: "host:worker1",
    });

    // The chosen machine wins over the browsed side; the script path stays
    // project-relative so it resolves against that host's own project root (the
    // backend re-cds into the worker's remote_path).
    expect(plan).toMatchObject({
      cwd: "/home/alice/demoproj",
      scriptRel: "train.sh",
      initialInput: "bash 'train.sh'",
      location: "host:worker1",
    });
  });

  it("sends a mirror-browsed script to the chosen remote machine", () => {
    // Browsing the local mirror but with a worker chosen: the run still lands on
    // the worker, and scriptRel (project-relative) resolves there.
    const plan = shellScriptRunPlan({
      project: remoteProject,
      treeRoot: "/state/demoproj/mirror",
      syncSource: "local",
      scriptPath: "/state/demoproj/mirror/train.sh",
      interp: "bash",
      runHostPref: "host:worker1",
    });

    expect(plan).toMatchObject({
      cwd: "/home/alice/demoproj",
      scriptRel: "train.sh",
      location: "host:worker1",
    });
  });

  it("refuses to build bash with an empty script path", () => {
    expect(
      shellScriptRunPlan({
        project: remoteProject,
        treeRoot: "/state/demoproj",
        syncSource: "remote",
        scriptPath: "/tmp/install.sh",
        interp: "bash",
      }),
    ).toBeNull();
  });
});
