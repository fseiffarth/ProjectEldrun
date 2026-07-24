# Native Presenter ("Deck") — Plan

Status: **all seven phases implemented, including the dual-window presenter**,
behind the experimental `deck_presenter` flag (`src/lib/experimental.ts` — off
for everyone, on in debug mode). Tracked as TODO M#90.

Automated gates green: `npx tsc --noEmit` clean, **147** deck tests, the full
frontend suite (1985) passing. **Nothing here has been exercised live** — see
the "Done ≠ Tested" legend in `TODO.md`. The dual-window half in particular is
the one part of this feature whose failure mode is public (it fails in front of
a room), so it needs live QA on real hardware with a real second display before
it is trusted.

**Post-Phase-7 additions (2026-07-24):** the rail shows real per-slide preview
thumbnails and is user-resizable (drag handle, width persisted per tab via
`ViewerState.deckRailWidth`); a **Notes** mode gives the editor a place to
*write* `Slide.notes` (until now only the presenter ever read it); a **TeX**
mode lists every TeX-figure object across the whole deck. TeX figures are the
other addition: the toolbar's TeX FAB writes a blank `standalone`-class `.tex`
beside the deck (`<deck>.tex-figures/<objectId>.{tex,pdf,png}`), compiles it,
rasterizes page 1 to a PNG, and places it as an ordinary `image` object carrying
an extra `texSrc` pointer. Double-clicking that object on the stage (or "Edit
source" in the inspector / TeX list) opens the `.tex` as a real tab — Eldrun's
full TeX editor, not a bespoke one — and a 1.5s mtime poll on the compiled PDF
(mirroring the PDF viewer's own external-change poll) notices a recompile from
that tab and re-rasterizes onto the slide automatically, the same "the PDF tab
already mtime-polls" trick §7 relies on for the base plate.

The integration anchors in §12 were verified against the tree by three
read-only investigation passes over the PDF stack, the viewer-registration /
file-I/O chain, and the TeX + overlay + GIF stack. Where an investigation
contradicted the first draft of this plan, the plan changed — those points are
marked **[verified]**.

---

## 1. What it is

A native presentation surface for Eldrun with three separable halves:

1. **Generation** — a base PDF, produced from TeX (Beamer or plain), imported
   from any existing PDF, or created blank from a generated starter `.tex`.
2. **Design** — editable object layers on top of each base page: text (with list
   styles), images, shapes, single-path icons, GIFs. Direct manipulation with
   snapping/alignment guides.
3. **Presenting** — a fullscreen presenter with slide transitions (including a
   GIF played as the bridge between two slides), per-object build steps, speaker
   notes, a timer, and the existing laser/marker tools.

The three are deliberately decoupled: you can design without ever compiling TeX,
and you can present a deck whose layers are empty.

---

## 2. The structural decision: the sidecar is the document

```
talk.tex           source — you own it, Eldrun never writes to it
talk.pdf           base plate — regenerated on every compile
talk.eldeck.json   THE DECK — layers, builds, transitions, notes
talk.export.pdf    flattened output, produced on demand
```

**The PDF is a background plate, not the document.** This is forced by TeX being
a first-class generator: `latexmk` rewrites `talk.pdf` on every compile, so any
layer stored *inside* the PDF is destroyed the next time the author fixes a typo
in their source. A sidecar survives arbitrarily many recompiles.

Three consequences fall out, all of them wanted:

- **The deck is a tracked text file.** It diffs, it merges, and git lockstep
  carries it to a remote host like any other source file — no binary blob, no
  special sync path.
- **Two authoring models stop fighting.** TeX is declarative source; the layer
  editor is direct manipulation. The rule that keeps them from contradicting each
  other is one-way: *TeX owns the base plate, the editor owns the top, and the
  editor never writes back to `.tex`.*
- **Export is a build step, not a save.** `talk.export.pdf` is derived,
  throwaway, and never read back — mirroring the existing rule that
  `pdfDoc.ts`'s `buildPdf` is the only place a PDF is written.

### 2.1 Anchoring layers across a recompile

Anchoring a layer to a page *index* breaks the moment a slide is inserted in the
TeX — the single most common edit an author makes. There are two anchors, and
the better one turns out to be free:

**SyncTeX, when a `.tex` source exists. [verified]** `compile_tex` already passes
`-synctex=1` unconditionally (`commands/tex.rs:197,221`) and `lib/viewers/tex.ts`
already exposes `synctexEdit`/`synctexView` returning `SyncRect{page,x,y,w,h}`.
So a slide generated from TeX anchors to **the source line that produced it** —
which survives insertion, deletion and reordering of other slides exactly as well
as the author's own mental model does. Strictly better than any content
heuristic, and it costs nothing: the mapping is already emitted and thrown away.

**A content fingerprint otherwise** (an imported PDF has no source):

```ts
fingerprint = hash(pageWidthPt, pageHeightPt, firstNCharsOfExtractedText)
```

Resolution order on load:

1. Page count unchanged and every anchor resolves → anchor by index. The common
   case, and free.
2. Otherwise → resolve by SyncTeX line (or fingerprint), then fill unmatched
   slides in document order.
3. Layers with no home go to a **detached bin**, surfaced with a "re-attach to
   slide…" action.

Never silently drop a layer. A recompile that quietly eats an author's
annotations is what makes people stop using a tool.

### 2.2 Saving: autosave, because there is nothing to hook

**[verified]** Eldrun has **no unsaved-work prompt anywhere**.
`closeTabWithConfirm` (`lib/closeRemoteTab.ts:86-88`) is literally
`removeTab(key)` — its own comment calls itself a seam for a future confirm that
was never added — there is no `beforeunload` in the viewer stack, and the PDF
viewer's undo stack and unsaved arrangement are silently dropped on tab close.

So a deck must never *hold* unsaved state. The sidecar is autosaved: it is
small, it is text, and it is under git, so durable undo already exists at the
right layer. That deletes the dirty flag, the save button, the close prompt and
the stale-on-disk conflict banner from the design in one move.

Two constraints govern how: **[verified]** `useEditableFile` autosaves on *every
keystroke* while dirty (`FileViewerPane.tsx:1038,1104-1106`), and
`write_file_text` **refuses to create a file that does not exist**
(`fs.rs:1339-1354`). Therefore:

- The live object model is **local React state during a gesture**; it commits to
  the draft text only on gesture *end*. Otherwise dragging one object would issue
  a disk write per `pointermove`.
- A sidecar that does not exist yet is created with
  `writeFileBytes(path, new TextEncoder().encode(json), scope)` — or
  `invoke("create_file", …)` — never `writeFileText`.

Export stays explicit. That one *is* a deliberate act.

### 2.3 Coordinates

Object geometry is stored **normalized to the page box** (0..1) — the same choice
`PresentationOverlay` makes for marker strokes, so zoom, pane resize, a second
monitor and export at any DPI all work with no conversion table.

Type size is stored in **PDF points**, not normalized. The split is deliberate:
geometry is relative (a page-size change should move things sensibly), type size
is absolute (24 pt should stay 24 pt).

Dropped from the first draft: a per-object `anchor` field (which page edge the
position is measured from). Normalized coordinates already keep an object where
it belongs; `anchor` would only matter on a base-plate aspect-ratio change, and a
field with no reader is not worth encoding speculatively.

**The coordinate chain [verified]** — `scale` in the PDF viewer is
CSS-px-per-PDF-point, so at `scale === 1` one CSS px is exactly one PDF point
("big point"). `tex.ts` already provides both halves of the screen mapping,
**top-left origin**:

```ts
pdfPointToBigPoints(rect, clientX, clientY, scale)  // tex.ts:249 — CSS px → bp
bigPointsToCssRect(rect, scale)                     // tex.ts:263 — bp → CSS px box
```

What does **not** exist anywhere in the repo is the **bottom-left flip pdf-lib
needs**. The exporter must add it — for an unrotated page,
`yPdf = pageHeightPt - yTopLeft - h`; a rotated sheet has to go through
`viewport.convertToPdfPoint`, since `getViewport({rotation})` bakes the turn in
and the whole viewer already measures in the rotated space.

---

## 3. Object model

```ts
type DeckObject = {
  id: string;
  x: number; y: number; w: number; h: number;  // normalized to the page box
  rot: number;        // degrees, free (unlike a PDF /Rotate)
  opacity: number;
  locked?: boolean;
  hidden?: boolean;
  build?: BuildStep;  // animate mode only
} & (
  | { kind: "text";  text: string; style: TextStyle; list?: ListStyle; … }
  | { kind: "image"; src: string; fit: "contain" | "cover" | "stretch" }
  | { kind: "shape"; shape: ShapeKind; fill?: string; stroke?: string; … }
  | { kind: "icon";  icon: string; color: string; strokeWidth: number }
  | { kind: "gif";   src: string; loop: boolean; autoplay: boolean }
);
```

Z-order is list order — the same "an arrangement is a list, every op is pure and
returns a new list" bargain `lib/viewers/pageModel.ts` already strikes, so undo
is an array of snapshots and rendering is a straight `map`.

**[verified]** Nothing in the repo has draggable/resizable canvas objects with
selection handles. `ImageAnnotator` is stroke-only and pixel-destructive (its
undo is a stack of `ImageData` snapshots); the only reusable pieces are its
`toCanvas` pointer mapping and `drawArrow`. So the object model, hit-testing and
handle math are genuinely new code — modeled on `pageModel.ts` (pure, tested,
consumed by two views).

### 3.1 Text, and why "enumeration fields" are a *style*

A text object carries one style (family, size, weight, italic, color, align, line
height) plus an optional list style:

```ts
list?: { kind: "bullet" | "number" | "alpha" | "roman"; start: number };
```

Modeling enumerations as a **list style on a text object** rather than a separate
object kind buys three things at once: renumbering is automatic, nesting comes
from per-line indent, and — the important one — **stepped reveal falls straight
out**: list item *i* becomes build step *i*, in one click. The most-used
animation in any talk, obtained for free from the data model.

Deliberately **not** in v1: rich text runs *within* one object (bold inside a
paragraph). One style per object; a second object is cheap. Inline runs need a
span model, a caret that walks it, and per-run metrics — a rabbit hole with a
poor payoff for slides.

### 3.2 Text metrics: lay out with PDF metrics on **both** sides

The classic failure of a WYSIWYG-over-PDF editor: the editor breaks lines using
browser metrics while the exporter uses PDF metrics, so the export silently
reflows.

Avoid it by measuring with **PDF metrics in the editor too** — create one
throwaway `PDFDocument` at startup, embed the standard-14 fonts, and make
`font.widthOfTextAtSize` the single source of truth for wrapping in both the
canvas and the exporter. Export is then identical to the screen by construction.

Accepted cost: **v1 is standard-14 only** (Helvetica / Times / Courier ×
regular/bold/italic/bold-italic). Arbitrary TTFs need `@pdf-lib/fontkit` plus a
font-embedding UI and buy little for a talk. On Linux, Helvetica resolves to
Nimbus Sans / Liberation Sans, which are metric-compatible, so the on-screen
paint matches as well as the line breaks do.

### 3.3 Shapes and icons: one mechanism

pdf-lib emits vector art through `drawSvgPath`, which accepts **SVG path data** —
not gradients, not groups, not a full SVG document. That single constraint
decides both features:

- **Shapes** are parametric path generators (rect, rounded rect, ellipse, line,
  arrow, callout) — a function from geometry to a path string.
- **Icons** must therefore be **single-path monochrome** icons, which is exactly
  the Lucide/Feather shape. ~150 curated icons ship as inline path strings in one
  TS module: no dependency, no network fetch (the offline story stays clean),
  recolorable and resizable because they are paths, and lossless to PDF.

One renderer (`<path d=…>` in SVG) and one exporter (`drawSvgPath`) cover both.
Arrows get draggable endpoints and a start/end marker set, because an arrow is
the most-drawn object on a slide and a non-adjustable one is useless.

---

## 4. Snapping

A pure module returning `{ x, y, guides[] }` so the stage only paints what it is
told. Candidates, in priority order:

- page center X / Y, and the page's safe-area margins
- every other object's six anchors (left/center/right × top/middle/bottom)
- **equal spacing** — the gap between two other objects, i.e. distribute-by-drag
- **same size** — during a resize, another object's width or height
- text baselines between two text objects

Modifiers: `Shift` locks the axis, `Alt` suspends snapping.

This gets the heaviest unit-test coverage in the feature. A sign error in
snapping is invisible in code review and infuriating in use.

---

## 5. Animate mode (separate from design)

A distinct mode, as specified — the design canvas ignores animation entirely and
the animate canvas edits nothing else. Two orthogonal axes:

### 5.1 GIF interstitials — the point of the feature

A GIF is **not** a transition effect and **not** an object on a slide. It is a
first-class entry in the slide *sequence*: an animation that plays between slide
*N* and slide *N+1*.

The reason this is the headline feature and not a garnish: a PDF produced by TeX
**cannot carry animation at all**. An author who wants to show a training curve
evolving, a simulation running, or a mechanism moving has to either leave the
deck and alt-tab to a video player, or give up. An interstitial puts the
animation *inside the presentation sequence* while leaving the deck a pure,
TeX-generated, version-controllable PDF. Nothing about the base plate changes.

Model — an interstitial hangs off the slide it follows, so the slide↔base-page
anchoring (§2.1) is untouched:

```ts
interface Interstitial {
  id: string;
  src: string;                 // project-relative path to the .gif
  fit: "contain" | "cover";    // full-bleed letterboxed, or filled
  background: string;          // what shows in the letterbox bars
  /** How it ends. */
  advance:
    | { on: "manual" }                    // loop until the presenter advances
    | { on: "end" }                       // play once, then auto-advance
    | { on: "end-after"; loops: number }; // play N times, then auto-advance
  /** Frame shown in the editor rail, and exported as a still (§5.2). */
  poster: number;
}

interface Slide { …; after?: Interstitial }   // "after this slide, before the next"
```

Presenter semantics: `→` from slide *N* enters the interstitial (it does not skip
to *N+1*); `→` again leaves it for *N+1*; `←` from the interstitial returns to
*N*. It occupies one step, exactly like a build step does.

**Export.** A GIF cannot be a PDF. `talk.export.pdf` therefore writes the
interstitial's **poster frame** as its own page by default, so the exported
handout has a placeholder where the animation was rather than an unexplained jump
— with a per-deck option to omit interstitial pages entirely.

**[verified]** Playback reuses `lib/viewers/gif.ts`, which is dependency-free and
already exposes exactly what is needed: `openGif(bytes, {maxPixelBytes})` →
`GifStream.nextFrame()`, `decodeGif`, and `effectiveDelayMs` (sub-20 ms delays
play at the 100 ms browser convention). Two facts to design around:

- **Memory.** Every frame is a full-canvas RGBA copy — a 1920×1080 GIF costs
  ~8.3 MB *per frame*, so ~30 frames reaches the 256 MB default cap. A transition
  GIF must be opened with a much smaller explicit `maxPixelBytes`, and frames
  pre-baked to `ImageBitmap` so playback is `drawImage`, not `putImageData`
  (which ignores transforms and so cannot scale).
- **Playback.** `GifView`'s rAF accumulator (banked wall-clock × speed, may
  advance several frames per tick, `MAX_CARRY_MS` clamp so a backgrounded tab
  doesn't spin on resume) is correct and should be lifted verbatim rather than
  rewritten.

### 5.2 The other two axes

**Transitions** (slide *N* → *N+1*): `none | fade | push | wipe`. Cheap, purely
cosmetic, and deliberately separate from interstitials — a transition is *how*
one page replaces another; an interstitial is *a thing you show*.

**Builds** (within one slide): each object gets an appear step (0 = visible on
entry) and an effect (`none | fade | rise | scale | wipe | draw`). Space advances
one build step; when a slide's steps are exhausted, space advances to the
interstitial if there is one, and otherwise to the next slide.

Two details without which the mode is unusable: build steps render as **numbered
badges on the objects** in the editor (animation whose structure you cannot see
cannot be reasoned about), and the presenter steps builds **backwards** — `←`
must undo the last reveal, not jump slides, or the first audience question costs
you the whole slide.

---

## 6. The presenter

**[verified]** Two mechanisms already exist and should be used instead of
`requestFullscreen`:

- `useTabsStore.toggleFullscreen(groupId)` (`stores/tabs.ts:589`) gives an
  app-internal full-bleed pane with zero new plumbing — panes stay mounted, it is
  a reposition not a remount, and Escape already clears it. Every viewer already
  receives `groupId`.
- The **dual-window** arrangement (`D`, or the ⧉ button) opens a second OS
  window: audience view on the external display, presenter view on the laptop —
  current slide, next slide, speaker notes, elapsed + wall-clock time, build
  indicator.

**Why the audience window is NOT a detached subwindow (#42).** A popout is a tab
group: a layout, a seed/edit protocol, dock-back, persistence — and *parking*.
That last one is disqualifying: `project_runtime::switch` hides a project-owned
window when its project goes inactive, which mid-talk would blank the projector.
So the audience window is its own thing (`commands/presenter.rs`, ~110 lines):
built by `open_presenter_window`, registered nowhere, owned only by the presenter
that opened it, and destroyed with it. What it *does* borrow from #42 is the two
lessons that path paid for — the command must be `async` (a sync command deadlocks
`WebviewWindowBuilder::build()` against WebView2 on Windows) and the first paint
must be kicked (WebKitGTK's second webview is an unpainted black GL surface until
a genuine OS resize; WebView2's is blank white until shown).

Its label is derived from the deck's **path** (`presenterLabel`), so opening the
second display twice for one talk targets the window already on the projector
instead of stacking another on it. `choose_audience_monitor` puts it fullscreen on
the first monitor the main window is *not* on; with one monitor it opens windowed
and decorated, to be dragged wherever the speaker wants.

**One owner, two heaps.** Two webviews cannot share a store, so the protocol
(`lib/viewers/deck/present.ts`, pure and tested) is deliberately lopsided: the
presenter window owns the stop and the blank screen; the audience window renders
what it is told and forwards the keys pressed *in it* back as requests. A second
index in the audience window is precisely how two displays end up a slide apart
in front of a room. Both windows run the same `keyToAction` map, so a clicker
means the same thing whichever window has focus.

What crosses: the deck as its **serialized sidecar** (small, and the only shape
both halves agree on — the presenter may hold edits the 800 ms autosave has not
written), plus the deck's path and file scope. What does **not** cross: the base
PDF, images and GIF frames — the audience window loads those itself through the
ordinary confined file commands (`deckAssets.ts`, shared with the editor), so a
40 MB plate never becomes an event payload.

Known limit: the laser and marker are drawn on the presenter's window and are
**not** mirrored to the audience one (TODO M#90).

The laser and marker come from `PresentationOverlay`, whose self-contained pieces
(`sizeCanvases`, `drawMarker`, `relPoint`, `pushLaser`, the laser rAF effect, the
palette and width/alpha constants) touch no store, file or tab and lift verbatim.
Its existing themed CSS classes are reusable by name. One caution: it is mounted
**once over every viewer** by `FileViewerPane`, so a viewer-level fullscreen
overlay must not fight it.

Keys: `Space`/`→` next build-or-slide, `←` previous build, `↑`/`↓` slide skip,
`B` black, `W` white, `G` grid overview, `N` notes, `D` second display, digits +
`Enter` goto, `Esc` exit. `G`/`N`/`D` are the speaker's alone — they never leave
the presenter window.

Any portal must target `document.getElementById("root")`, **not**
`document.body` — a body-level portal can fail to paint in a detached popout
webview (documented at `ContextFilePicker.tsx:129-143`).

---

## 7. Generation — three ways in, one deck out

- **From TeX** — point at a `.tex`, compile via `compile_tex`, wrap the output.
- **From a PDF** — any PDF becomes a base plate. The "annotate a paper for
  journal club" path; needs no TeX at all.
- **From blank** — generate a minimal starter `.tex` (title / section / content
  frames) and compile it, so "New presentation" works with zero TeX knowledge
  while the `.tex` stays there, editable, for anyone who wants it.

**[verified] `compile_tex` constraints that shape this:**

| Constraint | Consequence |
| --- | --- |
| Path must end `.tex` and must already exist (`canonicalize`) | write the file before compiling |
| CWD is always the source file's parent | images/assets live beside the `.tex`, or use paths relative to it |
| Output is `<stem>.pdf`, or `outDir/<stem>.pdf` | pass `outDir: "build"` to keep `.aux`/`.log`/`.synctex.gz` out of the deck folder |
| Shell-escape is unconditionally stripped | no `minted`, no TikZ externalization |
| **No timeout; the command is synchronous** | a hanging `latexmk` blocks a Tauri worker, and the frontend has no abort. `-interaction=nonstopmode` prevents the classic interactive hang, but adding a timeout to `commands/tex.rs` is worth doing as part of this work |
| **Local only** — no remote dispatch | a remote project compiles on its **local mirror**. Acceptable (the mirror is local by construction) but must be stated in the UI rather than failing obscurely |

Free wins: the PDF tab already mtime-polls at 1.5 s, so a recompile refreshes the
open base automatically — no invalidation to write. **Beamer appears nowhere in
the codebase** (zero hits), so frames/overlays/`\pause` are entirely new ground.

Deferred: **from Markdown** (`---`-separated markdown → generated Beamer `.tex`).
The fastest authoring path, reusing the existing markdown renderer, but additive
and best landed after the core is real.

---

## 8. Deliberately out of scope

| Not building | Why |
| --- | --- |
| Write-back from canvas to `.tex` | Round-tripping direct manipulation into source is what makes such tools untrustworthy. One-way keeps the contract stateable in one sentence. |
| Rich text runs inside one object | Needs a span model + per-run metrics + a caret that walks runs. A second text object is cheap. |
| Arbitrary font embedding | `@pdf-lib/fontkit` + a font UI; standard-14 covers slides. |
| PPTX import/export | An enormous format surface for a workflow this is not aimed at. |
| Video | Video-in-PDF and video-in-webview are both painful. GIF is already decoded. |

---

## 9. Risks

- **Size.** The largest single feature in the app (~18–20 new files). Phasing is
  mandatory; each phase must leave the tree type-checking and tested.
- **WebKitGTK.** HTML5 drag-and-drop does not work (learned twice already — see
  `stores/pdfDrag.ts` and `YamlTree`); every gesture here is **pointer-based**.
  Animated blurred box-shadows destroy paint performance under software
  rendering, so the presenter uses static-shadow pseudo-elements + opacity.
- **A write per pointermove.** The single easiest way to make this feature feel
  broken; see §2.2 for the gesture-local-state rule that prevents it.
- **`compile_tex` has no timeout and no remote support.** See §7.
- **GIF memory.** See §5.
- **Undo across two modes.** Design edits and animate edits share one document.
  One history stack, not two, or "undo" becomes unpredictable.
- **Fullscreen presenting** is unexercised in this app — a live-QA item.

---

## 10. Phases

Each phase ends with `npx tsc --noEmit` clean and its own tests green.

| Phase | Contents |
| --- | --- |
| **0** | Experimental flag `deck_presenter` (TS `Settings` + Rust `Settings` + accessor + both experimental tests), viewer registration for `*.eldeck.json` (§12), empty `DeckView` shell. |
| **1** | `deck/model.ts` (types + pure ops), `deck/sidecar.ts` (load/save + anchoring + detached bin). Tests. |
| **2** | `DeckStage`: base page render, object layer, select/move/resize/rotate/z-order, `deck/snap.ts` + painted guides. Tests. |
| **3** | Objects: text (+ list styles, PDF-metric wrapping via `deck/fonts.ts`), image, shape generators, `deck/icons.ts` + picker. |
| **4** | Generation: new-from-TeX / from-PDF / from-blank template; compile wiring (+ a `compile_tex` timeout). |
| **5** | `deck/export.ts` — the single pdf-lib flatten, incl. the bottom-left flip. |
| **6** | Animate mode: transitions (incl. GIF) + builds, badges in the editor. |
| **7** | Presenter: fullscreen, dual-window, notes, timer, laser/marker reuse, keys. |

---

## 11. File layout

```
src/lib/viewers/deck/
  model.ts      types + pure object ops (the pageModel of this feature)
  sidecar.ts    load/save, fingerprinting, anchoring, detached bin
  snap.ts       snapping/alignment/distribution → {x, y, guides}
  fonts.ts      standard-14 metrics + wrapping (one source of truth)
  shapes.ts     parametric path generators
  icons.ts      the single-path icon library + categories + search
  animate.ts    transitions/builds model + timing
  export.ts     pdf-lib flatten (the ONLY writer)
  template.ts   starter .tex generation

  present.ts    the dual-window protocol + shared navigation/key mapping

src/components/embed/deck/
  DeckView.tsx        editor shell: rail + stage + toolbar + inspector
  DeckStage.tsx       page + object layer + selection + gestures + guides
  DeckObjectView.tsx  render one object by kind
  DeckInspector.tsx   property panel
  DeckRail.tsx        slide rail (thumbnails, reorder, select)
  IconPicker.tsx      searchable icon grid
  DeckAnimate.tsx     the separate animate mode
  DeckPresenter.tsx   the presenter window (single- or dual-display)
  DeckAudienceApp.tsx the audience window's root (`?present=<label>`)
  DeckSlideView.tsx   a presented slide / interstitial — rendered in BOTH windows
  deckAssets.ts       image + GIF loading hooks, shared by editor and audience
  deckBase.ts         open the base plate, render a page
```

---

## 12. Integration map [verified]

### 12.1 Registering the viewer

**The load-bearing gotcha:** `FileEntry.extension` is only the last dotted
component — the backend builds it with `Path::extension()` (`fs.rs:50-53`) — so
`talk.eldeck.json` arrives as `".json"`. The branch must test **`entry.name`**,
and must sit **before** the `.json → "yaml"` line:

```ts
// fileUtils.ts, in naturalViewerFor, BEFORE line 194
if (entry.name.toLowerCase().endsWith(".eldeck.json")) return "eldeck";
```

| # | File | Change |
| --- | --- | --- |
| 1 | `lib/viewers/fileUtils.ts:39-62` | add `\| "eldeck"` to the `InternalViewer` union |
| 2 | `lib/viewers/fileUtils.ts:149-204` | the name-suffix branch above, before `.json` |
| 3 | `lib/viewers/fileUtils.ts:140-146` | `VIEWER_FALLBACK.eldeck = "yaml"` so an opt-out degrades to the JSON tree, not the external app |
| 4 | `lib/viewers/fileUtils.ts:254-334` | a `VIEWER_PREF_TYPES` entry — **required**, or the type can never be opted out and never appears in Settings |
| 5 | `components/embed/FileViewerPane.tsx:440-479` | the dispatch branch, before the final `else` |
| 6 | `components/tabs/TabHoverCard.tsx:38-56` | `VIEWER_LABEL` is an exhaustive `Record<InternalViewer, string>` — **TS will not compile until this key exists** |

An unknown viewer id persisted on `TabEntry.viewer` falls through to `TextView`,
so older/newer builds degrade safely.

### 12.2 File I/O

Every wrapper in `components/embed/fileAccess.ts` takes the scope as its last
argument, and **remote SFTP is transparent** — each backend command routes
internally on whether the project is remote and the path is outside the mirror.

```ts
readFileText(path, projectId)                 // read_file_text   — 8 MiB cap
readFileBytes(path, projectId)                // read_file_bytes  — 64 MiB cap
writeFileText(path, content, projectId)       // will NOT create a missing file
writeFileBytes(path, content, projectId)      // may create — use for a new sidecar
fileMtime(path, projectId)
```

Scope comes from `useFileScope()` (`fileAccess.ts:19-24`), never a hardcoded
`null`. Errors go through `describeFileError`. A custom backend command is *not*
automatically remote-aware — thread `projectId` yourself.

### 12.3 Rendering over a PDF page

`.file-viewer-pdf-page-wrap` is `position: relative` with the page canvas at
top-left, and already hosts absolutely-positioned overlays (search hits, SyncTeX
highlight). The object layer is another such child, sized
`cssSize.w * scale × cssSize.h * scale`.

The canvas contract (`PdfViewer.tsx:251-280`): device px = pt × scale × dpr,
CSS px = pt × scale.

### 12.4 Per-tab state and new tabs

- Per-tab UI state (current slide) is a new field on `ViewerState`
  (`stores/tabs.ts:177-235`, a flat interface), read via `useViewerState(tabKey)`
  and written with `persist({...})`. `tabKey` is `undefined` in popouts that
  cannot write back — degrade, don't crash.
- Opening the compiled PDF (or any linked file) as its own tab uses
  `openLinkedFile(tabKey, dir, { path, viewer, label })`
  (`FileViewerPane.tsx:633-679`), exactly as TeX's "open the compiled PDF" does
  at `:5877-5888`. It de-dupes against an already-open tab, and because the PDF
  pane mtime-polls, a reused tab reloads the fresh bytes by itself.

### 12.5 Styling

Flat, lowercase, hyphenated, component-prefixed class names in
`src/styles/themes.css` (BEM in `ImageAnnotator.css` is the outlier, not the
convention), with bare state modifier classes (`.on`, `.active`, `.is-dirty`).
Reuse `.modal-backdrop` / `.project-dialog` (accent top rail) for dialogs,
`.context-menu` for popups, `.file-viewer-zoom-btn` + `" active"` for toolbar
toggles, and the `.presentation-*` classes verbatim for the marker/laser bar.
Read colors from the theme variables; note `--bg-header` is a *gradient* in some
themes, so anything needing a color must use `--bg-header-solid`.
