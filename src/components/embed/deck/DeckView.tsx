/**
 * The deck editor's shell: load the sidecar and its base PDF, re-anchor, host the
 * rail and the stage, and autosave.
 *
 * **Why this owns its own I/O instead of using `useEditableFile`.** That hook is
 * string-typed end to end and writes on *every* change while dirty — correct for
 * a text editor, wrong for a document mutated by dragging, where it would issue a
 * disk write per pointer frame. It also cannot create a file, and `write_file_text`
 * refuses a path that does not exist. So the deck debounces its own writes and
 * goes through `writeFileBytes`, which may create.
 *
 * **Why there is no save button.** Eldrun has no unsaved-work prompt anywhere —
 * `closeTabWithConfirm` is literally `removeTab` — so a deck must never *hold*
 * unsaved state. It is small, it is text, and it is under git, which is where the
 * durable undo belongs. Ctrl+Z is the in-session undo; git is the real one.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { UntestedTag } from "../../common/UntestedTag";
import {
  describeFileError,
  fileMtime,
  readFileBytes,
  readFileText,
  useFileScope,
  writeFileBytes,
} from "../fileAccess";
import { openLinkedFile, useViewerState } from "../FileViewerPane";
import {
  type Deck,
  type DeckObject,
  type ImageObject,
  type ObjectList,
  type Slide,
  DUPLICATE_OFFSET,
  alignObjects,
  duplicateObjects,
  insertSlide,
  lowerObjects,
  moveObjects,
  moveSlides,
  newInterstitialId,
  newObjectId,
  newSlideId,
  raiseObjects,
  removeObjects,
  toBack,
  toFront,
  updateSlide,
} from "../../../lib/viewers/deck/model";
import {
  type BasePage,
  parseDeck,
  pdfPathForDeck,
  serializeDeck,
  reattach,
  reconcile,
} from "../../../lib/viewers/deck/sidecar";
import { type TextMetrics, loadMetrics } from "../../../lib/viewers/deck/fonts";
import type { IconDef } from "../../../lib/viewers/deck/icons";
import { exportDeck, exportPathFor } from "../../../lib/viewers/deck/export";
import {
  starterTex,
  starterTexFigure,
  texPathForDeck,
  titleFromPath,
} from "../../../lib/viewers/deck/template";
import { getTexCapability, type TexCompileResult } from "../../../lib/viewers/tex";
import { loadBase, renderPage, renderPdfPageToPng } from "./deckBase";
import {
  dirOf,
  interstitialsOf,
  resolveRel,
  useDeckGifs,
  useDeckImages,
} from "./deckAssets";
import { DeckStage } from "./DeckStage";
import { DeckInspector } from "./DeckInspector";
import { DeckAnimate } from "./DeckAnimate";
import { DeckNotes } from "./DeckNotes";
import { DeckTexPanel } from "./DeckTexPanel";
import { DeckPresenter } from "./DeckPresenter";
import { IconPicker } from "./IconPicker";
import { posterPng } from "./gifPlayback";

/** Bounds for the rail's user-resizable width (px). Wide enough at the max that
 *  a thumbnail is actually legible, narrow enough at the min to stay a rail. */
export const DECK_RAIL_MIN_WIDTH = 84;
export const DECK_RAIL_MAX_WIDTH = 260;
export const DECK_RAIL_DEFAULT_WIDTH = 112;

export function clampRailWidth(w: number): number {
  return Math.min(DECK_RAIL_MAX_WIDTH, Math.max(DECK_RAIL_MIN_WIDTH, Math.round(w)));
}

/** How often a TeX-figure's compiled PDF is checked for a newer mtime — i.e. a
 *  recompile the author ran from the source tab this view opened. Matches the
 *  PDF viewer's own external-change poll (`PdfViewer.RELOAD_POLL_MS`); there is
 *  no reason for a deck's figures to notice a recompile any slower. */
const TEX_FIGURE_POLL_MS = 1500;

/** The per-deck folder a TeX-figure object's source/PDF/PNG live in, beside the
 *  sidecar — kept out of the main `.tex`'s own directory so a figure's build
 *  artifacts (`.aux`/`.log`) never clutter the deck's own folder listing. */
function texFigureDir(deckPath: string): string {
  return `${deckPath.replace(/\.eldeck\.json$/i, "")}.tex-figures`;
}

/** One slide's thumbnail in the rail — its own small component so each row
 *  renders its canvas independently as `doc`/page/size change, the same
 *  "render into a ref'd canvas via an effect" shape `DeckStage` uses for the
 *  full-size page. */
function DeckRailThumb({
  doc,
  page,
  width,
  height,
}: {
  doc: PDFDocumentProxy | null;
  page: number;
  width: number;
  height: number;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !doc || width <= 0 || height <= 0) return;
    return renderPage(doc, page, canvas, width, height);
  }, [doc, page, width, height]);
  return <canvas className="deck-rail-thumb" ref={ref} />;
}

/** How long after the last edit the sidecar is written. Long enough that a
 *  gesture-heavy minute is a handful of writes, short enough that closing the tab
 *  right after an edit still catches it. */
const AUTOSAVE_MS = 800;

/** Arrow-key nudge, as a fraction of the page. Shift multiplies it. */
const NUDGE = 0.002;

export interface DeckViewProps {
  path: string;
  onOpenExternally: () => void;
  tabKey?: string;
  groupId?: string | null;
}

export function DeckView({ path, onOpenExternally, tabKey, groupId }: DeckViewProps) {
  const scope = useFileScope();

  const [deck, setDeck] = useState<Deck | null>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [slideIndex, setSlideIndex] = useState(0);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [metrics, setMetrics] = useState<TextMetrics | null>(null);
  const [picking, setPicking] = useState<null | "new" | "replace">(null);
  const [mode, setMode] = useState<"design" | "animate" | "notes" | "tex">("design");
  const [previewStep, setPreviewStep] = useState(0);
  const [presenting, setPresenting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [generating, setGenerating] = useState(false);
  /** Bumped to force a reload after the base plate is (re)generated. */
  const [reloadNonce, setReloadNonce] = useState(0);
  const [texAvailable, setTexAvailable] = useState(false);
  /** Ids of TeX-figure objects currently (re)compiling — the FAB, an explicit
   *  Recompile, and the external-change poll can all be in flight at once, each
   *  for a different object, so this is a set rather than a single flag. */
  const [texBusyIds, setTexBusyIds] = useState<ReadonlySet<string>>(new Set());

  const railState = useViewerState(tabKey);
  const [railWidth, setRailWidth] = useState(() =>
    clampRailWidth(railState.initial?.deckRailWidth ?? DECK_RAIL_DEFAULT_WIDTH),
  );
  /** Live width during a drag; committed (and persisted) only on release — see
   *  `SubwindowFilesSidebar`, whose resize handle this mirrors. */
  const [liveRailWidth, setLiveRailWidth] = useState<number | null>(null);

  const past = useRef<Deck[]>([]);
  const future = useRef<Deck[]>([]);
  /** Suppresses the autosave that would otherwise fire for the initial load. */
  const loadedRef = useRef(false);
  /** Last-seen mtime of each TeX-figure's compiled PDF (by absolute path), so
   *  the poll below can tell "a recompile just happened" from "nothing changed"
   *  without re-rasterizing on every tick. Seeded by every write this view makes
   *  itself, so its own compiles never look like an external change. */
  const mtimesRef = useRef<Map<string, number>>(new Map());

  // The standard-14 metrics the stage lays text out with. Loaded once per app
  // run (the module memoizes), and rendering degrades to CSS wrapping until it
  // resolves rather than showing nothing.
  useEffect(() => {
    let live = true;
    void loadMetrics().then((m) => {
      if (live) setMetrics(m);
    });
    return () => {
      live = false;
    };
  }, []);

  // --- load --------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    let opened: PDFDocumentProxy | null = null;
    loadedRef.current = false;
    setError(null);
    setNotice(null);

    void (async () => {
      let parsed: ReturnType<typeof parseDeck>;
      try {
        const text = await readFileText(path, scope);
        parsed = parseDeck(text);
      } catch (e) {
        if (!cancelled) setError(describeFileError(e));
        return;
      }
      if (cancelled) return;
      if (parsed.error) {
        setError(`This deck could not be read: ${parsed.error}`);
        return;
      }

      const dir = dirOf(path);
      const basePath = resolveRel(dir, parsed.deck.base ?? pdfPathForDeck(path));

      let pages: BasePage[] = [];
      try {
        const base = await loadBase(basePath, scope);
        opened = base.doc;
        pages = base.pages;
      } catch (e) {
        // A missing base plate is not a broken deck — the layers are still
        // intact and worth showing. Say so rather than failing the whole view.
        if (!cancelled) setNotice(`Base PDF could not be opened (${describeFileError(e)}).`);
      }
      if (cancelled) {
        opened?.destroy();
        return;
      }

      const r = reconcile(parsed.deck, pages);
      setDoc(opened);
      setDeck(r.deck);
      setSlideIndex((i) => Math.min(i, Math.max(0, r.deck.slides.length - 1)));

      const notes: string[] = [];
      if (parsed.repaired) notes.push(`Repaired on load: ${parsed.repaired}.`);
      if (r.detached > 0) {
        notes.push(
          `${r.detached} layer${r.detached === 1 ? "" : "s"} no longer match a page and ` +
            `${r.detached === 1 ? "was" : "were"} set aside rather than deleted.`,
        );
      }
      if (r.moved > 0) notes.push(`Re-anchored ${r.moved} slide${r.moved === 1 ? "" : "s"}.`);
      if (notes.length) setNotice(notes.join(" "));

      // Anchors just changed; let the first autosave persist them.
      loadedRef.current = true;
    })();

    return () => {
      cancelled = true;
      opened?.destroy();
      setDoc(null);
    };
  }, [path, scope, reloadNonce]);

  useEffect(() => {
    void getTexCapability().then((c) => setTexAvailable(c.available));
  }, []);

  // --- autosave ----------------------------------------------------------
  useEffect(() => {
    if (!deck || !loadedRef.current) return;
    const t = setTimeout(() => {
      setSaving(true);
      void writeFileBytes(path, new TextEncoder().encode(serializeDeck(deck)), scope)
        .catch((e) => setError(describeFileError(e)))
        .finally(() => setSaving(false));
    }, AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [deck, path, scope]);

  // --- editing -----------------------------------------------------------

  /** Every mutation goes through here, so history is impossible to forget. */
  const commit = useCallback((next: (d: Deck) => Deck) => {
    setDeck((cur) => {
      if (!cur) return cur;
      const out = next(cur);
      if (out === cur) return cur;
      past.current = [...past.current.slice(-99), cur];
      future.current = [];
      return out;
    });
  }, []);

  const setObjects = useCallback(
    (objects: ObjectList) => {
      commit((d) => ({
        ...d,
        slides: updateSlide(d.slides, slideIndex, (s) => ({ ...s, objects })),
      }));
    },
    [commit, slideIndex],
  );

  /** Apply a pure object-list op to the current slide. */
  const withObjects = useCallback(
    (op: (list: ObjectList, ids: string[]) => ObjectList) => {
      setDeck((cur) => {
        if (!cur) return cur;
        const slide = cur.slides[slideIndex];
        if (!slide) return cur;
        const objects = op(slide.objects, [...selection]);
        if (objects === slide.objects) return cur;
        past.current = [...past.current.slice(-99), cur];
        future.current = [];
        return {
          ...cur,
          slides: updateSlide(cur.slides, slideIndex, (s) => ({ ...s, objects })),
        };
      });
    },
    [slideIndex, selection],
  );

  const undo = useCallback(() => {
    setDeck((cur) => {
      const prev = past.current.pop();
      if (!cur || !prev) return cur;
      future.current = [...future.current, cur];
      return prev;
    });
  }, []);

  const redo = useCallback(() => {
    setDeck((cur) => {
      const next = future.current.pop();
      if (!cur || !next) return cur;
      past.current = [...past.current, cur];
      return next;
    });
  }, []);

  // --- copy / duplicate ----------------------------------------------------
  // An in-memory object clipboard, not the OS one: a deck object is a structured
  // value, and serializing it through the system clipboard (text or an image of
  // its render) would lose exactly what makes it editable. Paste lands on the
  // *current* slide, so it doubles as "copy this to another slide".
  const clipboard = useRef<DeckObject[]>([]);

  const copySelection = useCallback(() => {
    if (!deck || selection.size === 0) return;
    const slide = deck.slides[slideIndex];
    if (!slide) return;
    clipboard.current = slide.objects.filter((o) => selection.has(o.id)).map((o) => ({ ...o }));
  }, [deck, selection, slideIndex]);

  /** Add clones of `objs` to the current slide, offset and freshly-ided, and
   *  select them — the shared tail of paste and cross-slide copy. */
  const addClones = useCallback(
    (objs: readonly DeckObject[]) => {
      if (objs.length === 0) return;
      const fresh: string[] = [];
      const clones = objs.map((o) => {
        const id = newObjectId();
        fresh.push(id);
        return { ...o, id, x: o.x + DUPLICATE_OFFSET, y: o.y + DUPLICATE_OFFSET };
      });
      commit((d) => ({
        ...d,
        slides: updateSlide(d.slides, slideIndex, (s) => ({ ...s, objects: [...s.objects, ...clones] })),
      }));
      setSelection(new Set(fresh));
    },
    [commit, slideIndex],
  );

  const pasteClipboard = useCallback(() => addClones(clipboard.current), [addClones]);

  const duplicateSelection = useCallback(() => {
    if (!deck || selection.size === 0) return;
    const slide = deck.slides[slideIndex];
    if (!slide) return;
    const { list, ids } = duplicateObjects(slide.objects, [...selection]);
    if (list === slide.objects) return;
    commit((d) => ({
      ...d,
      slides: updateSlide(d.slides, slideIndex, (s) => ({ ...s, objects: list })),
    }));
    setSelection(new Set(ids));
  }, [deck, selection, slideIndex, commit]);

  // --- slide reorder -------------------------------------------------------
  // The presentation sequence is the deck's own slide order (reconcile preserves
  // it across a reload), so moving a slide earlier/later is a durable edit — it
  // does not touch which base page each slide backs.
  const moveSlide = useCallback(
    (from: number, dir: -1 | 1) => {
      const to = from + dir;
      commit((d) => {
        if (to < 0 || to >= d.slides.length) return d;
        return { ...d, slides: moveSlides(d.slides, [d.slides[from].id], to) };
      });
      // An adjacent move is a swap of `from` and `to`; keep the viewer on whatever
      // slide it was showing.
      setSlideIndex((i) => (i === from ? to : i === to ? from : i));
    },
    [commit],
  );

  // Copy a slide: a fresh-ided clone (its own objects, its own interstitial) that
  // backs the SAME base page as the original — durable now that reconcile lets two
  // slides share a page. Lands right after the original.
  const duplicateSlide = useCallback(
    (index: number) => {
      commit((d) => {
        const src = d.slides[index];
        if (!src) return d;
        const copy: Slide = {
          ...src,
          id: newSlideId(),
          objects: src.objects.map((o) => ({ ...o, id: newObjectId() })),
          ...(src.after ? { after: { ...src.after, id: newInterstitialId() } } : {}),
        };
        return { ...d, slides: insertSlide(d.slides, copy, index + 1) };
      });
      setSlideIndex(index + 1);
      setSelection(new Set());
    },
    [commit],
  );

  const addRect = useCallback(() => {
    if (!deck) return;
    const id = newObjectId();
    withObjects((list) => [
      ...list,
      {
        id,
        kind: "shape",
        shape: "rect",
        fill: deck.theme.shapeFill,
        stroke: deck.theme.shapeStroke,
        strokeWidth: deck.theme.shapeStrokeWidth,
        x: 0.35,
        y: 0.4,
        w: 0.3,
        h: 0.2,
        rot: 0,
        opacity: 1,
      },
    ]);
    setSelection(new Set([id]));
  }, [deck, withObjects]);

  const addText = useCallback(() => {
    if (!deck) return;
    const id = newObjectId();
    withObjects((list) => [
      ...list,
      {
        id,
        kind: "text",
        text: "Text",
        style: { ...deck.theme.text },
        padding: 2,
        x: 0.3,
        y: 0.45,
        w: 0.4,
        h: 0.1,
        rot: 0,
        opacity: 1,
      },
    ]);
    setSelection(new Set([id]));
  }, [deck, withObjects]);

  // --- assets --------------------------------------------------------------
  // Images and interstitial clips are loaded by the shared hooks the audience
  // window also uses, so the projector and the editor can never resolve a
  // deck-relative path two different ways.
  const { assets, refresh: refreshImage } = useDeckImages(deck, path, scope);
  const interstitials = useMemo(() => interstitialsOf(deck), [deck]);
  const gifs = useDeckGifs(interstitials, path, scope);

  const addIcon = useCallback(
    (def: IconDef) => {
      if (!deck) return;
      if (picking === "replace") {
        withObjects((list, ids) =>
          list.map((o) => (ids.includes(o.id) && o.kind === "icon" ? { ...o, icon: def.key } : o)),
        );
        setPicking(null);
        return;
      }
      const id = newObjectId();
      // Square by default: an icon stretched to a random box reads as a mistake,
      // and the aspect is measured against the page, not the box.
      const side = 0.12;
      withObjects((list) => [
        ...list,
        {
          id,
          kind: "icon",
          icon: def.key,
          color: deck.theme.iconColor,
          strokeWidth: deck.theme.iconStrokeWidth,
          x: 0.44,
          y: 0.44,
          w: side,
          h: (side * deck.pageWidth) / deck.pageHeight,
          rot: 0,
          opacity: 1,
        },
      ]);
      setSelection(new Set([id]));
      setPicking(null);
    },
    [deck, picking, withObjects],
  );

  // --- export -------------------------------------------------------------
  const doExport = useCallback(async () => {
    if (!deck || !metrics) return;
    setExporting(true);
    setNotice(null);
    try {
      const dir = dirOf(path);
      const basePath = resolveRel(dir, deck.base ?? pdfPathForDeck(path));
      let baseBytes: Uint8Array | null = null;
      try {
        baseBytes = new Uint8Array(await readFileBytes(basePath, scope));
      } catch {
        // Exporting a deck whose plate has gone is still worth doing — the
        // layers are the part the author made.
      }

      const images = new Map<string, Uint8Array>();
      for (const slide of deck.slides) {
        for (const o of slide.objects) {
          if (o.kind !== "image" || images.has(o.src)) continue;
          try {
            images.set(o.src, new Uint8Array(await readFileBytes(resolveRel(dir, o.src), scope)));
          } catch {
            // Reported as a warning by the exporter, which knows the context.
          }
        }
      }

      // A GIF cannot be a PDF page, so each interstitial contributes its poster
      // frame. Encoding needs a canvas, which is why it happens here and not in
      // the (deliberately DOM-free, testable) exporter.
      const posters = new Map<string, Uint8Array>();
      for (const a of interstitials) {
        const g = gifs.get(a.id);
        if (!g) continue;
        const png = await posterPng(g, a.poster);
        if (png) posters.set(a.id, png);
      }

      const out = await exportDeck({ deck, baseBytes, images, posters, metrics });
      const target = exportPathFor(path);
      await writeFileBytes(target, out.bytes, scope);
      setNotice(
        `Exported ${out.pages} page${out.pages === 1 ? "" : "s"} to ${target.split("/").pop()}.` +
          (out.warnings.length ? ` ${out.warnings.join(" ")}` : ""),
      );
    } catch (e) {
      setError(describeFileError(e));
    } finally {
      setExporting(false);
    }
  }, [deck, metrics, path, scope, interstitials, gifs]);

  const toDeckRelative = useCallback(
    (absolute: string) => {
      const dir = dirOf(path);
      return dir && absolute.startsWith(`${dir}/`) ? absolute.slice(dir.length + 1) : absolute;
    },
    [path],
  );

  const patchSlide = useCallback(
    (patch: (s: import("../../../lib/viewers/deck/model").Slide) => import("../../../lib/viewers/deck/model").Slide) => {
      commit((d) => ({ ...d, slides: updateSlide(d.slides, slideIndex, patch) }));
    },
    [commit, slideIndex],
  );

  // --- generate a base plate ----------------------------------------------
  /**
   * The "from blank" path: write a starter Beamer `.tex` and compile it into the
   * base plate this deck is missing.
   *
   * Deliberately never overwrites an existing `.tex` — the author owns that file
   * from the moment it is created, and Eldrun writing over a source they have
   * been editing is exactly the trust this feature cannot afford to lose.
   */
  const generateBase = useCallback(async () => {
    setGenerating(true);
    setError(null);
    try {
      const texPath = texPathForDeck(path);
      let hasTex = true;
      try {
        await readFileText(texPath, scope);
      } catch {
        hasTex = false;
      }
      if (!hasTex) {
        await writeFileBytes(
          texPath,
          new TextEncoder().encode(starterTex({ title: titleFromPath(path) })),
          scope,
        );
      }
      const res = await invoke<TexCompileResult>("compile_tex", { path: texPath });
      if (!res.success) {
        setNotice(
          `The starter LaTeX did not compile. ${res.log.trim().split("\n").slice(-3).join(" ")}`,
        );
        return;
      }
      setNotice(hasTex ? "Recompiled the base PDF." : "Created a starter LaTeX file and compiled it.");
      setReloadNonce((n) => n + 1);
    } catch (e) {
      setError(describeFileError(e));
    } finally {
      setGenerating(false);
    }
  }, [path, scope]);

  /**
   * Place an image. Stored **deck-relative** when the file is under the deck's
   * own folder, so moving or syncing the project does not break it; an absolute
   * path is kept only for a file genuinely outside the tree, where there is no
   * relative form to record.
   */
  const addImage = useCallback(async () => {
    const chosen = await open({
      multiple: false,
      filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg"] }],
    });
    if (typeof chosen !== "string") return;
    const id = newObjectId();
    withObjects((list) => [
      ...list,
      {
        id,
        kind: "image",
        src: toDeckRelative(chosen),
        fit: "contain",
        x: 0.3,
        y: 0.3,
        w: 0.4,
        h: 0.4,
        rot: 0,
        opacity: 1,
      },
    ]);
    setSelection(new Set([id]));
  }, [withObjects, toDeckRelative]);

  // --- TeX figures ---------------------------------------------------------
  // A TeX figure is an ordinary `image` object whose `src` PNG is generated by
  // compiling and rasterizing a `.tex` the object also remembers (`texSrc`).
  // Three entry points converge on one low-level step (`rasterizeInto`): the
  // toolbar FAB creates the pair from scratch, "Recompile" reruns an existing
  // one, and the poll below reacts when the author recompiles from the source
  // tab directly rather than from here.

  const markTexBusy = useCallback((id: string, busy: boolean) => {
    setTexBusyIds((cur) => {
      const next = new Set(cur);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  /** Read `pdfAbs`, rasterize its first page, and write the PNG to `pngAbs`.
   *  Records the PDF's new mtime so the poll never re-processes a write this
   *  view just made itself. Returns the raster's pixel size, or null on
   *  failure (reported by the caller, which knows the right wording). */
  const rasterizeInto = useCallback(
    async (pdfAbs: string, pngAbs: string) => {
      const pdfBytes = new Uint8Array(await readFileBytes(pdfAbs, scope));
      const rendered = await renderPdfPageToPng(pdfBytes);
      if (!rendered) return null;
      await writeFileBytes(pngAbs, rendered.png, scope);
      const mt = await fileMtime(pdfAbs, scope).catch(() => null);
      if (mt != null) mtimesRef.current.set(pdfAbs, mt);
      return rendered;
    },
    [scope],
  );

  const addTexFigure = useCallback(async () => {
    if (!deck) return;
    const dir = texFigureDir(path);
    const id = newObjectId();
    const texAbs = `${dir}/${id}.tex`;
    const pngAbs = `${dir}/${id}.png`;
    markTexBusy(id, true);
    setError(null);
    try {
      await writeFileBytes(texAbs, new TextEncoder().encode(starterTexFigure()), scope);
      const res = await invoke<TexCompileResult>("compile_tex", { path: texAbs });
      if (!res.success || !res.pdf_path) {
        setNotice(
          `The TeX figure did not compile. ${res.log.trim().split("\n").slice(-3).join(" ")}`,
        );
        return;
      }
      const rendered = await rasterizeInto(res.pdf_path, pngAbs);
      if (!rendered) {
        setNotice("The TeX figure compiled, but Eldrun could not rasterize the result.");
        return;
      }
      // Preserve the figure's own aspect ratio rather than forcing it into a
      // square — a wide equation squashed into a box is illegible.
      const w = 0.3;
      const h = w * (deck.pageWidth / deck.pageHeight) * (rendered.height / rendered.width);
      withObjects((list) => [
        ...list,
        {
          id,
          kind: "image",
          src: toDeckRelative(pngAbs),
          texSrc: toDeckRelative(texAbs),
          fit: "contain",
          x: 0.35,
          y: 0.35,
          w,
          h,
          rot: 0,
          opacity: 1,
        },
      ]);
      setSelection(new Set([id]));
    } catch (e) {
      setError(describeFileError(e));
    } finally {
      markTexBusy(id, false);
    }
  }, [deck, path, scope, withObjects, toDeckRelative, rasterizeInto, markTexBusy]);

  /** Open a TeX-figure's source as its own tab — Eldrun's full TeX editor, with
   *  its own Compile button and SyncTeX. The poll below is what notices when
   *  that tab's own recompile finishes and updates the slide. */
  const editTexObject = useCallback(
    (obj: ImageObject) => {
      if (!obj.texSrc) return;
      const dir = dirOf(path);
      openLinkedFile(tabKey, dir, {
        path: resolveRel(dir, obj.texSrc),
        viewer: "tex",
        label: obj.texSrc.split("/").pop() ?? obj.texSrc,
      });
    },
    [path, tabKey],
  );

  const recompileTexObject = useCallback(
    async (obj: ImageObject) => {
      if (!obj.texSrc) return;
      const dir = dirOf(path);
      const texAbs = resolveRel(dir, obj.texSrc);
      const pngAbs = resolveRel(dir, obj.src);
      markTexBusy(obj.id, true);
      setError(null);
      try {
        const res = await invoke<TexCompileResult>("compile_tex", { path: texAbs });
        if (!res.success || !res.pdf_path) {
          setNotice(`Recompile failed. ${res.log.trim().split("\n").slice(-3).join(" ")}`);
          return;
        }
        const rendered = await rasterizeInto(res.pdf_path, pngAbs);
        if (!rendered) {
          setNotice("Recompiled, but Eldrun could not rasterize the result.");
          return;
        }
        refreshImage(obj.src);
      } catch (e) {
        setError(describeFileError(e));
      } finally {
        markTexBusy(obj.id, false);
      }
    },
    [path, rasterizeInto, refreshImage, markTexBusy],
  );

  /** Jump to a TeX figure from the deck-wide list (`DeckTexPanel`): select its
   *  slide and the object itself, without leaving TeX mode. */
  const jumpToTexFigure = useCallback((slideIdx: number, objectId: string) => {
    setSlideIndex(slideIdx);
    setSelection(new Set([objectId]));
  }, []);

  // Notice an external recompile — the author hit Compile in the `.tex` tab
  // this view opened, rather than using the Recompile button here — by polling
  // every TeX figure's compiled PDF for an mtime this view did not itself just
  // record. Mirrors the PDF viewer's own external-change poll (same interval);
  // deliberately skips any object already mid-compile, so a manual Recompile
  // and this poll can never race to rasterize the same PDF twice.
  useEffect(() => {
    if (!deck) return;
    const figures = deck.slides.flatMap((s) =>
      s.objects.filter(
        (o): o is ImageObject & { texSrc: string } => o.kind === "image" && !!o.texSrc,
      ),
    );
    if (figures.length === 0) return;
    const dir = dirOf(path);
    let cancelled = false;
    const id = setInterval(() => {
      void (async () => {
        for (const obj of figures) {
          if (cancelled || texBusyIds.has(obj.id)) continue;
          const texAbs = resolveRel(dir, obj.texSrc);
          const pdfAbs = texAbs.replace(/\.tex$/i, ".pdf");
          let mt: number;
          try {
            mt = await fileMtime(pdfAbs, scope);
          } catch {
            continue; // Not compiled yet, or the PDF moved — nothing to raster.
          }
          if (cancelled) return;
          const known = mtimesRef.current.get(pdfAbs);
          if (known === mt) continue;
          if (known == null) {
            // First observation of this PDF this session — its PNG is presumed
            // already in sync (either this view just wrote it, or it was saved
            // that way in an earlier session), so this establishes the baseline
            // rather than re-rastering something that has not actually changed.
            mtimesRef.current.set(pdfAbs, mt);
            continue;
          }
          const pngAbs = resolveRel(dir, obj.src);
          markTexBusy(obj.id, true);
          try {
            const rendered = await rasterizeInto(pdfAbs, pngAbs);
            if (rendered && !cancelled) refreshImage(obj.src);
          } catch {
            // A transient read failure (mid-write) — the next tick retries.
          } finally {
            if (!cancelled) markTexBusy(obj.id, false);
          }
        }
      })();
    }, TEX_FIGURE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [deck, path, scope, texBusyIds, rasterizeInto, refreshImage, markTexBusy]);

  // --- keyboard ----------------------------------------------------------
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // A keystroke aimed at a form control (the inspector's text/number fields)
      // is that control's — never a canvas shortcut. Without this, typing a space
      // or hitting Backspace while editing text would nudge or delete the object.
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.isContentEditable ||
          t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT")
      ) {
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
        return;
      }
      if (mod && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
        e.preventDefault();
        redo();
        return;
      }
      if (mod && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSelection(new Set((deck?.slides[slideIndex]?.objects ?? []).map((o) => o.id)));
        return;
      }
      if (mod && e.key.toLowerCase() === "c") {
        copySelection();
        return;
      }
      if (mod && e.key.toLowerCase() === "x") {
        if (selection.size === 0) return;
        e.preventDefault();
        copySelection();
        withObjects((list, ids) => removeObjects(list, ids));
        setSelection(new Set());
        return;
      }
      if (mod && e.key.toLowerCase() === "v") {
        e.preventDefault();
        pasteClipboard();
        return;
      }
      if (mod && e.key.toLowerCase() === "d") {
        e.preventDefault();
        duplicateSelection();
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selection.size === 0) return;
        e.preventDefault();
        withObjects((list, ids) => removeObjects(list, ids));
        setSelection(new Set());
        return;
      }
      if (e.key === "Escape") {
        setSelection(new Set());
        return;
      }
      const step = e.shiftKey ? NUDGE * 10 : NUDGE;
      const nudge: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      };
      const d = nudge[e.key];
      if (d && selection.size > 0) {
        e.preventDefault();
        withObjects((list, ids) => moveObjects(list, ids, d[0], d[1]));
      }
    },
    [
      deck,
      slideIndex,
      selection,
      withObjects,
      undo,
      redo,
      copySelection,
      pasteClipboard,
      duplicateSelection,
    ],
  );

  // --- rail resize ---------------------------------------------------------
  // Pointer-based, live-local during the drag, committed (and persisted) once
  // on release — the same shape `SubwindowFilesSidebar`'s resize handle uses,
  // for the same reason: a store write per pointermove is the easiest way to
  // make a resize feel broken.
  const startRailResize = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      const startX = e.clientX;
      const startW = railWidth;
      let last = startW;
      const onMove = (ev: PointerEvent) => {
        last = clampRailWidth(startW + (ev.clientX - startX));
        setLiveRailWidth(last);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        setLiveRailWidth(null);
        if (last !== startW) {
          setRailWidth(last);
          railState.persist({ deckRailWidth: last });
        }
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [railWidth, railState],
  );

  // --- render ------------------------------------------------------------

  const slide = deck?.slides[slideIndex];
  const hasSel = selection.size > 0;

  if (error) {
    return (
      <div className="file-viewer">
        <div className="file-viewer-error">{error}</div>
      </div>
    );
  }
  if (!deck) {
    return (
      <div className="file-viewer">
        <div className="file-viewer-loading">Opening presentation…</div>
      </div>
    );
  }

  return (
    <div className="file-viewer deck-view" tabIndex={0} onKeyDown={onKeyDown}>
      <div className="file-viewer-pdf-toolbar" role="group" aria-label="Presentation tools">
        <span className="deck-toolbar-title">
          Presentation <UntestedTag />
        </span>
        <span className="file-viewer-pdf-toolbar-sep" />
        <button className="file-viewer-zoom-btn" onClick={addText} title="Add a text box">
          T
        </button>
        <button className="file-viewer-zoom-btn" onClick={addRect} title="Add a rectangle">
          ▭
        </button>
        <button
          className="file-viewer-zoom-btn"
          onClick={() => setPicking("new")}
          title="Add an icon"
        >
          ☆
        </button>
        <button
          className="file-viewer-zoom-btn"
          onClick={() => void addImage()}
          title="Add an image (PNG or JPEG)"
        >
          ▣
        </button>
        <button
          className="file-viewer-zoom-btn"
          onClick={() => void addTexFigure()}
          disabled={!texAvailable || texBusyIds.size > 0}
          title="Add a TeX figure: opens a blank, ready-to-compile .tex and places its compiled PDF as an image"
        >
          𝒯+
        </button>
        <span className="file-viewer-pdf-toolbar-sep" />
        <button
          className="file-viewer-zoom-btn"
          disabled={!hasSel}
          onClick={duplicateSelection}
          title="Duplicate selection (Ctrl+D)"
        >
          ⧉
        </button>
        <span className="file-viewer-pdf-toolbar-sep" />
        <button
          className="file-viewer-zoom-btn"
          disabled={!hasSel}
          onClick={() => withObjects((l, ids) => alignObjects(l, ids, "left"))}
          title="Align left"
        >
          ⇤
        </button>
        <button
          className="file-viewer-zoom-btn"
          disabled={!hasSel}
          onClick={() => withObjects((l, ids) => alignObjects(l, ids, "hcenter"))}
          title="Centre horizontally"
        >
          ⇔
        </button>
        <button
          className="file-viewer-zoom-btn"
          disabled={!hasSel}
          onClick={() => withObjects((l, ids) => alignObjects(l, ids, "right"))}
          title="Align right"
        >
          ⇥
        </button>
        <span className="file-viewer-pdf-toolbar-sep" />
        <button
          className="file-viewer-zoom-btn"
          disabled={!hasSel}
          onClick={() => withObjects((l, ids) => toFront(l, ids))}
          title="Bring to front"
        >
          ⤒
        </button>
        <button
          className="file-viewer-zoom-btn"
          disabled={!hasSel}
          onClick={() => withObjects((l, ids) => raiseObjects(l, ids))}
          title="Raise"
        >
          ↑
        </button>
        <button
          className="file-viewer-zoom-btn"
          disabled={!hasSel}
          onClick={() => withObjects((l, ids) => lowerObjects(l, ids))}
          title="Lower"
        >
          ↓
        </button>
        <button
          className="file-viewer-zoom-btn"
          disabled={!hasSel}
          onClick={() => withObjects((l, ids) => toBack(l, ids))}
          title="Send to back"
        >
          ⤓
        </button>
        <span className="file-viewer-pdf-toolbar-sep" />
        <button
          className={`file-viewer-zoom-text${mode === "design" ? " active" : ""}`}
          onClick={() => setMode("design")}
          title="Arrange objects on the slide"
        >
          Design
        </button>
        <button
          className={`file-viewer-zoom-text${mode === "animate" ? " active" : ""}`}
          onClick={() => setMode("animate")}
          title="Build steps, transitions, and GIF animations between slides"
        >
          Animate
        </button>
        <button
          className={`file-viewer-zoom-text${mode === "notes" ? " active" : ""}`}
          onClick={() => setMode("notes")}
          title="Speaker notes for the current slide (shown only in the presenter view)"
        >
          Notes
        </button>
        <button
          className={`file-viewer-zoom-text${mode === "tex" ? " active" : ""}`}
          onClick={() => setMode("tex")}
          title="Every TeX figure in this deck, across all slides"
        >
          TeX
        </button>
        <span className="file-viewer-pdf-toolbar-sep" />
        <button
          className="file-viewer-zoom-text"
          onClick={() => setPresenting(true)}
          disabled={deck.slides.length === 0}
          title="Present fullscreen (Esc to exit)"
        >
          ▶ Present
        </button>
        <button
          className="file-viewer-zoom-text"
          onClick={() => void doExport()}
          disabled={exporting || !metrics}
          title="Flatten the layers into a PDF beside this deck"
        >
          {exporting ? "Exporting…" : "Export PDF"}
        </button>
        <span className="file-viewer-header-spacer" />
        <span className="deck-save-state" aria-live="polite">
          {saving ? "Saving…" : "Saved"}
        </span>
        <button className="file-viewer-zoom-btn" onClick={onOpenExternally} title="Open externally">
          ↗
        </button>
      </div>

      {notice && <div className="file-viewer-banner">{notice}</div>}

      <div className="deck-body">
        <div
          className="deck-rail"
          role="listbox"
          aria-label="Slides"
          style={{ width: liveRailWidth ?? railWidth }}
        >
          <div className="deck-rail-head">Slides</div>
          {deck.slides.map((s, i) => (
            <div
              key={s.id}
              className={`deck-rail-item${i === slideIndex ? " active" : ""}`}
              role="option"
              aria-selected={i === slideIndex}
              tabIndex={0}
              style={{ aspectRatio: `${deck.pageWidth} / ${deck.pageHeight}` }}
              onClick={() => {
                setSlideIndex(i);
                setSelection(new Set());
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  setSlideIndex(i);
                  setSelection(new Set());
                }
              }}
            >
              <DeckRailThumb
                doc={doc}
                page={s.anchor.page}
                width={Math.max(1, (liveRailWidth ?? railWidth) - 12)}
                height={Math.max(1, ((liveRailWidth ?? railWidth) - 12) * (deck.pageHeight / deck.pageWidth))}
              />
              <span className="deck-rail-num">{i + 1}</span>
              {s.objects.length > 0 && (
                <span className="deck-rail-badge" title={`${s.objects.length} layer objects`}>
                  {s.objects.length}
                </span>
              )}
              {s.after && (
                <span className="deck-rail-gif" title="A GIF plays after this slide">
                  ▶
                </span>
              )}
              {/* Reorder and copy are both durable — reorder moves this slide in the
                  presentation sequence, copy adds a clone that backs the same base
                  page; neither changes the base PDF. */}
              <span className="deck-rail-actions">
                <button
                  className="deck-rail-act-btn"
                  disabled={i === 0}
                  title="Move slide earlier"
                  onClick={(e) => {
                    e.stopPropagation();
                    moveSlide(i, -1);
                  }}
                >
                  ▲
                </button>
                <button
                  className="deck-rail-act-btn"
                  disabled={i === deck.slides.length - 1}
                  title="Move slide later"
                  onClick={(e) => {
                    e.stopPropagation();
                    moveSlide(i, 1);
                  }}
                >
                  ▼
                </button>
                <button
                  className="deck-rail-act-btn"
                  title="Duplicate slide"
                  onClick={(e) => {
                    e.stopPropagation();
                    duplicateSlide(i);
                  }}
                >
                  ⧉
                </button>
              </span>
            </div>
          ))}
        </div>

        <div
          className="deck-rail-resize"
          title="Drag to resize the slide overview"
          onPointerDown={startRailResize}
        />

        {slide ? (
          <DeckStage
            slide={slide}
            doc={doc}
            pageWidth={deck.pageWidth}
            pageHeight={deck.pageHeight}
            margin={deck.theme.margin}
            selection={selection}
            onSelectionChange={setSelection}
            onObjectsChange={setObjects}
            assets={assets}
            metrics={metrics}
            previewStep={mode === "animate" ? previewStep : undefined}
            showBuildBadges={mode === "animate"}
            onEditObject={(obj) => {
              if (obj.kind === "image" && obj.texSrc) editTexObject(obj);
            }}
          />
        ) : (
          <div className="deck-stage deck-stage-empty">
            <p>This presentation has no base PDF yet.</p>
            {texAvailable ? (
              <>
                <p>
                  Eldrun can write a starter LaTeX file beside it and compile it. The
                  file is yours afterwards — recompiling keeps whatever layers you add,
                  which re-anchor to the slides they were placed on.
                </p>
                <button
                  className="deck-inspector-btn"
                  onClick={() => void generateBase()}
                  disabled={generating}
                >
                  {generating ? "Compiling…" : "Create a starter presentation"}
                </button>
              </>
            ) : (
              <p>
                No LaTeX engine was found on PATH, so a base PDF cannot be generated
                here. Point this deck at an existing PDF instead, or install a TeX
                distribution.
              </p>
            )}
          </div>
        )}

        {mode === "tex" ? (
          <DeckTexPanel
            deck={deck}
            onJump={jumpToTexFigure}
            onEditTex={editTexObject}
            onRecompileTex={(obj) => void recompileTexObject(obj)}
            texBusyIds={texBusyIds}
          />
        ) : mode === "notes" && slide ? (
          <DeckNotes slide={slide} onSlideChange={patchSlide} />
        ) : mode === "animate" && slide ? (
          <DeckAnimate
            slide={slide}
            selection={selection}
            onObjectsChange={setObjects}
            onSlideChange={patchSlide}
            previewStep={previewStep}
            onPreviewStep={setPreviewStep}
            toDeckRelative={toDeckRelative}
          />
        ) : (
          <DeckInspector
            objects={slide?.objects ?? []}
            selection={selection}
            onChange={setObjects}
            onPickIcon={() => setPicking("replace")}
            onEditTex={editTexObject}
            onRecompileTex={(obj) => void recompileTexObject(obj)}
            texBusyIds={texBusyIds}
          />
        )}
      </div>

      {picking && <IconPicker onPick={addIcon} onClose={() => setPicking(null)} />}

      {presenting && (
        <DeckPresenter
          deck={deck}
          doc={doc}
          metrics={metrics}
          assets={assets}
          gifs={gifs}
          path={path}
          scope={scope}
          startAt={0}
          onClose={() => setPresenting(false)}
        />
      )}

      {deck.detached.length > 0 && (
        <div className="file-viewer-banner deck-detached-banner">
          <span>
            {deck.detached.length} layer{deck.detached.length === 1 ? "" : "s"} lost
            {deck.detached.length === 1 ? " its" : " their"} slide when the base PDF
            changed. Nothing was deleted — pick one to put back on the slide you are
            viewing.
          </span>
          {deck.detached.map((d, i) => (
            <button
              key={i}
              className="deck-inspector-btn"
              title={`${d.objects.length} object(s), last seen on page ${d.from.page}`}
              onClick={() => commit((cur) => reattach(cur, i, slideIndex))}
            >
              Page {d.from.page} ({d.objects.length}) → slide {slideIndex + 1}
            </button>
          ))}
        </div>
      )}
      {/* `tabKey`/`groupId` are threaded for the presenter and per-tab state that
          Phases 6–7 add; referenced here so the props are not silently dropped. */}
      <span hidden data-tab-key={tabKey ?? ""} data-group-id={groupId ?? ""} />
    </div>
  );
}
