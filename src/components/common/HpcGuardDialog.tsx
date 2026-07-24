import { useHpcGuardStore, type HpcGuardKind } from "../../stores/hpcGuardPrompt";
import { UntestedTag } from "./UntestedTag";

/**
 * The HPC tag's confirmation, mounted once at the shell like the host-key prompt.
 *
 * It exists for the two gated things that can't just be switched off — a
 * disk-usage scan of the cluster tree, and running something in a login-node
 * shell — where the honest answer is "you may, but not by accident". It states
 * what the act costs the machine and what the compliant route is, and then gets
 * out of the way: proceeding is the user's call, and this never remembers the
 * answer.
 */

/** What each refusal is about, in the terms the site's rules put it. */
const COPY: Record<HpcGuardKind, { title: string; body: string; go: string }> = {
  "du-scan": {
    title: "Scan the whole tree on a cluster?",
    body:
      "This walks every file under the project root to add up sizes. On a cluster that root normally lives on the parallel filesystem, where a recursive walk means one metadata request per file against a server the whole site shares — the read filesystem guides ask you not to do casually. It is one scan, not a loop, so it is yours to run if you want it.",
    go: "Scan anyway",
  },
  census: {
    title: "Measure the host's folders on a cluster?",
    body:
      "The giant-folder census runs `du` over the whole host tree to find what is too big to sync. Same metadata cost as a full scan, and this one normally runs by itself on connect — which is why it stays off here unless you ask.",
    go: "Measure anyway",
  },
  "login-node-run": {
    title: "Run this on the login node?",
    body:
      "This would run on the cluster's login node, which is shared with everyone logged in right now. Sites ask you to keep CPU-intensive work off it and reserve the right to kill processes that load it for long. The compliant route for the same work is an interactive job — the Jobs view's srun shell — or a batch script with sbatch.",
    go: "Run here anyway",
  },
};

export function HpcGuardDialog() {
  const pending = useHpcGuardStore((s) => s.pending);
  const proceed = useHpcGuardStore((s) => s.proceed);
  const cancel = useHpcGuardStore((s) => s.cancel);

  if (!pending) return null;
  const copy = COPY[pending.kind] ?? COPY["login-node-run"];

  return (
    // Backdrop-dismissable, unlike the host-key prompt: nothing here is a
    // security decision, and "I didn't mean to" is a legitimate answer that
    // should cost one click.
    <div className="modal-backdrop" onClick={cancel}>
      <div className="project-dialog hpc-guard-dialog" onClick={(e) => e.stopPropagation()}>
        <h2 className="hpc-guard-title">
          {copy.title} <UntestedTag />
        </h2>
        <div className="hpc-guard-target">
          <span className="hpc-guard-badge">HPC</span>
          <code>{pending.target}</code>
        </div>
        <p className="hpc-guard-body">{copy.body}</p>
        <p className="hpc-guard-note">
          You tagged this machine as a cluster login node. Untag it in the Machines menu if that
          was wrong — nothing here is remembered, so this asks again next time.
        </p>
        <div className="project-dialog-actions">
          <button type="button" onClick={cancel}>
            Cancel
          </button>
          <button type="button" onClick={proceed}>
            {copy.go}
          </button>
        </div>
      </div>
    </div>
  );
}
