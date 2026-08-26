/**
 * Square, themed scrollbars drawn by the app instead of by the engine.
 *
 * WHY THIS EXISTS. On WebKitGTK — the engine every Linux build runs on — a
 * scrollbar's shape is not reachable from CSS. Setting `scrollbar-width` and
 * `scrollbar-color` gets a native GTK bar: `thin` is parsed but ignored (auto
 * and thin both measure 21px), and the thumb is whatever GTK draws, a rounded
 * capsule. The `::-webkit-scrollbar` pseudo-elements can square it, but the
 * engine only consults them when `scrollbar-width` is `auto` — and with it auto
 * the bar falls back to the native light GTK look (white trough, grey slider)
 * on any surface the pseudo-rules do not fully restyle. Neither path yields a
 * square themed thumb, so the only way to get one is to hide the engine's bar
 * and paint our own. That is what this module does, on every platform, so one
 * look ships everywhere rather than Linux drifting.
 *
 * WHO HIDES THE NATIVE BAR: the stylesheet, not this module. WebKitGTK 2.52
 * builds a scrollable area's bar once and never rebuilds it when
 * `scrollbar-width` changes later — set statically the property works, set from
 * JS on a live element it does nothing while `getComputedStyle` still reports
 * `none`. A takeover that hid the bar as it adopted a container therefore left
 * a native bar standing beside every thumb it painted. `themes.css` hides them
 * all up front instead, so containers are born bar-less; `evictNativeBar` below
 * is only the fallback for one that slipped past that.
 *
 * SHAPE OF THE SOLUTION. One fixed-position layer per window holds every thumb;
 * the app's own DOM is never wrapped or restructured (a wrapper element around
 * arbitrary scroll containers is what breaks React reconciliation, and Eldrun
 * has scroll containers in dozens of components). A container opts IN simply by
 * being scrollable — discovery is automatic — and opts OUT by already setting
 * `scrollbar-width: none`, which is how the app already says "this strip
 * scrolls but shows no bar" (the tab strip, the pill row, the mobile key row).
 * Those keep no bar, exactly as before.
 *
 * COST. Nothing polls. Two kinds of update exist and they are deliberately
 * asymmetric:
 *   - a SCROLL update reads three numbers off the element being scrolled and
 *     writes one transform. No `getBoundingClientRect`, because the container
 *     cannot move while it is merely scrolling — the cached rect stays valid.
 *     This is the path a terminal takes on every line of output, so it must not
 *     force a layout read of anything but the element itself.
 *   - a GEOMETRY update re-measures rects, re-tests visibility and prunes dead
 *     entries. It runs on resize, on DOM mutation and on an ancestor scrolling,
 *     never per frame of scrolling.
 * Both coalesce into a single rAF, and neither runs while the document is
 * hidden (a background window paints nothing worth measuring).
 */

/** Gutter width/height in px. Matches the `*::-webkit-scrollbar` size it replaces. */
const SIZE = 8;
/** A thumb never shrinks below this, however long the content is. */
const MIN_THUMB = 24;
/** Marks a container whose bar we have taken over; the CSS hides the native one. */
const TAKEOVER_ATTR = "data-eldrun-scrollbar";
/**
 * Where a window parks its uninstall, so a dev hot-reload of this module tears
 * the previous layer down instead of stacking a second one on top of it. A
 * string key rather than a module-level flag on purpose: replacing the module
 * replaces the flag, which is exactly the case that would double up.
 */
const INSTALL_KEY = "__eldrunCustomScrollbars";

export interface TrackMetrics {
  /** Full scrollable extent (`scrollHeight` / `scrollWidth`). */
  scrollSize: number;
  /** Visible extent (`clientHeight` / `clientWidth`). */
  clientSize: number;
  /** Current scroll offset (`scrollTop` / `scrollLeft`). */
  scrollPos: number;
  /** Length of the track the thumb slides along, in px. */
  trackLength: number;
}

export interface ThumbGeometry {
  /** Thumb length along the track, in px. */
  size: number;
  /** Thumb offset from the start of the track, in px. */
  offset: number;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * Thumb length and position for one axis, or null when the axis cannot scroll.
 *
 * The 1px slack on the overflow test is not superstition: a container whose
 * content is exactly its own height reports a `scrollHeight` one larger than
 * `clientHeight` on fractional device-pixel-ratio displays, and without the
 * slack every such element would sprout a full-length thumb that cannot move.
 */
export function thumbGeometry(m: TrackMetrics): ThumbGeometry | null {
  const overflow = m.scrollSize - m.clientSize;
  if (overflow <= 1 || m.trackLength <= 0) return null;
  const ratio = m.clientSize / m.scrollSize;
  const size = clamp(Math.round(m.trackLength * ratio), Math.min(MIN_THUMB, m.trackLength), m.trackLength);
  const maxOffset = m.trackLength - size;
  if (maxOffset <= 0) return { size, offset: 0 };
  const offset = Math.round((clamp(m.scrollPos, 0, overflow) / overflow) * maxOffset);
  return { size, offset: clamp(offset, 0, maxOffset) };
}

/**
 * Where a drag of `deltaPx` along the track should leave the scroll offset.
 *
 * The thumb moves across `trackLength - thumbSize` px while the content moves
 * across `scrollSize - clientSize` px, so the pointer delta scales by the ratio
 * between them — dragging a short thumb through a long document must cover more
 * content per pixel, which is exactly what makes a scrollbar feel right.
 */
export function scrollFromDrag(startScroll: number, deltaPx: number, m: TrackMetrics): number {
  const overflow = m.scrollSize - m.clientSize;
  const geom = thumbGeometry({ ...m, scrollPos: startScroll });
  if (!geom || overflow <= 0) return startScroll;
  const maxOffset = m.trackLength - geom.size;
  if (maxOffset <= 0) return startScroll;
  return clamp(startScroll + deltaPx * (overflow / maxOffset), 0, overflow);
}

/**
 * True when this element's own CSS asks for no scrollbar at all — no native bar
 * and no thumb of ours either. The tab strip, the project pill row and the
 * address display are the surfaces that mean it.
 *
 * The signal is `--eldrun-scrollbar: none`, a property registered in themes.css
 * so it does not inherit. It used to be `scrollbar-width: none`, which read the
 * decision straight off the stylesheet where it was made — but that stopped
 * distinguishing anything once every element had to be born with the native bar
 * already hidden, which is to say once `* { scrollbar-width: none }` became the
 * baseline. A dedicated property keeps the decision in the stylesheet without
 * overloading a value the engine now needs for something else.
 */
function optedOut(style: CSSStyleDeclaration): boolean {
  return style.getPropertyValue("--eldrun-scrollbar").trim() === "none";
}

/**
 * Evict a native scrollbar that reached first layout before the stylesheet's
 * hide could apply — a third-party sheet (xterm, pdf.js) or an inline style
 * naming its own `scrollbar-width` is how one gets through.
 *
 * WebKitGTK will not restyle a scrollbar that already exists, so the bar has to
 * be destroyed along with the scrollable area that owns it: toggling `overflow`
 * away and back does exactly that. Measured on 2.52.3 — the gutter drops from
 * 21px to 0, and `scrollTop` survives the round trip, so a terminal parked in
 * its scrollback does not jump to the top. It costs two forced layouts, hence
 * the early return: in the normal case, where the baseline did its job, this
 * only reads two numbers.
 */
function evictNativeBar(el: HTMLElement, style: CSSStyleDeclaration): void {
  // `offsetWidth - clientWidth` is the borders PLUS the scrollbar gutter, so the
  // borders have to come off before what is left can be called a bar.
  const border = (a: string, b: string) =>
    (parseFloat(style.getPropertyValue(a)) || 0) + (parseFloat(style.getPropertyValue(b)) || 0);
  const gutterX = el.offsetWidth - el.clientWidth - border("border-left-width", "border-right-width");
  const gutterY = el.offsetHeight - el.clientHeight - border("border-top-width", "border-bottom-width");
  if (gutterX < 1 && gutterY < 1) return;
  const inline = el.style.overflow;
  el.style.overflow = "hidden";
  void el.offsetHeight;
  // Back to whatever it was — an empty string hands control to the stylesheet.
  el.style.overflow = inline;
  void el.offsetHeight;
}

function scrollableAxis(overflow: string): boolean {
  return overflow === "auto" || overflow === "scroll" || overflow === "overlay";
}

interface Entry {
  el: HTMLElement;
  vertical: HTMLElement | null;
  horizontal: HTMLElement | null;
  /** Viewport rect of the container, refreshed only by a geometry pass. */
  top: number;
  left: number;
  width: number;
  height: number;
  /** False while the container is off-screen or covered by something else. */
  visible: boolean;
  /**
   * True when another registered container lives inside this one, i.e. when
   * scrolling THIS element moves someone else's cached rect. Scrolling an
   * element never moves its own box, so without this flag every scroll would
   * have to re-measure the whole window — which is the one thing a terminal
   * printing a build log must not cost.
   */
  nested: boolean;
}

type InstallHost = Window & { [INSTALL_KEY]?: () => void };

export function installCustomScrollbars(): () => void {
  if (typeof document === "undefined") return () => {};
  const host = window as InstallHost;
  // Tear down whatever a previous evaluation of this module left running.
  host[INSTALL_KEY]?.();

  const layer = document.createElement("div");
  layer.className = "eldrun-scrollbar-layer";
  layer.setAttribute("aria-hidden", "true");
  document.body.appendChild(layer);

  const entries = new Map<HTMLElement, Entry>();
  let geometryQueued = false;
  let scrollQueued = false;
  const dirtyScroll = new Set<HTMLElement>();
  let rafHandle = 0;

  // ── Registration ──────────────────────────────────────────────────────────

  /**
   * Observed per container as it registers, not re-attached in a sweep after
   * every mutation batch: a menu opening should cost one `observe` call, not a
   * disconnect-and-reobserve of every scroll container in the window.
   */
  const resizeObserver = new ResizeObserver(() => queueGeometry());

  function makeThumb(axis: "vertical" | "horizontal", el: HTMLElement): HTMLElement {
    const thumb = document.createElement("div");
    thumb.className = `eldrun-scrollbar-thumb eldrun-scrollbar-${axis}`;
    thumb.setAttribute("role", "presentation");
    bindDrag(thumb, el, axis);
    layer.appendChild(thumb);
    return thumb;
  }

  function register(el: HTMLElement): void {
    if (entries.has(el)) return;
    const style = getComputedStyle(el);
    if (optedOut(style)) return;
    const canV = scrollableAxis(style.overflowY) && el.scrollHeight - el.clientHeight > 1;
    const canH = scrollableAxis(style.overflowX) && el.scrollWidth - el.clientWidth > 1;
    if (!canV && !canH) return;
    el.setAttribute(TAKEOVER_ATTR, "");
    // The attribute's own rule carries `!important`, which is what keeps a
    // per-surface rule further down the stylesheet from resurrecting a bar under
    // the thumb. It cannot help an element that already HAS one, though — for
    // that, and only when there is one, the bar gets evicted the hard way.
    evictNativeBar(el, style);
    entries.set(el, {
      el,
      vertical: canV ? makeThumb("vertical", el) : null,
      horizontal: canH ? makeThumb("horizontal", el) : null,
      top: 0,
      left: 0,
      width: 0,
      height: 0,
      visible: false,
      nested: false,
    });
    resizeObserver.observe(el);
  }

  function unregister(el: HTMLElement): void {
    const entry = entries.get(el);
    if (!entry) return;
    entry.vertical?.remove();
    entry.horizontal?.remove();
    resizeObserver.unobserve(el);
    el.removeAttribute(TAKEOVER_ATTR);
    entries.delete(el);
  }

  /**
   * Find scroll containers inside `root`.
   *
   * The cheap test comes first on purpose: `scrollHeight`/`clientHeight` are
   * plain property reads, while `getComputedStyle` allocates, so filtering on
   * the overflow numbers before asking for a style object keeps a full-document
   * scan proportional to the handful of elements that actually scroll rather
   * than to the whole tree.
   */
  function scan(root: ParentNode): void {
    const candidates = root.querySelectorAll<HTMLElement>("*");
    for (const el of candidates) {
      if (entries.has(el)) continue;
      if (el.scrollHeight - el.clientHeight > 1 || el.scrollWidth - el.clientWidth > 1) {
        register(el);
      }
    }
    if (root instanceof HTMLElement && !entries.has(root)) {
      if (root.scrollHeight - root.clientHeight > 1 || root.scrollWidth - root.clientWidth > 1) {
        register(root);
      }
    }
  }

  // ── Update passes ─────────────────────────────────────────────────────────

  function applyScroll(entry: Entry): void {
    const { el } = entry;
    if (entry.vertical) {
      const geom = thumbGeometry({
        scrollSize: el.scrollHeight,
        clientSize: el.clientHeight,
        scrollPos: el.scrollTop,
        trackLength: entry.height,
      });
      paint(entry.vertical, geom, entry, "vertical");
    }
    if (entry.horizontal) {
      const geom = thumbGeometry({
        scrollSize: el.scrollWidth,
        clientSize: el.clientWidth,
        scrollPos: el.scrollLeft,
        trackLength: entry.width,
      });
      paint(entry.horizontal, geom, entry, "horizontal");
    }
  }

  function paint(
    thumb: HTMLElement,
    geom: ThumbGeometry | null,
    entry: Entry,
    axis: "vertical" | "horizontal",
  ): void {
    if (!geom || !entry.visible) {
      thumb.style.opacity = "0";
      thumb.style.pointerEvents = "none";
      return;
    }
    thumb.style.opacity = "1";
    thumb.style.pointerEvents = "auto";
    if (axis === "vertical") {
      thumb.style.height = `${geom.size}px`;
      thumb.style.transform = `translate(${entry.left + entry.width - SIZE}px, ${entry.top + geom.offset}px)`;
    } else {
      thumb.style.width = `${geom.size}px`;
      thumb.style.transform = `translate(${entry.left + geom.offset}px, ${entry.top + entry.height - SIZE}px)`;
    }
  }

  /**
   * Is this container the thing you would actually touch at that point?
   *
   * A hit test rather than a list of "which selectors count as a modal": the
   * layer is one fixed element for the whole window, so without this the right
   * panel's thumb would paint straight over an open dialog that covers it.
   * Asking the document what is topmost handles every overlay the app has now
   * and every one it grows later, with no list to keep in step. The probe point
   * sits inside the container's content, clear of the gutter, so a thumb can
   * never be the answer to its own question.
   */
  function isReachable(entry: Entry): boolean {
    const { top, left, width, height } = entry;
    if (width <= 0 || height <= 0) return false;
    if (top + height <= 0 || left + width <= 0) return false;
    if (top >= window.innerHeight || left >= window.innerWidth) return false;
    const x = clamp(left + width - SIZE - 2, 0, window.innerWidth - 1);
    const y = clamp(top + Math.min(height / 2, height - 2), 0, window.innerHeight - 1);
    const hit = document.elementFromPoint(x, y);
    return !!hit && (hit === entry.el || entry.el.contains(hit));
  }

  function runGeometry(): void {
    for (const [el] of entries) {
      if (!el.isConnected) unregister(el);
    }
    const live = [...entries.values()];
    for (const entry of live) {
      const rect = entry.el.getBoundingClientRect();
      entry.top = rect.top;
      entry.left = rect.left;
      entry.width = rect.width;
      entry.height = rect.height;
      entry.visible = isReachable(entry);
      applyScroll(entry);
    }
    // Recomputed here rather than on every scroll: containment only changes
    // when the tree does, and the tree changing is what got us here.
    for (const entry of live) {
      entry.nested = live.some((other) => other !== entry && entry.el.contains(other.el));
    }
  }

  function flush(): void {
    rafHandle = 0;
    if (document.hidden) {
      geometryQueued = false;
      scrollQueued = false;
      dirtyScroll.clear();
      return;
    }
    if (geometryQueued) {
      geometryQueued = false;
      scrollQueued = false;
      dirtyScroll.clear();
      runGeometry();
      return;
    }
    if (scrollQueued) {
      scrollQueued = false;
      for (const el of dirtyScroll) {
        const entry = entries.get(el);
        if (entry) applyScroll(entry);
      }
      dirtyScroll.clear();
    }
  }

  function schedule(): void {
    if (rafHandle) return;
    rafHandle = requestAnimationFrame(flush);
  }

  function queueGeometry(): void {
    geometryQueued = true;
    schedule();
  }

  function queueScroll(el: HTMLElement): void {
    scrollQueued = true;
    dirtyScroll.add(el);
    schedule();
  }

  // ── Dragging ──────────────────────────────────────────────────────────────

  function bindDrag(thumb: HTMLElement, el: HTMLElement, axis: "vertical" | "horizontal"): void {
    thumb.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const entry = entries.get(el);
      if (!entry) return;
      const vertical = axis === "vertical";
      const startPointer = vertical ? e.clientY : e.clientX;
      const startScroll = vertical ? el.scrollTop : el.scrollLeft;
      const metrics: TrackMetrics = {
        scrollSize: vertical ? el.scrollHeight : el.scrollWidth,
        clientSize: vertical ? el.clientHeight : el.clientWidth,
        scrollPos: startScroll,
        trackLength: vertical ? entry.height : entry.width,
      };
      thumb.setPointerCapture(e.pointerId);
      thumb.classList.add("dragging");
      document.body.classList.add("eldrun-scrollbar-dragging");

      const onMove = (move: PointerEvent) => {
        const delta = (vertical ? move.clientY : move.clientX) - startPointer;
        const next = scrollFromDrag(startScroll, delta, metrics);
        if (vertical) el.scrollTop = next;
        else el.scrollLeft = next;
      };
      const onUp = () => {
        thumb.classList.remove("dragging");
        document.body.classList.remove("eldrun-scrollbar-dragging");
        thumb.removeEventListener("pointermove", onMove);
        thumb.removeEventListener("pointerup", onUp);
        thumb.removeEventListener("pointercancel", onUp);
      };
      thumb.addEventListener("pointermove", onMove);
      thumb.addEventListener("pointerup", onUp);
      thumb.addEventListener("pointercancel", onUp);
    });

    // A wheel over the thumb should scroll what it belongs to, not fall through
    // to whatever sits under the fixed layer.
    thumb.addEventListener(
      "wheel",
      (e: WheelEvent) => {
        e.preventDefault();
        if (axis === "vertical") el.scrollTop += e.deltaY;
        else el.scrollLeft += e.deltaX || e.deltaY;
      },
      { passive: false },
    );
  }

  // ── Wiring ────────────────────────────────────────────────────────────────

  /**
   * Capture phase, because `scroll` does not bubble: this is the one listener
   * that sees every scroll in the window. It doubles as the safety net for
   * discovery — anything the mutation scan missed registers the instant it is
   * first scrolled, so a container can be wrong for one frame but never longer.
   */
  const onScroll = (e: Event) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) {
      queueGeometry();
      return;
    }
    if (!entries.has(target)) {
      register(target);
      queueGeometry();
      return;
    }
    queueScroll(target);
    // An ancestor scrolling moves its descendants' containers without any of
    // them firing a scroll of their own, so their cached rects are now stale.
    // Only an ancestor: an element's own scroll never moves its own box, which
    // is what keeps the common case one transform write.
    if (entries.get(target)?.nested) queueGeometry();
  };

  const mutationObserver = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof HTMLElement) scan(node);
      }
    }
    queueGeometry();
  });

  document.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", queueGeometry);
  document.addEventListener("visibilitychange", queueGeometry);
  mutationObserver.observe(document.body, { childList: true, subtree: true });

  scan(document.body);
  queueGeometry();

  const uninstall = () => {
    document.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", queueGeometry);
    document.removeEventListener("visibilitychange", queueGeometry);
    mutationObserver.disconnect();
    resizeObserver.disconnect();
    if (rafHandle) cancelAnimationFrame(rafHandle);
    for (const el of [...entries.keys()]) unregister(el);
    layer.remove();
    if (host[INSTALL_KEY] === uninstall) delete host[INSTALL_KEY];
  };
  host[INSTALL_KEY] = uninstall;
  return uninstall;
}
