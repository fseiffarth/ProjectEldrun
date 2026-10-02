import { useState } from "react";
import { useT, type TranslationKey } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";
import { DEFAULT_MARKUP_INSTRUCTION, MAX_MARKUP_INSTRUCTION, readMarkupInstruction, writeMarkupInstruction } from "../markupInstruction";

type Translate = (key: TranslationKey, vars?: Record<string, string | number>) => string;

/** What the settings row says the instruction is: the default, or the
 * reader's own. */
export function markupInstructionSummary(custom: string | null, t: Translate): string {
  return custom === null ? t("mobile.markup.instruction.default") : t("mobile.markup.instruction.custom");
}

/** The one place a Mark up Submit's instruction is worded
 * (`markupInstruction.ts`) — the Submit itself sends it as it stands. */
export function MarkupInstructionSheet({ onChange, onClose }: {
  onChange: (custom: string | null) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [text, setText] = useState(() => readMarkupInstruction() ?? DEFAULT_MARKUP_INSTRUCTION);
  const keep = (value: string) => {
    writeMarkupInstruction(value);
    onChange(readMarkupInstruction());
    onClose();
  };

  return <div className="sheet-backdrop" role="presentation" onClick={onClose}>
    <section className="option-sheet schedule-sheet" role="dialog" aria-modal="true" aria-label={t("mobile.markup.instruction.title")} onClick={(event) => event.stopPropagation()}>
      <span className="sheet-grip" aria-hidden="true" />
      <header><button className="sheet-close" onClick={onClose} aria-label="Close">✕</button><h2>{t("mobile.markup.instruction.title")} {isUntested("mobile.markup.instruction") && <small>{t("mobile.newTab.untested")}</small>}</h2><span className="sheet-close" aria-hidden="true" /></header>
      <p className="sheet-note">{t("mobile.markup.instruction.note")}</p>
      <div className="mobile-schedule-form">
        <label>{t("mobile.markup.instruction.label")}<textarea
          rows={7}
          value={text}
          maxLength={MAX_MARKUP_INSTRUCTION}
          onChange={(event) => setText(event.target.value)}
        /></label>
        <div className="mobile-schedule-actions">
          <button onClick={() => keep("")}>{t("mobile.markup.instruction.reset")}</button>
          <button onClick={onClose}>{t("mobile.markup.instruction.cancel")}</button>
          <button className="primary" onClick={() => keep(text)}>{t("mobile.markup.instruction.save")}</button>
        </div>
      </div>
    </section>
  </div>;
}
