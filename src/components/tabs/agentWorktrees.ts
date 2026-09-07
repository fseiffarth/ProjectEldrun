/**
 * Agent tabs and git worktrees (#23, Phase 4's "agent-per-branch" half).
 *
 * Two things had to be true for an agent to *live* in a linked worktree, and
 * neither was.
 *
 * **Starting there.** Every "+" menu entry landed at the project root, so the
 * only way to put an agent in a worktree was to `cd` inside it — which Claude
 * then keyed its session history to, silently. `useAgentWorktreePicker` asks
 * *before* the spawn, and only when there is something to choose: a project
 * with no linked worktrees never sees the dialog.
 *
 * **Coming back there.** `loadFromLayout` reset every agent tab's cwd to the
 * project root, on purpose — a stale saved cwd after a project move/rename put
 * the agent in the wrong directory. That reset was also what broke resume for
 * a worktree agent: Claude keys its history by cwd, so `--resume <id>` run from
 * the root found no such session and the restored tab came up as a fresh
 * conversation. `restoredAgentCwd` keeps the one class of saved cwd that is
 * *derived from* the project root rather than remembered from an old one —
 * `<root>/.eldrun/worktrees/<name>`, the single place a worktree may live
 * (`commands::git::WorktreeCtx::worktrees_root`) — and resets everything else
 * exactly as before. A moved project is still safe: `renameProjectDir` rewrites
 * the prefix, and a cwd under a *different* root fails the check and resets.
 *
 * The listing is always taken from the **mirror side** (`site: "mirror"`): for
 * a local project the site is ignored, and for a remote one this is a local git
 * call against the mirror rather than an SSH round trip a "+" click must never
 * cost. Local agents on a remote project have their cwd pinned to the mirror
 * root at spawn (`localTabCwd`), so the picker is only offered for local
 * projects; the remote/host side is Phase 3/4 work still deferred.
 */
import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useT } from "../../lib/i18n";
import { useDialogs } from "../common/PromptDialogs";
import type { TabEntry } from "../../stores/tabs";
import type { StaticMenuItem } from "./newTabItems";
import { buildStaticTabSpec } from "./newTabItems";
import {
  agentWorktreeChoices,
  isAgentMenuKind,
  worktreeName,
  type GitWorktree,
} from "../../lib/agentWorktrees";

/**
 * The "+" menus' worktree question, shared by `TabBar` and the popout's
 * `NewTabMenu` so the two cannot drift. `specFor` resolves a static agent
 * item to its full tab payload: the plain project-root spec when the project
 * has no linked worktrees (no dialog, no extra round trip visible), the
 * chosen worktree's spec otherwise, or `null` when the user dismissed the
 * question. `asking` is true while the dialog is up — a host menu that closes
 * on outside clicks must hold still for it.
 */
export function useAgentWorktreePicker({
  projectCwd,
  projectName,
  enabled,
}: {
  projectCwd: string;
  projectName: string;
  enabled: boolean;
}) {
  const t = useT();
  const { chooseOption, dialogs } = useDialogs();
  const [asking, setAsking] = useState(false);

  const specFor = useCallback(
    async (item: StaticMenuItem): Promise<Omit<TabEntry, "key"> | null> => {
      const rootSpec = () => buildStaticTabSpec(item, projectCwd, projectName, t);
      if (!enabled || !isAgentMenuKind(item.kind) || !projectCwd) return rootSpec();
      let choices: GitWorktree[] = [];
      try {
        const list = await invoke<GitWorktree[]>("git_worktree_list", {
          projectDir: projectCwd,
          site: "mirror",
        });
        choices = agentWorktreeChoices(list ?? []);
      } catch {
        // Not a repo, or git unavailable — the root is the only answer.
      }
      if (choices.length === 0) return rootSpec();
      setAsking(true);
      let picked: string | null;
      try {
        picked = await chooseOption({
          title: t("newTabMenu.worktreePickTitle", { agent: item.label }),
          body: t("newTabMenu.worktreePickBody"),
          options: choices.map((w) => ({
            id: w.path,
            label: w.is_main
              ? t("newTabMenu.worktreeMain")
              : worktreeName(w.path),
            detail: w.branch || t("newTabMenu.worktreeDetached"),
            hint: w.path,
            // Default to where the project itself is — the answer a click on
            // the old menu gave, and the safe one to Enter through.
            current: w.is_main,
          })),
          untested: true,
        });
      } finally {
        setAsking(false);
      }
      if (picked === null) return null;
      const wt = choices.find((w) => w.path === picked);
      if (!wt || wt.is_main) return rootSpec();
      const branch = wt.branch || worktreeName(wt.path);
      // Named after the branch on both the tab and the agent's own session so
      // two Claudes on two branches can be told apart at a glance.
      const spec = buildStaticTabSpec(
        item,
        wt.path,
        projectName ? `${projectName} (${branch})` : branch,
        t,
      );
      return { ...spec, label: t("newTabMenu.agentWorktreeLabel", { agent: spec.label, branch }) };
    },
    [chooseOption, enabled, projectCwd, projectName, t],
  );

  return { specFor, dialogs, asking };
}
