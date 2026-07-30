# In-app web browser in Eldrun — Plan A (surface, integration & UX)

TODO Group J #61 (`todo/group-j-mail.md`). Scope: **where the browser lives in Eldrun
and how it behaves as part of the app.** Security architecture (profile
isolation, navigation policy, what the security indicator *means*, cookie/JS
policy, favicon fetch policy) is Plan B (`docs/browser_plan_b.md`); webview/engine
feasibility and the native-view command surface is Plan C
(`docs/browser_plan_c.md`). Where this plan needs either, it states a **named
contract** rather than a guess.

Structural template: `docs/mail_client_plan_a.md`, and the implementation that
shipped from it (commit `9faa43a`). Where a decision below matches mail's, the
mail file/line is cited so the browser lands as the *same* kind of feature rather
than a second dialect.

---

## 0. Constraints (restated, binding)

- **Never launch Eldrun to verify.** A second instance corrupts workspace state.
  The only gates an agent has are `npx tsc --noEmit` and
  `cargo test --manifest-path src-tauri/Cargo.toml`. Everything else is a request
  to the user. Frontend (`src/`) edits hot-reload; `src-tauri/` edits need a
  user-initiated rebuild.
- Every new/unverified surface carries `<UntestedTag />`
  (`src/components/common/UntestedTag.tsx`); inside a `.context-menu` button also
  pass `untested: true` on the menu entry (the shape `NewTabMenu.tsx:333` uses for
  mail).
- Canonical menu/dialog scheme: `.context-menu`/`.tab-new-menu` popover (accent
  top rail + accent wash), `.modal-backdrop > .settings-dialog` with an accent
  `.settings-title-row` + divider. **A portaled dialog must set an explicit
  `color`** — `body` carries none, so inherited color renders black
  (`src/components/calendar/EventDialog.tsx` is the reference; `MailAccountDialog.tsx:220-224`
  is the recent copy).
- Repo is public. No institution/lab hostnames, no personal data. Example URLs in
  code, tests, docs and placeholder text are `example.com` or well-known public
  sites only. `scripts/privacy-check.sh` before every push.
- Every user-facing string goes through `src/lib/i18n.ts` in all five languages
  (en is the source of truth; the rest fall back).
- **WebKit paint rule** (`project_webkit_paint_perf`): never animate a *blurred*
  box-shadow. The loading bar is a width/opacity transition on a flat element.
- **HTML5 DnD is broken under WebKitGTK** (`project_tab_drag_pointer`). Everything
  drag-shaped in this plan is pointer-based and inherits `TabBar`'s existing
  gesture; the browser adds no new drag mechanism.

---

## 1. Where it lives — **a center tab** (`TabKind: "browser"`), one page per tab

### 1.1 The decision

**A center tab, `kind: "browser"`, non-singleton (`addTab`, not `ensureTab`), one
web page per Eldrun tab, no tab strip inside the tab.**

Rejected alternatives, with reasons:

- **Right-panel view (like Git/Files).** The right panel is a narrow overlay
  hosting *project-scoped tools* over the active project (`RightPanel.tsx` is a
  thin host around `ProjectFilesView`). A web page in a ~360 px sliding column is
  not a browser, it is a preview. Worse, the panel is a single instance bound to
  the active project — two pages open at once is impossible, and the browser's
  most obvious use (docs beside an agent) is exactly a *side-by-side split*,
  which the center panel already does and the right panel structurally cannot.
- **Global-app surface (`GlobalAppBar`).** That bar's `browser` role
  (`GlobalAppBar.tsx:19`) already means "launch the user's *external* browser".
  Reusing it for an in-app browser would overload one control with two
  incompatible meanings, and a global-app button has no pane to render into. The
  in-app browser is the *counterpart* of that role, not a replacement — §7 keeps
  both and gives the user a rule for which fires.
- **A second tab strip inside one browser tab (Chrome-style).** Eldrun *is* a
  tiling tab manager: drag-to-split, cross-window drag-dock, popout, rename,
  hover cards, per-tab persistence. An inner tab strip would be a second, worse
  tab manager whose tabs can't be split, popped out, dragged to another
  subwindow, or persisted — every one of those affordances would silently apply
  only to the outer tab. "Open link in a new tab" therefore `addTab`s a **sibling
  browser tab in the same group**, which lands the link in the strip the user
  already knows.

Closest existing structural analogue is **`diskusage`**, not `calendar`/`mail`:
each tab carries its own independent subject (a scan root there, a URL here), so
it *stacks* rather than focusing an existing one
(`TabBar.tsx:505-513` documents exactly this distinction). Mail/calendar are
singletons because their store is global and a second tab shows the same thing;
two browser tabs never show the same thing.

### 1.2 Exact edit sites (frontend)

The Rust `TabEntry` needs no change: `schema/project.rs` carries
`extra: HashMap<String, Value>` flattened, so `kind` and the new `url` field ride
in `extra` (the same free ride mail took).

| # | File:line | Change |
|---|---|---|
| 1 | `src/stores/tabs.ts:48-59` | Add `\| "browser"` to the `TabKind` union. |
| 2 | `src/stores/tabs.ts:184` (after `MAIL_TAB_CMD`) | `export const BROWSER_TAB_CMD = "__eldrun_browser__";` with a doc comment in the same shape: carries no PTY, is not a singleton, is never locatable (§5.2), and a restored one does not navigate on its own (§2). |
| 3 | `src/stores/tabs.ts:296+` `TabEntry` | Add `url?: string` — the tab's **committed** address (the last top-level URL that actually loaded), the analogue of `folder?` on a `projectfiles` tab. Never the in-flight address-bar text. |
| 4 | `src/stores/tabs.ts:505-540` `SavedTabEntry` | Add the same `url?: string`, with the comment that only this one field persists — no history, no scroll, no form state (§2). |
| 5 | `src/stores/tabs.ts:3717-3727` `cmdToKind` | `if (cmd === BROWSER_TAB_CMD) return "browser";` — recovers the kind from a bare persisted `cmd`. |
| 6 | `src/stores/tabs.ts:3743-3762` `isRestorableKind` | Add `kind === "browser"`, with the diskusage-style comment: *the tab comes back, on its resume card; it never re-navigates by itself* (§2). |
| 7 | `src/stores/tabs.ts:3764-3767` `isPtyTabKind` | **No change.** A browser tab must never enter spawn/kill/activity paths. |
| 8 | `src/stores/tabs.ts` `isLocatableKind` | **No change** — `browser` is deliberately absent, so the run-host preference and the tmux persistence helpers can never claim it (§5.2). |
| 9 | `src/stores/tabs.ts` `loadFromLayout` / `writeScope` | Thread `url` through the saved↔live conversion exactly as `folder` is threaded. |
| 10 | `src/components/tabs/TabPane.tsx:88+` | `case "browser": return <BrowserPane tab={tab} scope={scope} visible={visible} groupId={groupId} ownsTabs={ownsTabs} />;` beside the `mail` case (`:93`). **This one switch serves the main window and every popout** — do not add a second. |
| 11 | `src/components/tabs/newTabItems.ts:85-97` `TAB_ACCENT` | `Record<TabKind, string>` → tsc fails until `browser: "var(--accent-secondary)"` is added. |
| 12 | `src/components/tabs/TabHoverCard.tsx:23-36` `KIND_LABEL_KEY` | Also compile-enforced: `browser: "newTabMenu.browser"`. |
| 13 | `src/components/tabs/TabBar.tsx` (after `handleAddMail`, `:530-538`) | `handleAddBrowser()`: `focusGroup(groupId)` then **`addTab`** (not `ensureTab`) with `{ label: t("newTabMenu.browser"), cmd: BROWSER_TAB_CMD, cwd: projectCwd, kind: "browser", url: settings?.browser_home_url || undefined }`. |
| 14 | `src/components/tabs/TabBar.tsx:1420-1430` | New menu group beside the Mail group, gated on `useExperimental("web_browser")`, `dot: "🌐"` (matching `GLOBAL_APP_ROLES`' browser glyph), `color: TAB_ACCENT.browser`, `untested: true`. |
| 15 | `src/components/tabs/NewTabMenu.tsx:322-341` | The **detached** window's add menu — the same entry via `pickFixed({...})`. Missing this is the classic "works in the main window, dead in a popout" bug. |
| 16 | `src/lib/i18n.ts` | `newTabMenu.browser`, `tabKind.browser`, the `browser.*` block and the `settings.browser*` block, ×5 languages (§9). |
| 17 | `src/styles/themes.css` | A `.browser-*` block (toolbar, address field, security chip, progress bar, resume/suspend cards, download strip), built from `--text-primary` / `--bg-panel` / `--accent`. |
| 18 | `src/__tests__/TabPersistFilter.test.ts` | Lock `isRestorableKind("browser") === true` and that a saved browser tab round-trips its `url`. Given only `tsc` + `vitest` + `cargo test` run, this is the only automated proof the tab survives a restart. |

New components, all under `src/components/browser/`:

| File | Purpose |
|------|---------|
| `BrowserPane.tsx` | The tab's pane: toolbar + content region + the native-view lifecycle (attach/bounds/visibility/suspend). The only component that talks to `lib/browser.ts`'s view verbs. |
| `BrowserToolbar.tsx` | Back / forward / reload-or-stop / address field / security chip / zoom / find toggle / overflow menu. Pure presentation over callbacks. |
| `BrowserAddressBar.tsx` | The address field: edit-vs-display state, origin emphasis, commit semantics (§4.2). |
| `BrowserSecurityPopover.tsx` | The chip's popover, canonical `.context-menu` chrome. Renders whatever `BrowserSecurity` (Plan B) reports; owns no policy. |
| `BrowserFindBar.tsx` | Find-in-page, modeled on `PdfViewer.tsx`'s find bar (`findOpen` state at `:905`, Escape closes at `:1259`). |
| `BrowserDownloadStrip.tsx` | The per-tab download confirmation strip (§6). |
| `BrowserStartPage.tsx` | The blank-tab start page + the **resume card** a restored/suspended tab shows. |

New stores/lib:

| File | Purpose |
|------|---------|
| `src/stores/browserViews.ts` | The **suppression refcount** (§3.3) and the live-view LRU (§3.4). Deliberately *not* in `stores/tabs.ts` — it is per-window runtime state with no persistence, and each window is its own JS heap. |
| `src/lib/browser.ts` | **The** typed invoke surface — one wrapper per `browser_*` command, plus the `onBrowser*` event helpers. No component calls `invoke("browser_*")` directly. Exactly the convention `src/lib/mail.ts` follows. |
| `src/lib/linkTarget.ts` | The pure in-app-vs-external routing rule (§7), unit-tested. |
| `src/types/browser.ts` | The frozen TS contract (§10). |

### 1.3 Drag / split / popout behaviour

A browser tab is an ordinary tab: it drags with the existing pointer-based
gesture (`TabBar.tsx` + `tabs/commitDrop.ts` + `tabs/dragGeometry.ts`), splits a
subwindow, merges into another group, and detaches into a popout. **No new drag
code.** Two consequences the pane must honour, both because a native child
webview paints above all DOM regardless of z-index:

1. **During any drag, every native view hides.** The split preview, the drag
   ghost and the focused-subwindow marker are DOM overlays drawn *above* the pane
   layer (`CenterPanel.tsx:1126-1135`); a native view would cover them. The drag
   store (`stores/drag.ts`) increments the suppression refcount (§3.3).
2. **A file dragged from `FileTree` onto a browser tab bar** behaves as it does
   today (embed/split/popout of the *file*, via `commitFileDrop`). Dropping a
   file *onto the page* to fill an upload field is #53 — see §8.

---

## 2. Tab persistence / restore — **restores, URL only, does not navigate**

`isRestorableKind("browser") === true`. Persisted state is exactly one field:
`SavedTabEntry.url`, the last **committed** top-level URL.

Explicitly **not** persisted: history stack, scroll position, form state,
zoom, find query, per-tab cookies (the profile is machine-global and Plan B's).
Rationale: each of those is either engine-owned (and so Plan C's), or an
attacker-influenced blob written into `project.json`, which is a control file the
sandbox audit already flagged for living inside the project tree (`todo/group-o-security.md`,
sandbox-audit follow-ups). A URL string is inert, human-readable and reviewable
in a diff; a serialized session blob is none of those.

**A restored browser tab does not navigate at launch.** It comes back showing
`BrowserStartPage`'s *resume card*: the persisted URL rendered as text with its
host emphasised, and a **Load** button. Three reasons, each already precedent in
this repo:

- The diskusage precedent, quoted from `tabs.ts:3752-3754`: *"The tab comes back,
  but on its home screen — a scan is far too expensive to replay on every launch,
  so the pane never auto-rescans."*
- The mail rule (`MAIL_TAB_CMD`'s note, `tabs.ts:174-183`): *"nothing about a
  window being reopened is consent to dial out."* Restoring six browser tabs is
  six automatic outbound requests carrying whatever the profile's cookies are, to
  whatever the user last had open, before they have looked at the screen.
- Launch cost: N native webviews spun up and navigating at startup is the worst
  possible moment for it.

Escape hatch: setting `browser_restore_navigate` (default **false**). When on, a
restored tab navigates on first mount. Documented in the settings help as "loads
your open pages at startup".

Reconciliation with the existing policy in `tabs.ts`: the always-restore set
(`shell`/`files`/`projectfiles`/`network`/`monitor`/`diskusage`/`calendar`/`mail`)
grows by one. `RESUMABLE_AGENTS` / `isResumableAgentTab` are untouched — they are
about *agent conversations*, and a browser tab has no session to resume; it is a
kind-level restore like the panes beside it, not a tab-level one like Claude.

---

## 3. Popout / detached windows, and the native-view integration

### 3.1 Popouts are supported, with one hard contract on Plan C

A popout (#42) is a **separate `WebviewWindow`** (`commands/subwindow.rs:156`,
labels `detached-*`, listed in `src-tauri/capabilities/default.json`). It runs
`DetachedApp` — a separate React root in a separate JS heap, inert to the
`projects`/`tabs` stores, driven by a streamed copy of the layout.

For terminals this is solved by `attachOnly`: the popout never spawns a PTY, the
main window owns it. **A browser has no PTY and no equivalent of attaching** — a
native child webview belongs to exactly one OS window. Therefore:

> **Contract A (Plan C).** `browser_view_create` / `browser_view_set_bounds` /
> `browser_view_set_visible` / `browser_view_destroy` must all take a **window
> label** so a pane in `detached-<n>` attaches its view to that window, not to
> `main`. If the engine can only host views on the main window, browser tabs must
> be **refused in popouts**: `TabBar`'s detach affordance drops the tab (or the
> pane renders a "pop this back in to browse" card). Silent breakage is not an
> option, and this is the one capability that decides which.

Whichever way it resolves, `capabilities/default.json`'s `windows` array
(`["main", "detached-*", "present-*"]`) must be extended if the engine mints its
own labels (`"browser-*"`).

### 3.2 What a popout's browser pane may not do

`ownsTabs` is false in a popout (`TabPane.tsx` doc block). Consequences, matching
`DiskUsagePane`/`ProjectFilesTab`:

- **No retitle.** The popout cannot write the tab store, so page-title → tab-title
  (§4.4) is main-window only; a popped-out browser tab keeps the label it left with.
- **No "open link in a new tab".** The context-menu item is hidden (not disabled-
  and-broken); a middle-click / ctrl-click falls back to same-tab navigation. Same
  rule `FileTree`'s "Open in a new tab" follows: *a host with no way to own a tab
  simply doesn't pass the callback, instead of offering an action that goes nowhere.*
- **Download confirmation still works** — it is a backend dialog, not a tab write.

### 3.3 Suppression: when every native view must hide

A native child webview paints above all DOM. `stores/browserViews.ts` holds a
per-window **suppression refcount**; while it is > 0 every view in that window is
hidden and its pane paints a neutral fill with the toolbar still visible. It is
incremented by:

1. Any open modal (`.modal-backdrop` mounted — settings, project dialog, remote
   machines, the local-loss dialog, the alarm popup, the stats recap).
2. An active tab/file/PDF-page drag (`stores/drag.ts`, `stores/pdfDrag.ts`).
3. `.center-panel.moving` (`CenterPanel.tsx:108` already hides the heavy pane
   layer during a window move — a native view is not DOM, so it must be told).
4. The right-panel overlay while it overlaps the pane's rect (`RightPanel` slides
   *over* the center panel).
5. A presenter/fullscreen overlay (`stores/presentation.ts`'s counters).

This store is the single place that knowledge lives, so a new overlay adds one
`suppress()`/`release()` pair rather than a new class of "the page is covering my
dialog" bug.

### 3.4 Live-view cap: the flat pane layer never unmounts

`CenterPanel.tsx:859` renders a **flat pane layer holding every tab of every
scope, never unmounted**, positioned to JS-measured rects and hidden via
`visible`. That is free for a React pane and expensive for a native webview: ten
browser tabs across three projects would be ten live web engines forever.

Decision: **`BrowserPane` keeps the React pane mounted always, but the native
view is LRU-capped.** `stores/browserViews.ts` tracks live view ids in
most-recently-visible order; beyond `browser_max_live_views` (setting, default
**6**) the least-recently-visible view is destroyed and its pane falls back to
the same *resume card* a restored tab shows, holding the URL. Additionally, a
view whose scope is not the active scope is suspended after
`BROWSER_SUSPEND_MS` (60 s) off-screen.

Known cost, stated in the resume card's help text: a suspended tab loses scroll
position and any unsubmitted form. That is the honest trade; the alternative is
unbounded memory, and this is the same bargain the diskusage pane already makes
about not replaying its scan.

> **Contract B (Plan C).** `browser_view_destroy(view_id)` is idempotent and safe
> at any time, and `browser_view_create` can re-create a view for the same tab
> key with a fresh id. `BrowserPane` owns the *when*; the engine owns the *how*.

---

## 4. Chrome / UI

### 4.1 Layout

One toolbar row across the top of the pane (32 px, `--bg-panel`, bottom hairline
divider in the canonical accent-divider style), a 2 px progress bar directly
under it, then the content region. The find bar, when open, is an overlay row
under the toolbar (PdfViewer's arrangement). The download strip (§6) is an
overlay row at the **bottom** of the pane so it never shifts the content rect —
important, because shifting it would re-issue a `browser_view_set_bounds` on
every download.

Toolbar order, left to right:
`◀ back` · `▶ forward` · `⟳ reload` / `✕ stop` · **[ security chip │ address field ]** · `⌕ find` · `− zoom % +` · `⋯ overflow`.

### 4.2 Address bar

- **Display state** (not focused): the committed URL with **origin emphasis** —
  scheme and path muted (`--text-muted`), the registrable host in
  `--text-primary` at full weight. This is an anti-phishing affordance and it
  costs nothing; it is the same instinct `MailList.tsx` follows by always showing
  the addr-spec beside a display name.
- **Edit state** (focused): the full raw URL, selected on focus. `Escape` reverts
  to the committed URL and blurs. `Enter` commits.
- **Commit semantics** (pure, in `src/lib/linkTarget.ts`, unit-tested):
  1. Parses as an absolute `http(s)` URL → navigate to it.
  2. Looks like a bare host (`example.com`, `example.com/x`, `localhost:5173`) →
     prefix `https://`.
  3. Otherwise, if `browser_search_template` is set → substitute `%s` with the
     percent-encoded text and navigate there. Default template
     `https://duckduckgo.com/?q=%s`; the user may clear it.
  4. Otherwise → inline "not a URL" hint in the field; no navigation.
  5. **Non-`http(s)` schemes are never navigated by the address bar.** `file:`,
     `data:`, `javascript:`, `blob:` typed by hand are refused with a reason.
     (`about:blank` is the one internal exception, and it is rendered by
     `BrowserStartPage`, not navigated.)

> **Contract C (Plan B).** `browser_navigate(view_id, url)` enforces the
> navigation policy — allowed schemes, redirect handling, private/loopback
> address rules, and what happens on a policy refusal. The address bar performs
> the *shape* checks above as a first, independent gate; it is not the security
> boundary and must not be treated as one.

### 4.3 Security indicator

Position and rendering are mine; **meaning is Plan B's**. The chip sits inside
the address field's left edge and renders whatever
`BrowserSecurity { level: "secure" | "insecure" | "mixed" | "local" | "error", detail?: string }`
(Plan B's shape) reports, as glyph + tone: `🔒` `--success`, `⚠` `--warning`,
`✕` `--danger`, neutral for `local`. Clicking opens `BrowserSecurityPopover` —
canonical `.context-menu` chrome, portaled, **with an explicit `color`** — listing
the origin, the TLS state string, and the counts of anything Plan B's policy
blocked. The popover renders exactly the fields the backend sent; it computes
nothing. A level the frontend doesn't recognise renders as `error` with the raw
string, never as "secure".

### 4.4 Page title → tab title

On `browser:title { view_id, title }`, main window only (`ownsTabs`):
`renameTab(tab.key, title.trim().slice(0, 60))`.

Guard against clobbering a user's rename, using the rule `fileTabSync` already
uses for renamed files (*refresh the label only when it still equals the old
auto-derived one*): `BrowserPane` holds `autoLabelRef`, seeded at mount from the
tab's current label, and retitles only when `tab.label === autoLabelRef.current`.
A user rename breaks the chain permanently for that tab. A page with no title
falls back to the host.

The title is attacker-controlled text: it is rendered as a plain text node (never
`dangerouslySetInnerHTML`), length-capped, and stripped of control characters —
the same rule `MailList.tsx` enforces for mail-derived strings.

### 4.5 Favicons — **not in v1**

Refused for now, on the same reasoning `MailMessageView` used to refuse remote
content: the app CSP (`tauri.conf.json:29`) is `img-src 'self' data: blob:`, so
showing a favicon means *fetching it in Rust and inlining it as `data:`* — i.e.
building an image proxy. A control that fetches on the user's behalf, per site,
per tab, is a tracking surface and therefore a policy question, not a decoration.
The tab strip shows the `TAB_ACCENT.browser` dot; the toolbar shows the security
chip. Both are honest.

> **Contract D (Plan B).** If favicons are wanted later, Plan B specifies
> `browser_favicon(origin) -> Option<{ mime, bytes_b64 }>`: no cookies, no
> referrer, no redirects off-origin, a hard size cap, and a cache under
> `browser_dir()/favicons/`. It then plugs into `BrowserToolbar` and the tab dot
> at exactly two call sites.

### 4.6 Find-in-page, zoom, overflow menu

- **Find** (`Ctrl+F`): `BrowserFindBar`, modeled beat for beat on
  `PdfViewer.tsx`'s (`findOpen` state, `Escape` closes, `Enter`/`Shift+Enter`
  next/prev, `{current} of {total}` readout). Needs
  `browser_find(view_id, query, forward, match_case) -> { current, total }` and
  `browser_find_stop(view_id)`. **If Plan C reports the engine cannot do
  find-in-page, the button is not rendered at all** — the `GifView`/YAML
  `source only` rule: never offer a control that will lie.
- **Zoom**: `Ctrl` `+`/`−`/`0` and the toolbar's `− 100% +`, via
  `browser_view_set_zoom(view_id, factor)`. Per tab, **transient** (not
  persisted), seeded from `browser_default_zoom` (setting, default `1.0`). Not on
  `SavedTabEntry` — one more persisted field per tab is not worth a zoom level,
  and a global default covers the real need (a HiDPI machine).
- **Overflow `⋯`**: canonical `.context-menu` with *Open this page in the external
  browser* (§7), *Copy link*, *Reload ignoring cache*, *Downloads…* (focuses the
  file view's Downloads section, §6), *Clear browsing data…* (Plan B owns what it
  clears; this plan owns that the entry exists and lives here), *Settings…*.
- **In-page context menu** (right-click on the page) requires an engine hook
  (`browser:context_menu { view_id, x, y, link_url?, image_url?, selection? }`,
  Plan C). When available: *Open link in a new tab* (main window only), *Copy
  link*, *Open link in the external browser*. When not: the toolbar's overflow
  menu is the whole affordance, and the tab still works.

---

## 5. Project scoping

### 5.1 The tab is per-scope; the browser is machine-global

A browser tab belongs to whatever scope it was opened from (root or a project) and
persists into that scope's `project.json` `tab_layout` — automatic, free, no new
machinery. Switching projects parks it with the rest of the scope's tabs.

The **profile** — cookies, localStorage, cache, and whatever else the engine
keeps — is **one machine-global profile** under
`~/.local/share/eldrun/browser/`, never inside a project. Reasons:

- Consistent with every other machine-level feature: `calendar.json`, the VPN
  configs, the global machines, `~/.local/share/eldrun/mail/`.
- A project is a *code folder*, not an identity. Per-project profiles would
  multiply credential stores by the project count and make "which login am I in?"
  unanswerable from the UI.
- Cookie/profile isolation is a security-architecture question. Plan B owns
  whether a *second* (ephemeral/private) profile exists; this plan only fixes
  that the default is one, global, and outside every project tree.

> **Contract E (Plan B).** Profile location, partitioning and any private-window
> mode. This plan requires only: the profile root is under `state_dir()`, and no
> profile data is ever written into a project directory (it would be swept into
> the project's git, byte-sync and lockstep — see §6).

### 5.2 Remote / SSH projects: the browser is always local

A browser tab **never** runs on the project's SSH host and never tunnels through
it. Concretely:

- `browser` is **absent from `isLocatableKind`**, so the locality badge, the
  locality menu and `effectiveTabLocation` never touch it.
- It is absent from `lib/tmuxSession.ts`'s `shouldPersistTab` /
  `shouldPersistLocalTab` (both require a *shell* tab), so no tmux wrap.
- **The run-host preference must not claim it.** `applyRunHostPref`
  (`tabs.ts:40-46`) already gates on `tab.kind !== "shell"`, so this is free —
  but it is called out because `project_run_host_pref` records that a silent
  worker→primary fallback in both frontend and backend is a live debugging trap.
  A browser tab that quietly became "remote" would be inexplicable.
- A remote project's browser tab is therefore identical to a local project's. The
  connection lamps, `useRemoteBlocked` and the SSH pool are all irrelevant to it —
  and, importantly, a **disconnected** remote project's browser tab still works,
  unlike every file/git surface in that project.

### 5.3 Per-project downloads

There are none, by design. See §6.

---

## 6. Downloads

### 6.1 The rule

**No download happens without a native OS save dialog raised inside Rust.** The
engine's download request is intercepted and *refused by default*; the pane shows
`BrowserDownloadStrip` naming the filename, the size if the server declared one,
and the **origin**. Two buttons: **Save…** and **Cancel**.

**Save…** calls `browser_download_accept(download_id) -> Option<String>`, which:

1. Raises the native save dialog via `tauri_plugin_dialog`'s `DialogExt`
   callback API bridged to a `tokio::sync::oneshot` — **never** `blocking_pick_*`
   / `blocking_save_file`, which run on the main thread and freeze the WebView.
   The exact shape is already in-tree at `src-tauri/src/commands/mail.rs:1187-1200`.
2. Pre-fills the **sanitized** filename (attacker-controlled: strip path
   separators, `..`, control characters, leading dots; cap the length; preserve
   only the last extension).
3. Starts the download directory at `browser_download_dir` (setting; default
   `state_dir()/browser/downloads/`).
4. Returns the chosen path (for the "Saved to …" toast) or `None` on cancel,
   which writes nothing.

**No `browser_*` command takes a filesystem path as a parameter** — the same
capability boundary mail draws, for the same reason, and enforced by the same
mechanical test (§11). The frontend never names a destination; the page never
names one; the only path in the system is the one the user picked in an OS dialog.

### 6.2 Downloads do **not** route into the project tree

Refused, and #60 is the reason to quote: *"Routing a download into a project is a
security risk if the file is then pushed with the project's git."* For a **remote**
project it is worse — the project tree is also the subject of byte-sync
(`services/remote_sync.rs`) and git lockstep (`services/git_peer.rs`), so a file
that lands there is on a cluster login node minutes later without anyone
choosing that.

The route into a project already exists and is a deliberate gesture:
`src/components/files/DownloadsSection.tsx` — the Downloads strip below the file
tree, whose doc comment already reads *"It scans the machine-wide
`download_sources` setting (default: the OS Downloads dir), read-only — Eldrun
never changes any browser's download path."*

Integration is therefore **one line of policy, no new UI**: when the in-app
browser is enabled, `state_dir()/browser/downloads/` is included in the effective
`download_sources` list (as a default entry, alongside the OS Downloads dir, not
by rewriting the user's setting). A page downloaded in Eldrun then appears in the
Downloads strip, where the user can drag it onto a folder row in the tree or copy
it in with `→`, using machinery that is already built, already collision-safe
(`import_external_file`), and already disabled for remote projects.

### 6.3 Explicitly refused

- Eldrun **never** writes any external browser's download preference (#60, done
  and removed — `commands/downloads.rs` no longer exists; `src-tauri/CLAUDE.md`
  still lists it and should be corrected in the same commit).
- No "open the downloaded file with the system app" straight from the strip —
  that is arbitrary-write-plus-exec through `commands::apps::open_file`, the exact
  hole `mail_client_plan_a.md` §3 refused. The file is on disk at a path the user
  chose; the OS file manager and the Downloads strip both reach it.
- No silent write into the active project, ever, under any setting.

---

## 7. #33 URI-scheme routing: in-app vs external

### 7.1 The decision rule

One pure function, `src/lib/linkTarget.ts`, unit-tested in
`src/__tests__/LinkTarget.test.ts`:

```ts
export type LinkTarget =
  | { kind: "in_app"; url: string }              // open a browser tab
  | { kind: "global_app"; role: string; url: string }  // launch_app by role
  | { kind: "external"; url: string }            // open_external_url
  | { kind: "compose"; address: string }         // in-app mail composer
  | { kind: "ask"; url: string }                 // show the chooser
  | { kind: "refuse"; reason: string };

export function routeUri(uri: string, ctx: {
  setting: LinkOpenTarget;          // settings.browser_link_target
  browserEnabled: boolean;          // experimental web_browser flag
  mailEnabled: boolean;             // experimental mail_client flag
  explicit?: "in_app" | "external"; // a user gesture that named the target
  origin: "terminal" | "filetree" | "viewer" | "browser" | "eldrun";
}): LinkTarget;
```

Rules, in order:

1. **Scheme first.** `mailto:` → `compose` when `mailEnabled`, else
   `global_app("mail")`. `webcal:` → `global_app("calendar")`. `http`/`https` →
   continue. **Anything else → `refuse`** (this preserves `open_external_url`'s
   own guard at `commands/ssh.rs:259-266`, which independently refuses non-web
   URLs — two checks, neither trusting the other).
2. **`origin: "eldrun"` is always `external`.** A URL *Eldrun itself* starts — a
   git-hosting OAuth flow, a `gh`/`glab` auth page, a release link from
   `ProjectPill.tsx:598` — goes to the user's real browser, where their session
   already lives. Routing an auth flow into a brand-new profile just means logging
   in again, in the wrong place.
3. **An explicit gesture wins.** `ctx.explicit` (the link context menu's *Open in
   Eldrun* / *Open in the external browser*) overrides the setting. A preference
   is a default, not a lock.
4. **Browser disabled → `external`.** The experimental flag off, or the platform
   with no engine (Contract F), means the in-app option does not exist.
5. **Otherwise the setting decides**: `"external"` (default) →
   `global_app("browser")` if the user configured that role, else `external`;
   `"in_app"` → `in_app`; `"ask"` → `ask`, which shows a small canonical
   `.context-menu` chooser with a *Remember this choice* row that writes the
   setting.

### 7.2 Wiring #33

#33 is currently unimplemented (the last open item of the global-apps suite).
This plan makes it one call site rather than three:

- Terminal link clicks (`components/terminal/TerminalView.tsx`, the xterm link
  handler) and file-tree/viewer link clicks (`lib/viewers/markdown.ts` links,
  `FileViewerPane`) call `routeUri(...)` and then a single dispatcher
  (`openRoutedUri` in `lib/linkTarget.ts`) that performs the `addTab` /
  `launch_app` / `open_external_url` / composer-open.
- **Mail links are deliberately left alone in v1.** `MailMessageView`'s link path
  (confirm naming the real host → `openMailLink` → `open_external_url`,
  `src/lib/mail.ts:389-408`) is a settled anti-phishing flow; re-pointing it at a
  brand-new engine is a Plan-B-scoped change, not a routing tidy-up. Listed as a
  follow-up once the browser is live-verified.

### 7.3 The setting

`browser_link_target: "external" | "in_app" | "ask"`, default **`"external"`**.
Default chosen deliberately: the user's real browser has their logins, their
extensions and their password manager; an experimental in-app engine should not
silently start receiving their links.

---

## 8. #53 — drag a tab into a file-upload field

**Not in v1. External-browser drops keep working unchanged; in-app drops are
Phase 5+ and engine-gated.**

What #53 is today (`todo/group-m-viewers.md` #53, automated test already ✅): images and
image/text *tabs* are OS-level drag sources via `tauri-plugin-drag`
(`drag:default` is in `capabilities/default.json`; `src/lib/dragPlatform.ts` owns
the per-platform gesture semantics). Dropping onto an **external** browser's
upload field works because the OS drag carries a real file path and the external
browser is a normal drop target. Nothing in this plan changes that.

Dropping onto the **in-app** browser is a different problem, in three layers:

1. **The drop lands on a native child webview**, an OS surface outside the React
   tree. The JS drag state never sees it, so `stores/drag.ts` cannot commit it.
   `tauri.conf.json` also sets `"dragDropEnabled": false` for the app window.
2. **WebKitGTK withholds dropped paths from HTML5 drops** and leaks at most one
   via `text/html` — the limitation `files/importDrop.tsx` documents and works
   around by making the file *picker*, not the drop, the reliable route.
3. **Filling an `<input type=file>` needs an engine verb.** Chromium/WebView2 can
   do it via CDP `DOM.setFileInputFiles`; WebKitGTK exposes no public API for it.

What it would take, if picked up later:

- **Contract G (Plan C):** `browser_upload_stage(view_id, paths: Vec<String>)` —
  attach these files to the page's focused file input — plus a drop event from
  the native view (`browser:drop { view_id, x, y }`).
- **Contract H (Plan B):** the gesture must originate in Eldrun. A page must never
  be able to *request* a file, and a staged path must be one the user just
  dragged; a page-initiated `showOpenFilePicker`-style path is refused.
- Frontend: `BrowserPane` registers as a drop target in `stores/drag.ts` with the
  pane rect, so the existing pointer-drag can end over a page.

Until all three exist, the in-app browser's upload affordance is the page's own
file-picker button, which raises the OS dialog through the engine — sufficient,
and it costs nothing.

---

## 9. i18n keys

All added to `src/lib/i18n.ts` in en (source of truth) and de/es/fr/it.

**Tab surface**
`newTabMenu.browser`, `tabKind.browser`

**Pane / toolbar** (prefix `browser.`)
`back`, `forward`, `reload`, `reloadHard`, `stop`, `home`, `addressPlaceholder`,
`addressNotUrl`, `addressRefusedScheme`, `go`, `loading`, `zoomIn`, `zoomOut`,
`zoomReset`, `zoomLevel`, `menu`, `openExternal`, `copyLink`, `openInNewTab`,
`clearData`, `settings`

**Start page / resume / suspend**
`startTitle`, `startHint`, `resumeTitle`, `resumeHint`, `resumeLoad`,
`suspendedTitle`, `suspendedHint`, `noEngine`, `noEngineHint`, `errorTitle`,
`errorRetry`, `suppressed`

**Security chip**
`securitySecure`, `securityInsecure`, `securityMixed`, `securityLocal`,
`securityError`, `securityDetails`, `securityOrigin`, `securityUnknown`

**Find bar**
`find`, `findPlaceholder`, `findNext`, `findPrev`, `findMatches`,
`findNoMatches`, `findClose`, `findCaseSensitive`

**Downloads**
`downloadPrompt`, `downloadFrom`, `downloadSave`, `downloadCancel`,
`downloadSaved`, `downloadFailed`, `downloadUnknownSize`, `downloadsOpen`

**Link chooser (#33)**
`linkChooserTitle`, `linkChooserInApp`, `linkChooserExternal`,
`linkChooserRemember`, `linkRefused`

**Settings** (prefix `settings.`)
`webBrowser` (the experimental toggle label), `webBrowserHelp1/2`, `browser`
(section title), `browserHome`, `browserHomeHelp`, `browserSearch`,
`browserSearchHelp`, `browserLinkTarget`, `browserLinkTargetExternal`,
`browserLinkTargetInApp`, `browserLinkTargetAsk`, `browserLinkTargetHelp`,
`browserDownloadDir`, `browserDownloadDirHelp`, `browserRestoreNavigate`,
`browserRestoreNavigateHelp`, `browserZoom`, `browserMaxLiveViews`,
`browserMaxLiveViewsHelp`

Interpolated keys use the existing `t(key, { … })` form:
`browser.findMatches` = `"{current} of {total}"`,
`browser.downloadPrompt` = `"{name} ({size}) from {host}"`,
`browser.resumeLoad` = `"Load {host}"`,
`browser.downloadSaved` = `"Saved to {path}"`.

---

## 10. Settings, the frozen contract, and persistence

### 10.1 Experimental gate

Add `"web_browser"` to `EXPERIMENTAL_FLAGS` (`src/lib/experimental.ts:31-36`),
`web_browser?: boolean` to `Settings` (`src/types/index.ts`) **and** to the Rust
`Settings` (`src-tauri/src/schema/settings.rs`, beside the `mail_client` block at
`:63`), so it round-trips through `save_settings`. Read it only through
`useExperimental("web_browser")` — never `settings.web_browser ?? false`, which
misses the debug default.

The gate hides the **entry point** (the two new-tab menu entries and the #33
in-app routing option), never a pane already on screen: an open or restored
browser tab keeps rendering, exactly as `experimental.ts`'s doc block says for
mail.

### 10.2 Settings fields

Rust (`schema/settings.rs`) and TS (`types/index.ts`) in step, in a `browser_*`
block right after the `mail_*` block:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `web_browser` | `bool?` | unset (→ debug) | The experimental gate. |
| `browser_home_url` | `String?` | unset → start page | Where a new browser tab opens. Empty/unset = the built-in start page, not a remote request. |
| `browser_search_template` | `String?` | `"https://duckduckgo.com/?q=%s"` | Non-URL address-bar text becomes this. Clearable. |
| `browser_link_target` | `String?` | `"external"` | #33 routing (§7). |
| `browser_download_dir` | `String?` | `state_dir()/browser/downloads` | The save dialog's start directory — **Eldrun's own** directory, never another app's config (§6). |
| `browser_restore_navigate` | `bool?` | `false` | Restored tabs load at launch (§2). |
| `browser_default_zoom` | `f32?` | `1.0` | Seed zoom for a new view. |
| `browser_max_live_views` | `u32?` | `6` | LRU cap on live native views (§3.4). |

Plan B additionally owns the *policy* knobs (JS on/off, third-party cookies,
tracker blocking, private mode). They live in the **same** `browser_*` settings
block and render in the **same** settings sub-panel — that layout is this plan's;
their semantics are not.

**Never in `settings.json`:** anything session- or content-shaped (history,
cookies, cache index). `settings.json` is read and rewritten wholesale by
unrelated code paths; a growing blob there is a corruption surface — the same
argument `mail_client_plan_a.md` §4 makes for accounts.

### 10.3 Settings UI

A **Browser** section in `SettingsPanel.tsx`, placed directly after the Calendar
section (`:871`), with `<UntestedTag />` on the section title until verified:
home URL, search template (+ help naming `%s`), link target (`Dropdown`, three
options), download directory (read-only display + a *Change…* button raising the
native folder picker), restore-navigate `ToggleCard`, default zoom, max live
views. The experimental `web_browser` `ToggleCard` goes in the Experimental block
beside `agent_mode_toggle`/`python_run_debug` (`:807-836`).

### 10.4 On-disk layout

```
~/.local/share/eldrun/browser/
  profile/          # engine-owned: cookies, localStorage, cache (Plan B owns the shape)
  downloads/        # default save dir; also auto-included in download_sources (§6.2)
```

Never inside a project. An **overflow-menu → Clear browsing data…** entry exists
from Phase 4 (Plan B defines what it clears), for the same reason mail has "Clear
cached mail": a store that grows without bound needs one button, not a shell.

### 10.5 The frozen contract (write this first)

Three files land in one small commit and are then frozen for the phase, so the
frontend is unblocked on minute one and `npx tsc --noEmit` is meaningful from the
start — the shape `mail_client_plan_a.md` §6 used:

- `src/types/browser.ts` — the TS types below.
- `src-tauri/src/commands/browser.rs` — every command present and registered in
  `generate_handler!`, each returning `Err("not implemented".into())`.
- `src/lib/browser.ts` — one typed wrapper per command; no component invokes
  directly.

**Command surface.** All `pub async fn`, all `Result<T, String>`, **none takes a
filesystem path** (§6.1, §11). Commands marked *(C)* are Plan C's to implement;
their *signature* is fixed here so the frontend can be written against it.

```
browser_view_create(window_label, tab_key, bounds, url: Option<String>) -> String   # view_id   (C)
browser_view_destroy(view_id)                                           -> ()       (C)
browser_view_set_bounds(view_id, bounds: ViewBounds)                    -> ()       (C)
browser_view_set_visible(view_id, visible: bool)                        -> ()       (C)
browser_view_set_zoom(view_id, factor: f32)                             -> ()       (C)
browser_navigate(view_id, url: String)                                  -> ()       (B policy, C impl)
browser_back(view_id) / browser_forward(view_id) / browser_reload(view_id, hard: bool) / browser_stop(view_id) -> ()  (C)
browser_state(view_id)                    -> BrowserViewState                       (C)
browser_find(view_id, query, forward: bool, match_case: bool) -> BrowserFind        (C, optional)
browser_find_stop(view_id)                -> ()                                     (C, optional)
browser_download_accept(download_id)      -> Option<String>   # backend raises the OS save dialog
browser_download_cancel(download_id)      -> ()
browser_clear_data(scope: ClearScope)     -> ()                                     (B)
```

Events (`app.emit`, listened via `lib/browser.ts`'s `onBrowser*` helpers):

```
browser:state    BrowserViewState { view_id, url, title, loading, progress, can_back, can_forward, security }
browser:download BrowserDownloadEvent { view_id, download_id, filename, mime, size: Option<u64>, origin }
browser:closed   { view_id, reason }        # engine dropped the view (crash, policy)
browser:refused  { view_id, url, reason }   # Plan B's navigation policy said no
```

**TypeScript types (`src/types/browser.ts`, frozen):**

```ts
export interface ViewBounds { x: number; y: number; width: number; height: number }
export type BrowserSecurityLevel = "secure" | "insecure" | "mixed" | "local" | "error";
export interface BrowserSecurity { level: BrowserSecurityLevel; origin: string; detail?: string; blocked?: number }
export interface BrowserViewState {
  view_id: string; url: string; title: string;
  loading: boolean; progress: number;          // 0..1
  can_back: boolean; can_forward: boolean;
  security: BrowserSecurity;
}
export interface BrowserFind { current: number; total: number }
export interface BrowserDownloadEvent {
  view_id: string; download_id: string;
  filename: string; mime: string; size?: number; origin: string;
}
export type LinkOpenTarget = "external" | "in_app" | "ask";
export type ClearScope = "cookies" | "cache" | "all";
```

---

## 11. Phased implementation

Each phase is one or a few individually-committable steps. Gates for every phase:
`npx tsc --noEmit` and `cargo test --manifest-path src-tauri/Cargo.toml`, plus the
named test file. **Nothing here is verified by running Eldrun** — every
"acceptance" below is either a compiler/test statement or an explicit hand-off to
the user.

### Phase 0 — the frozen contract

Files: `src/types/browser.ts`, `src/lib/browser.ts`,
`src-tauri/src/commands/browser.rs` (stubs), `src-tauri/src/commands/mod.rs`
(alphabetical, between `boxes` and `calendar`), `src-tauri/src/lib.rs`
(`generate_handler!` block after the calendar/mail blocks; `.manage(browser_state)`
beside `.manage(mail_state)` at `:477`), `src-tauri/src/schema/settings.rs` +
`src/types/index.ts` (the `browser_*` block), `src/lib/experimental.ts`
(`"web_browser"`).

Acceptance:
- `cargo test` passes; every `browser_*` command is registered and returns
  `Err("not implemented")`.
- `npx tsc --noEmit` passes with `src/lib/browser.ts` fully typed against
  `src/types/browser.ts`.
- **The no-path-parameter source test lands here**, not later: a unit test in
  `commands/browser.rs` that `include_str!`s its own source and asserts no
  `#[tauri::command]` signature carries a `path`/`dest`/`dir`/`file` `String`
  parameter, plus the `blocking_pick_*`/`blocking_save_file` ban — the exact pair
  already in `commands/mail.rs:1466-1476`. It is cheap, mechanical, and fails
  loudly the first time someone "just adds a path here".

### Phase 1 — the tab surface, with no engine

Frontend only. All 18 rows of §1.2; `BrowserPane` renders the full toolbar,
`BrowserStartPage`, the resume card, and a "no engine on this build" placeholder
in the content region; `stores/browserViews.ts` with the suppression refcount and
the LRU bookkeeping (driving nothing yet); `.browser-*` in `themes.css`; the i18n
block ×5; `<UntestedTag />` on both menu entries and the settings section.

Acceptance:
- `TabPersistFilter.test.ts` locks `isRestorableKind("browser") === true` and a
  `url` round-trip through `SavedTabEntry`.
- A new `BrowserSuppression.test.ts` locks: a modal open, a drag in flight, and
  `moving` each raise the refcount, and views stay hidden until all three clear.
- `tsc` passes (the three `Record<TabKind, …>` maps are the compile-enforced proof
  the kind is wired everywhere).
- Hand-off to the user: *open a Browser tab, split it, drag it, pop it out,
  restart — the chrome should behave like any other tab, with no page in it.*

This phase is deliberately shippable on its own. It is the honest way to land the
surface before Plan C's engine work exists, and it makes every later phase a
content change rather than a structural one.

### Phase 2 — engine attach (**depends on Plan C**)

`browser_view_create/destroy/set_bounds/set_visible`, `browser_navigate`,
back/forward/reload/stop, the `browser:state` event. `BrowserPane` gains the
bounds observer (a `ResizeObserver` on its content region plus the pane layer's
measured rect), the visibility sync, and the LRU/suspension wiring from Phase 1's
store.

Acceptance: `cargo test` covers the pure parts (URL shape checks, bounds
arithmetic, the LRU policy in `stores/browserViews.ts` under vitest). Live
verification — *does a page render inside the tab, does it stay glued to the pane
under a split-divider drag, does it hide behind a dialog* — is a hand-off, listed
explicitly.

### Phase 3 — chrome completion

Address-bar commit semantics + `lib/linkTarget.ts`'s URL-shape half, the security
chip and its popover (rendering Plan B's `BrowserSecurity`), title→tab-title with
the `autoLabelRef` guard, find-in-page (or its principled absence), zoom, the
overflow menu, the in-page context menu when Plan C provides the hook.

Acceptance: `LinkTarget.test.ts` covers the commit-semantics table (absolute URL,
bare host, search fallback, refused scheme, empty). A `BrowserTitle.test.ts`
locks that a user-renamed tab is never retitled by a page.

### Phase 4 — downloads + #33 routing

`browser_download_accept`/`_cancel` with the `DialogExt`+`oneshot` save dialog and
the filename sanitizer; `BrowserDownloadStrip`; `browser/downloads/` added to the
effective `download_sources`; `lib/linkTarget.ts`'s routing half + `openRoutedUri`
+ the terminal/file-tree/viewer call sites (this closes **#33**); the link chooser
and its *Remember this choice*; the settings sub-panel.

Acceptance: Rust unit tests for the filename sanitizer (path separators, `..`,
control characters, no-extension, absurd length) and for
`browser_download_accept` returning `None` on cancel without writing. Vitest for
`routeUri`'s full rule table including the `origin: "eldrun"` always-external
rule. `src-tauri/CLAUDE.md`'s stale `downloads.rs` row is corrected in this commit.

### Phase 5 — deferred, each independently optional

Favicons (Contract D), #53 upload staging (Contracts G+H), a private/ephemeral
profile (Plan B), reader mode, per-origin zoom memory, routing `MailMessageView`'s
links through `routeUri`.

### Untested pills

`<UntestedTag />` ships on: both new-tab menu entries, the settings section
title, the security popover, the download strip, and the link chooser. Removed
**per item**, only when the user says that item is tested
(`feedback_untested_tag`).

---

## 12. Decisions at a glance

| # | Question | Decision |
|---|---|---|
| 1 | Where it lives | **Center tab**, `TabKind: "browser"`, `BROWSER_TAB_CMD`. Not the right panel, not a global-app surface. |
| 2 | Singleton? | **No** — `addTab`, like `diskusage`. Each tab is a different page. |
| 3 | Tabs inside the tab? | **No.** Eldrun's own tab strip is the tab strip; "open in a new tab" adds a sibling. |
| 4 | Restores on relaunch? | **Yes**, `isRestorableKind`. **URL only** — no history, no scroll, no form state. |
| 5 | Navigates on restore? | **No.** Resume card + Load button; `browser_restore_navigate` (default off) opts in. |
| 6 | Popouts | Supported **iff** Contract A holds (window-label-scoped views). No retitle, no open-in-new-tab in a popout. |
| 7 | Native view vs DOM overlays | Views hide on a suppression refcount (modals, drags, window move, right panel, presenter). |
| 8 | Unbounded views | LRU cap `browser_max_live_views` (6) + 60 s off-screen suspension; suspended tabs fall back to the resume card. |
| 9 | Favicons | **Not in v1** — a remote fetch per site is a policy question (Contract D). |
| 10 | Find-in-page | Yes if the engine supports it; **hidden entirely** if not. Never a control that lies. |
| 11 | Zoom | Per tab, transient, seeded from `browser_default_zoom`. Not persisted per tab. |
| 12 | Security indicator | Left of the address text; renders Plan B's `BrowserSecurity` verbatim, computes nothing. |
| 13 | Project scoping | Tab is per-scope (free, via `tab_layout`); profile is **machine-global** under `state_dir()/browser/`. |
| 14 | Remote projects | Browser is **always local** — not in `isLocatableKind`, no tmux, no run-host preference. |
| 15 | Downloads | Backend-raised native save dialog only; default dir is Eldrun's own; **no path parameter anywhere**. |
| 16 | Downloads → project tree | **Never automatic.** The existing `DownloadsSection` drag is the one route in. |
| 17 | External browsers' config | **Never touched** (#60). |
| 18 | #33 default | `browser_link_target` = **`"external"`**; Eldrun-initiated URLs are always external; an explicit gesture always wins. |
| 19 | #53 upload drop | **Not in v1**; needs Contracts G+H. External-browser drops keep working. |
| 20 | Experimental gate | `web_browser` flag; hides entry points only, never an open tab. |

---

## 13. Contracts owed by the other plans

| Contract | Owner | What this plan needs |
|---|---|---|
| **A** — window-scoped views | C | `browser_view_*` take a **window label** so a popout hosts its own view. If impossible, browser tabs are refused in popouts (and this plan's §3.1 degradation applies). |
| **B** — destroy/recreate | C | `browser_view_destroy` idempotent and safe at any time; a view can be recreated for the same tab key. Enables the LRU cap. |
| **C** — navigation policy | B (impl C) | `browser_navigate` enforces scheme/redirect/private-address policy and emits `browser:refused` with a reason the pane can render. |
| **D** — favicon policy | B | If favicons are wanted: no cookies, no referrer, size cap, cached under `browser_dir()`. Until then, none. |
| **E** — profile | B | Profile root under `state_dir()`, never inside a project. Whether a private/ephemeral profile exists. |
| **F** — platform coverage | C | Which of Linux/Windows/macOS actually gets an engine. Where none exists the flag must report it so the tab is not offered (Eldrun ships deb/appimage/nsis). |
| **G** — upload staging | C | `browser_upload_stage(view_id, paths)` + a native-view drop event, for #53. |
| **H** — upload consent | B | A page may never *request* a file; only an Eldrun-originated gesture stages one. |
| **I** — find-in-page | C | `browser_find`/`browser_find_stop`, or an explicit "cannot", so the button is hidden rather than broken. |
| **J** — context menu | C | `browser:context_menu { view_id, x, y, link_url?, image_url?, selection? }`, or its absence. |
| **K** — clear data | B | `browser_clear_data(scope)` semantics behind the overflow entry. |

---

## 14. Open questions

Things this plan could **not** settle from the repo:

1. **Does an engine exist on all three platforms?** (Contract F.) Eldrun ships
   deb/appimage/nsis and has macOS parity on develop. WebKitGTK, WebView2 and
   WKWebView have materially different capabilities for exactly the features in
   §4 (find, context menu, upload staging, per-view profile). If the answer is
   "Linux only", §1's decision holds but the experimental flag must be
   platform-gated the way `TerminalSignInToggle` is on Windows (`winManual`), and
   the new-tab entry must not appear where nothing can render.
2. **Can a native child webview be clipped to a sub-rect of the window at all
   under WebKitGTK?** The whole pane-layer integration (§3.3, §3.4) assumes
   bounds-settable, hideable child views. If the engine can only do a full-window
   webview, the browser is a *popout-only* feature and §1's center-tab decision
   needs revisiting with Plan C.
3. **Does the app CSP (`tauri.conf.json:29`) apply to a child webview?** It is
   set on the app's own webviews. If it leaks onto a browser view, no external
   page can load anything; if it must be relaxed, the relaxation must not weaken
   the main window's. Plan B/C.
4. **Where do keyboard shortcuts land when a native view has focus?** `F11`
   (fullscreen), `Super` (panels) and the global chord handler
   (`hooks/useKeyboard.ts`) listen on the *React* window. A focused native view
   may swallow them, which would make `Ctrl+F`, `Ctrl+W` and the app's own chords
   dead inside a browser tab. Needs an engine-level key hook or an explicit,
   documented loss.
5. **Zoom interaction with the per-window zoom.** Popouts already carry a
   per-window `zoom` (`DetachedGroup.zoom`, `core:webview:allow-set-webview-zoom`).
   Whether a child view inherits it or needs it applied twice is unknown.
6. **Does `project_runtime::switch` parking touch a child view?** `presenter.rs`
   deliberately avoids being a detached subwindow *because* parking would blank
   it mid-talk. Whether a child webview attached to `main` is affected at all is
   unverified.
7. **Should a `file://` view of the project tree ever be allowed?** It would make
   the browser a live preview for a local dev server's static build, which is a
   real use — but it is ambient filesystem read from a web surface, so it is Plan
   B's call, not mine. Default assumed: **no**, `http(s)` and `localhost` only.
8. **`localhost`/loopback policy.** Previewing a dev server (`http://localhost:5173`)
   is probably the single most valuable use of this feature in a dev workspace,
   and it is also the classic SSRF-adjacent target. Plan B must state whether
   loopback is allowed by default, and whether the *remote* project's forwarded
   ports are reachable (this plan assumes **not** — §5.2, the browser is local and
   does not tunnel).
9. **Whether `browser_search_template`'s default should be empty.** A default
   search engine means the address bar can send typed text to a third party. The
   chosen default (`duckduckgo.com`) is public and neutral, but "no search unless
   you configure one" is the more conservative reading of this repo's defaults
   (passwords off, remote images off, downloads confirmed). Flagged for the user
   to pick.
10. **`src-tauri/CLAUDE.md` lists a `downloads.rs` that no longer exists** (#60
    removed it). Corrected in Phase 4, noted here so it is not mistaken for a
    missing module during implementation.

---

## Critical files for implementation

- `src/stores/tabs.ts` — `TabKind`:48, `MAIL_TAB_CMD`:184 (insert
  `BROWSER_TAB_CMD` after), `TabEntry`:296, `SavedTabEntry`:505,
  `cmdToKind`:3717, `isRestorableKind`:3743, `isPtyTabKind`:3764
- `src/components/tabs/TabPane.tsx`:88 — the one shared kind→pane switch
- `src/components/tabs/newTabItems.ts`:85 (`TAB_ACCENT`),
  `src/components/tabs/TabHoverCard.tsx`:23 (`KIND_LABEL_KEY`) — both compile-enforced
- `src/components/tabs/TabBar.tsx`:530 (`handleAddMail` template), :1420 (menu group)
- `src/components/tabs/NewTabMenu.tsx`:322 — the detached window's add menu
- `src/components/layout/CenterPanel.tsx`:859 — the flat pane layer (never unmounted)
- `src/components/files/DownloadsSection.tsx` — the one route from a download into a project
- `src-tauri/src/commands/mail.rs`:1085-1200 — the `DialogExt` + `oneshot` dialog pattern; :1466 the source-level ban tests
- `src-tauri/src/commands/ssh.rs`:259 — `open_external_url` (the external half of #33)
- `src-tauri/src/commands/apps.rs`:225 (`launch_app`), :343 (`open_file`)
- `src/components/layout/GlobalAppBar.tsx`:19 — the `browser` global-app role
- `src-tauri/src/lib.rs`:477 (`.manage`), :589 (`generate_handler!`), :1006 (dialog plugin)
- `src-tauri/capabilities/default.json` — window label patterns
- `src/lib/experimental.ts`:31 — `EXPERIMENTAL_FLAGS`
- `src/components/layout/SettingsPanel.tsx`:807 (experimental block), :871 (calendar section — insert Browser after)
