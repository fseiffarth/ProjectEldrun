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

214. **The side panel repopulates from a snapshot.** ✅ Done 2026-08-30,
    code-complete and **live-unverified**. A closed panel does not hide its
    tree, it unmounts it (`SidePanel` passes `mountTree={open}`, so a closed
    panel holds no fs-watch and runs no probes; the `panelsHidden` toggle
    unmounts the whole panel). Everything the view had paid for died with it,
    so every reveal rebuilt from nothing — a `list_dir`, then a
    `git_file_statuses` behind it, then one recursive walk per visible folder,
    then the repo's own `git status` — and the panel visibly filled itself in
    for as long as that took. On a remote project each of those is an SFTP or
    SSH round trip, so the wait was the *point* at which the panel was least
    usable.

    `src/lib/fileViewSnapshots.ts` keeps the last state of each (project, root
    dir, folder) — entries, per-file git statuses, folder sizes and their
    ignored split — plus the git bar's counts per repo, in module scope, where
    they outlive the components. A reveal seeds every one of those from the
    snapshot in its `useState` initializers, so the **first committed frame is
    already populated**, and the upgrade goes out one frame later (the listing
    commands are synchronous main-thread calls; issuing one inside that commit
    would stall exactly the frame the seed exists to make instant). The upgrade
    is the same quiet, diffing refresh the fs-watcher uses, so nothing repaints
    where nothing changed, and the folder sizes are re-walked from scratch —
    the dedupe set is empty on a mount — so no figure on screen stays a stale
    one. Navigating into a previously-visited folder seeds the same way.

    This group's rule holds: nothing on screen is untrue for longer than a
    round trip, and the two states where the answer is genuinely unknown — a
    listing that FAILS (the snapshot is dropped, so the error shows rather than
    resurrected rows) and a remote pool that cannot be asked (the git bar
    clears) — are not seeded at all.
    - [x] 🤖 Automated test — `src/__tests__/SidePanelReveal.test.tsx` (9: a
      cold first frame is empty, a revealed one is not; the stale seed upgrades
      to what the folder now holds; the git counts survive a close; plus the
      LRU bounds and read-as-use on both snapshot maps).
    - [ ] 🖐️ Manual test — open a project with a sizeable tree, close the panel
      and reveal it again: the tree, its git colours and the folder sizes are
      there on the first frame, with no empty-then-fill. Change a file from a
      terminal while the panel is closed and reveal it: the change is on screen
      a moment later. Worth repeating on a remote project, where the round
      trips this skips are the expensive ones.
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work
    - [ ] **Open:** in memory only, deliberately — a listing must not survive a
      relaunch, after which the filesystem has had unbounded time to move on.
      Whether the *folder sizes* are worth persisting (they are the expensive
      half, and a walk's answer ages more slowly than a listing's) is a
      separate question and not answered here.

---

217. **Theme modernization pass.** ✅ Done 2026-08-30, code-complete and
    **live-unverified**. Five changes to `src/styles/themes.css` and its
    consumers, from a comparison against current desktop-app design practice:
    - **Derived accent/pill tokens** — `--accent-hover`/`--accent-active` and
      the pill washes now derive from each theme's own `--accent` via
      `color-mix` toward `--text-primary` (right direction in dark *and* light
      themes); the achromatic pair keeps its explicit overrides. A minimal
      theme is now surfaces + borders + text tiers + one accent.
    - **`soft_dark` theme** — the neutral dark-gray theme (no navy tint, no
      colored borders, restrained blue accent), the one theme that opts back
      into rounded corners via its own radius tokens. Its own xterm palette in
      `TerminalView.terminalTheme`.
    - **`system` pseudo-theme** — follows the OS light/dark preference
      (`fancy_light`/`fancy_dark`), resolved in `stores/settings.resolveTheme`
      with a `matchMedia` listener for live OS flips; never reaches
      `data-theme` or the terminal palette unresolved. The pre-paint
      localStorage cache stores the *resolved* theme.
    - **Contrast fixes** — `--text-muted` lifted to ≥4.5:1 on resting surfaces
      in `fancy_dark` (#8091a9), `fancy_light` (#5f6e84) and `light_lavender`
      (#746d8f).
    - **Token hygiene** — type-scale tokens (`--text-xs`…`--text-lg`, 10px
      floor; every ≤9px and half-pixel font-size migrated), spacing tokens
      (`--space-1..4`), `--ease-out`, status washes (`--success/warning/
      danger-soft`); ~140 dead `var(--x, #hex)` fallbacks stripped (one live
      phantom found: `var(--border, …)` — no such token); git/status chrome in
      `viewers.css`/`file-tree.css` moved onto `--success/--warning/--danger`,
      with filled status chips taking `--bg-main` text (the `.btn-primary`
      rule) instead of fixed white.
    - [x] 🤖 Automated test — the existing corpus: `TerminalThemeRenderer`,
      `TerminalAttachOnly` (mocks extended with `resolveTheme`),
      `GitStatusColors`; `npm run build` + full vitest green.
    - [ ] 🖐️ Manual test — walk all seven themes in Settings → Theme: chrome,
      pills, menus, dialogs, terminal palette each time. Check `soft_dark`'s
      rounded corners and neutral header, `system` following an OS light/dark
      flip live, muted text legibility in the three tinted themes, and the
      compare-view take/chip colors in a diff on a light theme.
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

218. **Accent color + corner style overrides.** ✅ Done 2026-08-30,
    code-complete and **live-unverified**. The payoff of #217's derived
    tokens: two appearance overrides in Settings, above the theme row.
    - **Accent color** — preset swatches + a native color input + "Theme
      default". Applied as inline root CSS vars
      (`stores/settings.applyAccent`): `--accent` plus the five derived
      hover/active/pill formulas restated inline, so the override outranks the
      achromatic pair's explicit literals and behaves exactly like a theme's
      own accent everywhere (focus rings, scrollbar thumb, pills, buttons).
      The color input live-previews and persists debounced (400 ms) — a GTK
      color chooser fires input events per drag tick, and each commit is a
      settings.json write plus a broadcast.
    - **Corners** — Theme default / Square / Rounded (`applyCorners`, the
      three radius tokens; "rounded" = soft_dark's 4/8/12 ladder).
    - Persistence: `Settings.ui_accent` / `ui_corners`
      (`schema/settings.rs` round-trips them — **backend restart needed** for
      persistence; the frontend applies live regardless). Cross-window:
      `APPEARANCE_CHANGED_EVENT` (DetachedApp listener) + the popout's own
      settings load. Pre-paint: `index.html` re-applies validated
      `eldrun-accent`/`eldrun-corners` localStorage caches before first paint.
    - [x] 🤖 Automated test — `src/__tests__/Appearance.test.ts` (normalize/
      apply/clear/invalid-input for both overrides; "system" resolution).
    - [ ] 🖐️ Manual test — pick a swatch: pills, focus rings, scrollbar and
      buttons recolor at once, in every theme including Plain Dark/Light;
      drag the custom color wheel (no save-storm jank); "Theme default"
      restores each theme's own accent. Flip Corners to Rounded on fancy_dark
      and Square on Soft Dark; check a popout follows live and a relaunch
      paints the override before first frame (after a backend restart).
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

219. **Accent-colored chrome seam + a third chrome surface.** ✅ Done
    2026-08-31, code-complete and **live-unverified**. Two changes to how the
    window's chrome layers read apart, on the same idea: the boundaries between
    them should be a decision, not a leftover.
    - **The top bar's bottom edge is the accent** (`shell.css`'s `.app-header`
      box-shadow, was `--border-color`). The two theme overrides that replace
      that shadow had to follow: the achromatic pair's explicit
      `--text-primary` line is now redundant (their accent *is* the ink) and
      was dropped, and the glass pair (`fancy_dark`/`light_lavender`), which
      replaces the box-shadow wholesale with a drop shadow, restates the seam
      beside it — otherwise those two silently lose it.
    - **`--bg-subheader`** — one shared secondary-chrome surface for the
      subwindow tab bars (`.tab-bar`) and the file panel's own two header rows
      (`.side-panel-header` + `.side-panel-toolbar`), so they read apart from
      both the app header above and the content below. Derived per theme
      (`accent 14% over --bg-elevated`), with `--glass-subheader` for the glass
      pair and a near-neutral literal for `dark`/`light`, whose accent is the
      ink and for which the shared derivation would be the mid-grey band their
      "resting surfaces are pure" rule exists to forbid. The tab bar's old
      inline `::before` accent wash (0.12) folded into the token.
    - **Correction 2026-08-31**: the achromatic pair's step was #101010/#f0f0f0
      — technically off the pure tone, invisible in practice, which is the same
      as not doing it (reported on Plain Dark). Raised to #1e1e1e / #ebebeb:
      still neutral, so nothing there acquires a hue, but the header actually
      reads apart from the pane. A distinction nobody can see is not one.
    - [ ] 🖐️ Manual test — in every theme: the header's bottom edge is the
      accent (and still visible on fancy_dark/light_lavender, which draw a
      drop shadow there); a subwindow's tab bar and the file panel's header
      block are each distinguishable from the top bar AND from the pane/panel
      under them — **Plain Dark and Plain Light included**.
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

220. **Theme Customizer — every color variable, in its own window.** ✅ Done
    2026-08-31, code-complete and **live-unverified**. Settings → *Theme
    colors* → "Customize…" opens a window of its own (opened instead of the
    Settings dialog, ‹ Back returns) listing the whole palette grouped by what
    it paints — surfaces, text, borders, accent, controls, status, pills,
    window buttons, the activity ramp, everything else — one row per CSS
    variable: swatch, the token name, an editable hex, and a per-token reset.
    **The corner style and the accent picker both moved in here** from the main
    Settings panel — #218's two knobs shape and color the same chrome, and the
    accent is a theme color like the rest — beside a "Reset all". Settings keeps
    one row: *Theme colors* → "Customize…". The accent's row keeps its swatch
    strip rather than becoming a plain hex field (the presets are the control
    most of the time) and its "Theme default" doubles as that row's reset.
    - Persistence: `Settings.ui_theme_vars` (a `{token: "#rrggbb"}` map),
      riding the backend's `extra` catch-all — **no Rust field, so no backend
      restart**. Cross-theme like the accent and applied *after* it, so a
      hand-picked `--accent-hover` beats the one derived from the accent.
    - Safety: `lib/themeTokens` is an allow-list and
      `stores/settings.normalizeThemeVars` the gate — these values are written
      as inline custom properties, so an unvalidated pair from a hand-edited
      settings.json would be an arbitrary-CSS write. `--accent` is rejected
      from the map on purpose: it keeps its own setting (`ui_accent`), which
      the accent row here writes, so one color never has two writers.
    - The "current value" of a token cannot be read (`getComputedStyle` hands
      back the token stream — a `color-mix`, a `var()` chain, a gradient), so
      each swatch is resolved by *painting* it on a hidden probe and reading
      the computed `color` back; a sentinel catches the values that are not
      colors at all (the fancy themes' gradient `--bg-header`), which fall back
      to a twin token.
    - Cross-window via `APPEARANCE_CHANGED_EVENT` (payload grew `themeVars`);
      pre-paint via a validated `eldrun-theme-vars` localStorage cache in
      `index.html`.
    - **Per-token examples** (2026-08-31): every row carries a line under the
      variable name saying what *visibly* changes when it does ("Menus,
      dropdowns and dialog surfaces"), keyed off the name via
      `themeTokenExampleKey` so a catalog entry cannot arrive without one — the
      name says where a value sits in the design system, which is not the
      question anyone at this panel is asking. 50 strings × 5 languages.
    - **`--bg-side-panel`** (2026-08-31): recoloring the side panel through
      `--bg-panel` repainted every other panel-toned surface with it (settings
      sections, the file browser, popovers — ~100 rules). The panel now reads
      its own token, which follows `--bg-panel` until something sets it, so the
      customizer can give the panel a tone of its own. Not a rename: the
      general token still means what it meant, and its example line says so.
    - **Group order** (2026-08-31): Accent leads, above Surfaces — the color
      most people open this window for, and the fastest thing in it to try.
    - **Two derived surfaces got sections of their own** (2026-08-31), on one
      idea: a surface whose look is *derived* cannot be recolored without
      moving everything it derives from, so each gets tokens that follow the
      shared ones until set.
      - **Side panel** — `--bg-side-panel` (follows `--bg-panel`),
        `--bg-side-panel-header` (follows `--bg-subheader`) and
        `--side-panel-border` (follows `--border-color`). The header pair
        applies only *inside* `.side-panel`: the same header markup renders in
        the Files (Project) tab and the docked file column, which stay on the
        shared token, so retoning the panel's header leaves the subwindow tab
        bars alone.
      - **Alerts strip** — `--alerts-bg`, `--alerts-header-bg`,
        `--alerts-border` (the three accent-over-ground mixes, moved out of
        `file-tree.css` into `themes.css`) plus the urgency ramp
        `--alerts-overdue`/`--alerts-now`/`--alerts-soon`, which followed
        `--danger`/`--warning`/`--accent` inline and now follow them as
        tokens.
    - **Saved themes + "Colors in this theme"** (2026-08-31): the customizer
      can now *store and load* a look. A save line at the top of the window
      takes a name and puts the whole appearance away —
      `Settings.ui_theme_presets`, an array of `{id, name, theme, accent,
      corners, vars}` riding the same `extra` catch-all, **no Rust field and no
      backend restart**. The base theme travels with the palette because a set
      of overrides built on Fancy Dark reads as somebody else's look on Plain
      Light; Load writes theme + accent + vars + corners in **one**
      `updateSettings` patch (so the accent's derived family and the
      hand-picked tokens land in the order they expect, and the popouts get one
      broadcast) and drops any color edit still sitting on the 400 ms debounce,
      since that edit belongs to the look being replaced. Saving under an
      existing name replaces that entry rather than growing a second one
      claiming to be it; ⭮ overwrites a row with the current look; × asks once
      before deleting, because a hand-built palette has no undo. Presets are
      validated on **read** (`stores/settings.normalizeThemePresets`, capped at
      40 × 60 chars) for `normalizeThemeVars`' reason turned up one notch: a
      preset sits inert in a hand-editable settings.json until somebody presses
      Load, which would otherwise be an arbitrary-CSS-variable write with a
      friendly button in front of it.
      Beside it, every color row (and the accent's) grew a ▤ button opening
      **"Colors in this theme"**: the painted palette deduplicated
      (`paletteFromColors`) — every distinct color the document shows right
      now, your own overrides included — so a new value can be matched to one
      already on screen instead of guessed next to it. It expands the row
      rather than floating over it: the card scrolls, and a popover would be
      one scroll from being clipped. A palette pick reaches the accent
      6-digit — `ui_accent` has no alpha channel and a translucent accent would
      fade every control derived from it.
    - [x] 🤖 Automated test — `src/__tests__/ThemeVars.test.ts` (the allow-list
      gate, hex validation incl. the 8-digit alpha form, clearing an override
      really clears it, the pre-paint cache holds only validated values, every
      catalog token exists in the stylesheet **and has an example string**, the
      computed-color → hex reader, **preset normalization** — vars gate, known
      theme/accent/corner values only, id/name/duplicate drops, the caps — and
      **`paletteFromColors`** deduplicating in catalog order).
    - [ ] 🖐️ Manual test — change `--bg-panel` and `--text-secondary`: the app
      repaints live while dragging, a popout follows, and the values survive a
      relaunch (painted before the first frame). Reset one token and then all.
      Set `--accent-hover` by hand, then change the accent — the hand-picked
      value must win. Switch themes: the overrides ride along. Check the
      corner control and the accent swatches still work from their new home,
      and that Settings itself no longer carries either. Check `--bg-side-panel`
      moves the side panel and nothing else, and that `--bg-panel` still moves
      the rest.
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work
    - [ ] 🖐️ Manual test (saved themes) — build a look (theme + accent + a
      couple of tokens + corners), name it, Save. Change everything, then Load
      it back: theme, accent, colors and corners all return, in the popouts
      too, and survive a relaunch. Save under the same name again — one row,
      not two. ⭮ on a row picks up the current look; × asks before deleting.
      Open ▤ on a row: the strip shows the colors currently on screen (an
      override you just made included) and picking one sets that token; on the
      accent row it sets the accent.
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

---

221. **The project root no longer re-lists itself forever.** ✅ Done
    2026-08-31, code-complete and **live-unverified** (the backend half needs a
    restart). Reported as the side panel "flickering between two paths" and
    `.idea` "appearing then disappearing continuously" in a local project. A
    file-backed trace of the live window showed the root folder in a closed
    loop: `refresh()` → `git_file_statuses` → `git status` opportunistically
    rewrote `.git/index` → `.git`'s mtime bumped → the tree's non-recursive
    root watch reported the `.git` entry as changed → 250 ms later `refresh()`
    again, about once a second for as long as the root was on screen. The
    visible part was a piled-up status probe failing now and then: a failure
    was applied as an EMPTY map, which promoted every gitignored folder out of
    the collapsed gitignored section into the regular list for a frame.

    Backend: `hardened_git_command` sets `GIT_OPTIONAL_LOCKS=0`, git's own
    switch for "read-only commands must not write the repo" — output of every
    status/log/rev-list is unchanged, mutating commands keep their mandatory
    locks, and the loop cannot close. Frontend (`FileTree`): a failed status
    probe keeps the last good letters, and a listing/status result for a folder
    the tree has since left is discarded (`loadTargetRef`, seeded from the
    saved folder so the seeded reveal's refresh passes) — with the seeded
    `load` of #214 painting the new folder at once, a slow result for the old
    one used to flash in over it. Tests: `FileTreeRefreshRaces.test.tsx` (all
    three fail against the previous `FileTree`).

    - [ ] 🖐️ Manual test — after a restart, open a local git project's side
      panel at the project root and leave it for a minute: `.git`'s mtime
      (`stat .git`) must stop advancing every second, no row may appear or
      disappear on its own, and the gitignored section must keep its members.
      Then `touch` a file in the root and commit it from a terminal tab: the
      tree still re-lists on the touch and its git letters still update after
      the commit (mutating git commands still take their locks and still fire
      the watch).
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work
    - [ ] 🖐️ Manual test (stale result) — click ↻ at the root and immediately
      enter a subfolder: the subfolder's rows and crumb stay; the root's rows
      never flash back in.
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

222. **The top bar's status readouts collapse into one lamp; every global
    button moved right of the project strip.** ✅ Done 2026-08-31,
    code-complete and **live-unverified** (the settings field is a backend
    change, so the toggle needs a restart; the header itself hot-reloads).
    Reported as the main top frame being too crowded. It was: ~22 slots in a
    40 px row, of which exactly one — the project pill strip — is elastic, so
    every fixed control was taken out of the app's primary navigation all day.
    Six of them (connection, battery, Mobile, OpenVPN, Machines, CPU/RAM/GPU)
    were roughly a third of the bar's width saying "still fine" six times over.

    Frontend: new `stores/headerStatus.ts` (each widget self-reports a tone +
    one tooltip line, so the cluster re-derives nothing) and
    `header/StatusCluster.tsx`, which folds the six behind a summary lamp and a
    `‹`/`›` toggle persisted as `header_status_expanded` (default collapsed).
    Folding is `display: none`, never unmounting — a folded widget has to keep
    polling to be able to **escalate** itself: a member reporting
    `attention`/`alert` renders in the bar regardless of the fold, and the
    escalating set is deliberately narrow (offline · battery ≤ 15 % on its own
    power · Mobile error · VPN mid-connect · a machine in the error bucket) so
    nothing pops in and out during ordinary work. Members keep a fixed DOM
    order, so escalating never re-orders the survivors, and the fold is skipped
    entirely when fewer than two members would fold. `HeaderBar` now holds the
    project strip alone in the centre; ✉ 🗓 ☑ (kept as their own buttons — each
    carries a live badge a launcher menu would hide), then 🧠 ▦ ⚙, then the
    cluster, sit right of it in three gap-separated groups.
    Backend: `Settings.header_status_expanded`.

    - [ ] 🖐️ Manual test — with Machines/VPN/Mobile enabled, look at the bar:
      the right side is ✉ 🗓 ☑ · 🧠 ▦ ⚙ · one lamp + `‹` · window controls, and
      the project pills have visibly more room. Hovering the lamp lists every
      folded member's state. Click `‹`: all six come back inline and each one's
      own hover menu still opens flush with the bar's bottom edge. Click `›`
      and relaunch — it is still collapsed.
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work
    - [ ] 🖐️ Manual test (escalation) — while collapsed, pull the network cable
      (or disconnect WiFi): the connection icon appears in the bar on its own
      and the summary lamp turns red. Reconnect: it folds away again. Same with
      a VPN connect (amber while connecting, folds once green) and a global
      machine that fails to connect (stays out until it is fixed or removed).
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work
    - [ ] 🖐️ Manual test (no pointless fold) — on a desktop with no battery, no
      VPN, no machines and the resource rows switched off, the toggle must not
      render at all rather than hiding a single lamp behind a chevron.
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work
