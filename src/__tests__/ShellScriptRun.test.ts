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

    // For a HOST-side script the preference picks which remote machine; the script
    // path stays project-relative so it resolves against that host's own project
    // root (the backend re-cds into the worker's remote_path).
    expect(plan).toMatchObject({
      cwd: "/home/alice/demoproj",
      scriptRel: "train.sh",
      initialInput: "bash 'train.sh'",
      location: "host:worker1",
    });
  });

  it("keeps a mirror-browsed script LOCAL even with a worker chosen", () => {
    // The browsed side is dominant (`lib/pythonRun`'s `pythonRunPlan` carries the
    // reasoning): the preference is persisted per project, so it is normally set
    // from some earlier session on the host side, and it must not reach back and
    // redirect a Run of a file the user is looking at on the local mirror.
    const plan = shellScriptRunPlan({
      project: remoteProject,
      treeRoot: "/state/demoproj/mirror",
      syncSource: "local",
      scriptPath: "/state/demoproj/mirror/train.sh",
      interp: "bash",
      runHostPref: "host:worker1",
    });

    expect(plan).toMatchObject({
      cwd: "/state/demoproj/mirror",
      scriptRel: "train.sh",
      location: "local",
    });
  });

  it("keeps a mirror path local even if syncSource never arrives", () => {
    // The prop has to be threaded correctly through five components to be true;
    // the path is a fact. A mirror-side script is local whatever `syncSource` says
    // (here: absent, which used to read as "browsing the host" and put an `ssh`
    // tab on screen for a file sitting on this machine).
    const plan = shellScriptRunPlan({
      project: remoteProject,
      treeRoot: "/state/demoproj/mirror",
      scriptPath: "/state/demoproj/mirror/train.sh",
      interp: "bash",
      runHostPref: "remote",
    });

    expect(plan).toMatchObject({
      cwd: "/state/demoproj/mirror",
      scriptRel: "train.sh",
      location: "local",
    });
  });

  it("keeps a host path remote even if syncSource says local", () => {
    const plan = shellScriptRunPlan({
      project: remoteProject,
      treeRoot: "/state/demoproj/mirror",
      syncSource: "local",
      scriptPath: "/home/alice/demoproj/train.sh",
      interp: "bash",
    });

    expect(plan).toMatchObject({ cwd: "/home/alice/demoproj", location: "remote" });
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
