// The voice language as a list to tap: one sheet, opened from the Reader's
// menu inside a session and from the start page's own row, because the
// setting belongs to the phone rather than to any one terminal — someone who
// dictates in German wants that before they are in a session, not after.

import { useT, type TranslationKey } from "../../../src/lib/i18n";
import { stopSpeaking } from "../speechOutput";
import { speechLangLabel, speechTag, SPEECH_LANGS, writeSpeechLang, type SpeechLang } from "../speechLang";
import { OptionSheet, type SheetOption } from "./OptionSheet";

type Translate = (key: TranslationKey, vars?: Record<string, string | number>) => string;

/** What the row that opens the sheet says it is set to. `auto` names the
 * language the phone turned out to report, since "the phone's language" on its
 * own leaves the reader to guess which one that is. */
export function speechLangSummary(choice: SpeechLang, t: Translate): string {
  return speechLangLabel(choice) ?? `${t("mobile.speech.languageAuto")} · ${speechTag("auto")}`;
}

export function SpeechLangSheet({ chosen, onChoose, onClose }: {
  chosen: SpeechLang;
  onChoose: (choice: SpeechLang) => void;
  onClose: () => void;
}) {
  const t = useT();
  const options: SheetOption[] = SPEECH_LANGS.map((choice) => ({
    key: choice,
    label: speechLangLabel(choice) ?? t("mobile.speech.languageAuto"),
    description: choice === "auto" ? speechTag("auto") : undefined,
    current: choice === chosen,
  }));
  return <OptionSheet
    title={t("mobile.speech.language")}
    note={{ text: t("mobile.speech.languageHint") }}
    options={options}
    waiting=""
    busy={false}
    onPick={(key) => {
      const choice = key as SpeechLang;
      // Whatever is still queued was said for the old voice; the next answer
      // is read in the new one.
      stopSpeaking();
      writeSpeechLang(choice);
      onChoose(choice);
      onClose();
    }}
    onClose={onClose}
  />;
}
