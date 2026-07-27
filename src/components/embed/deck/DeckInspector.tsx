/**
 * The property panel for the current selection.
 *
 * It edits through the same pure `updateObjects` op the stage's gestures use, so
 * there is one mutation path and one history entry per change however the change
 * was made. Fields are shown per *kind*: a mixed selection gets only the
 * properties every member actually has, rather than a form whose controls
 * silently apply to some objects and not others.
 */

import type {
  DeckObject,
  ImageObject,
  ListKind,
  ObjectList,
  ShapeKind,
  TextAlign,
} from "../../../lib/viewers/deck/model";
import { customFontPath, fontKey, updateObjects } from "../../../lib/viewers/deck/model";
import { FontField } from "./FontField";
import { ALIGN_KEYS } from "./DeckThemePanel";
import { useT } from "../../../lib/i18n";

export interface DeckInspectorProps {
  objects: ObjectList;
  selection: ReadonlySet<string>;
  onChange: (next: ObjectList) => void;
  /** Opens the icon picker to replace the selected icon. */
  onPickIcon: () => void;
  /** Opens a TeX-figure image's `.tex` source as its own tab. */
  onEditTex?: (obj: ImageObject) => void;
  /** Recompiles a TeX-figure image's source and re-rasterizes it onto the slide. */
  onRecompileTex?: (obj: ImageObject) => void;
  /** Ids of objects currently (re)compiling. */
  texBusyIds?: ReadonlySet<string>;
  /** Swap the file behind an image object, keeping its geometry and build step. */
  onReplaceImage?: (obj: ImageObject) => void;
  /** Custom font paths the deck names but could not load (#120), so the picker
   *  can say "missing" rather than showing a face that is not what will draw. */
  missingFonts?: ReadonlySet<string>;
}

/**
 * A colour control that understands the **8-digit** hex the model actually uses.
 *
 * `<input type="color">` accepts only `#rrggbb`. The deck's default shape fill is
 * `#00000000` — fully transparent — so a new rectangle inherited a value the
 * swatch rendered as opaque black, and one interaction with the picker committed
 * that: a transparent rect turned solid black by being looked at (TODO V #119).
 * So the swatch shows the RGB half and an alpha slider owns the last byte, and
 * the two are recombined on the way out.
 */
export function ColorField({
  label,
  value,
  onChange,
  /** Show the alpha slider. Off for a pure ink colour (text, icon stroke), where
   *  the object's own opacity is the right control and a second one is a trap. */
  alpha = true,
  title,
}: {
  label?: string;
  value: string | undefined;
  onChange: (next: string) => void;
  alpha?: boolean;
  title?: string;
}) {
  const t = useT();
  const rgb = (value ?? "#000000").slice(0, 7);
  const a = alphaOf(value);
  return (
    <label className="deck-field deck-field-color" title={title}>
      {label && <span>{label}</span>}
      <span className="deck-color-row">
        <input
          type="color"
          value={/^#[0-9a-f]{6}$/i.test(rgb) ? rgb : "#000000"}
          onChange={(e) => onChange(alpha ? withAlpha(e.target.value, a) : e.target.value)}
        />
        {alpha && (
          <input
            className="deck-alpha"
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(a * 100)}
            title={t("deckInspector.opacityTitle", { pct: Math.round(a * 100) })}
            onChange={(e) => onChange(withAlpha(rgb, Number(e.target.value) / 100))}
          />
        )}
      </span>
    </label>
  );
}

/** The alpha byte of a `#rrggbbaa`, or 1 for the 6-digit form. */
function alphaOf(hex: string | undefined): number {
  if (!hex || !/^#[0-9a-f]{8}$/i.test(hex)) return 1;
  return parseInt(hex.slice(7, 9), 16) / 255;
}

/** Recombine an `#rrggbb` with an alpha. Drops the byte entirely at full opacity,
 *  so an ordinary colour stays in the ordinary 6-digit form in the file. */
function withAlpha(rgb: string, a: number): string {
  const base = rgb.slice(0, 7);
  if (a >= 1) return base;
  return `${base}${Math.round(Math.max(0, a) * 255)
    .toString(16)
    .padStart(2, "0")}`;
}

/**
 * The value every selected object agrees on, or `undefined` if they differ —
 * which is also what a control renders as "(differs)" rather than silently
 * showing the first object's value and applying it to all of them on focus.
 *
 * Generic over the element type so it can take an already-narrowed array
 * (`texts`, `shapes`) without the getter widening back to `DeckObject`.
 */
function shared<O, T>(objs: readonly O[], get: (o: O) => T): T | undefined {
  if (objs.length === 0) return undefined;
  const first = get(objs[0]);
  return objs.every((o) => get(o) === first) ? first : undefined;
}

export function DeckInspector({
  objects,
  selection,
  onChange,
  onPickIcon,
  onEditTex,
  onRecompileTex,
  texBusyIds,
  onReplaceImage,
  missingFonts,
}: DeckInspectorProps) {
  const t = useT();
  const sel = objects.filter((o) => selection.has(o.id));
  if (sel.length === 0) {
    return (
      <div className="deck-inspector">
        <p className="deck-inspector-empty">{t("deckInspector.emptyMsg")}</p>
      </div>
    );
  }

  const ids = sel.map((o) => o.id);
  const patch = (fn: (o: DeckObject) => DeckObject) => onChange(updateObjects(objects, ids, fn));

  const texts = sel.filter((o): o is Extract<DeckObject, { kind: "text" }> => o.kind === "text");
  const shapes = sel.filter((o): o is Extract<DeckObject, { kind: "shape" }> => o.kind === "shape");
  const icons = sel.filter((o): o is Extract<DeckObject, { kind: "icon" }> => o.kind === "icon");
  const images = sel.filter((o): o is Extract<DeckObject, { kind: "image" }> => o.kind === "image");
  const allText = texts.length === sel.length;
  const allShape = shapes.length === sel.length;
  const allIcon = icons.length === sel.length;
  const allImage = images.length === sel.length;
  const KIND_KEYS = {
    text: "deckInspector.kindText",
    shape: "deckInspector.kindShape",
    icon: "deckInspector.kindIcon",
    image: "deckInspector.kindImage",
  } as const;

  return (
    <div className="deck-inspector">
      <div className="deck-inspector-head">
        {sel.length === 1
          ? t(KIND_KEYS[sel[0].kind])
          : t("deckInspector.multiObjectsHead", { n: sel.length })}
      </div>

      {/* --- text --- */}
      {allText && (
        <>
          <label className="deck-field deck-field-wide">
            <span>{t("deckInspector.textLabel")}</span>
            <textarea
              rows={3}
              value={shared(texts, (o) => (o as typeof texts[number]).text) ?? ""}
              placeholder={sel.length > 1 ? t("deckInspector.differsPlaceholder") : ""}
              onChange={(e) =>
                patch((o) => (o.kind === "text" ? { ...o, text: e.target.value } : o))
              }
            />
          </label>

          <div className="deck-field-row">
            <FontField
              value={shared(texts, (o) => fontKey(o.style.family)) ? texts[0].style.family : "sans"}
              missing={texts.some((o) => {
                const p = customFontPath(o.style.family);
                return p != null && missingFonts?.has(p) === true;
              })}
              onChange={(family) =>
                patch((o) => (o.kind === "text" ? { ...o, style: { ...o.style, family } } : o))
              }
            />
            <label className="deck-field deck-field-narrow">
              <span>{t("deckInspector.sizeLabel")}</span>
              <input
                type="number"
                min={1}
                max={400}
                value={shared(texts, (o) => o.style.size) ?? ""}
                onChange={(e) => {
                  const size = Number(e.target.value);
                  if (!Number.isFinite(size) || size <= 0) return;
                  patch((o) => (o.kind === "text" ? { ...o, style: { ...o.style, size } } : o));
                }}
              />
            </label>
          </div>

          <div className="deck-field-row">
            <button
              className={`deck-toggle${shared(texts, (o) => o.style.bold) ? " active" : ""}`}
              onClick={() =>
                patch((o) =>
                  o.kind === "text" ? { ...o, style: { ...o.style, bold: !o.style.bold } } : o,
                )
              }
              title={t("deckInspector.boldTitle")}
            >
              <b>B</b>
            </button>
            <button
              className={`deck-toggle${shared(texts, (o) => o.style.italic) ? " active" : ""}`}
              onClick={() =>
                patch((o) =>
                  o.kind === "text" ? { ...o, style: { ...o.style, italic: !o.style.italic } } : o,
                )
              }
              title={t("deckInspector.italicTitle")}
            >
              <i>I</i>
            </button>
            {(["left", "center", "right"] as TextAlign[]).map((a) => (
              <button
                key={a}
                className={`deck-toggle${shared(texts, (o) => o.style.align) === a ? " active" : ""}`}
                onClick={() =>
                  patch((o) => (o.kind === "text" ? { ...o, style: { ...o.style, align: a } } : o))
                }
                title={t("deckInspector.alignTitle", { align: t(ALIGN_KEYS[a]) })}
              >
                {a === "left" ? "⬅" : a === "center" ? "↔" : "➡"}
              </button>
            ))}
            <label className="deck-field deck-field-color">
              <input
                type="color"
                // Ink is opaque — the object's own opacity is the control for
                // fading it — so the 8-digit form is clipped rather than shown as
                // a swatch that would silently commit `#000000`.
                value={(shared(texts, (o) => o.style.color) ?? "#111111").slice(0, 7)}
                onChange={(e) =>
                  patch((o) =>
                    o.kind === "text" ? { ...o, style: { ...o.style, color: e.target.value } } : o,
                  )
                }
                title={t("deckInspector.textColourTitle")}
              />
            </label>
          </div>

          <div className="deck-field-row">
            <label className="deck-field">
              <span>{t("deckInspector.listLabel")}</span>
              <select
                value={shared(texts, (o) => o.list?.kind ?? "none") ?? "none"}
                onChange={(e) => {
                  const v = e.target.value;
                  patch((o) =>
                    o.kind === "text"
                      ? v === "none"
                        ? { ...o, list: undefined }
                        : { ...o, list: { kind: v as ListKind, start: o.list?.start ?? 1 } }
                      : o,
                  );
                }}
              >
                <option value="none">{t("deckInspector.listNone")}</option>
                <option value="bullet">{t("deckInspector.listBullets")}</option>
                <option value="number">1. 2. 3.</option>
                <option value="alpha">a. b. c.</option>
                <option value="roman">i. ii. iii.</option>
              </select>
            </label>
            {texts.some((o) => o.list && o.list.kind !== "bullet") && (
              <label className="deck-field deck-field-narrow">
                <span>{t("deckInspector.startAtLabel")}</span>
                <input
                  type="number"
                  min={1}
                  value={shared(texts, (o) => o.list?.start ?? 1) ?? 1}
                  onChange={(e) => {
                    const start = Math.max(1, Math.round(Number(e.target.value)));
                    if (!Number.isFinite(start)) return;
                    patch((o) =>
                      o.kind === "text" && o.list ? { ...o, list: { ...o.list, start } } : o,
                    );
                  }}
                />
              </label>
            )}
          </div>

          {/* Everything below was modelled from the start and had no control at
              all, so setting it meant hand-editing the sidecar JSON (TODO V #119). */}
          <div className="deck-field-row">
            <label className="deck-field deck-field-narrow">
              <span>{t("deckInspector.paddingLabel")}</span>
              <input
                type="number"
                min={0}
                step={0.5}
                value={shared(texts, (o) => o.padding) ?? ""}
                title={t("deckInspector.paddingTitle")}
                onChange={(e) => {
                  const padding = Number(e.target.value);
                  if (!Number.isFinite(padding) || padding < 0) return;
                  patch((o) => (o.kind === "text" ? { ...o, padding } : o));
                }}
              />
            </label>
            <label className="deck-field deck-field-narrow">
              <span>{t("deckInspector.lineHeightLabel")}</span>
              <input
                type="number"
                min={0.5}
                step={0.05}
                value={shared(texts, (o) => o.style.lineHeight) ?? ""}
                title={t("deckInspector.lineHeightTitle")}
                onChange={(e) => {
                  const lineHeight = Number(e.target.value);
                  if (!Number.isFinite(lineHeight) || lineHeight < 0.5) return;
                  patch((o) =>
                    o.kind === "text" ? { ...o, style: { ...o.style, lineHeight } } : o,
                  );
                }}
              />
            </label>
          </div>

          <div className="deck-field-row">
            <ColorField
              label={t("deckInspector.boxLabel")}
              value={shared(texts, (o) => o.fill) ?? "#ffffff"}
              title={t("deckInspector.boxFillTitle")}
              onChange={(fill) => patch((o) => (o.kind === "text" ? { ...o, fill } : o))}
            />
            <button
              className="deck-toggle"
              onClick={() => patch((o) => (o.kind === "text" ? { ...o, fill: undefined } : o))}
              title={t("deckInspector.noBoxFillTitle")}
            >
              ⃠
            </button>
            <ColorField
              label={t("deckInspector.borderLabel")}
              value={shared(texts, (o) => o.stroke) ?? "#111111"}
              onChange={(stroke) => patch((o) => (o.kind === "text" ? { ...o, stroke } : o))}
            />
            <button
              className="deck-toggle"
              onClick={() => patch((o) => (o.kind === "text" ? { ...o, stroke: undefined } : o))}
              title={t("deckInspector.noBorderTitle")}
            >
              ⃠
            </button>
            <label className="deck-field deck-field-narrow">
              <span>{t("deckInspector.widthLabel")}</span>
              <input
                type="number"
                min={0}
                step={0.5}
                value={shared(texts, (o) => o.strokeWidth ?? 1) ?? ""}
                onChange={(e) => {
                  const strokeWidth = Number(e.target.value);
                  if (!Number.isFinite(strokeWidth) || strokeWidth < 0) return;
                  patch((o) => (o.kind === "text" ? { ...o, strokeWidth } : o));
                }}
              />
            </label>
          </div>
        </>
      )}

      {/* --- shape --- */}
      {allShape && (
        <>
          <label className="deck-field">
            <span>{t("deckInspector.shapeLabel")}</span>
            <select
              value={shared(shapes, (o) => o.shape) ?? ""}
              onChange={(e) =>
                patch((o) =>
                  o.kind === "shape" ? { ...o, shape: e.target.value as ShapeKind } : o,
                )
              }
            >
              <option value="rect">{t("deckInspector.shapeRect")}</option>
              <option value="roundrect">{t("deckInspector.shapeRoundrect")}</option>
              <option value="ellipse">{t("deckInspector.shapeEllipse")}</option>
              <option value="line">{t("deckInspector.shapeLine")}</option>
              <option value="arrow">{t("deckInspector.shapeArrow")}</option>
              <option value="callout">{t("deckInspector.shapeCallout")}</option>
            </select>
          </label>
          <div className="deck-field-row">
            <ColorField
              label={t("deckInspector.fillLabel")}
              value={shared(shapes, (o) => o.fill) ?? "#ffffff"}
              onChange={(fill) => patch((o) => (o.kind === "shape" ? { ...o, fill } : o))}
            />
            <button
              className="deck-toggle"
              onClick={() => patch((o) => (o.kind === "shape" ? { ...o, fill: undefined } : o))}
              title={t("deckInspector.noFillTitle")}
            >
              ⃠
            </button>
            <ColorField
              label={t("deckInspector.strokeLineLabel")}
              value={shared(shapes, (o) => o.stroke) ?? "#111111"}
              onChange={(stroke) => patch((o) => (o.kind === "shape" ? { ...o, stroke } : o))}
            />
            <label className="deck-field deck-field-narrow">
              <span>{t("deckInspector.widthLabel")}</span>
              <input
                type="number"
                min={0}
                step={0.5}
                value={shared(shapes, (o) => o.strokeWidth) ?? ""}
                onChange={(e) => {
                  const strokeWidth = Number(e.target.value);
                  if (!Number.isFinite(strokeWidth) || strokeWidth < 0) return;
                  patch((o) => (o.kind === "shape" ? { ...o, strokeWidth } : o));
                }}
              />
            </label>
          </div>
          {shapes.some((o) => o.shape === "line" || o.shape === "arrow") && (
            <div className="deck-field-row">
              <label className="deck-field">
                <span>{t("deckInspector.startLabel")}</span>
                <select
                  value={shared(shapes, (o) => o.tail ?? "none") ?? "none"}
                  onChange={(e) =>
                    patch((o) =>
                      o.kind === "shape"
                        ? { ...o, tail: e.target.value as typeof o.tail }
                        : o,
                    )
                  }
                >
                  <option value="none">{t("deckInspector.headNone")}</option>
                  <option value="arrow">{t("deckInspector.headArrow")}</option>
                  <option value="dot">{t("deckInspector.headDot")}</option>
                  <option value="bar">{t("deckInspector.headBar")}</option>
                </select>
              </label>
              <label className="deck-field">
                <span>{t("deckInspector.endLabel")}</span>
                <select
                  value={shared(shapes, (o) => o.head ?? "none") ?? "none"}
                  onChange={(e) =>
                    patch((o) =>
                      o.kind === "shape"
                        ? { ...o, head: e.target.value as typeof o.head }
                        : o,
                    )
                  }
                >
                  <option value="none">{t("deckInspector.headNone")}</option>
                  <option value="arrow">{t("deckInspector.headArrow")}</option>
                  <option value="dot">{t("deckInspector.headDot")}</option>
                  <option value="bar">{t("deckInspector.headBar")}</option>
                </select>
              </label>
            </div>
          )}
        </>
      )}

      {/* --- icon --- */}
      {allIcon && (
        <div className="deck-field-row">
          <button className="deck-inspector-btn" onClick={onPickIcon}>
            {t("deckInspector.changeIconBtn")}
          </button>
          <ColorField
            label={t("deckInspector.colourLabel")}
            alpha={false}
            value={shared(icons, (o) => o.color) ?? "#111111"}
            onChange={(color) => patch((o) => (o.kind === "icon" ? { ...o, color } : o))}
          />
          <label className="deck-field deck-field-narrow">
            <span>{t("deckInspector.weightLabel")}</span>
            <input
              type="number"
              min={0}
              step={0.5}
              value={shared(icons, (o) => o.strokeWidth) ?? ""}
              onChange={(e) => {
                const strokeWidth = Number(e.target.value);
                if (!Number.isFinite(strokeWidth) || strokeWidth < 0) return;
                patch((o) => (o.kind === "icon" ? { ...o, strokeWidth } : o));
              }}
            />
          </label>
        </div>
      )}

      {/* --- image --- */}
      {allImage && (
        <div className="deck-field-row">
          <label className="deck-field">
            <span>{t("deckInspector.fitLabel")}</span>
            <select
              value={shared(images, (o) => o.fit) ?? ""}
              onChange={(e) =>
                patch((o) =>
                  o.kind === "image" ? { ...o, fit: e.target.value as typeof o.fit } : o,
                )
              }
            >
              <option value="contain">{t("deckInspector.fitContain")}</option>
              <option value="cover">{t("deckInspector.fitCover")}</option>
              <option value="stretch">{t("deckInspector.fitStretch")}</option>
            </select>
          </label>
          {/* Swapping the picture was simply not offered: the only route was
              delete-and-re-place, which threw away the object's position, size,
              rotation and build step (TODO V #108). Single selection only — one
              file cannot sensibly replace several different images at once. */}
          {sel.length === 1 && !images[0]?.texSrc && onReplaceImage && (
            <button
              className="deck-inspector-btn"
              onClick={() => onReplaceImage(images[0])}
              title={images[0].src}
            >
              {t("deckInspector.replaceImageBtn")}
            </button>
          )}
        </div>
      )}

      {/* --- TeX figure: only meaningful for a single selected object, since
          "edit" and "recompile" are inherently a one-object action. --- */}
      {sel.length === 1 && sel[0].kind === "image" && sel[0].texSrc && (
        <div className="deck-field deck-field-wide deck-tex-field">
          <span>{t("deckInspector.texFigureLabel")}</span>
          <div className="deck-field-row">
            <button
              className="deck-inspector-btn"
              disabled={texBusyIds?.has(sel[0].id)}
              onClick={() => onEditTex?.(sel[0] as ImageObject)}
              title={sel[0].texSrc}
            >
              {t("deckInspector.editSourceBtn")}
            </button>
            <button
              className="deck-inspector-btn"
              disabled={texBusyIds?.has(sel[0].id)}
              onClick={() => onRecompileTex?.(sel[0] as ImageObject)}
            >
              {texBusyIds?.has(sel[0].id) ? t("deckTexPanel.compiling") : t("deckTexPanel.recompile")}
            </button>
          </div>
        </div>
      )}

      {/* --- common --- */}
      <div className="deck-field-row">
        <label className="deck-field deck-field-narrow">
          <span>{t("deckInspector.opacityLabel")}</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={shared(sel, (o) => o.opacity) ?? 1}
            onChange={(e) => patch((o) => ({ ...o, opacity: Number(e.target.value) }))}
          />
        </label>
        <label className="deck-field deck-field-narrow">
          <span>{t("deckInspector.rotationLabel")}</span>
          <input
            type="number"
            step={1}
            value={shared(sel, (o) => o.rot) ?? 0}
            onChange={(e) => {
              const rot = Number(e.target.value);
              if (!Number.isFinite(rot)) return;
              patch((o) => ({ ...o, rot }));
            }}
          />
        </label>
        <button
          className={`deck-toggle${shared(sel, (o) => o.locked === true) ? " active" : ""}`}
          onClick={() => {
            // Locked objects are skipped by `updateObjects` by design, so
            // UNLOCKING cannot go through it — it would filter out exactly the
            // objects it is meant to change.
            const locking = !shared(sel, (o) => o.locked === true);
            onChange(
              objects.map((o) =>
                selection.has(o.id) ? { ...o, locked: locking ? true : undefined } : o,
              ),
            );
          }}
          title={t("deckInspector.lockTitle")}
        >
          🔒
        </button>
        {/* `hidden` was modelled, honoured by `visibleAt`, respected by the
            exporter — and had no control anywhere (TODO V #119). Same
            can't-go-through-`updateObjects` reasoning as the lock above, since a
            hidden object may also be locked. */}
        <button
          className={`deck-toggle${shared(sel, (o) => o.hidden === true) ? " active" : ""}`}
          onClick={() => {
            const hiding = !shared(sel, (o) => o.hidden === true);
            onChange(
              objects.map((o) =>
                selection.has(o.id) ? { ...o, hidden: hiding ? true : undefined } : o,
              ),
            );
          }}
          title={t("deckInspector.hideTitle")}
        >
          👁
        </button>
      </div>
    </div>
  );
}
