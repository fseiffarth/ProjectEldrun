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

44. **TeX viewer: preview off by default.** Default the TeX viewer to the source
    editor rather than auto-rendering a preview; make preview an explicit toggle.
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test

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

46. **Undo/redo in native text/TeX viewers.** Add an undo/redo history to the
    in-app text and TeX editors (keyboard `Ctrl+Z`/`Ctrl+Shift+Z` plus buttons).
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test

47. **Save icon instead of "save/saved" text (+ optional autosave).** Replace the
    textual save/saved status in the text/TeX viewer with a save icon that
    reflects dirty/clean state; consider periodic autosave (with the #43
    diff-aware reload as the counterpart for external changes).
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test

48. **Per-file-type native-viewer settings + document supported types.** A single
    settings surface to configure native-viewer behavior keyed by file type, and
    document the supported types (and the native text viewer) in `README.md`.
    Ties into #44 (per-type preview defaults) and #45 (per-type completion).
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test

49. **Make file links in text/TeX viewers visibly clickable.** Render links that
    point at files with a clear affordance (underline / dotted underline) so they
    read as clickable, in both the text and TeX viewers. (Companion to #50, which
    governs *where* a clicked link opens.)
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test

50. **Link-open routing: same subwindow, or drag-to-set-default.** When a file
    link (#49) is clicked, open the target in the **same** subwindow by default;
    if the user drags the link to another subwindow, make that the default target
    **only for that file, from that linking file, for this session** — discard the
    mapping when the linking file's tab is closed (and optionally close the
    linked file(s) with it).
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test

51. **Native `.odt` / `.xlsx` viewer.** Add an in-app viewer for OpenDocument /
    spreadsheet files. First decide whether it's worth it / already feasible via
    an existing Tauri-side renderer before building one.
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test

52. **Image viewer: zoom/scroll to the cursor.** Improve image-viewer scrolling so
    zoom centers on the mouse cursor rather than the viewport origin.
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test

53. **Drag images (and their tabs) out as drop sources.** Make images in the image
    viewer — and image tabs — draggable as drop sources, e.g. drag an image/text
    tab and drop it into a browser file-upload field.
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test

54. **TeX compile output → PDF in a new tab + compiler options.** Open the
    compiled PDF as its own tab (it is a real file), and add compiler options to
    the TeX viewer (output folder, engine/flags, …). Extends the existing
    `compile_tex` affordance from Group D.14.
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test

55. **Adjustable text size in the text/TeX/Markdown editors.** Add an `A−`/`A+`
    control (and `Ctrl` +/−, `Ctrl`+0 to reset) that scales the editor font. In
    the code editors (text/TeX) the gutter and syntax/link/ghost overlay layers
    scale together via the `--code-font-size`/`--code-line-height` CSS variables;
    in Markdown it sizes the source textarea and, once set, the rendered preview
    base font. The size persists per file type in `viewer_prefs[type].font_size`
    (alongside #45's autocomplete).
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test

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
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test

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

68. **Image viewer: auto-reload on disk change.** Give the image viewer the same
    diff-aware reload as the editors/PDF (#43): `useBlobUrl` polls `file_mtime`
    and re-reads the bytes when the file changes on disk, swapping the blob URL
    only once the fresh bytes are ready (no flash) and revoking the old one. An
    image regenerated by an external tool updates in place; the user's zoom/pan is
    preserved when the new image has the same dimensions, and only re-fit when the
    dimensions change.
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test

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

70. **TeX viewer: `Ctrl`+`S` saves and recompiles.** In the LaTeX viewer (engine
    available), `Ctrl`+`S` runs `compile()` instead of a plain save — `compile()`
    persists pending edits first, so the PDF preview tracks the source. The
    no-engine fallback keeps `Ctrl`+`S` as a plain save.
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test

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

87. **Python in the native code viewer: Run, Debug, breakpoints, go-to-definition.**
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

---
