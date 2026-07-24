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
  FontFamily,
  ImageObject,
  ListKind,
  ObjectList,
  ShapeKind,
  TextAlign,
} from "../../../lib/viewers/deck/model";
import { updateObjects } from "../../../lib/viewers/deck/model";

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
}: DeckInspectorProps) {
  const sel = objects.filter((o) => selection.has(o.id));
  if (sel.length === 0) {
    return (
      <div className="deck-inspector">
        <p className="deck-inspector-empty">Select something to edit its properties.</p>
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

  return (
    <div className="deck-inspector">
      <div className="deck-inspector-head">
        {sel.length === 1 ? sel[0].kind : `${sel.length} objects`}
      </div>

      {/* --- text --- */}
      {allText && (
        <>
          <label className="deck-field deck-field-wide">
            <span>Text</span>
            <textarea
              rows={3}
              value={shared(texts, (o) => (o as typeof texts[number]).text) ?? ""}
              placeholder={sel.length > 1 ? "(differs)" : ""}
              onChange={(e) =>
                patch((o) => (o.kind === "text" ? { ...o, text: e.target.value } : o))
              }
            />
          </label>

          <div className="deck-field-row">
            <label className="deck-field">
              <span>Font</span>
              <select
                value={shared(texts, (o) => o.style.family) ?? ""}
                onChange={(e) =>
                  patch((o) =>
                    o.kind === "text"
                      ? { ...o, style: { ...o.style, family: e.target.value as FontFamily } }
                      : o,
                  )
                }
              >
                <option value="sans">Helvetica</option>
                <option value="serif">Times</option>
                <option value="mono">Courier</option>
              </select>
            </label>
            <label className="deck-field deck-field-narrow">
              <span>Size</span>
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
              title="Bold"
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
              title="Italic"
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
                title={`Align ${a}`}
              >
                {a === "left" ? "⬅" : a === "center" ? "↔" : "➡"}
              </button>
            ))}
            <label className="deck-field deck-field-color">
              <input
                type="color"
                value={shared(texts, (o) => o.style.color) ?? "#111111"}
                onChange={(e) =>
                  patch((o) =>
                    o.kind === "text" ? { ...o, style: { ...o.style, color: e.target.value } } : o,
                  )
                }
                title="Text colour"
              />
            </label>
          </div>

          <div className="deck-field-row">
            <label className="deck-field">
              <span>List</span>
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
                <option value="none">None</option>
                <option value="bullet">Bullets</option>
                <option value="number">1. 2. 3.</option>
                <option value="alpha">a. b. c.</option>
                <option value="roman">i. ii. iii.</option>
              </select>
            </label>
          </div>
        </>
      )}

      {/* --- shape --- */}
      {allShape && (
        <>
          <label className="deck-field">
            <span>Shape</span>
            <select
              value={shared(shapes, (o) => o.shape) ?? ""}
              onChange={(e) =>
                patch((o) =>
                  o.kind === "shape" ? { ...o, shape: e.target.value as ShapeKind } : o,
                )
              }
            >
              <option value="rect">Rectangle</option>
              <option value="roundrect">Rounded rectangle</option>
              <option value="ellipse">Ellipse</option>
              <option value="line">Line</option>
              <option value="arrow">Arrow</option>
              <option value="callout">Callout</option>
            </select>
          </label>
          <div className="deck-field-row">
            <label className="deck-field deck-field-color">
              <span>Fill</span>
              <input
                type="color"
                value={shared(shapes, (o) => o.fill ?? "#ffffff") ?? "#ffffff"}
                onChange={(e) =>
                  patch((o) => (o.kind === "shape" ? { ...o, fill: e.target.value } : o))
                }
              />
            </label>
            <button
              className="deck-toggle"
              onClick={() => patch((o) => (o.kind === "shape" ? { ...o, fill: undefined } : o))}
              title="No fill"
            >
              ⃠
            </button>
            <label className="deck-field deck-field-color">
              <span>Line</span>
              <input
                type="color"
                value={shared(shapes, (o) => o.stroke) ?? "#111111"}
                onChange={(e) =>
                  patch((o) => (o.kind === "shape" ? { ...o, stroke: e.target.value } : o))
                }
              />
            </label>
            <label className="deck-field deck-field-narrow">
              <span>Width</span>
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
                <span>Start</span>
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
                  <option value="none">None</option>
                  <option value="arrow">Arrow</option>
                  <option value="dot">Dot</option>
                  <option value="bar">Bar</option>
                </select>
              </label>
              <label className="deck-field">
                <span>End</span>
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
                  <option value="none">None</option>
                  <option value="arrow">Arrow</option>
                  <option value="dot">Dot</option>
                  <option value="bar">Bar</option>
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
            Change icon…
          </button>
          <label className="deck-field deck-field-color">
            <span>Colour</span>
            <input
              type="color"
              value={shared(icons, (o) => o.color) ?? "#111111"}
              onChange={(e) =>
                patch((o) => (o.kind === "icon" ? { ...o, color: e.target.value } : o))
              }
            />
          </label>
          <label className="deck-field deck-field-narrow">
            <span>Weight</span>
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
        <label className="deck-field">
          <span>Fit</span>
          <select
            value={shared(images, (o) => o.fit) ?? ""}
            onChange={(e) =>
              patch((o) =>
                o.kind === "image" ? { ...o, fit: e.target.value as typeof o.fit } : o,
              )
            }
          >
            <option value="contain">Contain</option>
            <option value="cover">Cover</option>
            <option value="stretch">Stretch</option>
          </select>
        </label>
      )}

      {/* --- TeX figure: only meaningful for a single selected object, since
          "edit" and "recompile" are inherently a one-object action. --- */}
      {sel.length === 1 && sel[0].kind === "image" && sel[0].texSrc && (
        <div className="deck-field deck-field-wide deck-tex-field">
          <span>TeX figure</span>
          <div className="deck-field-row">
            <button
              className="deck-inspector-btn"
              disabled={texBusyIds?.has(sel[0].id)}
              onClick={() => onEditTex?.(sel[0] as ImageObject)}
              title={sel[0].texSrc}
            >
              Edit source
            </button>
            <button
              className="deck-inspector-btn"
              disabled={texBusyIds?.has(sel[0].id)}
              onClick={() => onRecompileTex?.(sel[0] as ImageObject)}
            >
              {texBusyIds?.has(sel[0].id) ? "Compiling…" : "Recompile"}
            </button>
          </div>
        </div>
      )}

      {/* --- common --- */}
      <div className="deck-field-row">
        <label className="deck-field deck-field-narrow">
          <span>Opacity</span>
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
          <span>Rotation</span>
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
          title="Lock: keep this object out of the way of edits"
        >
          🔒
        </button>
      </div>
    </div>
  );
}
