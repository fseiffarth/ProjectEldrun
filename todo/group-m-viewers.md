## Group M — In-App Viewers: Text / TeX / Image Enhancements (Phase 2+)
*Builds on Group D.14 (in-app file→tab viewers). Files: `src/components/embed/FileViewerPane.tsx`,
`src/components/files/markdown.ts`/`tex.ts`/`highlight.ts`, `fileUtils.ts`
(`internalViewerFor`), `src/stores/tabs.ts` (`"embed"` tab kind, `viewer`),
`src/components/embed/EmbedPane.tsx`, backend `commands/tex.rs`
(`tex_capability`/`compile_tex`), `commands/apps.rs` (`embed_capability`,
default-app resolution), `src/types/index.ts`, `README.md`.*

43. **Auto-reload the native text viewer from disk (diff-aware).** When a file
    open in the in-app text viewer changes on disk, reload it with a diff check so
    external edits (agents, git checkout, other tools) surface in the viewer.
    Don't clobber unsaved in-tab edits — detect divergence and reconcile (reload
    when clean; warn/merge-prompt when the buffer is dirty). Likely a file-watch
    or poll on the open file's mtime/hash.
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

44. **TeX viewer: preview off by default.** Default the TeX viewer to the source
    editor rather than auto-rendering a preview; make preview an explicit toggle.
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

45. **Auto-complete in native text viewers (pre-defined model).** Add code/text
    auto-completion across all native text viewers, driven by a pre-defined
    (ideally local) model. Settle the model source (local Ollama vs. configured
    global), trigger/UX, and the privacy posture (no remote calls for local-only
    projects) when picked. *Completion-length modes:* the model can be asked for a
    Sentence (current word/line), Block (current code block/paragraph), or Scope
    (whole enclosing function) completion — set per file type in settings
    (`viewer_prefs[type].autocomplete_mode`) and toggled live in-editor with
    `Shift+Tab` (cycles Sentence → Block → Scope and re-requests). The Rust
    `CompletionMode` drives both the prompt TASK hint and the `num_predict` cap
    (`commands/ollama.rs`). *Accept (while a ghost is showing):* `Tab` inserts the
    whole suggestion; `Right` (→) inserts only the next word and keeps the rest
    ghosted (walk word-by-word); `Esc` dismisses.
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

46. **Undo/redo in native text/TeX viewers.** Add an undo/redo history to the
    in-app text and TeX editors (keyboard `Ctrl+Z`/`Ctrl+Shift+Z` plus buttons).
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

47. **Save icon instead of "save/saved" text (+ optional autosave).** Replace the
    textual save/saved status in the text/TeX viewer with a save icon that
    reflects dirty/clean state; consider periodic autosave (with the #43
    diff-aware reload as the counterpart for external changes).
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

48. **Per-file-type native-viewer settings + document supported types.** A single
    settings surface to configure native-viewer behavior keyed by file type, and
    document the supported types (and the native text viewer) in `README.md`.
    Ties into #44 (per-type preview defaults) and #45 (per-type completion).
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

49. **Make file links in text/TeX viewers visibly clickable.** Render links that
    point at files with a clear affordance (underline / dotted underline) so they
    read as clickable, in both the text and TeX viewers. (Companion to #50, which
    governs *where* a clicked link opens.)
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

50. **Link-open routing: same subwindow, or drag-to-set-default.** When a file
    link (#49) is clicked, open the target in the **same** subwindow by default;
    if the user drags the link to another subwindow, make that the default target
    **only for that file, from that linking file, for this session** — discard the
    mapping when the linking file's tab is closed (and optionally close the
    linked file(s) with it).
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

51. **Native `.odt` / `.xlsx` viewer.** Add an in-app viewer for OpenDocument /
    spreadsheet files. First decide whether it's worth it / already feasible via
    an existing Tauri-side renderer before building one.
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

52. **Image viewer: zoom/scroll to the cursor.** Improve image-viewer scrolling so
    zoom centers on the mouse cursor rather than the viewport origin.
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

53. **Drag images (and their tabs) out as drop sources.** Make images in the image
    viewer — and image tabs — draggable as drop sources, e.g. drag an image/text
    tab and drop it into a browser file-upload field.
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

54. **TeX compile output → PDF in a new tab + compiler options.** Open the
    compiled PDF as its own tab (it is a real file), and add compiler options to
    the TeX viewer (output folder, engine/flags, …). Extends the existing
    `compile_tex` affordance from Group D.14.
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

55. **Adjustable text size in the text/TeX/Markdown editors.** Add an `A−`/`A+`
    control (and `Ctrl` +/−, `Ctrl`+0 to reset) that scales the editor font. In
    the code editors (text/TeX) the gutter and syntax/link/ghost overlay layers
    scale together via the `--code-font-size`/`--code-line-height` CSS variables;
    in Markdown it sizes the source textarea and, once set, the rendered preview
    base font. The size persists per file type in `viewer_prefs[type].font_size`
    (alongside #45's autocomplete).
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

66. **SyncTeX PDF↔source navigation + subtex→main compile wiring.** Make the
    compiled PDF and its `.tex` source navigable both ways, and let a child file
    build its parent. Compiles now always emit `-synctex=1` (`commands/tex.rs`).
    *Reverse search:* clicking a point in a PDF (`PdfCanvas`) runs `synctex_edit`
    and jumps the source tab to that line (via the `editorJump` store +
    `CodeEditor` `gotoLine`). *Forward search:* after a compile, `synctex_view`
    maps the source caret to a PDF box that `PdfCanvas` scrolls to and flashes
    (via the `pdfSync` store). *Subtex wiring:* a successful compile records each
    `\input`/`\include` child→root in `~/.local/share/eldrun/tex_roots.json`, and
    `resolve_tex_root` (magic `% !TEX root` comment → stored map → self) redirects
    a child's Compile to its main document. Adds a compile run animation
    (`.is-compiling` button sheen + header progress strip, reduced-motion aware).
    *Reverse search resolves natively* (`commands/synctex.rs`): `synctex edit`
    sent a click that was not squarely on a glyph — the left margin, a paragraph
    indent, the slack after a short line — into the **wrong `.tex` file**, because
    pdfTeX tags a line's box with wherever `\par` fired and the CLI falls back to
    that tag. The `.synctex(.gz)` is now read directly and the answer taken from
    the leaf records; the CLI stays as the fallback for a PDF with no map.
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

67. **Find in the text/TeX viewers.** Add an in-editor search bar to the shared
    `CodeEditor` (so it covers both the text and TeX viewers). `Ctrl`/`Cmd`+`F`
    opens a floating find bar pinned to the editor's top-right — bound on the
    editor container so it opens whenever focus is anywhere in the tab, not only
    on the textarea. The bar has a query input (seeded from the selection), a live
    `n/total` count, `↑`/`↓` (and `Enter`/`Shift`+`Enter`) to cycle, a `Aa` match-
    case toggle, and `Esc` to close. Matches are painted by a transparent overlay
    `<pre>` layer (`decorateSearchRanges`) scroll-synced like the highlight/link
    layers, the current match brighter; navigation moves the textarea selection
    and scrolls the match into view. Pure helpers `findMatches`/`decorateSearchRanges`.
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

68. **Image viewer: auto-reload on disk change.** Give the image viewer the same
    diff-aware reload as the editors/PDF (#43): `useBlobUrl` polls `file_mtime`
    and re-reads the bytes when the file changes on disk, swapping the blob URL
    only once the fresh bytes are ready (no flash) and revoking the old one. An
    image regenerated by an external tool updates in place; the user's zoom/pan is
    preserved when the new image has the same dimensions, and only re-fit when the
    dimensions change.
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

69. **Persist viewer scroll/zoom across reopen + restart.** The in-app PDF, text,
    and image viewers remember the reader's position so reopening a file — or
    restarting Eldrun — restores it instead of jumping to the top/default zoom.
    A per-tab `ViewerState` (`scrollTop`/`scrollLeft`/`scale`/`offsetX`/`offsetY`,
    `src/stores/tabs.ts`) travels with the `embed` tab through
    `save_tab_layout`/`loadFromLayout` (round-tripped via the Rust `TabEntry`'s
    flattened `extra`, no backend change). The viewer panes
    (`FileViewerPane.tsx`, shared `useViewerState` hook) restore once on first
    load and persist (throttled) as the reader scrolls/zooms/pans; the PDF honours
    a saved zoom over fit-width on first load, and `CodeEditor` gained
    `initialScrollTop`/`onScrollPersist`. `setViewerState` merges + dedups so an
    unchanged write never churns the saveLayout debounce.
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

70. **TeX viewer: `Ctrl`+`S` saves and recompiles.** ✅ Implemented ·
    🧪 Awaiting live QA. In the LaTeX viewer (engine
    available), `Ctrl`+`S` runs `compile()` instead of a plain save — `compile()`
    persists pending edits first, so the PDF preview tracks the source. The
    no-engine fallback keeps `Ctrl`+`S` as a plain save.
    - Shipped at `FileViewerPane.tsx:6348-6350` (`save={() => void compile()}`,
      comment names this item); the no-engine fallback is at `:6156`.
    - [ ] 🤖 Automated test — **genuinely absent**: no `key: "s"` case exists
      anywhere under `src/__tests__/`. The empty boxes here mean "untested",
      not "unstarted".
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

71. **Find in the native PDF viewer (`Ctrl`+`F`).** Add an in-document search bar
    to the pdf.js-backed PDF viewer (the counterpart to #67's editor search).
    `Ctrl`/`Cmd`+`F` (or the 🔍 toolbar button) opens a find bar — a static row
    below the zoom toolbar — bound on the PDF host so it opens wherever focus sits
    in the pane (the scroll area is `tabIndex=0`). It has a query input, a live
    `n/total` count, `↑`/`↓` (and `Enter`/`Shift`+`Enter`) to cycle, a `Aa` match-
    case toggle, and `Esc` to close. Each page's text is extracted lazily on first
    use via `getTextContent()` (shared `pageTextItemBoxes`, the same boxes SyncTeX
    word-refinement uses) and cached per document; the pure `pdfPageMatches`
    (`lib/viewers/tex.ts`) slices matches into big-point boxes (one per text run a
    match straddles). Matches paint as translucent overlays over the page canvases
    (`.file-viewer-pdf-search-hit`), the current one brighter and scrolled into
    view. Pure helper `pdfPageMatches`.
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

80. **PDF page arranging + merging, on ONE code base with the print preview.**
    Turn the read-only PDF viewer into a page organiser: reorder, delete, turn,
    duplicate and merge pages, drag pages from one open PDF viewer into another,
    and drag them **between two Eldrun windows**.

    The print preview already had half of this (a thumbnail strip that
    drag-reorders/deletes/turns pages) — it just never wrote a PDF. So rather than
    build a second page-arranger, its model and its strip were **generalised and
    shared**:

    - **`lib/viewers/pageModel.ts` — the one arrangement model.** A `PageList` of
      `PageRef{id, src, page, rot}`. Each entry carrying its own id/source/rotation
      is what the print preview's old `order: number[]` + rotations-keyed-by-page
      could not express: pages from *several* documents (merge), a duplicate turned
      independently of its twin, and multi-page moves. `print.ts`'s
      `initialOrder`/`movePage`/`removePage`/`rotatePage`/`printSequence` are gone;
      its old test cases were re-expressed against the new model, so the port is
      pinned as behaviour-preserving.
    - **`components/common/PageStrip.tsx` — the one strip.** Horizontal in the print
      preview, vertical as the PDF page rail. `printDocument` keeps its tuned
      imperative modal (iframe, WebKitGTK `@page` workarounds) and mounts the React
      strip into it via `mountPageStrip`. Print preview *gained* shift-select,
      ctrl-select, duplicate and a right-click menu for free.
    - **Writing the PDF (the missing half).** New dep `pdf-lib`, used in exactly one
      place: `pdf/pdfDoc.ts#buildPdf`, on save. Editing never rebuilds the document —
      the reader and rail render straight off the `PageList` — so a reorder is an
      array op, not a re-parse. Save writes through the existing `writeFileBytes`,
      which already routes local **and** remote/SFTP. Explicit save + full undo/redo;
      an external change while dirty raises a banner instead of clobbering either
      side. pdf.js *detaches* the buffer it is handed, so each source keeps a pristine
      byte copy for pdf-lib.
    - **Cross-window drag (`stores/pdfDrag.ts` + `commands/pdf_clip.rs`).** Two
      windows are separate WebViews with separate JS heaps, so the pages are built
      into a small PDF, parked in a backend slot, and only the *token* rides the
      event. Position comes from polling the OS cursor in physical desktop px
      (`lib/coords`), because DOM pointer events don't cross an OS window boundary on
      WebKitGTK — the same reason the tab drag-dock does it. On release every window
      gets the END carrying the last polled cursor; only the one whose rect contains
      it claims the drop and acks. Copy is the default; **Shift moves**, and the
      source deletes its pages *only* once the drop is acknowledged — so a drag
      released over empty desktop can never destroy them.
    - Merge also via a toolbar **Insert PDF…** (the project-scoped
      `ContextFilePicker` — the backend confines reads to the project tree, so an OS
      file dialog's path would simply be refused).
    - **Known limit:** pdf-lib's `copyPages` preserves page content and most
      annotations, but AcroForm fields and some tagged-PDF structure can be lost on
      rebuild. Fine for a page organiser; not a lossless editor for interactive forms.
    - [x] 🤖 Automated test (`PageModel`, `PageStrip`, `PdfSave` — real pdf-lib
      round-trips asserting page order/rotation in the written bytes —, `PdfPageDrag`,
      and Rust `pdf_clip`)
    - [ ] 🖐️ Manual test — **the cross-window drag is the one to watch**: it is the
      WebKitGTK-sensitive path. Also re-check the print preview still reorders/prints
      as before, and that saving works on a **remote (SSH)** project's PDF.
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

87. *(This is group-M's #87; group-O has a different #87.)*
    **Python in the native code viewer: Run, Debug, breakpoints, go-to-definition.**
    Turn the text editor into a usable Python workbench for the three things a
    script actually needs, without importing an LSP or a DAP client.

    - **Run / Debug open a terminal tab** (`lib/pythonRun.ts`) rather than a bespoke
      execution path — the same one-click-open-a-tab-and-run policy as
      `installCommand.ts`. That is what makes them work everywhere Eldrun already
      works, *for free*: a shell tab carries the project's locality and sandboxing,
      so Run on a **remote (SSH)** project runs on the host and Run on a
      **containerised** project runs inside the container, with no code of its own.
      It also means the process is a real interactive terminal — `input()` works,
      `Ctrl+C` works, and the shell outlives the program so the traceback stays on
      screen and `↑` re-runs it. The project's **virtualenv wins** over the system
      interpreter (`.venv`/`venv`/`env`, probed via `list_dir`, which resolves over
      SFTP on a remote project) — running with the bare `python3` would
      `ModuleNotFoundError` on the project's own deps and read as "Run is broken".
      Re-running **replaces** the previous run tab for that file rather than
      re-typing into it: the old PTY may be sitting at a pdb prompt or blocked on
      input, and the command would go to *that*, not to a shell.
    - **Debugging is pdb, driven from the gutter.** Breakpoints are handed to it as
      `-c "b file:N"` followed by `-c continue`, so the session runs straight to the
      first one. With none set the `continue` is omitted and pdb stops at line 1 —
      otherwise "debug" would be indistinguishable from "run".
    - **The gutter is the breakpoint UI** (`CodeEditor`): its line numbers become
      real buttons (so the column drops its `aria-hidden` — hiding a control from the
      a11y tree would make the feature mouse-only). Two things make a breakpoint more
      than a line number, and both live in the pure `lib/viewers/python.ts`: pdb
      *refuses* blank/comment/decorator lines, so a click **snaps** down to the next
      executable one; and a line number silently re-points at the wrong statement
      when you type above it, so every draft change is diffed and the dots are
      **remapped** (a breakpoint inside the edited span is dropped, not guessed at).
      They persist in the tab's `ViewerState` — same plumbing as the reader's scroll
      position, and no backend migration (Rust's `TabEntry` flattens `extra`).
    - **`Ctrl`/`Cmd`+Click follows a name to its `def`** across files, reusing the
      #49/#50 link machinery (`linkRanges` + `onFollowLink`) and `jumpToSource` — so
      it opens in the same subwindow, and works into a detached window. The resolver
      is deliberately **lexical, not type-inferring**: it walks the import graph
      (relative levels, aliases, `__init__` re-exports, src-layout) and matches
      `def`/`class`/module-level bindings. `self.method` resolves in-file. Its honesty
      is the point — only names it can actually follow are underlined, so the
      affordance never lies, and `obj.method()` on a local simply isn't a link.
    - **Which Python it runs** (`commands/python.rs`) is the part that decides whether
      Run is trustworthy at all: a script run with the bare system `python3` when its
      deps live in a venv fails with `ModuleNotFoundError`, and that reads as "the Run
      button is broken", not "wrong interpreter". The backend owns the precedence as
      the **single** source of it — the frontend asks (`python_interpreter_for`) and
      never re-derives, since two rankings that can disagree is a bug waiting to
      happen. A project's pinned interpreter always wins (and then costs no probing);
      otherwise auto-detect ranks **in-tree venv → poetry → active `VIRTUAL_ENV`/
      `CONDA_PREFIX` → pyenv → system**. A **named conda env is offered but never
      auto-picked**: choosing one of N unrelated envs on the user's behalf is a guess,
      and a wrong guess here is indistinguishable from a bug. Pinning is per project
      (pill ▸ **Python interpreter…**, stored like the sandbox spec — `projects.json`
      mirror + `project.json`); the dialog leads with Auto-detect and *shows what it
      currently resolves to*, rather than asking the user to trust an invisible
      decision. A **remote** project probes the **host** (one constant `sh` script via
      `run_remote_script`, so it is one SSH round trip, not six) — the interpreter that
      matters is the one on the machine the run tab actually runs on.
    - **Gated** behind the experimental `python_run_debug` flag (`lib/experimental.ts`:
      off for everyone, on in debug mode). Run *executes a file* one click from an
      editor, so it is opt-in rather than something found by mis-clicking. Go-to-
      definition is deliberately **not** gated — it reads, it never runs anything.
    - [x] 🤖 Automated test (`PythonIntel` — imports/defs/lexer/breakpoint remap +
      resolution incl. circular re-export; `PythonRun` — command building, both
      platforms; Rust `commands::python` — conda/probe parsing, ranking, and that a
      named conda env is never auto-selected; `PythonViewer` — the real UI: gutter
      click sets/snaps/clears a dot, Run/Debug launch the right tab into the file's own
      scope with the resolved interpreter, Ctrl+Click opens the sibling module at its
      `def`, and the flag-off case shows none of it)
    - [ ] 🖐️ Manual test — **the pdb round trip is the one to watch**: set two
      breakpoints, hit Debug, confirm it halts on the first and `c` reaches the
      second. Then check interpreter selection on a project that actually needs it
      (a script importing a dep that only exists in a venv/conda env — and that
      pinning one in the pill dialog sticks across a restart), that Run on a
      **remote (SSH)** project runs on the host with the *host's* interpreter, and
      that Ctrl+Click into a package (`from .pkg import thing` re-exported by its
      `__init__`) lands on the real definition.
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

88. **Native YAML/JSON viewer: an editable structure tree.** Give `.yaml`/`.yml`/
    `.json` the same shape markdown has — a rendered half and a source half behind
    one toggle — except that the rendered half is *editable*: rename a key, retype
    a value, add a key or a list item (with a type picker: text/number/boolean/
    null/map/list), reorder siblings, delete a subtree. Source is the unchanged
    code editor, so these files keep everything they already had (highlighting,
    format, the JSON/YAML validation banner, blame, compare, autocomplete).

    - **The tree edits the TEXT, not a model of it** (`lib/viewers/yaml.ts`): every
      action is a surgical splice back into the draft. Re-serializing the parsed
      model — the obvious shortcut, and what most YAML editors do — rewrites the
      whole file and **drops every comment in it**, which for a config file is the
      one thing you must not do. Splicing is also what makes Tree and Source two
      views on ONE draft: switching converts nothing, and save / undo / redo /
      autosave / the external-change banner keep working on the text underneath
      without either mode knowing the other exists. A tree edit is an ordinary undo
      step.
    - **Both of YAML's syntaxes are first-class, because real files mix them:**
      *block* (`key:` / `- item`, indentation-structured) and *flow* (`{a: 1,
      b: [2, 3]}` — which is exactly **JSON**, inline or spread over twenty lines).
      A flow collection parses into real map/seq nodes with real children, which is
      what makes a JSON-formatted `.yml` — and a `.json` file, the same thing — a
      tree instead of one opaque blob. (The first cut only *tolerated* flow: it
      rendered a multi-line `{` as a single un-editable scalar. That was the bug.)
      **Which syntax a node is written in decides how it is edited** — block splices
      LINES, flow splices its SPAN — and the tree keeps the author's choice: adding
      to `[a, b]` yields `[a, b, c]`, never a silent rewrite into block; deleting
      from it takes the separating comma with it. Every node therefore carries
      absolute offsets; block nodes additionally carry the lines they own.
    - **JSON is a dialect, not a second viewer.** `.json` routes to the same tree
      with `strict` set: no plain scalars, so keys and strings are always quoted and
      only numbers/bools/null go bare. An empty `[]`/`{}` is a real (empty) flow
      collection that grows children in place, in either dialect.
    - **What it offers, it can do.** A construct it can render but not rewrite
      safely — an anchor, an alias, a merge key, a plain scalar continued across
      lines — parses to an `editable: false` node that shows its value as text with
      *no control behind it* (labelled "source only"), rather than an input that
      would corrupt the file. A line it cannot classify at all fails the parse and
      the tree defers to Source, naming the line. Same rule as the Python
      go-to-definition underline: the affordance never lies.
    - **Adding is where the types live.** A new entry is written with the literal
      its picked type demands — so "no" and "8080" chosen as *text* come out quoted,
      which is what makes them the strings the user meant. A key that already holds
      a value refuses a child rather than silently destroy it.
    - Opting the viewer out (#48) falls back to the **plain code editor**, not the
      external app (`VIEWER_FALLBACK`) — turning off the tree is a vote against the
      tree, not against editing YAML/JSON in Eldrun.
    - [x] 🤖 Automated test (`YamlModel` — parse/edit ops: comments, quoting style,
      CRLF and no-trailing-newline round-trips, block scalars, `- key:` items,
      anchors, multi-doc; flow: inline and multi-line collections, nesting, add
      inline-vs-on-its-own-line, delete-with-comma, span-swap reorder, unclosed
      bracket refused; JSON: whole-document parse, strict writing, empty-file seed;
      and that an unsupported construct is refused rather than guessed.
      `YamlViewer` — the real UI: a `.yaml` opens in the tree, an edit saves the
      file with its comments intact, add/rename/delete/reorder, Source shows the
      tree's edit and it undoes like a typed one, a JSON-formatted `.yml` renders as
      a tree (the regression), and a `.json` file writes the strict dialect.
      `InternalViewer` — `.yaml`/`.yml`/`.json` route to the tree, and the opt-out
      falls back to the code editor)
    - [ ] 🖐️ Manual test — open a real config with comments (a CI workflow, a
      `docker-compose.yml`, a `package.json`): edit a value in the tree and confirm
      the comments and layout are untouched, that Source shows the same edit, and
      that `Ctrl`+`Z` walks it back. Check a flow/JSON-formatted file adds and
      deletes in its own style, and that a file with an anchor/merge key
      (`<<: *base`) renders those rows read-only instead of offering a broken input.
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

89. **CSV table viewer: a separator you can name, and cells you can edit.**
    📄 **Doc drift:** `README.md:369` still describes the table viewer as a
    *"Read-only grid … windowed to keep the webview responsive"*, which this item
    replaced (editable cells, delimiter picker, `ColumnsMenu`). Update it.
    The
    table viewer (#40) read every `.csv` as comma-delimited because that is what
    the *extension* implies — so a `;`- or `|`-delimited file (a European export,
    a database dump) split into rows but not into **columns**, and arrived as one
    tall single-column table. Four things follow from fixing that properly:

    - **The separator is sniffed, and stays overridable** (`sniffDelimiter`). Each
      candidate (`,` `;` `\t` `|`) is scored by parsing a sample *with that
      candidate* — so a comma inside a quoted field can't fool the `;` reading —
      and asking how rectangular the result is. A character that never splits a row
      is rejected however consistently it fails to appear, which is what stops `,`
      from "winning" a semicolon file with a perfect score of one column per row.
      The header offers Auto / Comma / Semicolon / Tab / Pipe / a **custom
      character**. An explicit override persists per tab (`ViewerState.delimiter`);
      Auto deliberately does not, so the sniffer stays free to read better later.
    - **Cells are editable, and an edit is a SPLICE** (`replaceCell` /
      `insertRowAfter` / `deleteRow`) into the text draft `useEditableFile` already
      owns — the same bargain #88 strikes for YAML comments. Re-serializing the
      parsed rows would rewrite every field in the file, normalising away each
      one's original quoting and the file's line endings, to change one cell. So
      the table is a **view on the text**: a cell edit is an ordinary
      dirty/undoable/autosaved/`Ctrl`+`S` change, and the bytes nobody touched are
      still there. It is also why sorting and filtering carry each row's **source
      index** (`RowRef`) — a splice must address the row a cell came *from*, not
      the row it currently occupies on screen.
    - **Only the visible rows render.** The old cap ("showing first 2000 rows")
      is gone; the body is windowed against the scroll position, so a million-row
      CSV is fully browsable. The column widths are therefore measured over the
      whole file *up front* — sizing them to what happens to be on screen would
      resize every column as the reader scrolled.
    - **A filter box**, matching any cell case-insensitively, and a row-number
      gutter showing the source row (with a delete, plus `+ Row` in the header).
    - **Columns hide from a list of their names** (`ColumnsMenu`): click a name to
      hide that column, click it again to bring it back. It is a *multi*-select, so
      it does not close on a click — hiding six of twenty columns is one visit to
      the menu, not six — and a hidden column stays listed, struck through, because
      the list is the only way back. Two consequences: the row **filter searches
      only the visible columns** (a row matched on a hidden cell would appear with
      nothing on it to explain why), and hiding is dropped when the **delimiter**
      changes, since a hidden column is only an *index* and a different separator
      cuts the row into different columns. The rendered columns keep their original
      indices rather than being re-numbered, so an edit still addresses the column
      the cell came from.

    - [x] 🤖 Automated test (`table.ts` — sniffing: semicolon/pipe/tab/comma, a
      comma inside a quoted `;` field, the single-column fallback; spans: quoted
      fields, BOM offsets, CRLF, terminated-vs-unterminated final row; edits:
      quoting only when needed, other cells' quoting left alone, CRLF preserved,
      ragged-row padding, insert/delete round-trips; filter/sort keeping the
      source index; the filter scoped to the visible columns)
    - [ ] 🖐️ Manual test — open a real `;`-delimited export and confirm it opens
      **in columns** with `Auto (Semicolon)` shown; force the separator to Comma
      and back and watch the columns re-cut; set a custom one. Edit a cell in a
      quoted CSV and confirm in Source that only that field changed. Scroll a
      large CSV to the bottom (columns must not resize as it scrolls). Sort, then
      filter, then edit a visible cell — the change must land on the row it was
      shown in, not the row at that screen position. Hide a few columns from the
      Columns list, confirm they come back on a second click and survive a reopen,
      and that editing a cell to the *right* of a hidden one still writes the right
      field.
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work
    - [ ] **Deferred:** inserting/deleting a **column** (a row op is one splice; a
      column op is one splice per row, and every splice invalidates the offsets
      after it — the same constraint `moveNodeTo` faces in `yaml.ts`). Editing an
      `.xlsx` also stays out: it arrives pre-parsed from `calamine`, with no source
      text for a splice to land in.

---

90. **Native presenter ("deck"): a PDF-based presentation editor and presenter.**
    A TeX/PDF-first presentation surface, behind the experimental
    `deck_presenter` flag. Plan and rationale: `docs/deck_presenter_plan.md`.
    Three separable halves: **generation** (a base PDF from `.tex`, from an
    imported PDF, or from a generated starter template), **design** (editable
    object layers — text with list styles, images, shapes, single-path icons —
    with snapping and alignment guides), and **presenting** (fullscreen, speaker
    notes, per-object build steps, and **GIF interstitials**: a clip that plays
    *between* two slides, which is the only way a TeX-generated PDF can carry
    animation at all).

    The structural decision is that the **sidecar is the document**: layers live
    in `talk.eldeck.json` beside `talk.pdf`, never inside it, because `latexmk`
    rewrites the PDF on every compile. Slides re-anchor across a recompile by
    SyncTeX source line (already emitted, previously thrown away) and fall back
    to a content fingerprint; anything that cannot be placed is set aside in a
    detached bin rather than dropped.

    - [x] **Phase 0** — experimental flag (TS + Rust), `*.eldeck.json` viewer
      registration (matched on the *filename*: the backend's `extension` is only
      the last dotted component, so a deck arrives claiming to be `.json`).
    - [x] **Phase 1** — `lib/viewers/deck/model.ts` (pure object/slide ops, the
      presenter sequence) and `sidecar.ts` (defensive parse, fingerprinting,
      re-anchoring, detached bin).
    - [x] **Phase 2** — `DeckStage` (base page, object layer, select/move/resize/
      rotate/z-order, marquee) and `deck/snap.ts` (page/margin/object/equal-gap/
      same-size snapping with painted guides).
    - [x] 🤖 Automated test — 119 cases across `DeckModel`, `DeckSidecar`,
      `DeckSnap`, `DeckTransform`, `DeckExport` and `DeckTemplate`. Notable:
      re-anchoring when a slide is inserted, SyncTeX beating a stale fingerprint,
      ambiguous fingerprints being refused, orphan layers detached not dropped,
      the y-flip and rotate-about-centre worked by hand, wrap parity, and every
      export limitation surfacing as a warning.
    - [x] **Phase 3** — text (list styles + standard-14 metric wrapping via
      `deck/fonts.ts`, shared with the exporter so the export cannot reflow),
      images, `deck/shapes.ts`, and `deck/icons.ts` (~80 icons, directional
      variants derived by rotation) with a searchable picker + property inspector.
    - [x] **Phase 4** — generation: **from a PDF** (the PDF viewer's "Present"
      button writes the sidecar and opens it), **from TeX** (a `.tex` compiles to
      a PDF tab, which then presents), and **from blank** (a deck with no plate
      offers to write a starter Beamer `.tex` and compile it — it never
      overwrites an existing one). Plus a **10-minute timeout for `compile_tex`**
      with pipe-draining reader threads, so a wedged `latexmk` can no longer hold
      a Tauri worker for the session.
    - [x] **Phase 5** — `deck/export.ts`, the single pdf-lib flatten, on top of
      `deck/transform.ts` (the bottom-left flip and rotate-about-centre anchor,
      which existed nowhere in the repo). Reports what PDF cannot do — a cropped
      `cover` image, a missing icon — instead of dropping it silently.
    - [x] **Phase 6** — animate mode (a separate mode, as specified): per-object
      build steps with numbered badges, slide transitions, and **GIF
      interstitials** — `Slide.after`, a clip that plays *between* two slides as
      its own stop, which is the only way a TeX-generated PDF can carry animation.
      Exports as its poster frame.
    - [x] **Phase 7** — the presenter: fullscreen portal, `sequence()`-driven
      navigation (so `←` steps a build backwards rather than losing the slide),
      speaker notes + elapsed timer, overview grid, black/white screens,
      type-a-number-to-jump, and `PresentationOverlay`'s laser + marker reused
      verbatim.
    - [x] **Dual-window presenter** (`D` / ⧉): a second OS window shows the
      audience view — fullscreen on the first monitor the main window is *not*
      on — while the presenter window becomes the speaker's console (current
      slide, next slide still-preview, notes, elapsed + wall clock, build
      indicator). Deliberately **not** a detached subwindow (#42): a popout is
      *parked* when its project goes inactive, which mid-talk would blank the
      projector. One owner, two heaps — the presenter window owns the stop, the
      audience window renders what it is told and forwards its own keys back
      (`lib/viewers/deck/present.ts`, pure + tested), so the two displays cannot
      drift apart. The deck crosses as its serialized sidecar; the base PDF,
      images and GIF frames do not — the audience window loads those itself.
    - [ ] **Known gap:** the laser/marker overlay is drawn on the presenter
      window and is **not** mirrored to the audience one, so in dual-window mode
      the room does not see the pointer. Needs the stroke/laser stream to cross
      windows (the `DETACHED_DRAG_*` cursor stream is the precedent). *Now
      tracked as [Group V](group-v-presenter.md) #127, with the letterbox-normalization
      trap noted.*

    > **⚠️ Before the manual QA below, see [Group V](group-v-presenter.md)
    > (#93–#141).** A three-way static analysis of the shipped code found two
    > defects that **destroy authored work with no prompt** — the debounced
    > autosave is cancelled on unmount (#93) and a newer-version deck is
    > silently downgraded and overwritten (#94) — plus six failures that would
    > show up in front of a room on first use: auto-advancing GIFs skip a slide
    > in dual-window mode (#95), export throws on any non-WinAnsi character
    > (#96), the audience window's WebKitGTK paint kick is skipped in exactly
    > the case it exists for (#97), Escape-to-holster-the-laser ends the talk
    > (#98), "Present fullscreen" only fills the app window (#99), and the
    > SyncTeX anchoring described above **is never populated at runtime**, so
    > every deck falls through to a fingerprint that Beamer overlays defeat by
    > construction (#100). The 148 automated cases cover only the pure modules;
    > all of the above live in `DeckView`'s effects and `presenter.rs`, which
    > have no coverage. Fix #93–#100 before spending a projector session on the
    > two manual-test items.
    - [ ] 🖐️ Manual test — open a `.eldeck.json` beside a compiled PDF; drag,
      resize and rotate objects and confirm the guides name the right reason;
      recompile the `.tex` with a slide inserted and confirm layers follow their
      slides; confirm the autosave lands (there is no save button by design).
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work
    - [ ] 🖐️ Manual test (dual-window, **on real hardware with a projector or
      second monitor**) — `D` opens the audience window fullscreen on the *other*
      display, not over the notes; advancing on either window moves both; `←`
      steps a build backwards on both; `B`/`W` blank the audience screen too;
      closing the audience window from the WM drops back to one screen without
      ending the talk; `Esc` ends the talk and takes the audience window with it;
      opening the second display twice re-uses one window. With **one** monitor
      it opens windowed and decorated, draggable onto the projector.
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work
    - [ ] **Known gap:** `compile_tex` is **local-only** (no remote dispatch), so
      a remote project must compile on its local mirror. (It is also a
      *synchronous* Tauri command, so every compile freezes the window — see
      [Group V](group-v-presenter.md) #105.)

    **Follow-on work: [Group V](group-v-presenter.md) #93–#141** — post-Phase-7 hardening
    and gaps, organized as V.1 blockers (data loss + first-real-use failures),
    V.2 correctness and core usability, V.3 performance, polish and the
    differentiated bet.

91. **Native `.bib` viewer: one card per bibliography entry.** ✅ Implemented ·
    🖐️ untested. Give `.bib`/`.bibtex` the same two-halves shape `.yaml` has — a
    structured half and a Source half behind one toggle — but as a **flat list of
    cards**, one per `@article{…}`, each holding its `field = {value}` pairs as
    key/value rows. Cards is the default; Source is the unchanged code editor, so
    a `.bib` keeps everything it had (highlighting, find/replace, blame, compare,
    autocomplete, the save/undo path).

    - **The cards edit the TEXT** (`lib/viewers/bib.ts`), the #88 bargain applied
      to a second format: every action is a splice, so field order, the alignment
      somebody sorted by hand, brace-protected `{LaTeX}` capitalization, an older
      file's `"…"` quoting and the `%` comments all survive an edit, and a card
      edit is an ordinary dirty/undoable/saveable change on the draft Source
      shows. Ops: retype a value, rename a field, rename the citation key, change
      the entry type, add/delete a field, delete an entry, add a new `@misc`.
    - **It is NOT a drill** — that is the one place it parts with `YamlGrid`. A
      `.bib` has no nesting: it is a few thousand records at one level, so the
      value is the list itself. What that needs instead is a **filter** across
      every key, type and field value, and a **per-card fold** (persisted per tab
      in `ViewerState.bibCollapsed`; the filter deliberately is not, or a reopen
      would hide most of the file with no visible cause).
    - **What it refuses to touch is visible.** A value that is a `@string` macro
      reference or a `#` concatenation renders read-only, in full — rewriting
      `journal = jml` as `{jml}` would silently change the rendered bibliography.
      Text belonging to no record (the `%` comments) is reported in a note rather
      than hidden, since a card view that quietly omits part of a file is worse
      than none. Duplicate citation keys — silently wrong, the processor keeps one
      — are flagged on the card.
    - **One parser for the format**: `tex.ts`'s `parseBibEntries`, which feeds the
      `\cite` completion dropdown, is now an adapter over the same parse, so the
      card view and the completion list cannot disagree about what is in a `.bib`.
      Ctrl+clicking `\bibliography{refs}` in a `.tex` now lands in the cards.
    - Tested in `src/__tests__/BibViewer.test.ts` (21 cases: the tolerant parse,
      the delimiter/locked-value rules, and every op's splice-not-rewrite
      guarantee).
    - [ ] 🖐️ Manual test — open a real `.bib` (a Zotero/Mendeley export, ideally
      one with `@string` macros and a `%` header): confirm the entry count, that a
      value edit lands in Source byte-identical apart from that value, that
      `Ctrl+Z` undoes it as one step, that the filter finds an entry by author and
      by title, that a fold survives closing and reopening the tab, and that
      deleting a field leaves no blank line behind.
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

92. **The PDF's own hyperlinks (`hyperref` cross-references and URLs).** ✅
    Implemented · 🖐️ untested. A PDF carries its links as *link annotations* — a
    rectangle on a page plus an action — and the native viewer painted the page
    without them, so every `\ref`, `\eqref`, `\cite`, `\autoref`, footnote mark
    and table-of-contents row in a LaTeX document was inert text. The reader had
    the contents sidebar (#pdf-outline) and go-to-page and nothing else: following
    a citation meant reading its number, opening go-to-page and typing it.

    - **Two actions are honoured and nothing else.** A **GoTo** (an internal
      destination — the overwhelming majority in an academic PDF) scrolls; a
      **URI** leaves the app. A form widget, a `Launch` naming a local program, a
      `GoToR` into another file and a named action (`NextPage`) are **not
      rendered at all**, because a box that highlights under the cursor and then
      does nothing reads as a bug, and a rendered box that starts a program is a
      hole. `pdf/links.ts` is the whole model, pure but for the destination
      lookup.
    - **The jump lands ON the target**, not at the top of its page: a destination
      names a y anchor (`/XYZ`, `/FitH`, `/FitR` — each in a different argument
      slot), so `destTop` reads it, `destTopInBigPoints` converts it through the
      *target* sheet's own viewport (which is why `PdfDest.top` stays in the
      file's units until the jump — only the jump knows the turn the viewer has
      applied), and a band marks where it landed. A whole-page `/Fit` names no
      line and falls back to the page top.
    - **There is a way back.** Following a `\cite` is only useful if returning is
      one gesture, so the scroll position is pushed on a bounded stack and a `←`
      toolbar button (and `Alt`+`←`) pops it. The button appears only once there
      is somewhere to go back to.
    - **An external link is confirmed, and the confirm is `MailMessageView`'s.** A
      PDF is untrusted content the moment it was not written by the reader, and
      `\href` *defines* the display text and the address as independent — so the
      host is called out and the full address shown, monospace, wrapping, never
      ellipsis-truncated. Opening goes through `lib/linkTarget`'s routing with
      `origin: "viewer"`, so it can never become a live in-app page in one click,
      and `routeUri` re-checks the scheme pdf.js already refused. There is
      deliberately no "always open links from PDFs".
    - **One destination resolver for the whole viewer**: `outline.ts`'s
      `resolveDest` now serves both the contents sidebar and the links, so a
      chapter and a `\ref` to the same anchor cannot disagree about where it is.
      Resolutions are cached per document (weakly), since a bibliography page
      points a hundred links at a handful of anchors.
    - **Ctrl/⌘-click still means SyncTeX.** The link layer sits over the canvas,
      so the modifier is checked first and the reverse-search click is measured
      against the canvas rather than the event's own target; the boxes take the
      crosshair cursor while it is armed. Only pages of the file itself carry a
      link layer — a merged-in page's destinations point into *its* document.
    - Tested in `src/__tests__/PdfLinks.test.ts` (the geometry, the destination
      slot rules, and every annotation shape that must be dropped).
    - [ ] 🖐️ Manual test — open a `hyperref` PDF (any LaTeX paper with citations):
      confirm a `\cite` jumps to the bibliography entry and `←` comes back, that a
      `\ref` lands on the equation rather than the page top, that the boxes follow
      a zoom and a page turn, that a `\url` raises the confirm and Cancel opens
      nothing, and that Ctrl+click on a link still reverse-searches into the
      source.
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

93. **Black out text in a PDF, securely (#pdf-redact).** ✅ Implemented ·
    🖐️ untested. The viewer could rearrange a PDF but not remove anything *from* a
    page, so the one thing people actually need before sending a document out —
    covering a name, an address, a reviewer's identity, a key — had to be done in
    another application, or was done in this one by drawing a black box in an
    annotation tool and shipping the text underneath it.

    - **A black rectangle is not a redaction, so the feature never draws one.**
      Covering a word leaves every glyph in the content stream: select-all, copy,
      `pdftotext`, or deleting the annotation gives it straight back, and that is
      the standard way redactions leak. A mark here names an *area to destroy*.
      At save, each sheet carrying one is rendered to pixels, the marked areas are
      painted out of *those*, and the image becomes the page (`pdfDoc.ts`'s
      `flattenPage`). What is destroyed with the text is the rest of that page's
      text, vectors, links and tagging — a real cost, which is why **only marked
      sheets are flattened** and every other page is copied across intact.
    - **The content-stream surgery alternative is deliberately not on offer.**
      Dropping just the glyphs inside each box keeps the page, but doing it
      correctly means tracking text state, font metrics and form XObjects well
      enough to know where every glyph lands — and a redaction that is subtly
      wrong is worse than one that is heavy-handed.
    - **Marks are ordinary arrangement edits.** They ride on the entry
      (`PageRef.marks`, big points in the sheet's rotated space — the space the
      search hits and link boxes already use), so they follow zoom and rotation
      for free, travel with a page that is moved, are copied by a duplicate, are
      covered by the existing undo/redo and dirty flag, and touch the file only at
      Save. `lib/viewers/redact.ts` is the whole pure model.
    - **Two ways to mark, and the fast one is the point.** A drag over the page
      marks an area (**snapped out to the words it touches**, on by default — a
      box drawn by eye clips ascenders and word ends, and the burn-in is
      pixel-exact, so an unsnapped mark is how a legible sliver of the redacted
      word survives). And "black out all N matches" marks every Ctrl+F hit in the
      document from the same measurement the highlight is drawn from: a name out
      of a 200-page report is a search and one click, not 300 drags. Re-running it
      stacks no duplicates, and a mark that merely *clips* a hit does not count as
      covering it.
    - **The irreversible step is confirmed and priced.** Save raises a banner
      naming both numbers (areas, and pages that become images) and what is
      removed permanently — never the silent half of a Save pressed to reorder two
      pages. Quality is Draft/Standard/Sharp (150/200/300 dpi), JPEG, with the
      raster capped at 40 MP so an outsized page loses resolution rather than
      content.
    - **Every route out of the viewer carries the blackouts.** Printing paints
      them onto the rasters it prints, and a page dragged into another viewer or
      window is exported *burned in* — a mark that travelled as an editable
      overlay would arrive as a page whose text is still there under a box.
    - Tested in `src/__tests__/PdfRedact.test.ts` — including end to end through
      pdf-lib: a real PDF with real text is marked, saved, and its decoded content
      streams are searched for the word that was supposed to be destroyed.
    - [ ] 🖐️ Manual test — open a PDF, arm ▮, drag over a line (confirm the box
      snaps to the words and the rail thumbnail shows it too), search for a word
      and "black out all matches", then Save: confirm the banner names the right
      counts, that the saved page renders identically minus the blacked areas, and
      that selecting/copying that page — or `pdftotext` over the file — returns
      none of the redacted text.
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

94. **Delete a PDF's metadata (#pdf-meta).** ✅ Implemented · 🖐️ untested.
    The blackout tool covers what is *on* the page; nothing covered what the file
    says about *itself*. A PDF out of Word, LaTeX or a scanner carries an author,
    the machine account that wrote it, which software and version produced it, and
    the minute it was made — none of it visible in any reader, all of it going out
    with the file. Sending a document out therefore meant a round trip through
    `exiftool` or another application, after doing the redaction here.

    - **The fields are shown before the deletion is offered.** A bare "Delete all
      metadata" button acts on something the reader can neither see beforehand nor
      verify afterwards, which makes it indistinguishable from a button that does
      nothing. The 🏷 panel lists what is actually there — the `/Info` fields that
      are filled in, any non-standard ones the producer invented, and whether an
      XMP packet is present — read through pdf.js (`readPdfMetadata`) so the panel
      and the document in front of the reader cannot disagree. It reads **on
      open**, not at load, so nobody pays for it on the reload of every recompile.
    - **It is pending, not immediate.** One flag on the save rather than an
      arrangement edit — there is no page it belongs to — so it is as cancellable
      as every other edit here, one Save writes the lot, and the armed state shows
      on the toolbar button with the panel closed. It is also the only thing that
      makes Save reachable on an otherwise untouched file, which `dirty` reads.
    - **Three stores, three answers.** The `/Info` dict is never *created*:
      pdf-lib stamps its own Producer, Creator and a `CreationDate` of **now**
      onto every `PDFDocument.create()`, so a strip declines it at the source
      (`updateMetadata: false`) instead of deleting it afterwards. The catalog's
      XMP never comes across, the output being a fresh document. The **page**
      level genuinely does — `copyPages` brings each page dict over as it stands —
      so `/Metadata`, `/PieceInfo` (Illustrator and Word keep whole working
      documents in there) and `/LastModified` are deleted from it.
    - **Deleting the key is not enough, and that is the real work.** pdf-lib
      serializes every object registered in the context, reachable or not, so an
      XMP stream whose last reference has just been removed would still be written
      into the file in full: gone from the structure, perfectly readable in the
      bytes — the same shape of failure as a rectangle drawn over live text.
      `collectGarbage` is a mark-and-sweep from the trailer, run before `save()`,
      safe by construction (anything the catalog reaches is kept) and early enough
      that a redacted sheet's images are not yet registered.
    - **The deletion travels with a page dragged out**, for the blackouts' reason:
      those bytes are what lands in the other viewer.
    - Tested in `src/__tests__/PdfSave.test.ts`, asserting against the **saved
      bytes** rather than the object model — the failure being guarded against is
      precisely a field that survives in the file after the model says it is gone.
    - [ ] 🖐️ Manual test — open a PDF with a real author/producer (anything out of
      Word or `pdflatex`), open 🏷 and confirm the listed fields match what
      `exiftool` reports, click "Delete all metadata", Save, then re-run
      `exiftool` on the file: confirm it reports no Title/Author/Creator/Producer
      and no dates, that `strings` over the file finds none of the old values, and
      that the pages still render and their text still selects.
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

95. **Remarks on a PDF (#pdf-notes).** ✅ Implemented · 🖐️ untested.
    The viewer could rearrange a PDF, black text out of it and strip its
    metadata, and could not do the one thing a reader does most: write something
    next to a paragraph. Reading a draft therefore meant a second application
    open beside this one, or a comment landing in a mail instead of on the page
    it is about.

    - **A remark is the PDF's own annotation, not a sidecar.** It is written into
      the file as a `/Text` annotation — the sticky note every reader draws — so
      what is saved here opens as a comment in Acrobat, Okular, a browser's viewer
      and whatever a colleague uses, and a comment written *there* opens here.
      Nothing is stored beside the document, because a comment only Eldrun can see
      may as well not have been written. `Contents` is a hex (UTF-16BE) string, so
      a remark outside PDFDocEncoding survives; `/F` is `Print` and nothing else.
    - **The gesture is right-click, not an armed tool.** No mode to enter and none
      to leave, which is the deliberate difference from the blackout beside it: a
      blackout is destructive and wants a mode you can see you are in, a comment
      is something you do in the middle of reading. Right-click any page → "Add
      remark here"; right-click a marker → edit or delete it.
    - **A sheet's remarks are owned all-or-nothing.** `PageRef.notes` is absent
      while the file's own annotations are merely displayed; the first edit adopts
      the *whole* set for that page, and a save rewrites that page's `/Text`
      annotations from it while leaving every other page's — and every *other*
      annotation on that page, its links above all — untouched. The alternative,
      matching per-annotation edits across a rewrite, is the bookkeeping that
      silently duplicates or drops a comment. The cost is a foreign note's exotic
      parts (rich text, a reply thread, a custom popup box) on a page the reader
      actually edited a remark on, and only there.
    - **The menu waits for the page's own remarks to be read.** That list is the
      baseline an edit adopts, so offering the action early would take "no remarks
      here" as the truth and delete the file's comments at the next save. The read
      is lazy per page, on the link layer's gate and for its reason.
    - **Nothing invents an author.** New remarks are unsigned unless a name is
      typed into the card, and the OS login is deliberately never consulted: a
      document leaves the machine, and a real name would leave with it.
    - Pending remarks ride the arrangement, so undo/redo, the dirty flag, the page
      rail and a page dragged into another document all cover them for free; a
      **flattened** (blacked-out) sheet keeps its remarks though it keeps nothing
      else, since a comment about what was destroyed is the reader's own work.
    - Tested in `src/__tests__/PdfNotes.test.ts`, asserting against the **saved
      bytes**: that a remark is a real `/Text` annotation, that an untouched page's
      comments are unmoved, that a touched page's are replaced rather than doubled,
      that a link is never disturbed, and that two copies of one duplicated sheet
      do not share an annotation array.
    - [ ] 🖐️ Manual test — right-click a page, add a remark, Save, then open the
      file in **another** PDF viewer (Okular, Firefox, Acrobat) and confirm the
      note is there with its text; edit and delete it in that viewer, reopen here
      and confirm Eldrun shows the change; then open a PDF that already carries
      comments, add one of your own and Save, and confirm both survive.
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

96. **Selecting text in a PDF (#pdf-textselect).** ✅ Implemented · 🖐️ untested.
    The reader paints pages to a canvas, and a canvas has no text in it. Until
    now the only way to get a sentence out of a PDF open in Eldrun was to retype
    it, or to copy the *region* as an image (the ✂ tool, which is a picture of
    the words rather than the words) — while Ctrl+F could already find them, which
    is the same text, read for a different purpose.

    - **pdf.js's own `TextLayer`, not a hand-rolled one.** One transparent,
      correctly-placed span per text run, so the browser's ordinary selection
      lands on the glyphs the reader sees and Ctrl+C copies what the file says.
      The CSS is a scoped copy of `pdfjs-dist/web/pdf_viewer.css`'s `.textLayer`
      rules rather than an import of that file, which also styles a whole viewer
      application we do not use.
    - **A mode, not scenery.** ~~So it is armed from the toolbar (`T`) like the
      blackout and the region-copy, and turns both off.~~ **Superseded by #99**:
      it is not a mode any more. The layer is up on every near page and the tool
      button is gone.
    - **Only near pages build one**, on the canvas render's gate and for its
      reason; and a zoom costs nothing, because pdf.js lays the spans out in the
      page's own units and scales them through `--scale-factor` — the same bargain
      the link boxes and the search hits strike by storing big points.
    - [ ] 🖐️ Manual test — see #99, which replaced the mode this describes.

97. **Remarks: autosave, moving one, and a panel to walk them (#pdf-notes).**
    ✅ Implemented · 🖐️ untested. Three things #95 left undone, each of which made
    remarks cost more than the comment was worth.

    - **A marker drags to a new spot.** A right-click places a remark exactly
      where the pointer was, and where the pointer was is regularly a line off;
      without a move, correcting one meant deleting it and retyping the text. The
      gesture shares the marker with the click that opens the card, so distance
      tells them apart (3 CSS px, so it means the same at 40% and at 400%) and the
      click is swallowed only when the pointer travelled. `pointercancel` commits
      like `pointerup` — the trap the tab and card drags document. The anchor is
      clamped by the icon's own box, not by the point, so a remark cannot be
      parked half off the sheet with its `/Rect` outside the media box.
    - **Autosave, and what it refuses to carry.** A remark is written into the
      file ~1.2 s after the last one is made, so a reader who writes one has
      finished the job. It is a **silent** write: no reload, no repaint, no
      scroll reset, no spinner, and the undo history and every remark id survive
      it — the written sheets simply give up their ownership and what was written
      becomes the file's own remarks in the cache, under the same ids. That
      reconciliation is safe because the gate below admits nothing but the
      identity arrangement (so a sheet's cache key stands for exactly one entry),
      and because a sheet edited while the bytes were in flight keeps its
      ownership — its `notes` array is no longer the one that was written. The safety is entirely in the refusal: a save writes the
      *whole* arrangement, so an autosave that fired with a page move pending
      would commit the move, and one that fired with a blackout pending would
      flatten the sheet — the single irreversible edit here, and one that is
      deliberately confirmed. Hence `isPristineExceptNotes`: remarks may be the
      only thing pending, the file must not have changed underneath, and a pending
      metadata deletion counts as something else. When it is holding, the panel
      says so, because a switch that is on and quietly doing nothing is worse than
      one that was never offered. Per tab (`ViewerState.pdfAutosaveNotes`), default
      **on**, so only turning it off stores anything.
    - **A panel that lists every remark in the document, and walks them.** The
      markers answer "is there a comment here?"; they cannot answer "what did
      anyone say about this paper?", because the answer is spread over forty
      sheets and each marker holds its text behind a click. The panel is the
      *reading* surface — a row carries the whole remark, wrapped and never
      clipped — with ↑/↓ walking a **ring** in the document's own reading order
      (`placedNotes`: sheet, then down the page, then across it, never the
      annotation array's order). A row click goes to the marker and flashes it; ✎
      opens its card; ✕ deletes it.
    - **One owner of the file's remarks.** Reading a page's annotations mints
      fresh ids (a PDF's annotation reference is document-scoped and rewritten on
      every save), so the page canvas reading its own set and the panel reading
      another would give two sets of ids for one comment, and "go to this remark"
      would address one the page had never heard of. The read is hoisted to the
      viewer, keyed by source/page/rotation, requested by a page when it comes
      near and by the panel for the whole document when it opens.
    - Tested in `src/__tests__/PdfNotes.test.ts`: the reading order and the ring,
      that the arrangement's set wins over the file's for a sheet it has taken
      over, that a remark is addressed by its entry so a reorder follows it, the
      drag clamp, and what `isPristineExceptNotes` refuses to let an autosave
      carry along.
    - [ ] 🖐️ Manual test — add a remark, wait a second and confirm the Save button
      goes clean on its own and the file on disk carries the note (another viewer,
      or reopen the tab); drag its marker a few centimetres, wait, and confirm the
      new position survives a reload; open 💬, confirm every remark in the document
      is listed with its page, walk it with ↑/↓ and confirm the page follows and
      the marker flashes; then reorder two pages and confirm the panel says
      autosave is holding and nothing is written until Save.
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

98. **Ctrl+F over a word split across two lines (#71).** ✅ Implemented ·
    🖐️ untested. A PDF has no words and no lines — only positioned runs of glyphs
    — so a wrapped paragraph arrives as `"hyphen-"` then `"ation"`. The search
    joined the runs end to end, which produced `hyphen-ation`: searching for
    *hyphenation* found nothing on a page that plainly prints it, and two whole
    words either side of a break joined into `theend`, so a phrase that happened
    to wrap could not be searched for at all. On a typeset document (which is
    most of what this viewer opens) that is a large share of the words on every
    page.

    - **A break is now read, not ignored** (`pageHaystack` in
      `lib/viewers/tex.ts`): a trailing hyphen at a line end is dropped, joining
      the halves into the word the typesetter split; any other break becomes a
      space, which is what it means to a reader — unless one of the two sides
      already carries whitespace.
    - **A dash that is punctuation is left alone.** Only a hyphen-minus, a
      typographic hyphen and a soft hyphen are dropped; an en or em dash at a
      line end is a range (`pages 3–\n4`), and joining it would invent `34`.
    - **pdf.js's own `hasEOL` outranks the geometry** (`TextItemBox.eol`), since
      it is the producer's answer rather than a guess — which is also why an
      empty run, pdf.js's bare end-of-line marker, is now folded into the run
      before it instead of being skipped with the other empty ones. Where the
      flag is absent the geometry stands in (clearly below, or starting back to
      the left).
    - **The highlight stays honest**: a per-character map back to (run, offset)
      means the boxes are still sliced out of the runs' own geometry, so a match
      across a break draws one box per line, and a match running *through* a
      dropped hyphen covers it rather than stopping a glyph short of the word it
      matched. Case folding is per character for the same reason — `İ` folds to
      two characters, and lowercasing the joined string would shift every index
      after it and slide the boxes off the words.
    - The blackout tool's "black out all N matches" inherits all of it, since it
      marks from exactly these boxes: a redacted name that wrapped is now covered
      on both lines.
    - Tested in `src/__tests__/TexSync.test.ts`.
    - [ ] 🖐️ Manual test — find a paper with a hyphenated line break, search for
      the whole word and confirm both halves highlight (hyphen included) and that
      Enter walks onto it; search a two-word phrase that wraps and confirm it is
      found; then check a page range like "3–4" split over a line does not match
      "34".
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

99. **Selection without a mode, highlights with remarks, and copy-on-select
    (#pdf-textselect, #pdf-notes).** ✅ Implemented · 🖐️ untested. Three asks that
    turned out to be one feature: select text *on the page* (not behind a tool),
    highlight it and write a remark on the highlight, and have a selection reach
    the clipboard by itself.

    - **The `T` tool is gone.** Selecting words in a document is what a pointer
      over text does everywhere else, and #96 made it a mode only because
      pdf.js's text layer takes the pointer over the whole sheet. The answer is
      the one pdf.js's own viewer uses: everything that needs its own click (link
      boxes, search hits, markers, highlights, the blackout and region-copy
      surfaces) is stacked **above** the text layer by `z-index` in `themes.css`,
      which leaves the plain drag — the one gesture nothing else wants — to the
      text. That stack is load-bearing: drop a `z-index` from one of those layers
      and it silently stops being clickable.
    - **A highlight IS a remark.** `PdfNote.quads` is the whole distinction:
      without it a remark is a sticky note at a point (`/Text`), with it a
      highlight over the words those boxes cover (`/Highlight`), whose remark is
      that annotation's own `/Contents`. One model, so the ownership rule, the
      baseline, the panel, the walk, the undo history, the autosave gate and the
      save are written once — a second parallel model would be a second chance
      for those answers to disagree. What genuinely differs is small and real: a
      highlight has no drag, has a colour worth changing, opens its card *under*
      the sentence, and clearing its text does not delete it (marking a sentence
      is a complete act; the remark is the optional half).
    - **Reading `/Highlight` is what the text layer bought.** `notes.ts` used to
      ignore the subtype and said why: a highlight is painted by the page render
      itself, so surfacing it here would draw it twice, and a viewer with no text
      layer cannot know which words one would cover. Both halves are now
      answered — the words come from the selection, and the doubling is settled
      by suppressing the file's own paint for a highlight we have read
      (`{ noView: true }` in pdf.js's annotation storage, keyed by the annotation
      id kept on the remark as `srcId`, with every render switched to
      `ENABLE_STORAGE`). Exactly one thing on screen draws each highlight and it
      is the one that can be clicked. The suppression map is **not** derived from
      the remark cache: an autosave replaces a sheet's cached remarks with the
      ones it just wrote, which carry no `srcId`, so a derived key would empty
      itself and the file's originals would come back underneath ours.
    - **The bar over a selection** (`PdfSelectionBar`) is four highlighter
      colours — a swatch *is* the highlight button, because marking a sentence is
      a mid-reading act and a two-step one is a step too many — plus 💬 for
      "highlight and write a remark", plus the copy chip.
    - **Copy-on-select is on by default and reversible where it happens.** The
      chip both reports the copy ("Copied") and turns the behaviour off for this
      document (`ViewerState.pdfCopyOnSelect`, per tab). A clipboard write cannot
      be taken back, so the honest control is the next one, not an undo of this
      one. The write is on `mouseup`/`keyup`, never on `selectionchange`, which
      fires on every pixel of a drag.
    - **A drag across a page break** is one selection to the engine and one
      annotation per sheet to a PDF, so `selection.ts` sorts the range's client
      rects into the page wrappers they land in and clips them — the cross-page
      case falls out of the same code as the ordinary one. Line rects are merged
      along a line (a sentence crossing a font change arrives as five boxes, and
      five overlapping quads at 40% each are visibly darker at every seam) and
      never across lines (that would paint the leading between them).
    - **An appearance stream is written** for every highlight, with a `Multiply`
      `ExtGState`: optional in the format, and written anyway for the readers
      that do not synthesise one (a printer's rasteriser, a thumbnail service, an
      old viewer). Multiply is also what keeps black glyphs black instead of
      dragging them towards the fill colour.
    - **The quoted words are display-only** and never written into the file: they
      are already on the page, and a copy of them in the annotation is a second
      version of the sentence that stops being true the moment the document is
      edited. Asserted against the saved bytes.
    - Tested in `src/__tests__/PdfNotes.test.ts` (model, annotation read, and the
      saved bytes), `src/__tests__/PdfSelection.test.ts` (the rect merge) and
      `src/__tests__/PdfNoteUi.test.tsx` (a highlight through the real UI).
    - [ ] 🖐️ Manual test — open a PDF and drag across a paragraph with no tool
      armed: the selection should follow the words, a bar should appear over the
      end of it, and the text should already be on the clipboard (paste it
      somewhere). Click a swatch and confirm the sentence is marked in that
      colour; click the mark and write a remark; check the 💬 panel lists it with
      the quoted words. Save, reopen the file, and confirm the highlight and its
      comment are still there and are shown by another reader (Okular, a browser)
      — and that it appears **once**, not twice. Then: a link and a remark marker
      must still be clickable, Ctrl-click must still reverse-search, the blackout
      and ✂ tools must still take their drag, and a selection dragged across a
      page break must produce one highlight per page.
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

100. **Markdown viewer: cross-file `#fragment` navigation.** ✅ Implemented ·
    A preview link like `docs/guide.md#setup` now opens the target *and*
    scrolls its preview to the heading. The click posts the fragment to
    `stores/mdAnchor` keyed by the target's absolute path (`openLinkedFile`
    may re-activate an existing tab, so a prop cannot carry it — the same
    shape as `stores/editorJump` for SyncTeX line targets); the target's
    `MarkdownView` consumes it once its preview is rendered. Fragment→id
    matching (`matchAnchorId` in `lib/viewers/markdown.ts`) tries the decoded
    fragment verbatim, then its slugified form (a link written as the
    heading's visible text), then case-insensitively; in-page `#anchor`
    clicks go through the same matcher.
    - [x] 🤖 Automated test (`src/__tests__/MdAnchor.test.ts`)
    - [ ] 🖐️ Manual test — in one md file write `[x](other.md#some-heading)`
      and click it in Preview: the other file should open scrolled to that
      heading; click again from the source file (repeat jump must re-fire).
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

101. **Markdown relationship graph (opt-in `md_graph`).** ✅ Implemented ·
    A third "Graph" mode on the markdown viewer, behind the `md_graph`
    experimental flag (Settings → Experimental; on by default in debug mode):
    the viewed document's local-file links crawled breadth-first
    (`lib/viewers/mdGraph.ts` — markdown targets followed, every other file a
    leaf, unreadable md targets drawn as missing, capped at 120 nodes) and
    rendered as clickable SVG on concentric depth rings
    (`components/embed/MdGraphView.tsx`). Clicking a node opens that file
    through the same `openLinkedFile` routing a preview link uses. Reads ride
    the confined `read_file_text` with the pane's project scope; the crawl is
    one bounded pass per look, never a background poll.
    - [x] 🤖 Automated test (`src/__tests__/MdGraph.test.ts`)
    - [ ] 🖐️ Manual test — enable the flag, open `PROJECT.md` in a scaffolded
      project, switch to Graph: the scaffold files should ring the center;
      click `README.md` to open it; delete a linked file and rebuild (↻) to
      see it dashed red.
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

102. **`PROJECT.md` scaffold: the navigation entry point.** ✅ Implemented ·
    New and imported projects (and the scaffold repair) now also get a
    `PROJECT.md` — a map linking every other scaffold file with one line on
    what it is for, so a fresh project can be walked from a single file via
    the md viewer's link-following (#49/#50) and the graph (#101). Listed
    first in `SCAFFOLD_FILES` (`commands/projects.rs`), linked from
    `AGENTS.md`'s Project docs, named in the agent scaffold-fill prompt as
    the map to keep working, and in `STANDARD_PROJECT_FILES` so the tree
    sorts it with the other standard docs. Never overwritten when present.
    - [x] 🤖 Automated test (scaffold tests in `commands/projects.rs`)
    - [ ] 🖐️ Manual test — create a new project and check `PROJECT.md`
      exists, links resolve in the viewer, and an existing project picks it
      up via scaffold repair without touching other files.
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

103. **PDF region capture rides the global Screenshot app.** ✅ Implemented ·
    The PDF viewer's ✂ "select and copy as image" toolbar tool is gone; the
    same region capture is now armed by the header's global Screenshot button
    instead. Pressing Screenshot while a PDF viewer is visible offers the shot
    to it first (claimable `eldrun:screenshot-capture` window event,
    `lib/screenshot.ts`; first visible viewer claims, so the OS region tool is
    only spawned when no PDF is on screen). The drag captures from the rendered
    page canvas (document-sharp, pending blackouts burned in), copies the PNG
    to the clipboard AND files it as `screenshots/Screenshot-….png` in the
    PDF's own project (`write_project_file_bytes`) — the global screenshot's
    file-plus-clipboard contract. One press is one shot; Esc cancels.
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test — open a PDF, press the header Screenshot button:
      the capture bar should appear (no OS tool); drag a region and check the
      clipboard paste and the new file under `screenshots/`; press Screenshot
      with no PDF visible and check the OS region tool still runs; Esc while
      armed cancels without a shot.
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

211. **Migrate project: step-by-step scaffold/entry migration.** ✅ Implemented ·
    Project Settings (file-view gear) grew a Migration section whose "Migrate
    project…" opens a reviewed, per-step migration dialog — the counterpart of
    the pill's all-at-once "Repair scaffold files". `project_migration_plan`
    (commands/projects.rs) is a pure dry-run listing one step per missing
    piece: normalize the `projects.json` entry (directory backfill, legacy
    `git_type` — the fields the type tags derive from), each missing scaffold
    file, each untouched legacy agent-doc stub, missing default `.gitignore`
    patterns (named in the step), `.claude/settings.json`, and `git init`.
    Every step renders with what it would change plus Accept/Decline;
    `project_migration_apply` runs only the accepted ids and re-checks each
    condition on disk, so a stale accept is a no-op, never an overwrite.
    Frontend: `ProjectMigrationDialog.tsx` + pure `migration.ts` helpers.
    - [x] 🤖 Automated test (`commands/projects.rs` migration tests,
      `src/__tests__/ProjectMigration.test.ts`)
    - [ ] 🖐️ Manual test — needs a backend restart (two new commands). On an
      old project (or one with a deleted scaffold file / legacy `# Claude
      Context` stub): open the file view's ⚙ → Migrate project…, check each
      step lists correctly, decline one step and apply — the declined change
      must not happen, the accepted ones must; re-open: only the declined
      step remains; an up-to-date project says so.
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work
212. **Project remarks follow-ups.** REMARKS.md v1 leaves directory roll-up
    badges, FileBrowser's unscoped context menu, MarkdownView's edit-mode
    add-at-line button, and fs-watch-driven live badge refresh for later. The
    current surfaces refresh on project/view demand to avoid background SFTP
    polling.
221. **TeX workspace: fold the Structure sidebar, and a Back step.** ✅ Done
    2026-08-31, code-complete and **live-unverified**. Two controls, both in the
    workspace's only chrome (its sidebar header), because the center is whatever
    viewer is showing and has none to spare.
    - **Fold** — `‹` in the header puts the sidebar away and leaves a 26 px rail
      carrying `›` to bring it back. Never a bare pane edge: a sidebar
      recoverable only from a settings panel is a one-way door, and this tab has
      nowhere else to put the control. Persisted per tab as
      `ViewerState.texSidebarHidden` beside `texSidebarWidth` (absent = shown, so
      only the reader who folded it stores anything) — frontend-only, **no
      backend restart**, since `viewerState` already round-trips through the
      layout save. Also on the no-structure placeholder header, or a document
      whose gather failed could not be folded at all.
    - **Back** — `←`, beside the fold on both surfaces (one `TexBackButton`, so
      the two cannot describe the same step differently). Every path that
      replaces the center now goes through one `goTo`: a sidebar click, an
      in-document `\ref`/link follow, a SyncTeX reverse jump — so the stack
      cannot miss a navigation. Session state, bounded at 50 and **not
      persisted** (a stack restored from disk would offer to go "back" to a file
      this sitting never left); cleared when the tab's Local/Remote switch
      re-roots every path. Shown **disabled**, never hidden, when the stack is
      empty — it is the tab's only navigation control, and one that appears the
      moment a file is opened is one nobody finds before they need it. No
      keyboard binding: `Alt+←` is the PDF viewer's own back step, and a PDF
      opened in the workspace centre would be answering for both.
    - i18n: `texWorkspace.hideStructure` / `showStructure` / `back` /
      `backEmpty`, 4 strings × 5 languages.
    - [x] 🤖 Automated test (`src/__tests__/TexWorkspace.test.tsx` (h) fold →
      rail → back, persisted; (i) sidebar click then ← returns the centre and
      the button goes inert again)
    - [ ] 🖐️ Manual test — open a multi-file `.tex` as a workspace: fold the
      sidebar (tree gone, rail with two buttons remains), reopen the tab and
      confirm it is still folded, unfold from the rail. Then click a child
      `.tex`, a graphic and a `\ref` in turn and walk back through them with ←;
      check the button's tooltip names the file it would return to, that it is
      inert on the main document, and that a resize still works after unfolding.
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

250. **TeX workspace: an Up step to the parent's `\input` line, and hotkeys
    for Up and Back.** ✅ Done 2026-09-02, code-complete and **live-unverified**.
    #221's ← retraces where the centre has *been*; this adds `↑`, beside it on
    both surfaces (header and folded rail), that climbs the document's own tree:
    from a chapter to the `\input{chapter}` line of the file that inputs it,
    whether or not that parent was ever centred this sitting.
    - **Where it lands** — `gatherTexStructure` now records the 1-based
      line/column of every `\input`/`\include`/`\subfile` and
      `\includegraphics` it lists (`TexFileNode.line`/`column`, same on
      graphics), and `texStructureParent` answers "who inputs this, and where".
      Up is an ordinary `goTo` (so ← undoes it) followed by an editor-jump
      request to that line — landing at the parent's top would leave the reader
      searching for the line they just came from. A file inputted twice is
      listed once, under the parent that reached it first, so Up goes there.
    - **Hotkeys** — `Ctrl+Shift+↑` (up) and `Ctrl+Shift+↓` (back), rebindable
      as `texUp`/`texBack` in a new "TeX workspace" group of the Keyboard
      Shortcuts panel and cheat sheet. **Only while the TeX viewer has focus**:
      the workspace listens on its own root element rather than through
      `useKeyboard`, which scopes the chords to "focus is somewhere in this
      workspace" (the editor's textarea included — the global hook's editable-
      target guard would drop them there) and makes them work in a popout with
      no per-window wiring. A chord with nowhere to go is not consumed. The
      button titles show the resolved chord, so a rebound key is what the
      tooltip says. Frontend-only, **no backend restart**.
    - The defaults were `Ctrl+Shift+U`/`B` until 2026-09-02, changed at the
      user's request: on a GTK desktop with IBus, `Ctrl+Shift+U` is the input
      method's own unicode-entry chord and can be eaten before the page sees it
      while a textarea is focused. The arrows collide with no other default
      (the subwindow-cycling arrows are Shift-only) and the workspace consumes
      the chord, so the textarea's own paragraph selection never runs.
    - i18n: `texWorkspace.up` / `upEmpty` / `backChord`,
      `shortcutHelp.group.tex`, 4 strings × 5 languages.
    - [x] 🤖 Automated test (`src/__tests__/TexStructure.test.ts`: line/column
      per reference incl. a nested child and a graphic, `texStructureParent`
      for child/graphic/root/unlisted; `TexWorkspace.test.tsx` (m) ↑ inert on
      the main, climbs from the child with the jump to line 3, ← returns; (n)
      the chords from the editor textarea and the workspace root, and a chord
      fired outside the workspace does nothing)
    - [ ] 🖐️ Manual test — open a multi-file `.tex` workspace, click a chapter
      in the sidebar, press `↑` (or `Ctrl+Shift+↑` with the caret in the
      editor): the main file is centred with the caret on its `\input{…}` line,
      scrolled into view. `Ctrl+Shift+↓` returns to the chapter. Open a graphic
      from the sidebar and go up — the caret lands on the `\includegraphics`.
      Check both buttons are inert on the main document, that the tooltips name
      the file, line and chord, that the rail (folded sidebar) carries all three
      buttons, and that the chords do nothing with a terminal tab focused. Then
      rebind `texUp` in Settings → Keyboard Shortcuts and confirm the tooltip
      and the key follow.
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

241. **PDF viewer: present the file fullscreen in a window of its own.** ✅
    Implemented (2026-09-01, untested live) · `▶ Fullscreen` in the PDF toolbar
    opens the PDF as a window with nothing else on it — no tab bar, no toolbar,
    one sheet fitted to the screen on black. For reading a beamer deck off a
    projector without popping the whole workspace out.
    - **The window** is the deck presenter's own
      (`commands/presenter.rs::open_presenter_window`) under a `present-pdf-<hash
      of path>` label, so it inherits the placement, the WebKitGTK/WebView2
      first-paint kick, the second-monitor takeover and the idempotent
      open-or-focus for free — and, being inside the `present-*` glob, the window
      capabilities. The one thing added for it is `fullscreen: Option<bool>`:
      **the deck's audience window stays windowed on a single-monitor machine**
      (the speaker drags it onto the projector, keeping the notes view), which is
      exactly wrong here, where the screen becoming the sheet *is* the button.
      **Backend restart** for that argument; without it the window opens
      windowed and the renderer's own post-paint assert fullscreens it.
    - **`App` routes on the label**, not on a second query parameter: a deck
      label carries exactly one hyphen, so `present-pdf-` can never collide with
      one. Both branches are lazy — pdfjs-dist has no business in another
      window's startup chunk.
    - **The seed carries the path, the scope and the sheet**, never bytes: the
      window opens the file itself over the confined file commands, so a 130 MB
      thesis is not an event payload. It therefore shows the file **as saved** —
      an unsaved page arrangement stays in the tab, which the button's tooltip
      says while there is one. Once seeded the window navigates **itself** (a
      talk has two displays that must agree; this is one), and pressing Present
      again re-seeds it to the sheet now on screen.
    - Keys: `←`/`→` (also `↑`/`↓`, PgUp/PgDn, Space, `n`/`p`, click and wheel)
      turn a sheet, digits + `Enter` go to one, Home/End jump to the ends, `F11`
      windows it, `Esc` closes it. Holds the deck presenter's sleep inhibitor
      while it is up, so the projector does not blank in a long Q&A.
    - i18n: `pdfViewer.fullscreenPresent{Title,DirtyTitle,Label,Btn}` and
      `pdfPresent.{waiting,opening,loadError,keyHint}`, 8 strings × 5 languages.
    - [x] 🤖 Automated test (`src/__tests__/PdfPresent.test.ts`: one label per
      path, never confused with a deck label, valid as a window label and through
      `?present=`, page clamped before the document is open)
    - [ ] 🖐️ Manual test — open a PDF, scroll to a middle sheet and press
      `▶ Fullscreen`: the sheet appears fullscreen on black with the page counter
      bottom-right. Turn pages with the arrows, a click and the wheel; type a
      number + Enter; press Esc. Press Present again from a different sheet and
      confirm the same window comes back to the front on that sheet rather than a
      second one opening. On a two-monitor machine, confirm it takes the *other*
      screen. With unsaved page changes, confirm the tooltip says so and the
      window shows the saved file.
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

242. **TeX editor: grey out `comment` blocks, and a linewise comment toggle.** ✅
    Implemented (2026-09-01, untested live) · Two halves of the same gesture —
    seeing what is commented out, and commenting it out.
    - **`\begin{comment}` … `\end{comment}`** (the `comment`/`verbatim` package)
      now greys out as one `tok-comment` span, delimiters included, the way a `%`
      line does. Nothing inside is tokenized: the body is not LaTeX any more, it
      is text the compiler throws away, so a `\section` in there must not read as
      a live one. An unclosed block greys to the end of the file — again what the
      compiler does with it. Only the `comment` environment: every other
      environment keeps its `tok-type` name (`scanTex`/`texCommentEnvEnd` in
      `lib/viewers/highlight.ts`).
    - **Ctrl/Cmd+Shift+C** toggles line comments over every line the selection
      touches, in the *native editor generally*, not just TeX: `%` in a `.tex`
      file, `//`, `#`, `--`, … elsewhere from the highlighter's own language table
      (`lineCommentMarker`), and a no-op where the language has none (JSON,
      markdown, HTML — wrapping every line in `<!-- -->` is a different gesture).
    - Comment-or-uncomment is decided by what is already there: it uncomments
      only when **every** non-blank line is already commented, so a
      partially-commented block commutes to fully commented first and a second
      press always round-trips. The marker goes in at the block's *shallowest*
      indent (relative indentation survives), blank lines are skipped rather than
      left holding stranded markers, and uncommenting drops the marker plus at
      most one following space — `%% x` keeps its second percent, since a
      deliberate double-comment is not this gesture's to undo.
    - Commits through the ordinary `edit()` path, so undo/redo, the dirty mark
      and the syntax overlay all stay consistent, and the selection is restored
      over the same text afterwards.
    - [x] 🤖 Automated test (`src/__tests__/EditorLineComment.test.ts`: markers
      per language, round-trip, partial→full, indent alignment, blank-line skip,
      selection ending at a line start; `Highlight.test.ts`: the comment block,
      an unclosed one, and other environments unaffected)
    - [ ] 🖐️ Manual test — open a `.tex` file, wrap a few lines in
      `\begin{comment}`/`\end{comment}` and confirm the whole block greys out
      while the text after it colours normally. Select a few lines and press
      Ctrl+Shift+C: each gets `% ` at the common indent, the selection still
      covers them; press again and the text comes back exactly as it was. Try it
      with the caret on a single line, on a block that is already half
      commented, and in a `.py`/`.ts` file (`#`/`//`).
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

243. **TeX editor: Ctrl+click an `\input{…}` that isn't there yet offers to
    create it.** ✅ Implemented (2026-09-01, untested live) · Following a
    reference to a file that does not exist opened a tab whose only content was
    "This file no longer exists" — but a `\input{chapters/intro}` written before
    the chapter is an ordinary state of a document being written, not a broken
    link. The click now raises a one-line offer in the viewer's own notice
    chrome (`tex-install-banner`): *chapters/intro.tex doesn't exist yet* ·
    **Create the file** · **Cancel**. Creating writes an empty file and opens it
    exactly as an existing target opens — the workspace centre for an
    in-structure child, its own tab otherwise.
    - A banner, not a modal: the click was aimed at the editor, the caret is
      still where it was, and declining must cost nothing.
    - Offered only for a reference an *empty file* is a valid first version of —
      `\input`/`\include`/`\subfile` (`.tex`) and
      `\bibliography`/`\addbibresource` (`.bib`), i.e. the commands whose default
      extension the viewer already assumes. Never a `\includegraphics` (there is
      no format to invent, and an empty one breaks the build rather than waiting
      to be written), never an extension the command does not assume
      (`\input{fig.png}` is a mistake, not a new file), never an absolute token.
    - A reference naming a subfolder of the document's own (`chapters/`) creates
      that folder too, and the offer *says so* before it does. A `../` token
      creates no folder — that tree is outside the document's own and not this
      offer's to build.
    - **The write overwrites, so the existence check is re-taken at the moment it
      is acted on** (`createTexRefFile`): a stat that does not answer reads as
      absent, which is usually true and is not always, so the one reading that
      could empty somebody's chapter must not be a stale one. A file that turned
      out to be there is simply opened.
    - Existence is stat'd through **`file_mtime`**, the scope-confined
      absolute-path read the editor's reload poll already makes, and that is what
      keeps a *remote* project working: `project_path_exists` canonicalizes a
      local path and cannot see a host tree, and a `list_dir` of the parent only
      routes over SFTP for a project's own registered directory — either would
      have called every existing `\input` of a remote document missing and
      offered to overwrite it. The create is `write_file_bytes` for the same
      reason (the one create that routes over SFTP). The folder step is the
      exception, project-addressed `create_dir`, so a remote project fails it
      with the host's own message rather than silently.
    - [x] 🤖 Automated test (`src/__tests__/TexLinks.test.ts`: what each command
      would create, the declines, the folder pair, `texPathExists` and the
      command it stats with, folder-then-file creation, an existing folder left
      alone, and the re-check writing nothing when the file was there)
    - [ ] 🖐️ Manual test — in a `.tex` file type `\input{chapters/intro}` for a
      chapter that does not exist and Ctrl+click it: the banner names
      `chapters/intro.tex` and says the folder would be created too; press Create
      and the empty file opens (in a TeX workspace, in the centre). Repeat with a
      sibling `\input{notes}` (no folder line), with `\bibliography{refs}` (opens
      the bib cards), and Ctrl+click a `\includegraphics{figs/plot}` that is
      missing — no offer, as before. Cancel must leave the document untouched.
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

245. **LaTeX editor: the standard features it was still missing.** ✅
    Implemented (2026-09-01, untested live) · The TeX viewer could compile,
    jump both ways through SyncTeX, follow an `\input`, complete a `\ref` and a
    `\cite`, and list a build's errors — and could not do the four things every
    other LaTeX editor does. Four separable additions, one number because they
    are the same complaint: the parts of writing LaTeX the editor left to the
    typist.
    - **Command completion.** Typing `\se` offers `\section`, `\setlength`, …
      from a **curated standard table** (`TEX_STANDARD_COMMANDS`, ~200 entries:
      structure, text, references, floats, math, the definition forms) rather
      than a parse of the installed distribution — reading `texmf` would offer
      thousands of commands from packages the document never loads, and the
      value of a completion list is entirely in what it leaves out. Accepting
      seeds the mandatory `{}` arguments with the caret inside the first
      (`\frac` → `\frac{|}{}`), and adds none when the text already continues
      with a brace, i.e. when the name of an existing command is being
      corrected. Matched by **prefix only**: a substring match over two hundred
      names offers `\varepsilon` for `\ps` on every keystroke.
    - **Environment completion, and `\end{…}` written for you.** Inside
      `\begin{`/`\end{` the same dropdown offers the standard environments plus
      every one this document defines (`\newenvironment`, `\newtheorem`) or
      already uses — using one is evidence enough, since the table cannot know
      which packages were loaded. Accepting a `\begin{align}` on a line with
      nothing after it **opens the block**: `\end{align}` on its own line at the
      `\begin`'s indent, a body line between them (carrying `\item ` for a
      list), and an argument the environment cannot compile without seeded with
      the caret in it (`tabular` → `{|}`). It never does so when a matching
      `\end` is already ahead (nesting counted), when text remains inside the
      braces, or when the line continues past them — restructuring a line
      somebody is in the middle of is the one thing an autocomplete must not do.
    - **The build's warnings, not just its errors.** A LaTeX build that
      *succeeds* is the normal case and is where nearly everything worth fixing
      is reported: an undefined `\ref` prints a bold `??` in the PDF and
      compiles happily, a missing citation `[?]`, an overfull `\hbox` a line in
      the margin. The viewer parsed errors and nothing else, so the reader found
      the `??` by reading the output — exactly the trip to the PDF the SyncTeX
      work exists to save. `parseTexWarnings` reads the `… Warning: …` family
      (continuation lines folded in, a package's `(name)` gutter marker
      stripped, `on input line N` picked up wherever it landed) and the bare
      `Overfull/Underfull \hbox` reports, into a collapsed card with jump-to-line
      per row.
    - **Which file a warning is in is *tracked*, not guessed.**
      `-file-line-error` applies to errors only, so a warning carries a line and
      no file; the file comes from following the `(path … )` nesting TeX prints
      as it opens and closes each source — parens counted for depth whatever
      they hold (`(12.3pt too wide)` and a hundred other asides), only
      source-extension paths remembered, closing a depth forgetting every file
      at or below it. A warning the nesting could not place carries **no file**
      and falls back to the build root rather than naming a guessed one. The
      tracking is only as good as the log's line breaking, so `run_in` now sets
      `max_print_line`/`error_line`/`half_error_line` in the compile
      environment — the engine's own knobs against the 79-column wrap that
      splits a path across two lines. A backend test tripwires those three,
      because deleting them breaks the attribution with nothing failing.
    - **A word count that means something.** "How long is it?" is asked of every
      piece of academic writing by something with a limit attached, and a `.tex`
      answers it worst: `wc -w` counts
      `\includegraphics[width=0.8\textwidth]{figures/plot.pdf}` as four words.
      `texWordCount` reads the source the way `texcount` does — the preamble is
      not text, a control sequence is not a word, a formula is one object,
      verbatim and `tikzpicture` are not prose, headings and captions are
      counted **apart** (that is how a limit is normally written) — and
      `gatherTexWordCount` sums it over every `.tex` the document reaches, from
      the *draft* of the file on screen rather than its last save. Deliberately
      shallow like the rest of the module: it does not expand macros, so a
      `\newcommand` producing three words counts as none. That is the right side
      to be wrong on — a count that silently inflates is worse than one the
      writer knows is a floor.
    - **A local macro is marked as one.** A candidate the document itself
      defines sorts first and wears a `local` pill: it is the one entry in the
      list whose meaning nobody can look up.
    - **The completion trigger learned two refusals it should always have had**:
      nothing is offered inside a `%` comment (a `\sec` in a note about the
      document is prose), and a bare `\` opens nothing — it is the first
      keystroke of `\\`, `\[` and `\%`, and a list of every command over it
      would fight the typist.
    - [x] 🤖 Automated tests (`src/__tests__/TexCompletions.test.ts` — the two
      new contexts and their refusals, the `\newcommand`-family and
      environment parsers, and every branch of both inserts including the
      nested-`\end` case; `src/__tests__/TexLogWarnings.test.ts` — a realistic
      two-file log: kinds, lines from both spellings, file attribution across a
      close, a wrapped warning, a package marker, deduplication, and errors not
      being read as warnings; `src/__tests__/TexWordCount.test.ts` — body vs.
      preamble, headings/captions counted apart, math as objects, verbatim and
      machinery arguments skipped, and the unterminated-group cases;
      `commands::tex::tests::compile_env_disables_log_line_wrapping`)
    - [ ] 🖐️ Manual test — **needs a restart** (the compile-environment change
      is backend). In a `.tex` file type `\se` and confirm the dropdown offers
      `\section` with a `{…}` signature; Tab, and the caret lands inside the
      braces. Type `\begin{ite` and Tab: the block closes itself with an
      indented `\item ` and the caret on it. Do the same for `\begin{tabular}` —
      the caret should be inside the seeded `{}`. Add a `\newcommand{\R}{...}`
      in the preamble and confirm `\R` is offered with a **local** pill from
      another file of the same document. Type `%` and then `\sec` — no
      dropdown. Compile a document with a `\ref` to a label that does not exist:
      the build succeeds, and a collapsed **Warnings** card appears; open it,
      and the row names the right file and line and jumps there. Press
      **Words** and check the count against `texcount` if it is installed.
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

246. **The native editor aligns its own Enter, and marks the indents it draws.**
    ✅ Implemented (2026-09-01, untested live) · The code editor had a Tab that
    indents and a Shift+Tab that outdents, and an **Enter that dropped the caret
    to column 0** — so every line of a Python block or a LaTeX environment was
    re-indented by hand. Two halves, sharing one reading of the file.
    - **The unit is read out of the text**, never assumed
      (`detectIndentUnit`): the step between successive lines' indentation, with
      only 2/3/4/8 admitted (every other step is a wrapped argument list, not a
      level), and a file whose lines lead with tabs is a tab file whatever those
      steps say. Both halves below use that one answer, so what the reader sees
      and what typing produces cannot disagree.
    - **Enter, aligned** (`applyAutoIndent`, Python and TeX — the two languages
      that put their structure in the indentation). It carries the current
      line's indent; inside brackets (Python's implicit continuation) it aligns
      under the first argument, or one level in when the opener ends its line,
      and pushes the closer onto its own line when the caret sits directly
      between a pair; one level in after a `:`, one level out after
      `return`/`raise`/`pass`/`break`/`continue`; and after `\begin{env}` one
      level in **plus the matching `\end{env}`** — guarded by `hasMatchingTexEnd`,
      the same test the environment completion makes, so a `\begin` typed out by
      hand and one completed cannot disagree about writing a second `\end`.
    - A caret inside a **string literal** gets the plain carry and nothing else
      (`pythonIndentState` scans from the top, since an unclosed bracket can be
      lines above): a `:` at the end of a sentence is not a block.
    - It **declines** whenever there is nothing to add — a plain newline goes
      through the engine, which is what keeps the textarea's own undo entry for
      an ordinary Enter. Shift+Enter is left as the deliberate way out of a rule
      that guessed wrong.
    - **Indent guides** (`decorateIndentGuides`): a hairline down the first
      column of every level a line occupies, on its own overlay layer beneath
      the syntax colours, in every language the editor highlights except the two
      that are prose (plain, markdown — a stray indent in a paragraph is not a
      level of anything). The spans wrap the **file's own** whitespace, never a
      tab rewritten as spaces, because one substituted character would slide
      every guide after it off its column; painted as a gradient rather than a
      `border-left`, which would add a pixel of width and do the same.
    - [x] 🤖 Automated test (`src/__tests__/EditorAutoIndent.test.ts`: the carry,
      block openers and exits, the file's own unit, strings and comments not
      read as code, continuation alignment across lines, the between-a-pair
      case, `\begin` with and without a waiting `\end`, nesting, a `\begin`
      inside a comment, other languages untouched; unit detection incl. tabs and
      blank lines; guide chunking, tab preservation, partial levels, escaping)
    - [ ] 🖐️ Manual test — open a `.py` file: press Enter after a `def f():`
      and the caret lands one level in; after a `return` it lands one level out;
      inside `foo(a,` it lands under the `a`; with the caret between `foo(` and
      `)` the closer moves to its own line. Type a `:` inside a docstring and
      press Enter — nothing deepens. Open a 2-space-indented file and confirm it
      indents by two, not four. In a `.tex` file type `\begin{itemize}` by hand
      and press Enter: an indented body line with `\end{itemize}` below it, and
      pressing Enter on an existing `\begin` whose `\end` is already there adds
      no second one. Check the guides line up with the text in a tab-indented
      file and in the wrapped LaTeX editor, and that Shift+Enter still writes a
      plain newline.
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

247. **TeX editor: hover a snippet, see it typeset.** ✅ Implemented
    (2026-09-01, untested live) · The viewer could compile the whole document
    and show the PDF in its own tab, which answers "is the paper right" and
    never "is *this* formula right" — the question actually asked while writing
    one, and asked dozens of times per page. Resting the pointer on a fragment
    now typesets that fragment alone and shows it over the source.
    - **What counts as a snippet** (`texSnippetRanges`, `lib/viewers/tex.ts`):
      inline math, display math, and a **whitelist** of self-contained
      environments (`equation`/`align`/`gather`/`multline`/`cases`/the matrix
      family/`array`/`tabular`/`tikzpicture`/…) **plus `figure` and `table`
      floats**. Floats needed their own wrapping rather than their own excuse:
      `\begin{figure}` demands outer par mode while `\begin{preview}` has
      already boxed TeX, so a float wrapped like everything else dies with "Not
      in outer par mode" — `preview.sty`'s own `floats` option makes the
      environment itself the preview instead. Placement is the one thing such a
      preview cannot show, and it is not what the hover is asked for: whether
      the graphic is the right size and where the caption wraps is, and both
      come out. The floats left out were each tried against a real engine and
      each failed — a `wrapfigure` is not a `\@float` and previews to no pages,
      an `algorithm` (a `float`-package float) dies inside preview's own float
      fixup — as is anything that only means something inside the document
      around it (`frame`, `abstract`). Comments are blanked before the scan, so a
      `%`-ed example is not a hover target and its stray `$` cannot pair with
      real math half a page away; a nested fragment is dropped, since the
      `\begin{align}` around a `$…$` is the thing to typeset and two
      overlapping hit boxes would make which one you get depend on layout order.
    - **The author's own preamble is what it is typeset with**, and for an
      `\input`ed chapter — which has no preamble of its own — the build root's
      is read instead. Without that, every formula using the paper's own
      `\newcommand` would preview as "Undefined control sequence", i.e. the
      feature would work on toy documents and fail on real ones.
    - **Nothing is written where the document lives.** The backend
      (`tex_preview_snippet`) puts the wrapper `.tex` and every artefact in a
      scratch dir under the state dir and removes it before returning, while
      running the engine **in the document's own folder** so a preamble's
      relative `\usepackage{mystyle}` / `\input{macros}` still resolve. The PDF
      comes back as bytes rather than a path, because the confined viewer file
      commands cannot read the state dir and must not learn to. Cropping is
      `preview.sty`'s `[active,tightpage]` (the AUCTeX mechanism), so the card
      gets a formula rather than a formula adrift on A4.
    - **What keeps it from being expensive**: a 400 ms dwell (crossing a page of
      equations on the way somewhere else starts nothing), one engine run at a
      time with a superseded hover cancelled *before* it starts, a single pass
      of the engine rather than latexmk (a fragment has no bibliography to
      settle), a 25 s ceiling rather than the build's ten minutes, and a cache
      keyed by preamble+snippet that also **remembers failures** — a snippet
      with a typo is hovered repeatedly while it is being fixed, which is
      exactly when recompiling it would cost most and say least.
    - **When the preamble is the problem**, a second pass without it
      (`standalone` + AMS) renders the formula and the card says the document's
      macros are not applied — an honest degraded answer rather than a red
      error for a `preview.sty` that is merely not installed. A failure the
      *snippet* caused fails once and shows TeX's own error line.
    - On by default, per tab, with a **Preview** toggle in the compile toolbar
      (persisted in the tab's `viewerState`, seeded from
      `viewer_prefs.tex.hover_preview`). Absent from a machine with no TeX
      engine, like the rest of the compile UI.
    - [x] 🤖 Automated test (`src/__tests__/TexHoverPreview.test.ts`: what is and
      is not a previewable fragment, delimiters included in the range, nesting,
      commented-out math, `\$` and `\\[2mm]` left alone, offset lookup, preamble
      slicing and the null for a child file, cache-key identity, error-line
      reading; `commands::tex` tests: the wrapper keeps the preamble and drops a
      stray document body, a preamble-less fragment still gets a class, no
      option clash for a document that already loads `preview`, a float goes
      through the `floats` option unwrapped, only the four float names preview
      actually fixes up count as floats, a float's fallback is an `article`
      rather than `standalone`, "not in outer par mode" earns the second pass,
      the fallback carries no preamble, only a preamble failure earns it, no
      shell-escape in the preview's own argument list, oversized/empty snippets
      refused, stale scratch dirs swept and fresh ones kept; the 2026-09-01
      speed pass: the scratch sweep spares the format cache, a format key names
      the dumped wrapper head and nothing else — two snippets share one, a
      float or a changed preamble/engine does not — a dead format is told apart
      from a broken snippet, and old/surplus formats are swept oldest-first)
    - [ ] 🖐️ Manual test — open a `.tex` with some maths in it and rest the
      pointer on a `$…$`: after a moment a card appears under it with the
      formula typeset. Move along the line — the card follows fragment to
      fragment and never appears over prose. Hover an `align` or a
      `tikzpicture`: the whole environment renders as one image. Hover a formula
      that uses one of the document's own `\newcommand`s and confirm the macro
      is applied; do the same in a chapter file that is `\input`ed by the main
      document. Hover a `figure` with a real `\includegraphics` in it: the
      graphic appears at its true width with the caption under it, and the image
      path resolves the same way it does in a build (including through a
      `\graphicspath`). Hover a `table` and confirm the caption and rules come
      out. Confirm no `.aux`/`.log` appears beside the document afterwards. Break a formula (`\frac{1}{`) and hover it: an error card
      naming TeX's own message, not a spinner. Hover the same formula again —
      it answers instantly (cached). Sweep the pointer quickly across a page of
      equations and confirm nothing stacks up. Click **Preview** in the toolbar
      to switch it off, confirm hovering does nothing, reopen the tab and
      confirm it is still off. Speed pass (2026-09-01, needs backend restart):
      hover a SECOND, different formula under the same preamble — it should
      render clearly faster than the first (the preamble is now precompiled
      into a cached format on pdflatex; `<state>/tex-preview/fmt/` should hold
      a `.fmt` afterwards). Also confirm the hovered fragment still picks up
      its wash exactly under the pointer after scrolling and in wrap mode (the
      hit layer was missing from the overlay alignment CSS and is now
      hit-tested via elementsFromPoint).
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

248. **Dictionary spell check in the native editors.** ✅ Implemented (untested
    live). A deterministic, model-free spelling provider beside the #45 LLM
    grammar check: `services::spell` (the pure-Rust Hunspell checker
    `spellbook`) reads the system's own dictionaries (`/usr/share/hunspell` on
    Linux) plus any `.aff`/`.dic` pair dropped into `<state_dir>/dictionaries/`,
    and the editor underlines misspellings on an 800 ms idle — no resident
    model, milliseconds per check, offline. The document is **masked** first so
    only prose is checked: LaTeX commands/math/comments/key arguments
    (`\ref`/`\cite`/`\input`/… — but `\textbf{...}`, captions and `\href` link
    text stay prose), Markdown fences/inline code/link targets/HTML tags, and
    URLs/emails everywhere; the tokenizer additionally skips identifiers
    (CamelCase, `snake_case` halves, digit-glued tokens). Issues reuse the LLM
    provider's wire shape (`GrammarIssue`), so one overlay, one tooltip and one
    Fix button serve both — the tooltip additionally offers **Add to
    dictionary** (append-only `personal.dic`, folded into every language) for
    dictionary hits, and a model duplicate of a dictionary hit is dropped
    (`mergeSpellIssues`) so the per-line resolver cannot walk it onto the next
    occurrence. Opt-in per viewer type (`ViewerPref.spell_check`, Project
    Settings table's new Spelling column) with a per-tab override in the editor
    header — offered without a loaded model, unlike its two siblings — and one
    machine-wide dictionary choice (`Settings.spell_language`, defaulting to an
    installed English variant).
    - [x] 🤖 Automated test (Rust `services::spell`: flags a misspelling with
      its line, suggests a close correction, accepts sentence case, skips
      identifiers/CamelCase/single letters, keeps apostrophe words, masking
      preserves length + lines, LaTeX masks commands/math/comments/keys but
      keeps prose and `\href` link text, masks math-environment bodies,
      Markdown masks fences/inline code/link targets, URLs/emails masked in
      plain text, discovery pairs `.aff`/`.dic` and skips orphans + the
      personal list, English-preferring default, Latin-1 fallback decode, the
      issue cap; TS `GrammarCheck.test.ts`: `mergeSpellIssues` passthrough,
      ordering, same-line dedupe, different-line keep)
    - [ ] 🖐️ Manual test — turn Spelling on for Markdown in Project Settings
      (Native viewers table) and open a `.md`: typos get red wavy underlines
      within a second of pausing; code fences, inline code and link URLs are
      never marked. Hover a mark: the tooltip offers "Fix → <word>" and "Add to
      dictionary" — Fix replaces the word, Add clears every mark of that word
      and it stays unmarked after a restart. In a `.tex`, confirm `\commands`,
      math, comments and `\cite`/`\ref` keys are never marked while prose in
      `\textbf{...}` and captions is. Toggle the Spelling chip in the editor
      header off for one tab and confirm the other tabs keep their marks. Pick
      a different dictionary in Project Settings (with two installed) and
      confirm the marks re-judge. Remove all dictionaries and confirm the
      status line names the missing dictionary once instead of erroring
      repeatedly.
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

248. **TeX workspace: the structure sidebar can add a file to the document.** ✅
    Implemented (2026-09-01, untested live) · The sidebar listed what a document
    pulls in and offered no way to grow it: a new chapter meant the file tree's
    New File, then typing the `\input` by hand — in the one tab whose whole point
    is that the document is worked on as a single thing. A ＋ in the sidebar
    header now asks for a name (`chapters/intro` — relative, `.tex` only),
    creates the file when it is missing, adds an `\input` line to the document,
    re-gathers the structure and centers the new file.
    - #243 (#tex-create-ref) run in the other direction, on the SAME machinery
      (`texRefCreation`/`createTexRefFile`), so the two gestures cannot disagree
      about what a name means or overwrite an existing file: a name that is
      already a file is *adopted* — only the `\input` is added, and a parent that
      already references the file (however the token is spelled — `intro` vs
      `intro.tex`, `\input` vs `\include`) is left alone.
    - The reference lands in the file currently centered when that is a `.tex`
      (a chapter grows its own sections), else in the main document; the line
      goes directly above `\end{document}` (looked up comment-blanked, so a
      commented-out one does not attract it) or at the end of a fragment.
    - A parent with unsaved edits is refused in the dialog rather than spliced
      on disk — the editor's next save would write the older draft over the
      reference. A clean open editor needs nothing: its mtime poll reloads the
      spliced line on its own.
    - Asked in the app's own prompt chrome (`useDialogs`), so a failed create or
      splice keeps the typed name with the reason beside it (#244's rule).
    - [x] 🤖 Automated test (`src/__tests__/TexLinks.test.ts`: the splice above
      `\end{document}` / past a commented one / onto a fragment / into an empty
      parent; create+insert, adopt-without-second-`\input`, spelled-differently
      matching, exists-but-unreferenced, the declines touching nothing;
      `TexWorkspace.test.tsx` (j): the ＋ end to end — file created, `\input`
      written above `\end{document}`, structure re-listed, new file centered)
    - [ ] 🖐️ Manual test — open a multi-file `.tex` workspace and press the
      sidebar's ＋; type `chapters/notes`: the file appears in the structure,
      opens in the centre, and the main file gains `\input{chapters/notes}`
      just above `\end{document}`. Press ＋ again with the same name — no
      duplicate `\input`, the file simply opens. Type `/tmp/x` or `fig.png` —
      refused with the reason, the typed name kept. With unsaved edits in the
      main file the dialog refuses until you save. Center a chapter first and
      add a file — the `\input` lands in the chapter, not the main.
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

249. **Editor overlays: make the link/grammar/unclosed hover hit-tests O(1) like
    the snippet layer's.** The 2026-09-01 hover-preview speed pass replaced the
    snippet layer's per-mousemove scan (querySelectorAll + one
    getBoundingClientRect per span, hundreds of rect reads per move on a page
    of equations) with a single `document.elementsFromPoint` query against a
    hit-testable layer. `updateLinkHover`, `grammarHitAt` and `unclosedTipAt`
    still run the measured scan on every mousemove of the same textarea; the
    same technique applies (flip the layer to `pointer-events: auto` — the
    textarea above it still catches every real event — and keep the measured
    scan as the jsdom fallback). Worth doing next time an editor feels sluggish
    under the pointer in a link-dense or heavily-annotated document.

250. **PDF→TeX reverse search: LuaTeX/beamer precision + "recompile" notices.**
    Fixed 2026-09-02, not yet verified live. (a) In the MLG_GNN_GED talk a
    Ctrl-click on a block title jumped to `main.tex`'s `\end{frame}` line and
    body lines were a coin flip: LuaTeX's font callback re-tags glyph runs
    with the frame's closing line, and the resolver *preferred* those leaves
    (`commands/synctex.rs`, ancestor-tag rule; 68.8 % → 0 % wrong answers on
    that talk). (b) A click with no `.synctex.gz`, a stale map (source saved
    after the build, or PDF rebuilt without SyncTeX), or an honest miss now
    raises a banner in the PDF tab with a one-click **Recompile** (routed to
    the mounted editor's own compile via `registerTexCompile`, cross-window
    through the `tex-workspace-center` event). To verify: open the talk's
    `main.pdf`, Ctrl-click "In continuous domains: interpolate" → should land
    on `slides/interpolation.tex:1`; edit a slide, save, Ctrl-click → stale
    notice + Recompile; delete the `.synctex.gz`, Ctrl-click → no-map notice.

251. **TeX editor: the structure diagnostic reads `\begin`/`\end`, not just
    braces.** Fixed 2026-09-02, not yet verified live. The persistent red
    underline in the `.tex` editor flagged an unclosed `{`, `[`, `(`, `$` or
    `\[` and, in principle, an unclosed `\begin{…}` — but it paired
    environments the way the caret-local matcher does, **by nesting depth with
    the name ignored**. Depth counting is right for a well-formed document and
    exactly wrong for a broken one, which is the only document a diagnostic is
    for: `\begin{itemize}…\end{enumerate}` cancels out and the file read as
    clean, and `\begin{document}\begin{itemize}…\end{document}` blamed
    `\begin{document}` — the one token that is not the mistake. An `\end`
    without any `\begin` was silently ignored outright, under the "extra
    closing delimiters are not diagnosed" rule the ordinary brackets follow.
    - **Environments now pair by name** (`findUnclosedTexBrackets`). An `\end`
      closes the innermost open environment of *its* name; every environment
      opened inside that one is then reported unclosed — the recovery that
      blames `\begin{itemize}` above and keeps the rest of the file's structure
      from skewing off a wrong pop. The caret-local matcher
      (`findTexEnvDelimiterMatch`) still counts depth alone, on purpose: it
      answers "where is this token's partner" in a document that parses.
    - **An `\end` is now flagged on its own** — the one closing delimiter that
      is. A stray `}` stays ignored: it says nothing about which group it meant
      to close and would turn red constantly mid-edit, while `\end{itemize}`
      names the environment it claims to close and is simply wrong when no
      `itemize` is open.
    - **The hover hint says which mistake it is.** Each flagged range carries
      its own sentence in `data-hint` (`fileViewer.unclosedEnvHint`,
      `fileViewer.unmatchedEndHint`, all five languages), naming the
      environment: "\begin{itemize} is missing its \end{itemize}" reads
      differently from "\end{enumerate} has no matching \begin{enumerate}", and
      one generic "opening delimiter is missing its closing partner" was wrong
      text for half of them.
    - [x] 🤖 Automated tests (`src/__tests__/TexDelimiterMatch.test.ts` —
      mismatched names flagging both halves, a stray `\end`, the inner-`\begin`
      blame, crossed environments, repeated/nested same-name pairs, a
      commented-out `\end`, and spacing inside the braces;
      `src/__tests__/EditorBracketMatch.test.ts` — the hint reaching
      `data-hint`, escaped)
    - [ ] 🖐️ Manual test — frontend only, hot-reloads. In a `.tex` file write
      `\begin{itemize}` … `\end{enumerate}`: **both** lines should underline
      red and carry a gutter mark, and hovering each should name the right
      environment. Delete the `\end` entirely — only the `\begin` is red. Type
      an `\end{center}` with no `\begin{center}` anywhere — that line is red.
      Confirm a well-formed document with nested and repeated environments is
      clean, and that an `\end` inside a `%` comment is ignored.
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

252. **TeX workspace: the structure tree says *which file* is broken.**
    Implemented 2026-09-02, not yet verified live. The Errors and Warnings cards
    answer "what is wrong" for a build, and are read from whichever pane the
    reader happens to be editing. In a document split across a dozen `\input`s
    that leaves the more useful question open — *which chapter* — and the
    structure sidebar is the one surface already drawing the document as its
    files.
    - **A red and an amber pill per row**, counts only (`texDiagnosticsByFile`
      buckets a build's errors and warnings by the absolute path of the file
      each is in, keyed the same way the tree is). Nothing is drawn for a clean
      file: a tree of green ticks would cost the one thing the badges are worth,
      which is that a red pill is rare enough to be seen without looking for it.
    - **Clicking a pill centers that file with the caret on the first error** (or
      first locatable warning) — the step a reader who spotted the badge was
      about to take by hand, and the reason the pills are their own buttons
      rather than decoration inside the row's. A row is now a `rowline` holding
      the file button and its pills; nesting a button inside the row's would be
      invalid markup and unreachable by keyboard.
    - **Reported by every build, failed or green** (`onDiagnostics`, beside the
      existing `onCompiled` which only fires on success): a green build still
      has warnings, and a clean one reports an empty map, which is what clears
      the badges. Reset when the workspace changes documents — stale badges
      pointing at a previous document's lines are worse than none.
    - A warning TeX's `(…)` nesting could not place falls back to the built
      root, the same rule the Warnings card renders under, so a warning cannot
      be attributed to one file in the list and another in the badge. Errors in
      a file the structure does not list (a `.sty`, a package) have no row to
      land on and stay in the cards only.
    - [x] 🤖 Automated tests (`src/__tests__/TexErrors.test.ts` — bucketing by
      resolved path, first-line-wins, the no-file warning falling back to the
      root, a warning with no line leaving no jump target, and the empty map;
      `src/__tests__/TexWorkspace.test.tsx` — a failing build badges the child's
      row and not the main's, and the pill centers the child with a `requestJump`
      on the reported line)
    - [ ] 🖐️ Manual test — frontend only, hot-reloads. Open a multi-file TeX
      workspace, break something in a chapter (an undefined command), Compile:
      that chapter's row in the sidebar should show a red **1** and the main
      document's row nothing. Click the pill — the chapter centers with the
      caret on the error line. Fix it and compile again: the red pill goes, and
      any amber warning pills land on the files the Warnings card names.
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work
