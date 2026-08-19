/**
 * The little bar that appears over selected text (#pdf-textselect): the four
 * highlighter colours, "highlight and write a remark", and the copy switch.
 *
 * It exists because selecting a sentence in a document is almost never the end of what
 * the reader wanted, and the two things they wanted next — the words on the clipboard,
 * the sentence marked — have nowhere else to live: a toolbar button is a trip away
 * from the sentence and forgets which one was selected by the time it is pressed, and
 * a right-click menu hides both behind a gesture nobody makes on a paragraph they have
 * just dragged over.
 *
 * Four decisions.
 *
 * **A colour swatch *is* the highlight button.** There is no "Highlight" button that
 * then asks for a colour: marking a sentence is a mid-reading act, and a two-step one
 * is a step too many. The colours are a fixed set of four (see `notes.ts`'s
 * `HIGHLIGHT_COLORS`) for the same reason a highlighter pen comes in a handful — a
 * picker would turn "mark this" into a dialog.
 *
 * **The remark is a separate button, not a colour.** A highlight with a comment on it
 * is a different act from a highlight (one produces a card with the caret in it, over
 * the page, and the other must not), so it is a separate press rather than a modifier
 * nobody would find.
 *
 * **The copy switch says what already happened, and undoes the habit rather than the
 * copy.** Selecting text puts it on the clipboard by itself, which is what a reader
 * quoting a paper wants and what a reader merely pointing at a line does not — so the
 * chip both reports the copy ("Copied") and turns the behaviour off for this document.
 * A clipboard write cannot be taken back, so the honest control is the next one, not
 * an undo of this one.
 *
 * **It never covers what was selected.** The bar hangs above the last line of the
 * selection and flips below it at the top of a page, exactly as the remark card flips
 * side in the margin — a control that hides the text it is about is a control that has
 * to be dismissed before it can be used.
 */
import { useT } from "../../../lib/i18n";
import { UntestedTag } from "../../common/UntestedTag";
import { HIGHLIGHT_COLORS } from "./notes";

/** The bar's own height plus a little air, in CSS pixels — how far above the line it
 *  sits, and the room it needs before it has to flip below. Measured rather than read
 *  from the DOM because where it goes has to be decided in the same paint that mounts
 *  it, and an element that has not been laid out has no height yet. */
const BAR_H = 34;

/** Where the bar goes, in CSS pixels within the page wrapper: centred over the end of
 *  the selection, above it when there is room and below it when there is not. Pure, so
 *  the one piece of arithmetic that decides it is testable. */
export function selectionBarPos(
  x: number,
  y: number,
  scale: number,
  lineHeight: number,
): { left: number; top: number; below: boolean } {
  const left = x * scale;
  const above = y * scale - BAR_H;
  if (above >= 0) return { left, top: above, below: false };
  return { left, top: (y + lineHeight) * scale + 6, below: true };
}

/** A colour triple as a CSS colour. The swatch has to look like the mark it makes, so
 *  it is drawn at the same opacity the highlight is drawn at. */
export function swatchCss(color: readonly [number, number, number], alpha = 1): string {
  const [r, g, b] = color.map((c) => Math.round(c * 255));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function PdfSelectionBar({
  left,
  top,
  copyOn,
  copied,
  onHighlight,
  onRemark,
  onToggleCopy,
}: {
  left: number;
  top: number;
  /** Selecting text copies it by itself. */
  copyOn: boolean;
  /** …and it just did, for this selection. */
  copied: boolean;
  /** Mark the selection in this colour. */
  onHighlight: (color: readonly [number, number, number]) => void;
  /** Mark it and open the card to write about it. */
  onRemark: () => void;
  onToggleCopy: () => void;
}) {
  const t = useT();
  return (
    <div
      className="file-viewer-pdf-sel-bar"
      style={{ left, top }}
      role="group"
      aria-label={t("pdfText.barLabel")}
      // A press inside the bar must not reach the page: `pointerdown` outside a
      // selection is what clears it, so a bar that let the press through would empty
      // the selection it is about before its own click could run.
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {HIGHLIGHT_COLORS.map((c, i) => (
        <button
          key={i}
          type="button"
          className="file-viewer-pdf-sel-swatch"
          style={{ background: swatchCss(c) }}
          title={t("pdfText.highlightTitle")}
          aria-label={t("pdfText.highlightTitle")}
          onClick={() => onHighlight(c)}
        />
      ))}
      <button
        type="button"
        className="file-viewer-zoom-btn file-viewer-zoom-text"
        title={t("pdfText.remarkTitle")}
        onClick={onRemark}
      >
        💬
      </button>
      <span className="file-viewer-pdf-toolbar-sep" aria-hidden="true" />
      {/* The copy state, as one control: what happened and whether it keeps
          happening. `aria-pressed` rather than a checkbox because it is a mode the
          reader is turning off, not a field they are filling in. */}
      <button
        type="button"
        className={`file-viewer-zoom-btn file-viewer-zoom-text file-viewer-pdf-sel-copy${
          copyOn ? " active" : ""
        }`}
        title={t(copyOn ? "pdfText.copyOnTitle" : "pdfText.copyOffTitle")}
        aria-pressed={copyOn}
        onClick={onToggleCopy}
      >
        {copied ? t("pdfText.copied") : "⧉"}
      </button>
      <UntestedTag />
    </div>
  );
}
