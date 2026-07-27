/**
 * Speaker-notes editor — the authoring half of `Slide.notes`.
 *
 * Until this existed, notes were write-only: the presenter's speaker-notes panel
 * (`DeckPresenter.tsx`) reads `slide.notes`, but nothing in the editor ever set
 * it. A dedicated mode (alongside Design/Animate) keeps the same "swap the right
 * panel, leave the stage" shape those two already use, rather than inventing a
 * separate surface for one textarea.
 */

import type { Slide } from "../../../lib/viewers/deck/model";
import { useT } from "../../../lib/i18n";

export interface DeckNotesProps {
  slide: Slide;
  onSlideChange: (patch: (s: Slide) => Slide) => void;
}

export function DeckNotes({ slide, onSlideChange }: DeckNotesProps) {
  const t = useT();
  return (
    <div className="deck-inspector deck-notes">
      <div className="deck-inspector-head">{t("deckNotes.title")}</div>
      <textarea
        className="deck-notes-textarea"
        value={slide.notes}
        placeholder={t("deckNotes.placeholder")}
        onChange={(e) => {
          const notes = e.target.value;
          onSlideChange((s) => ({ ...s, notes }));
        }}
      />
    </div>
  );
}
