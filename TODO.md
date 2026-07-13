# ProjectEldrun Plan — Grouped & Numbered Open Ideas

## Context

This is the index into the plan of open implementation work. Each group lives
in its own file under [`todo/`](todo/); this file only tracks group letters,
one-line descriptions, and status, plus the context that applies across all of
them (status legend, competitive evaluation, sequencing, verification
approach). The raw idea dump lives in `open_ideas.md` (51 loose ideas spanning
the right file-tree panel, the bottom project switcher, X11/KDE workspace
switching, project import/publishing, git tooling, drag-and-drop reordering,
remote/SSH projects, branding, session restore, in-app file/text/tex viewers,
tab renaming/mapping, per-project security & remote-control toggles, a native
browser, keyboard-driven navigation, and right-panel polish); cross-platform
Windows/macOS follow-ups (#30–#31), backend runtime follow-ups (#32), and the
global-app URI-routing item (#33) were consolidated here from the former
separate plan file and the old `TODO.md`. The goal of this plan is **not** to
implement everything at once, but to organize the ideas into coherent groups
with stable numbers so you can say "do #14" and I can act on a well-scoped
unit.

Exploration confirmed several ideas are partially built already — those notes
are called out per item so we don't rebuild existing infrastructure.

Numbering is **global and stable** (1–65); new ideas are appended with new
numbers so existing references never shift. Open groups are lettered A, B, C…
(roughly in suggested sequence); completed groups are collected in
[`todo/done.md`](todo/done.md), renumbered D.1, D.2… where that's already
happened (a couple of done groups — N, U — are still under their original
letter, not yet renumbered; see that file). You can pick any item in any
order.

## Status legend — Done ≠ Tested

Three independent axes are tracked per item:

- **✅ Done** — code-complete: written, type-checks (`npx tsc --noEmit`) and/or
  compiles (`cargo test`/`cargo build`). Says nothing about whether it actually
  works.
- **🤖 Automated** — an automated test (vitest under `src/__tests__/` or a Rust
  `cargo test`) exercises the behavior and passes on the current code.
- **🖐️ Manual** — runtime QA in a live Eldrun confirms the behavior by hand.

Each done feature carries two checkboxes — one per verification axis — with an
example test in words to guide both. A feature is fully **🧪 Tested** only when
**both** boxes are ticked.

> ✅ **Automated coverage complete; 🖐️ manual QA still pending** for every done
> group (see [`todo/done.md`](todo/done.md) for the current exception list —
> a couple of items are visual-only or partial-coverage). No 🖐️ Manual box is
> ticked yet — nothing has been runtime-QA'd in a live Eldrun, so treat each
> feature as fully 🧪 Tested only once its manual box also flips.

---

## Evaluation — Idea & Current State vs. Competitors

*Strategic assessment of Eldrun's concept and current feature set against the
competitive landscape (as of 2026-06). Not a numbered work item — context for
prioritization. Competitor specifics are current to ~early 2026; that field
moves monthly.*

### The core bet

Eldrun's thesis: **"you don't open apps, you open projects"** — switching a
project swaps the *entire desktop context* (windows, downloads folder,
default-app mappings, time tracking) as one unit, with built-in agent terminals
riding on top. The bet targets a real, under-served pain (window/context sprawl
across many concurrent projects) and sits in a gap no single competitor fills.
The README's positioning is honest and basically correct — but the bet has
structural vulnerabilities that matter more than the feature checklist suggests.

### Competitive map

- **Agent orchestrators — the gold rush Eldrun opts out of.** Vibe Kanban,
  Conductor, Claude Squad, Crystal, the Claude Code desktop/web app, Cursor
  background agents, plus cloud players (Devin, OpenAI Codex cloud, Google
  Jules, Sculptor). These parallelize agents across git worktrees with task
  queues, diff review, and merge flow. Eldrun's "agent cockpit" is just
  `claude`/`codex`/`gemini` in PTY tabs — i.e. *running the CLI*, nothing more.
  This is where funding and momentum are, and Eldrun explicitly doesn't play.
  **Verdict: complementary, not competitive — and the right call.** You can run
  Vibe Kanban *inside* an Eldrun project terminal. Building a weak orchestrator
  here would be a mistake.
- **AI IDEs/editors — Cursor, Windsurf, Zed, VS Code+Copilot, JetBrains.** Where
  developers actually live. Eldrun's center surface is a *terminal*, and it
  pushes the editor out to an external `xdg-open`'d window. **Biggest conceptual
  gap:** Eldrun is a shell *around* the dev experience, not the dev experience.
- **Terminal/session restorers — tmux+tmuxinator/tmuxp, Zellij, Warp, WezTerm.**
  tmux restores terminal layouts; Warp adds AI to the terminal. **Eldrun wins on
  scope (whole desktop, not just the terminal), but these are far more mature
  and cross-platform.**
- **Desktop context tools — KDE Activities, GNOME workspaces, i3/sway
  scratchpads, Arc Spaces, Workona.** Each solves one slice (Activities move
  windows but have no project model/restore; Workona/Arc are browser-tabs only).
  **Eldrun's "context as one unit" (windows + downloads + default apps + time)
  is more complete than any of these** — the downloads-rerouting and per-project
  default-app remapping are genuinely novel touches nobody bundles.
- **Dev-env managers — devcontainers, Gitpod/Coder, DevPod, Nix/direnv, mise.**
  Reproducible per-project *environments*, no desktop/window layer. Orthogonal
  (and the #38 Docker work moves Eldrun partway into this space).

### Honest strengths

- The gap is real and defensible: (desktop context switching) × (built-in agent
  terminals) on Linux is genuinely under-served.
- Thoughtful, concrete differentiators: per-project downloads routing,
  default-app remapping, time tracking, sticky cross-project app toolbar.
- Local/privacy posture: Ollama-backed local tabs + sshfs remote projects +
  all-local state, a real counter-position to the cloud-agent wave.
- Strategic honesty: positioning as complementary to orchestrators avoids a
  losing fight.

### Honest weaknesses / risks

- **Linux-X11/KDE-only is the dominant constraint.** The entire value prop hinges
  on window management that works on only a couple of compositors; Windows/macOS
  ship the differentiator missing. This caps the audience to roughly "the author
  and people like him." Cross-compositor support (Hyprland, Sway, GNOME) is
  make-or-break for adoption beyond personal use.
- **The editor gap (above):** without a first-class editor story, Eldrun risks
  being a layer people immediately tab away from.
- **Maturity vs. a fast-moving field:** ~75h logged, v0.1.0, single developer,
  and the entire "AI roadmap" (semantic search, startup suggestions, terminal
  hints) is unbuilt while funded orchestrator teams ship weekly.
- **Single-user, local-only** while the market trend is cloud/async/team agents.
- **Existential risk:** if an orchestrator or IDE grows a "workspaces" feature
  that manages windows/context (e.g. Cursor or the Claude Code desktop app adding
  project-scoped desktop state), Eldrun's gap closes from above. Its moat is
  desktop-integration depth — which is also its portability ceiling.

### Strategic take

Eldrun is best understood **not as an agent tool but as a project-context OS
layer**, and should lean all the way into that: *Eldrun is the desktop shell;
inside each project you run whatever the best orchestrator/IDE is.* That framing
turns its biggest "weakness" (not being an orchestrator) into the product.

Two priorities worth weighing **above** the AI-roadmap items:

1. **Portability** — at least Hyprland/Sway/GNOME (ties into Group C #18/#19 and
   Group H #30/#31). Without it the idea can't escape its author.
2. **A real editor/IDE integration story** — even just first-class "this
   project's editor window" treatment rather than embedding.

The idea is good and the gap is real. The execution risk is that it's a deep,
narrow, single-developer Linux tool competing for attention in a field racing
toward broad, cloud, team-scale agent automation — and the defensibility
(desktop depth) is in direct tension with the growth lever (portability).

---

## Open groups

| Group | File | Description |
| --- | --- | --- |
| A | [`todo/group-a.md`](todo/group-a.md) | Bottom Panel: Meta-Project Grouping — "project boxes" to group related pills into one (#13 core UI, #41 multi-project merge). |
| C | [`todo/group-c.md`](todo/group-c.md) | Workspace Switching / Platform Stability — X11/KDE hidden-workspace hardening, window z-order, i3-style tiling mode, cross-OS verification. |
| E | [`todo/group-e.md`](todo/group-e.md) | Git Worktree — mostly done (#23); "open worktree as project" stretch goal still deferred. |
| F | [`todo/group-f.md`](todo/group-f.md) | Session Restore — wire up unused `active_session.json` startup restore on top of existing terminal/tab persistence. |
| G | [`todo/group-g.md`](todo/group-g.md) | Remote / SSH & Containerized Projects — largest net-new backend surface: work-remote axis, SSH/SFTP-native projects, Docker sandboxing, VPN. |
| H | [`todo/group-h.md`](todo/group-h.md) | Cross-Platform: Windows & macOS Support — follow-ups on the already-landed platform foundations. |
| I | [`todo/group-i.md`](todo/group-i.md) | Backend Runtime Follow-Ups — hardening on top of the first `services/` runtime boundary pass. |
| J | [`todo/group-j.md`](todo/group-j.md) | Web & Mail Surfaces — URI routing to external apps (#33), plus in-app mail (#65) and browser (#61) counterparts. |
| L | [`todo/group-l.md`](todo/group-l.md) | Center Panel: Tabs, Subwindows & Navigation — detach-to-window, tab UX fixes, keyboard nav, on top of the done tiling split model. |
| M | [`todo/group-m.md`](todo/group-m.md) | In-App Viewers — text/TeX/image enhancements (Phase 2+) on top of the done file→tab viewer infrastructure. |
| O | [`todo/group-o.md`](todo/group-o.md) | Project Security & Permissions — per-project policy for downloads, agent spawn, and git-push guardrails. |
| R | [`todo/group-r.md`](todo/group-r.md) | Right Panel: Polish & App-Window Tracking — follow-on polish + a tracking-display bug on the done pin toggle. |
| S | [`todo/group-s.md`](todo/group-s.md) | Local Agents via Ollama — generalize the local `vibe` model tab into a family of local Ollama-backed agent tabs. |
| T | [`todo/group-t.md`](todo/group-t.md) | Smart / Native Shell Terminal — research done, not yet built; shell-completion via a new Ollama command. |
| P | [`todo/group-p.md`](todo/group-p.md) | Git Hosting: Multi-Host Publishing — generalize the GitHub-only publish flow to GitLab + generic remote URLs. |

Completed groups (code-complete, automated tests green, manual QA pending
across the board) live in [`todo/done.md`](todo/done.md).

## Suggested sequencing

Group-wise — tackle whole groups in this order, since items within a group
share files and context:

- **Quick wins next:** J (#33 URI routing — last remaining global-apps item; the
  in-app mail #65 / browser #61 in the same group are the larger net-new
  surfaces, weigh security first and pair with #60).
- **Then correctness/stability:** C (X11/KDE workspace switching) — the
  highest-risk area; do #15/#16/#17 together.
- **Then larger features:**
  A (project boxes, builds on the done drag-drop) → E (git worktree) →
  F (session restore) → G (remote/SSH projects, largest net-new backend).
- **Center panel:** L (#42 detach, #55–#57 tab UX, #62 keyboard nav) — builds on
  the done D.11 tiling work; start with the #55 mapping bug (correctness), pairs
  with C since detached windows reuse the per-project parking path.
- **In-app viewers (incremental):** M (#43–#54) — small, mostly-independent
  enhancements on the done D.14 viewer; the link pair #49/#50 and the autosave
  pair #43/#47 are best done together.
- **Project policy:** O (#58–#60) — per-project security/permission model;
  touches the create/import dialog and the agent-spawn + git-push paths.
- **Right-panel polish:** R (#63 needle contrast, #64 app-window tracking bug).
- **Local agents:** S (#72–#78) — generalize the vibe local-agent tab to the
  `ollama launch` family (Claude Code, Hermes, OpenClaw, OpenCode); do the
  registry + backend argv (#72–#74) first, then the picker (#75) and per-agent
  verification (#76). Blocked at runtime until the local Ollama runner is fixed.
- **Git hosting:** P (#79) — multi-host publishing (GitLab + generic remote URL)
  on top of the done GitHub-only flow (D.10 #22); self-contained, pickable anytime.
- **Cross-platform (parallel track):** H (Windows #30 / macOS #31 follow-ups) —
  validate builds & packaging per OS; can proceed alongside the above.
- **Backend runtime (ongoing):** I (#32) — backend-owned runtime hardening
  (PTY resurrection, `.eldrun/` promotion, durable window metadata, tests);
  pairs with F (session restore).

## Verification approach (per item, when implemented)

- Frontend changes: `npx tsc --noEmit`, plus existing/added tests under
  `src/__tests__/` (e.g. the session-restore test for Group F).
- Backend changes: `cargo test --manifest-path src-tauri/Cargo.toml`.
- Runtime validation: **do not** launch Eldrun from the agent — ask you to
  restart your running instance to verify workspace/window/UI behavior.

---

*This is an organizational plan. Pick a group or item number and I'll produce a
focused implementation plan + changes for just that item.*
