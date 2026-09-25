# Models & agents overlay: plan

The header's processor-chip button (`layout/LocalModelMenu.tsx`) gets a click that opens a movable
overlay, **"Models & agents"**. The overlay covers everything the hover dropdown does, plus Manage CLIs
and Ollama install/catalog. It never sends the user to Settings. The hover dropdown stays as it is.
Settings keeps its own Agents/Ollama pages, unchanged.

## Rules for the implementer (AGENTS.md + session rules)
- **Never start or stop Eldrun.** `src/` hot-reloads. Report the gates, and give the user click-through steps (end of file).
- **No `git stash`, commit, reset or checkout.** Other sessions have uncommitted edits in this tree, including
  `i18n.ts`, `i18nDicts/*`, `untested.ts`, `docs/filemap_frontend.md`, `mail-todo.css`, `settings-chrome.css`
  and `projects-tabs.css`. Edit those files by **surgical insertion** only (Edit tool, unique anchors), and never rewrite them.
- All strings go through `useT()`. English (`i18n.ts`) holds every key. Add de/es/fr/it too.
- New surfaces carry an `UntestedTag` and a row in `untested.ts`. **Never delete or stamp an existing row by hand.**
- Portaled dialogs set an explicit `color`. Never animate a blurred `box-shadow`. Gate work in hidden panes (`PaneVisibleContext`).
- Install flows keep the existing one-click `runInstallInTab` path.

## 1. Shell
- **Store** `src/stores/modelsOverlay.ts`:
  ```ts
  export type ModelsOverlayTab = "agents" | "models" | "ollama" | "skills";
  interface ModelsOverlayState {
    open: boolean;
    tab: ModelsOverlayTab;                       // initial: last tab from localStorage, else "agents"
    openOverlay: (tab?: ModelsOverlayTab) => void; // no arg → keep current/last tab
    setTab: (tab: ModelsOverlayTab) => void;       // persists "eldrun.modelsOverlayTab" (try/catch)
    close: () => void;
  }
  ```
  The store holds no data copies.
- **Host** `src/components/models/ModelsOverlay.tsx` exports `ModelsOverlayHost` and copies `skills/SkillsOverlay.tsx` line for line:
  - backdrop `modal-backdrop root-overlay-backdrop app-overlay-backdrop models-overlay-backdrop`;
  - frame `root-overlay subwindow focused models-overlay {frameClass}` with `useFloatingFrame("eldrun.modelsOverlayFrame")`, `role="dialog" aria-modal`, `aria-label={t("modelsOverlay.title")}`;
  - bar with the mark (`ModelsGlyph` + `app-overlay-label` "Models & agents" + `UntestedTag`), a `tab-strip` `role="tablist"` of 4 fixed tabs, and `fillButton` + ×;
  - body `subwindow-body models-overlay-body`.
- **Tabs** copy mail's `role="tab"` divs: activate on mousedown button 0 and on Enter/Space, with ←/→ roving `tabIndex`. They set `aria-selected`, and each pane is `role="tabpanel" aria-labelledby`.
- **Mounting.** A pane mounts the first time its tab is visited. After that it stays mounted with the `hidden` attribute, because install logs are component state (`agent-install-progress`, `ollama-install-progress`, `vibe-install-progress`). The visited set resets on close, and the host returns `null` when `!open`. The real hidden-pane gates are the hub's `active` (§3) and `SkillsLibraryView`'s existing `visible` prop (pass `visible={tab === "skills"}`). Wrapping panes in `PaneVisibleContext.Provider` (`components/embed/fileAccess.ts`) is optional, since nothing in these panes reads it today.
- **Pane box.** Each pane is `<div role="tabpanel" className="models-overlay-pane" hidden={…}>`. The panels return a fragment (`SettingsHeader` + `div.dialog-scroll`), so the pane must be the flex column that lets `.dialog-scroll` scroll: `.models-overlay-pane:not([hidden]) { display:flex; flex-direction:column; min-height:0; background: var(--bg-panel); color: var(--text-primary) }`. Use `:not([hidden])`, because an author `display` beats the `hidden` attribute.
- **Close.** Escape uses a bubble-phase `window` keydown handler and closes only when `!e.defaultPrevented`, as the siblings do. A backdrop mousedown closes only when `target === currentTarget`.
- **Focus.** On open, focus the active tab. Focus return belongs to **LocalModelMenu**, which holds the button: on the overlay's open→closed edge, if `document.activeElement` is `body`/null, set a `skipRevealRef` and then `btn.focus()`. `onFocus` runs `reveal()` unless that ref is set (and clears it). Without the ref, the new `onFocus={reveal}` (§4) pops the dropdown open on every Escape.
- **Mount** in `layout/AppShell.tsx` (`<SkillsOverlayHost />` is at ~1402), non-lazy, **directly after `<SkillsOverlayHost />`**. Step 4 then deletes that line. It sits after `LazyTodoOverlayHost` and **before `<RootOverlayHost />`**, so a "Run in terminal" install opens the root console on top. No `createPortal`. Not in `DetachedApp`. `HeaderBar` (and so the button) only exists in AppShell.
- **Glyph.** Move the inline chip SVG from LocalModelMenu to `header/HeaderGlyphs.tsx` as `ModelsGlyph`, used by both the button and the mark. Keep it as **its own `<svg viewBox="0 0 24 24">` with stroke 1.4**, not the file's `Glyph` helper (16-unit, stroke 0.95), so the button stays pixel-identical (`svg.local-model-icon` sizes it to 19px, mail-todo.css ~103).

## 2. Tabs
| id | label key | content |
|---|---|---|
| `agents` | `modelsOverlay.tab.agents` "Agents & CLIs" | `<AgentsPanel installedExtras={(a) => <AgentChips agent={a} wiredClis={wired} />} />` |
| `models` | `modelsOverlay.tab.models` "Local models" | `<LocalModelsSection hub layout="overlay" />`, then `MachineMeters` (the dropdown's order) |
| `ollama` | `modelsOverlay.tab.ollama` "Ollama" | `<OllamaPanel />` (install, storage path, pulls, load-on-start, registry, Vibe) |
| `skills` | `modelsOverlay.tab.skills` "Skills" | `<SkillsLibraryView projectDir={null} visible={tab === "skills"} />` (what SkillsOverlay renders today) |

- Each tab opens with a one-line intro (`modelsOverlay.intro.<id>`). The `models` intro says "use and assign"; the `ollama` intro says "download, store, delete".
- **Agents tab: `wired`.** The tab reads `root_mcp_status().wired_clis` when it becomes visible, and again on `AGENT_REGISTRY_CHANGED_EVENT` (`lib/agents/agentRegistry.ts`), because installing or removing a CLI can change which ones are wired. Before that read, `wired` is `null` and the MCP chip renders as today's "not wired".
- **Door changes inside the overlay:** "Manage local models…" / "Install Ollama…" and the autostart-skipped "Settings" chip (all `openInstall` today) call `onManageModels` = `setTab("ollama")`.
- **Models tab box:** `<div className="dialog-scroll models-overlay-models">` with `.models-overlay-models { gap: 1px }`. The rows expect `.tab-new-menu`'s column/1px gap, not `.dialog-scroll`'s 12px.

## 3. Extraction from LocalModelMenu (behaviour-neutral)
- **`src/stores/agents/ollamaActivity.ts`** (zustand) holds the session facts that must outlive either surface:
  ```ts
  installed: boolean;                // written by LocalModelMenu's poll; the overlay reads it
  models: LocalModelInfo[]; modelsLoading: boolean; modelsError: "not_running" | "failed" | null;
  fetchModels(): Promise<void>;      // today's fetchModels (incl. autoload noteResident); hub maps error → t()
  downloads: Record<string, { pct: number | null }>; paused: string[];   // array, not Set (zustand equality)
  loads: Record<string, "loading" | "error">;
  updates: Record<string, OllamaModelUpdate>; checkingUpdates: boolean;
  version: OllamaVersionStatus | null;  // its `latest` comes from the same check that sets checkResult
  checkResult: { ok: true; updates: number } | { ok: false; reason: string } | null;
  setUpdates / setCheckResult / setVersion / markLoad / clearPaused(model) / ...
  export function initLocalModelEvents(): () => void; // ref-counted: 1st call registers the two listen()s,
                                                      // disposer at count 0 awaits + calls both unlistens
  export function __resetOllamaActivityForTests(): void;
  ```
  The two listeners are moved verbatim from LocalModelMenu (~453 `ollama-pull-progress`, ~484 `ollama-load-progress`). The pull listener sets `paused` on status `"paused"`. On `"success"`, the load listener calls the store's `fetchModels()`, as it does today. LocalModelMenu calls `useEffect(() => initLocalModelEvents(), [])`. OllamaPanel keeps its own private listeners in v1.
  **Why `models` is shared.** The auto-apply effect below reads `models`. If each hub instance kept its own list, an unload or load done in the overlay would never reach the dropdown's copy. The "one model left → assign all roles" behaviour would then silently stop working from the overlay. `version` and `checkingUpdates` go with `checkResult`, because they are the same click (the `reveal` version merge, ~601, becomes the hub's per-activation read into the store).
- **Stays in LocalModelMenu only:**
  - the button, the hover frame and `reveal` / `scheduleClose`;
  - the `installed` poll (it writes `installed` to the store);
  - `useOllamaStatus`, the autostart "!" flag, and the **sole-resident → assign-all-roles effect (~880)**, which has one owner by structure. It reads `models` from the store.
- **`src/components/models/useModelsHub.ts`**: `useModelsHub(active: boolean)` gets everything else from the component body:
  - state: agents, wiredClis, error (load/unload failures), unloading, gpuStatus, gpus, machine;
  - actions: fetchAgents, select, toggleRole, root/MCP toggles, load/unload, pause/resume/delete pull, checkUpdates, updateModel, upgrade.
  `select` and `upgradeOllama` close the hover menu via `useHeaderHoverMenuStore.getState().close("local-model")`. That is a no-op from the overlay, which stays open.
  The once-per-activation reads, and the 2 s GPU/machine poll (keep `saverInterval` / `useQuiesce`), key off `active`, where they used to key off `open`. `status` for the "server stopped" hint (~1511) comes from `useOllamaStatus`, which is a shared poll, so a second subscriber costs nothing.
  - Callers: the dropdown passes `menuOpen`; the overlay's models tab passes `open && tab === "models"`.
- **`src/components/models/ModelsHubSections.tsx`** takes these components out of LocalModelMenu verbatim:
  - `AgentChips({ agent, wiredClis })`, which reads `useSettingsStore` itself: Default · + tab · Root · MCP;
  - `LocalModelsSection({ hub, layout: "menu" | "overlay", onManageModels })`: updates/version, notices, downloads, Running (roles, Root, MCP, autostart, unload), the iGPU notice next to Running, and On disk;
  - `MachineMeters({ hub })`;
  - the helpers that go with them: `StatMeter`, `CaveatChip`, `CapabilityChips`, `UpdateAction`, `MODEL_ROLES`.
  The dropdown keeps its markup (`tab-new-menu local-model-menu` → title → note → sections), so it stays pixel-identical.

## 4. Button and dropdown (LocalModelMenu)
- Add `onClick`, copied from `MailIndicator.tsx:286`: close the hover menu, clear its timer, then `open ? close() : openOverlay()`.
- Add `aria-pressed={overlayOpen}`. Keep `aria-haspopup="menu"`. Make `aria-expanded={menuOpen && !overlayOpen}`.
- Add `onFocus`, which calls `reveal` unless `skipRevealRef` is set (see §1 Focus).
- In `reveal`, return early while the overlay is open, so it has a single consumer (keyboard focus can still reach the button).
- Door retargets. LocalModelMenu must end up with **zero** `eldrun:open-settings` dispatches (today ~763, ~772):
  - "Manage CLIs…" → `openOverlay("agents")`;
  - "Skills library…" → `openOverlay("skills")`;
  - "Manage local models…" / "Install Ollama…" / the autostart-skipped "Settings" chip → `openOverlay("ollama")`.
  Every door also closes the hover menu.

## 5. Settings panels (`layout/SettingsSubPanels.tsx`)
- `SubPanelProps.onBack` becomes optional. `SettingsHeader` (`settingsUi.tsx`) already omits Back when it is undefined.
  Settings' call sites stay as they are.
- `AgentsPanel` gets an optional `installedExtras?: (a: AgentInfo) => ReactNode`, rendered at the end of each **installed** card only.
  Settings doesn't pass it, so nothing changes there.
- CSS hides the duplicate title: `.models-overlay .settings-title-row { display: none }`. This covers both of OllamaPanel's header branches.

## 6. CSS (widen existing selectors; no new treatment)
- `mail-todo.css` ~462/487/500: add `.models-overlay` / `.models-overlay-body` / `.models-overlay-body > *` to the shared size and body lists.
- `apps.css:913`: `.settings-dialog .dialog-scroll` → `:is(.settings-dialog, .models-overlay-body) .dialog-scroll`.
- Add `.models-overlay-body .dialog-scroll { padding-inline: max(18px, calc((100% - 880px) / 2)); }`, an 880px reading column so the cards (designed for 560–740px) don't stretch. It uses padding rather than `max-width`, so the scrollbar stays at the pane edge and the wheel works over the margins.
- `header-menus.css:476` and `:514` (section band, `.is-sub`): `.local-model-menu` → `:is(.local-model-menu, .models-overlay-body)`.
  Menu-only rules (`max-height`, pinned title) stay as they are.
- Move `.skills-overlay .skills-title` (mail-todo.css ~513) to `.models-overlay .skills-title`.
- Check the `.settings-dialog` theme overrides (`themes.css` ~711/798) for anything the embedded panels rely on.

## 7. i18n (insert near `localModel.*`; en + de/es/fr/it)
`modelsOverlay.title` "Models & agents" · `modelsOverlay.tab.agents` "Agents & CLIs" ·
`modelsOverlay.tab.models` "Local models" · `modelsOverlay.tab.ollama` "Ollama" · `modelsOverlay.tab.skills` "Skills" ·
`modelsOverlay.intro.{agents,models,ollama,skills}`. For the × button, reuse `common.close`.
After retirement, `skillsLibrary.overlayTitle` / `overlayTab` are unused. Remove them from all 5 dicts **only** if no other reference remains (rg first).

## 8. UntestedTag rows (`untested.ts`, insertion only)
- `"modelsOverlay.title": { area: "layout", what: "ModelsOverlay · Models & agents" }` (pill on the mark).
- New rows `"localModel.manageAgents"` / `"localModel.manageLocalModels"` (neither exists today): the retargeted doors, pills in the dropdown.
- Leave `localModel.skillsLibrary` as is. **Keep `skillsLibrary.overlayTitle` live**: put `<UntestedTag id="skillsLibrary.overlayTitle" />` on the Skills tab's label. `untested.mjs check` (run by `UntestedRegistry.test.ts`) fails on a row that no pill uses, so deleting SkillsOverlay's pill without a new site turns `npm test` red. You may reword the row's `what`; never stamp or delete it.

## 9. Retire SkillsOverlay (last, separate step)
Its only callers are `LocalModelMenu.tsx:784` and the `AppShell.tsx:1402` mount. It has no tests.
- Delete `components/skills/SkillsOverlay.tsx` and `stores/skills.ts`.
- The stale `eldrun.skillsOverlayFrame` localStorage key is harmless; leave it.
- Help and doc wording, found with `rg -n`, reading only the matched ranges:
  - `docs/help/agent-clis.md` ~14 (Manage CLIs now opens the overlay's tab from the header), ~108;
  - `docs/help/tabs-and-panels.md` ~83; `docs/help/local-models.md` ~13 (Install Ollama… now opens the overlay);
  - `DOCUMENTATION.md` ~179 (`SkillsOverlay` in the overlay family) and ~449 (`stores/skills.ts` in the feature table).

## 10. Order and tests (vitest)
1. **Characterization first.** Write `src/__tests__/agents/LocalModelMenu.test.tsx` (mock `invoke`/`listen`) and confirm it passes **before** any move:
   - hover opens the menu and renders agents and models;
   - a pull-progress event shows a download row; a `"paused"` event shows Resume/Delete;
   - a load-success event refetches;
   - the sole-resident auto-apply writes `ollama_roles` once;
   - Manage CLIs / Manage local models dispatch today's settings events (step 3 updates these assertions).
2. **Pure extraction** (§3). The tests from step 1 stay green; run `npm run build`.
   Add `src/__tests__/agents/OllamaActivity.test.ts`: `initLocalModelEvents()` called twice registers once; unlisten happens only at the last disposer; the reset hook clears state.
3. **Overlay** (§1, 2, 4–8). Add `src/__tests__/agents/ModelsOverlay.test.tsx`, stubbing `AgentsPanel` / `OllamaPanel` / `SkillsLibraryView`:
   - closed → renders nothing; the dialog is labelled;
   - tabs switch, and a visited pane stays mounted and `hidden`;
   - Escape closes, except when `defaultPrevented`; backdrop mousedown closes, inner mousedown doesn't;
   - `openOverlay("ollama")` deep-links;
   - a pull started before open shows in the models tab;
   - the agents tab rereads `root_mcp_status` on the registry-changed event.
   Update the LocalModelMenu tests: a click toggles `open` and closes the menu; every door calls `openOverlay(<tab>)` and a `dispatchEvent` spy sees **no** `eldrun:open-settings`; hover while open doesn't reveal the menu; Escape returns focus to the button **without** opening the dropdown; an unload in the overlay that leaves one resident model runs the auto-apply (it reads the shared `models`).
4. **Retire SkillsOverlay** (§9). The gates stay green.

**Gates**, all at zero warnings. The build is the only type check (`SubPanelProps` changes):
`npm run build 2>&1 | tail -40` · `npm test -- --reporter=dot` · `npm run lint` · `cargo test -q --manifest-path src-tauri/Cargo.toml` ·
`cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` · `git diff --check`.
This is a frontend-only change. If a cargo gate fails, check whether other sessions' dirty backend edits caused it before blaming this change.

## 11. File-map rows (`docs/filemap_frontend.md`, one line each, inserted)
- New: `models/ModelsOverlay.tsx`, `models/useModelsHub.ts`, `models/ModelsHubSections.tsx`, `stores/modelsOverlay.ts`, `stores/agents/ollamaActivity.ts`.
- `layout/LocalModelMenu.tsx`: add a row (none exists) covering the button, hover menu, click → overlay, auto-apply owner and event init.
- Update the Skills row (~127, overlay gone → a tab of ModelsOverlay) and the stores `skills.ts` row (~243, removed).
- `header/HeaderGlyphs.tsx`: add `ModelsGlyph`.

## 12. Live check (for the user; not run by the implementer)
- Click the chip button: the overlay opens on Agents. Click the button's spot again: the backdrop covers the header, so that click closes the overlay and does not reopen it. Hover while it is open: no dropdown. Escape: focus is back on the button and no dropdown appears.
- Start a pull from the dropdown, then open the overlay's Local models tab: the progress bar is already there.
- Agents tab: install a CLI. The root console opens above the overlay; after the install, the new card has chips and the MCP chip is correct.
- Every door in the dropdown lands on its tab. Settings → Agents / Ollama look unchanged.

## Dissent (Designer A)
None on substance; the tie-breaks match the evidence. One note: `onBack`-optional plus a CSS title hide keeps a hidden
`dialog-close-btn` in the DOM. That is harmless because `display: none` removes it from the tab order and the accessibility tree.
If a test queries "Close" by role, it will find only the overlay's ×. That is intended.

## Sign-off (Designer B)
Signed off. I checked the plan against the code on 2026-09-25 and corrected these facts in place:
- **Shared `models`, `installed`, `version`, `checkingUpdates` (§3).** The auto-apply effect (~880) reads `models`. With per-hub lists and `residentEpoch`, an unload in the overlay would never reach the dropdown's copy, so auto-assign would silently stop. `select`/`upgrade` close the hover menu through its store.
- **Pane box (§1).** `.dialog-scroll` only scrolls inside a flex column, and the overflow-hidden body gave it none. Add the `.models-overlay-pane:not([hidden])` rule, and a models-tab box with a 1px gap. The only real gates are `visible`/`active`, since nothing reads `PaneVisibleContext` in these panes.
- **Focus return vs `onFocus={reveal}` (§1/§4).** Without the ref, Escape reopens the dropdown.
- **Untested (§8).** An orphaned `skillsLibrary.overlayTitle` row fails `UntestedRegistry.test.ts`, so the pill moves to the Skills tab.
- **Line refs (§9/§11).** Filemap rows are 127/243, not 125/240. Added `local-models.md` and `DOCUMENTATION.md` ~179/449. The glyph keeps its 24-unit drawing. The mount comes after SkillsOverlayHost until step 4.
- **880px column (§6).** Now `padding-inline`, not `max-width`: same column, but the scrollbar stays at the pane edge.

Remaining dissent: none. For the implementation review, I'll check that `models` is not cached per hub, that `hidden` panes really hide, and that the untested gate is green.


## As built (deviations from the spec above; the code is the reference)
- **Refresh.** The hub has `refresh()` (agents + models + version, the dropdown's every reveal) and
  `refreshModels()` (models + version only, what the Local models tab calls when it becomes visible or
  `installed` flips). A mouse click that focuses the button does not refresh a second time.
- **Local models tab order.** The "Local Models" band renders in both layouts, so the tab reads: band,
  door + update check, Running / On disk sub-bands, then Machine. `layout` only decides the door's pill.
- **Doors.** The autostart-skipped chip is labelled "Ollama…". Inside the overlay it and "Manage local
  models…" switch to the Ollama tab. The embedded panels get no `onClose` (their × is hidden with the
  title row; the bar has its own).
- **Tabs.** Manual activation: ←/→/Home/End move focus, Enter/Space or a press activate.
  `aria-controls` is set only on tabs whose pane is rendered.
- **Escape.** The overlay stands down while the root console is open, and for a key aimed at a node
  outside its frame (other than `<body>`). A keyboard-opened dropdown closes on Escape (capture phase)
  or when focus leaves it, unless the pointer is over it.
- **Button.** Its accessible name is `modelsOverlay.title` ("Models & agents"); `localModel.ariaLabel`
  was removed. The pointer flag is cleared when the overlay opens.
- **Store.** Pull progress hands back the same state while the whole percent is unchanged.
- **CSS.** The pane surface is `--bg-elevated`. The 880px column is one rule (apps.css,
  `.models-overlay-body :is(.dialog-scroll, .models-overlay-intro)`); the intro sits outside the pane's
  `.dialog-scroll`, and the Skills intro uses a 10px inset. Band selectors are
  `:is(.local-model-menu, .models-overlay-models)`, including the first band's zero top margin. The
  title hide is `.models-overlay-pane > .settings-title-row` / `.models-overlay-pane .skills-title`.
