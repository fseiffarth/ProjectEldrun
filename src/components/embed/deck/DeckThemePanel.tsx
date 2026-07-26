/**
 * Deck mode — the editing surface for `DeckTheme`.
 *
 * `DeckTheme` shipped with readers everywhere and **no writers at all**: the safe
 * margin, the default text style, the shape/icon defaults and
 * `exportInterstitials` were all consumed by the stage, the toolbar and the
 * exporter, and none of them could be set by any UI. Changing a deck's default
 * font meant hand-editing the sidecar JSON, and `exportInterstitials` was simply
 * unreachable — despite the type declaring itself to exist "so a deck looks
 * consistent without effort" (`model.ts`). This is the form (TODO V #117).
 *
 * Two things beyond plain fields make it worth its own mode rather than a corner
 * of the inspector:
 *
 * **The footer.** A slide number or a running title is the most-asked-for thing a
 * deck-wide setting can give, and it is rendered as a *synthetic* object
 * (`model.footerObject`) drawn through the ordinary text path — so it cannot look
 * different on screen and in the export, and there is nothing on any slide to
 * drag, select or lose.
 *
 * **The two propagation buttons.** A theme that only affects objects created
 * *after* it is set is a theme you have to decide on before you start, which is
 * the opposite of how anyone works. So "make this the deck default" reads a
 * selected object's style back into the theme, and "apply to all text" pushes the
 * theme down over what already exists.
 */

import type { Deck, DeckObject, TextAlign } from "../../../lib/viewers/deck/model";
import { defaultFooter } from "../../../lib/viewers/deck/model";
import { ColorField } from "./DeckInspector";
import { FontField } from "./FontField";

export interface DeckThemePanelProps {
  deck: Deck;
  /** The current selection, so "make this the deck default" has a source. */
  selected: readonly DeckObject[];
  onDeckChange: (patch: (d: Deck) => Deck) => void;
  /** Push the theme's text style onto every text object in the deck. */
  onApplyTextToAll: () => void;
}

export function DeckThemePanel({
  deck,
  selected,
  onDeckChange,
  onApplyTextToAll,
}: DeckThemePanelProps) {
  const t = deck.theme;
  const setTheme = (patch: Partial<Deck["theme"]>) =>
    onDeckChange((d) => ({ ...d, theme: { ...d.theme, ...patch } }));
  const setText = (patch: Partial<Deck["theme"]["text"]>) =>
    onDeckChange((d) => ({ ...d, theme: { ...d.theme, text: { ...d.theme.text, ...patch } } }));
  const footer = t.footer;
  const setFooter = (patch: Partial<NonNullable<Deck["theme"]["footer"]>>) =>
    onDeckChange((d) => ({
      ...d,
      theme: { ...d.theme, footer: { ...(d.theme.footer ?? defaultFooter()), ...patch } },
    }));

  const styleSource = selected.find((o) => o.kind === "text");

  return (
    <div className="deck-inspector deck-theme-panel">
      <div className="deck-inspector-head">Default text</div>
      <div className="deck-field-row">
        <FontField value={t.text.family} onChange={(family) => setText({ family })} />
        <label className="deck-field deck-field-narrow">
          <span>Size</span>
          <input
            type="number"
            min={1}
            max={400}
            value={t.text.size}
            onChange={(e) => {
              const size = Number(e.target.value);
              if (Number.isFinite(size) && size > 0) setText({ size });
            }}
          />
        </label>
        <label className="deck-field deck-field-color">
          <input
            type="color"
            value={t.text.color.slice(0, 7)}
            title="Default text colour"
            onChange={(e) => setText({ color: e.target.value })}
          />
        </label>
      </div>
      <div className="deck-field-row">
        <button
          className={`deck-toggle${t.text.bold ? " active" : ""}`}
          onClick={() => setText({ bold: !t.text.bold })}
          title="Bold by default"
        >
          <b>B</b>
        </button>
        <button
          className={`deck-toggle${t.text.italic ? " active" : ""}`}
          onClick={() => setText({ italic: !t.text.italic })}
          title="Italic by default"
        >
          <i>I</i>
        </button>
        {(["left", "center", "right"] as TextAlign[]).map((a) => (
          <button
            key={a}
            className={`deck-toggle${t.text.align === a ? " active" : ""}`}
            onClick={() => setText({ align: a })}
            title={`Align ${a} by default`}
          >
            {a === "left" ? "⬅" : a === "center" ? "↔" : "➡"}
          </button>
        ))}
        <label className="deck-field deck-field-narrow">
          <span>Line height</span>
          <input
            type="number"
            min={0.5}
            step={0.05}
            value={t.text.lineHeight}
            onChange={(e) => {
              const lineHeight = Number(e.target.value);
              if (Number.isFinite(lineHeight) && lineHeight >= 0.5) setText({ lineHeight });
            }}
          />
        </label>
      </div>
      <div className="deck-field-row">
        <button
          className="deck-inspector-btn"
          disabled={!styleSource}
          title="Read the selected text object's style back into the deck default"
          onClick={() =>
            styleSource &&
            styleSource.kind === "text" &&
            setTheme({ text: { ...styleSource.style } })
          }
        >
          Use selection's style
        </button>
        <button
          className="deck-inspector-btn"
          onClick={onApplyTextToAll}
          title="Restyle every text object in the deck to this default"
        >
          Apply to all text
        </button>
      </div>

      <div className="deck-inspector-head">Shapes &amp; icons</div>
      <div className="deck-field-row">
        <ColorField
          label="Shape fill"
          value={t.shapeFill}
          onChange={(shapeFill) => setTheme({ shapeFill })}
        />
        <ColorField
          label="Shape line"
          value={t.shapeStroke}
          alpha={false}
          onChange={(shapeStroke) => setTheme({ shapeStroke })}
        />
        <label className="deck-field deck-field-narrow">
          <span>Width</span>
          <input
            type="number"
            min={0}
            step={0.5}
            value={t.shapeStrokeWidth}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v >= 0) setTheme({ shapeStrokeWidth: v });
            }}
          />
        </label>
      </div>
      <div className="deck-field-row">
        <ColorField
          label="Icon"
          value={t.iconColor}
          alpha={false}
          onChange={(iconColor) => setTheme({ iconColor })}
        />
        <label className="deck-field deck-field-narrow">
          <span>Weight</span>
          <input
            type="number"
            min={0}
            step={0.5}
            value={t.iconStrokeWidth}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v >= 0) setTheme({ iconStrokeWidth: v });
            }}
          />
        </label>
      </div>

      <div className="deck-inspector-head">Layout</div>
      <label className="deck-field">
        <span>Safe margin — {Math.round(t.margin * 100)}% of the page</span>
        <input
          type="range"
          min={0}
          max={20}
          step={1}
          value={Math.round(t.margin * 100)}
          title="The frame objects snap to, so a projector's overscan never clips a caption"
          onChange={(e) => setTheme({ margin: Number(e.target.value) / 100 })}
        />
      </label>

      <div className="deck-inspector-head">Footer</div>
      {!footer ? (
        <button className="deck-inspector-btn" onClick={() => setTheme({ footer: defaultFooter() })}>
          Add a footer / slide number
        </button>
      ) : (
        <>
          <label className="deck-field deck-field-wide">
            <span>Text</span>
            <input
              type="text"
              value={footer.text}
              placeholder="{n} / {N}"
              title="{n} is this slide's number in the talk, {N} the total"
              onChange={(e) => setFooter({ text: e.target.value })}
            />
          </label>
          <div className="deck-field-row">
            {(["left", "center", "right"] as TextAlign[]).map((a) => (
              <button
                key={a}
                className={`deck-toggle${footer.align === a ? " active" : ""}`}
                onClick={() => setFooter({ align: a })}
                title={`Align ${a}`}
              >
                {a === "left" ? "⬅" : a === "center" ? "↔" : "➡"}
              </button>
            ))}
            <label className="deck-field deck-field-narrow">
              <span>Size</span>
              <input
                type="number"
                min={1}
                value={footer.size}
                onChange={(e) => {
                  const size = Number(e.target.value);
                  if (Number.isFinite(size) && size > 0) setFooter({ size });
                }}
              />
            </label>
            <ColorField
              label="Colour"
              alpha={false}
              value={footer.color}
              onChange={(color) => setFooter({ color })}
            />
          </div>
          <div className="deck-field-row">
            <label className="deck-field">
              <span>Distance from the bottom — {Math.round(footer.offset * 1000) / 10}%</span>
              <input
                type="range"
                min={0}
                max={150}
                step={1}
                value={Math.round(footer.offset * 1000)}
                onChange={(e) => setFooter({ offset: Number(e.target.value) / 1000 })}
              />
            </label>
          </div>
          <label className="deck-check">
            <input
              type="checkbox"
              checked={footer.skipFirst}
              onChange={(e) => setFooter({ skipFirst: e.target.checked })}
            />
            <span>Leave the first slide bare (a title page rarely wants a number)</span>
          </label>
          <button
            className="deck-inspector-btn"
            onClick={() => onDeckChange((d) => ({ ...d, theme: { ...d.theme, footer: undefined } }))}
          >
            Remove the footer
          </button>
        </>
      )}

      <div className="deck-inspector-head">Export</div>
      <label className="deck-check">
        <input
          type="checkbox"
          checked={t.exportInterstitials}
          onChange={(e) => setTheme({ exportInterstitials: e.target.checked })}
        />
        <span>
          Write a poster page for each animation — a handout should show a placeholder
          where the clip was, not an unexplained jump.
        </span>
      </label>
    </div>
  );
}
