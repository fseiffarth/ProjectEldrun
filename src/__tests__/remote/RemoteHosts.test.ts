/**
 * `hostsForProject` (`lib/remote/remoteHosts`): the one host list the monitor's source
 * picker and the usage dialog share — primary first, workers after, each with
 * the SSH target the careful/HPC flags are keyed by.
 */
import { describe, expect, it } from "vitest";

import { hostsForProject } from "../../lib/remote/remoteHosts";
import type { ProjectEntry } from "../../types";

const base = { id: "p", name: "p", status: "active" as const, position: 0, local_file: "/p" };

describe("hostsForProject", () => {
  it("is empty for a local project or no project", () => {
    expect(hostsForProject(undefined)).toEqual([]);
    expect(hostsForProject({ ...base })).toEqual([]);
  });

  it("lists the primary first, labelled by its label or host", () => {
    const project: ProjectEntry = {
      ...base,
      remote: { user: "alice", host: "login.example.org", port: 2222, remote_path: "/h" },
    };
    expect(hostsForProject(project)).toEqual([
      {
        id: "primary",
        label: "login.example.org",
        target: { user: "alice", host: "login.example.org", port: 2222 },
      },
    ]);
    const labelled: ProjectEntry = { ...base, remote: { ...project.remote!, label: "Cluster" } };
    expect(hostsForProject(labelled)[0].label).toBe("Cluster");
  });

  it("appends each worker with its own id and target, blanks normalised", () => {
    const project: ProjectEntry = {
      ...base,
      remote: { host: "login.example.org", remote_path: "/h" },
      compute_hosts: [
        { id: "w-1", host: "gpu.example.org", user: "", remote_path: "/h" },
        { id: "w-2", host: "cpu.example.org", label: "CPU box", user: "bob", port: 22, remote_path: "/h" },
      ],
    };
    const hosts = hostsForProject(project);
    expect(hosts.map((h) => h.id)).toEqual(["primary", "w-1", "w-2"]);
    expect(hosts[0].target).toEqual({ user: undefined, host: "login.example.org", port: undefined });
    expect(hosts[1]).toEqual({
      id: "w-1",
      label: "gpu.example.org",
      target: { user: undefined, host: "gpu.example.org", port: undefined },
    });
    expect(hosts[2]).toEqual({
      id: "w-2",
      label: "CPU box",
      target: { user: "bob", host: "cpu.example.org", port: 22 },
    });
  });
});
