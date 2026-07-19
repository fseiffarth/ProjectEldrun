import { describe, expect, it } from "vitest";
import { shellScriptRunPlan } from "../lib/shellScriptRun";
import type { ProjectEntry } from "../types";

const remoteProject: ProjectEntry = {
  id: "simplegnn",
  name: "simplegnn",
  status: "active",
  position: 0,
  local_file: "/state/simplegnn/project.json",
  directory: "/state/simplegnn",
  remote: {
    user: "alice",
    host: "gpu",
    remote_path: "/home/alice/simplegnn",
  },
};

describe("shell script run planning", () => {
  it("runs a remote-source script relative to the host project root", () => {
    const plan = shellScriptRunPlan({
      project: remoteProject,
      treeRoot: "/state/simplegnn",
      syncSource: "remote",
      scriptPath: "/home/alice/simplegnn/install.sh",
      interp: "bash",
    });

    expect(plan).toMatchObject({
      cwd: "/home/alice/simplegnn",
      scriptRel: "install.sh",
      initialInput: "bash 'install.sh'",
      location: "remote",
    });
  });

  it("runs a local-source script relative to the mirror and pins local locality", () => {
    const plan = shellScriptRunPlan({
      project: remoteProject,
      treeRoot: "/state/simplegnn/mirror",
      syncSource: "local",
      scriptPath: "/state/simplegnn/mirror/install.sh",
      interp: "bash",
    });

    expect(plan).toMatchObject({
      cwd: "/state/simplegnn/mirror",
      scriptRel: "install.sh",
      initialInput: "bash 'install.sh'",
      location: "local",
    });
  });

  it("refuses to build bash with an empty script path", () => {
    expect(
      shellScriptRunPlan({
        project: remoteProject,
        treeRoot: "/state/simplegnn",
        syncSource: "remote",
        scriptPath: "/tmp/install.sh",
        interp: "bash",
      }),
    ).toBeNull();
  });
});
