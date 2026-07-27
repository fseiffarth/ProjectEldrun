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
import { useT, type TranslationKey } from "../../../lib/i18n";

export const ALIGN_KEYS: Record<TextAlign, TranslationKey> = {
  left: "deckThemePanel.alignLeft",
  center: "deckThemePanel.alignCenter",
  right: "deckThemePanel.alignRight",
};

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
  const t = useT();
  const theme = deck.theme;
  const setTheme = (patch: Partial<Deck["theme"]>) =>
    onDeckChange((d) => ({ ...d, theme: { ...d.theme, ...patch } }));
  const setText = (patch: Partial<Deck["theme"]["text"]>) =>
    onDeckChange((d) => ({ ...d, theme: { ...d.theme, text: { ...d.theme.text, ...patch } } }));
  const footer = theme.footer;
  const setFooter = (patch: Partial<NonNullable<Deck["theme"]["footer"]>>) =>
    onDeckChange((d) => ({
      ...d,
      theme: { ...d.theme, footer: { ...(d.theme.footer ?? defaultFooter()), ...patch } },
    }));

  const styleSource = selected.find((o) => o.kind === "text");

  return (
    <div className="deck-inspector deck-theme-panel">
      <div className="deck-inspector-head">{t("deckThemePanel.defaultTextTitle")}</div>
      <div className="deck-field-row">
        <FontField value={theme.text.family} onChange={(family) => setText({ family })} />
        <label className="deck-field deck-field-narrow">
          <span>{t("deckThemePanel.sizeLabel")}</span>
          <input
            type="number"
            min={1}
            max={400}
            value={theme.text.size}
            onChange={(e) => {
              const size = Number(e.target.value);
              if (Number.isFinite(size) && size > 0) setText({ size });
            }}
          />
        </label>
        <label className="deck-field deck-field-color">
          <input
            type="color"
            value={theme.text.color.slice(0, 7)}
            title={t("deckThemePanel.defaultTextColorTitle")}
            onChange={(e) => setText({ color: e.target.value })}
          />
        </label>
      </div>
      <div className="deck-field-row">
        <button
          className={`deck-toggle${theme.text.bold ? " active" : ""}`}
          onClick={() => setText({ bold: !theme.text.bold })}
          title={t("deckThemePanel.boldTitle")}
        >
          <b>B</b>
        </button>
        <button
          className={`deck-toggle${theme.text.italic ? " active" : ""}`}
          onClick={() => setText({ italic: !theme.text.italic })}
          title={t("deckThemePanel.italicTitle")}
        >
          <i>I</i>
        </button>
        {(["left", "center", "right"] as TextAlign[]).map((a) => (
          <button
            key={a}
            className={`deck-toggle${theme.text.align === a ? " active" : ""}`}
            onClick={() => setText({ align: a })}
            title={t("deckThemePanel.alignDefaultTitle", { align: t(ALIGN_KEYS[a]) })}
          >
            {a === "left" ? "⬅" : a === "center" ? "↔" : "➡"}
          </button>
        ))}
        <label className="deck-field deck-field-narrow">
          <span>{t("deckThemePanel.lineHeightLabel")}</span>
          <input
            type="number"
            min={0.5}
            step={0.05}
            value={theme.text.lineHeight}
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
          title={t("deckThemePanel.useSelectionTitle")}
          onClick={() =>
            styleSource &&
            styleSource.kind === "text" &&
            setTheme({ text: { ...styleSource.style } })
          }
        >
          {t("deckThemePanel.useSelectionBtn")}
        </button>
        <button
          className="deck-inspector-btn"
          onClick={onApplyTextToAll}
          title={t("deckThemePanel.applyAllTitle")}
        >
          {t("deckThemePanel.applyAllBtn")}
        </button>
      </div>

      <div className="deck-inspector-head">{t("deckThemePanel.shapesTitle")}</div>
      <div className="deck-field-row">
        <ColorField
          label={t("deckThemePanel.shapeFillLabel")}
          value={theme.shapeFill}
          onChange={(shapeFill) => setTheme({ shapeFill })}
        />
        <ColorField
          label={t("deckThemePanel.shapeLineLabel")}
          value={theme.shapeStroke}
          alpha={false}
          onChange={(shapeStroke) => setTheme({ shapeStroke })}
        />
        <label className="deck-field deck-field-narrow">
          <span>{t("deckThemePanel.widthLabel")}</span>
          <input
            type="number"
            min={0}
            step={0.5}
            value={theme.shapeStrokeWidth}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v >= 0) setTheme({ shapeStrokeWidth: v });
            }}
          />
        </label>
      </div>
      <div className="deck-field-row">
        <ColorField
          label={t("deckThemePanel.iconLabel")}
          value={theme.iconColor}
          alpha={false}
          onChange={(iconColor) => setTheme({ iconColor })}
        />
        <label className="deck-field deck-field-narrow">
          <span>{t("deckThemePanel.weightLabel")}</span>
          <input
            type="number"
            min={0}
            step={0.5}
            value={theme.iconStrokeWidth}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v >= 0) setTheme({ iconStrokeWidth: v });
            }}
          />
        </label>
      </div>

      <div className="deck-inspector-head">{t("deckThemePanel.layoutTitle")}</div>
      <label className="deck-field">
        <span>{t("deckThemePanel.safeMargin", { pct: Math.round(theme.margin * 100) })}</span>
        <input
          type="range"
          min={0}
          max={20}
          step={1}
          value={Math.round(theme.margin * 100)}
          title={t("deckThemePanel.safeMarginTitle")}
          onChange={(e) => setTheme({ margin: Number(e.target.value) / 100 })}
        />
      </label>

      <div className="deck-inspector-head">{t("deckThemePanel.footerTitle")}</div>
      {!footer ? (
        <button className="deck-inspector-btn" onClick={() => setTheme({ footer: defaultFooter() })}>
          {t("deckThemePanel.addFooterBtn")}
        </button>
      ) : (
        <>
          <label className="deck-field deck-field-wide">
            <span>{t("deckThemePanel.textLabel")}</span>
            <input
              type="text"
              value={footer.text}
              placeholder="{n} / {N}"
              title={t("deckThemePanel.footerTextTitle")}
              onChange={(e) => setFooter({ text: e.target.value })}
            />
          </label>
          <div className="deck-field-row">
            {(["left", "center", "right"] as TextAlign[]).map((a) => (
              <button
                key={a}
                className={`deck-toggle${footer.align === a ? " active" : ""}`}
                onClick={() => setFooter({ align: a })}
                title={t("deckThemePanel.footerAlignTitle", { align: t(ALIGN_KEYS[a]) })}
              >
                {a === "left" ? "⬅" : a === "center" ? "↔" : "➡"}
              </button>
            ))}
            <label className="deck-field deck-field-narrow">
              <span>{t("deckThemePanel.sizeLabel")}</span>
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
              label={t("deckThemePanel.colourLabel")}
              alpha={false}
              value={footer.color}
              onChange={(color) => setFooter({ color })}
            />
          </div>
          <div className="deck-field-row">
            <label className="deck-field">
              <span>
                {t("deckThemePanel.footerDistance", { pct: Math.round(footer.offset * 1000) / 10 })}
              </span>
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
            <span>{t("deckThemePanel.skipFirstLabel")}</span>
          </label>
          <button
            className="deck-inspector-btn"
            onClick={() => onDeckChange((d) => ({ ...d, theme: { ...d.theme, footer: undefined } }))}
          >
            {t("deckThemePanel.removeFooterBtn")}
          </button>
        </>
      )}

      <div className="deck-inspector-head">{t("deckThemePanel.exportTitle")}</div>
      <label className="deck-check">
        <input
          type="checkbox"
          checked={theme.exportInterstitials}
          onChange={(e) => setTheme({ exportInterstitials: e.target.checked })}
        />
        <span>{t("deckThemePanel.posterPageLabel")}</span>
      </label>
    </div>
  );
}
