## Group U — Interface Cost & Responsiveness

*Created 2026-08-26. Files: `src/lib/fastMode.ts`, `src/stores/power.ts`,
`src/styles/themes.css`, plus the surfaces each item names.*

*The group exists because none of the others fit and the subject is real: what
Eldrun **spends** to show what it shows. Every feature here is somebody else's
feature seen from the other side — a folder size is a recursive walk, a git dot
is a `git status`, a hover card is a poll — and the question "is this worth its
cost, on this machine, right now?" belongs to the user rather than to whichever
group shipped the aid. Energy Saver (`stores/power`) was the first answer and
is a different one: it widens timers off a live **battery** reading, this group
is about a standing **preference**.*

*The rule for anything added here: nothing may make Eldrun say something
untrue. Withdrawing a figure is fair; leaving a stale or unresolvable one on
screen is not.*

---

210. **Fast mode.** ✅ Done 2026-08-26, code-complete and **live-unverified**.
    One global toggle (Settings → Fast mode, default off) that withdraws the
    display aids whose cost is a directory walk, a standing poll, or a read of
    every file in view. The list lives in `src/lib/fastMode.ts` — one home, so
    the help text and the code cannot drift — and everything on it has to share
    three properties: it costs work nobody asked for, its absence is *legible*
    (no spinner, no "…" that never resolves), and nothing is lost but the aid.

    What it turns off:
    - **Folder sizes in the file tree** — one `dir_size_breakdown` per visible
      folder, and on a remote project each is a `du` over SSH. The group totals
      go with them: with no walk, every sum is a permanent lower bound, so the
      header would read `≥ 1.2 MB` for the rest of the session.
    - **The git-dirty dots on the project pills** — a `git status` per local
      project every 12 s, forever, for projects the user is not in.
    - **The project hover card** — `project_cpu_percent` every 1.5 s for as long
      as the pointer rests, plus a scaffold probe per open. Falls back to the
      plain tooltip the Trash pill already uses.
    - **The tab hover card** — its own ticking clock and store subscriptions per
      hover; the tab keeps its label as a `title`.
    - **The header CPU/RAM/GPU readout** — a poll every 2.5 s for a figure that
      is, by construction, a readout of Eldrun's own overhead.
    - **The Python ▶ gate** — deciding whether a `.py` has a `__main__` guard
      means reading it, an SFTP round trip per file on a remote listing. Files
      already in the persisted cache keep their ▶: it stops the *scanning*, not
      the answers already paid for.
    - **The tree's 15 s remote re-stat** — the focus listener and every explicit
      re-list survive, so the sync markers still catch up on a gesture.
    - **UI animations and transitions** — `data-fast-mode` on the document root.
      Deliberately stronger than the blur rule beside it: that one *pauses* what
      is running (right for a window nobody is looking at), this cancels it and
      collapses transitions, because the user is looking and has asked for the
      frames back.

    It composes with Energy Saver rather than replacing it, and it is reactive
    throughout — turning it off restores every surface in place, with no
    relaunch and no remount, which is what makes it safe to try.
    - [x] 🤖 Automated test — `src/__tests__/FastMode.test.tsx` (8: the gate is
      never inferred — unset, `false` and an unloaded store all read off; the
      root attribute; and a withdrawn surface renders nothing **and** asks the
      backend nothing, then comes back when the toggle flips) plus the schema
      round trip in `schema::settings`.
    - [ ] 🖐️ Manual test — turn it on with a project open: folder sizes and the
      group totals go, the pills lose their git dots, hovering a pill or a tab
      shows a plain tooltip instead of a card, the header loses its CPU/RAM row,
      and nothing animates. Turn it off: all of it comes back without a restart.
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work
    - [ ] **Open:** the withdrawals are all frontend. The costs a *backend*
      loop pays regardless — the byte-sync pass, the lockstep poll, the usage
      watcher — are untouched, and are gated today only by the HPC tag. Whether
      fast mode should reach them is a real question and deliberately not
      answered here: those loops keep two trees in step, so skipping one is not
      withdrawing an aid but declining to do the work, which is the line this
      group's rule draws.
    - [ ] **Open:** no measurement. "Faster" is asserted from what each item
      costs rather than from a before/after reading, and the dev-only perf
      monitor (`src/dev/`, Ctrl+Alt+P) is the obvious instrument for turning
      that into a number.

---
