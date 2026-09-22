/**
 * The session's own memory of submitted SLURM jobs (`stores/remote/hpc/hpcJobs`): newest
 * first, deduped by job id AND host (two clusters can hand out the same id),
 * and a cancel forgets exactly one row.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { useHpcJobsStore, type HpcJob } from "../../stores/remote/hpc/hpcJobs";

const job = (jobId: string, host = "primary", extra: Partial<HpcJob> = {}): HpcJob => ({
  jobId,
  name: `job-${jobId}`,
  outFile: `/scratch/out-${jobId}.log`,
  host,
  submittedAt: 1,
  ...extra,
});

beforeEach(() => {
  useHpcJobsStore.setState({ byProject: {} });
});

describe("add", () => {
  it("lists the newest submission first, per project", () => {
    const { add } = useHpcJobsStore.getState();
    add("p1", job("100"));
    add("p1", job("101"));
    add("p2", job("7"));
    expect(useHpcJobsStore.getState().byProject.p1.map((j) => j.jobId)).toEqual(["101", "100"]);
    expect(useHpcJobsStore.getState().byProject.p2.map((j) => j.jobId)).toEqual(["7"]);
  });

  it("replaces a re-submitted id on the same host with the newer record", () => {
    const { add } = useHpcJobsStore.getState();
    add("p1", job("100", "primary", { outFile: "/old.log" }));
    add("p1", job("101"));
    add("p1", job("100", "primary", { outFile: "/new.log" }));
    const rows = useHpcJobsStore.getState().byProject.p1;
    expect(rows.map((j) => j.jobId)).toEqual(["100", "101"]);
    expect(rows[0].outFile).toBe("/new.log");
  });

  it("keeps the same id on two different hosts", () => {
    const { add } = useHpcJobsStore.getState();
    add("p1", job("100", "primary"));
    add("p1", job("100", "w-cluster-b"));
    expect(useHpcJobsStore.getState().byProject.p1).toHaveLength(2);
  });
});

describe("remove", () => {
  it("forgets one job by id and host, leaving its namesake on the other host", () => {
    const { add, remove } = useHpcJobsStore.getState();
    add("p1", job("100", "primary"));
    add("p1", job("100", "w-cluster-b"));
    remove("p1", "100", "primary");
    expect(useHpcJobsStore.getState().byProject.p1.map((j) => j.host)).toEqual(["w-cluster-b"]);
  });

  it("tolerates a project or job it never saw", () => {
    useHpcJobsStore.getState().remove("nope", "1", "primary");
    expect(useHpcJobsStore.getState().byProject.nope).toEqual([]);
  });
});
