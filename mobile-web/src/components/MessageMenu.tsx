import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useT } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";
import { speechTag } from "../speechLang";
import { currentSpeechId, speak, speechOutputSupported, spokenText, stopSpeaking, subscribeSpeech } from "../speechOutput";

/** How long a finger rests on a bubble before its menu opens. Long enough
 * that a flick of the chat is never a press, short enough to feel like the
 * platform's own hold. */
const HOLD_MS = 450;
/** A press that wanders this far is a scroll, not a hold. */
const HOLD_SLOP = 12;

/** The first words of a message, for the sheet's note: which bubble is being
 * acted on, since the sheet covers the chat it came from. */
function preview(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 90 ? `${line.slice(0, 89)}…` : line;
}

/**
 * What can be done with one chat message: copy it, or have the phone read it
 * aloud. A prompt and an answer offer the same two — the reader's own words
 * are read back as readily as the agent's.
 *
 * It is a sheet rather than buttons beside the bubble: the chat is the whole
 * screen on a phone, and two controls per message crowd it. The bubble holds
 * what was said and nothing else; a click-hold on it asks what to do with it.
 */
function MessageMenu({ id, text, onClose }: { id: string; text: string; onClose: () => void }) {
  const t = useT();
  const speaking = useSyncExternalStore(subscribeSpeech, currentSpeechId) === id;
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  // A copy says so and then gets out of the way; a failed one stays to be read.
  useEffect(() => {
    if (!note || note.error) return;
    const timer = window.setTimeout(onClose, 900);
    return () => window.clearTimeout(timer);
  }, [note, onClose]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setNote({ text: t("mobile.focus.copied") });
    } catch {
      setNote({ text: t("mobile.focus.copyFailed"), error: true });
    }
  };
  // Reading keeps the sheet open: the row that started the voice is the one
  // that stops it, and the backdrop dismisses it in a tap.
  const read = () => {
    if (speaking) stopSpeaking();
    else speak(id, spokenText(text, t("mobile.speech.code")), speechTag(), true);
  };
  const title = t("mobile.focus.messageMenu");
  return <div className="sheet-backdrop" role="presentation" onClick={onClose}>
    <section className="option-sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
      <span className="sheet-grip" aria-hidden="true" />
      <header>
        <button className="sheet-close" onClick={onClose} aria-label={t("mobile.focus.messageMenuClose")}>✕</button>
        <h2>{title} {isUntested("mobile.focus.messageMenu") && <small>{t("mobile.focus.untested")}</small>}</h2>
        <span className="sheet-close" aria-hidden="true" />
      </header>
      <p className={note?.error ? "sheet-note error" : "sheet-note"} role={note ? "status" : undefined}>{note ? note.text : preview(text)}</p>
      <ul className="option-list">
        <li>
          <button onClick={copy}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h8" /></svg>
            <span><strong>{t("mobile.focus.copyMessage")}</strong></span>
          </button>
        </li>
        {speechOutputSupported() && <li>
          <button className={speaking ? "current" : ""} onClick={read}>
            {speaking
              ? <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1" /></svg>
              : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v4h3l5 4V6l-5 4zM16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11" /></svg>}
            <span><strong>{t(speaking ? "mobile.speech.stop" : "mobile.speech.read")}</strong></span>
          </button>
        </li>}
      </ul>
    </section>
  </div>;
}

/** The handlers a bubble spreads to open its menu on a click-hold — and, on a
 * mouse, on the right-click that means the same thing. */
export interface HoldHandlers {
  onPointerDown: (event: React.PointerEvent) => void;
  onPointerMove: (event: React.PointerEvent) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
}

/**
 * The message menu for a chat: `hold(id, text)` on every bubble, `menu` once
 * beside them. The message is read at the moment of the press and kept — a
 * shown bubble never changes, and neither does what the menu acts on.
 */
export function useMessageMenu(): { hold: (id: string, text: () => string) => HoldHandlers; menu: React.ReactNode } {
  const [target, setTarget] = useState<{ id: string; text: string } | null>(null);
  const timer = useRef(0);
  const from = useRef<{ x: number; y: number } | null>(null);
  const cancel = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = 0;
    from.current = null;
  }, []);
  useEffect(() => cancel, [cancel]);
  const open = useCallback((id: string, text: () => string) => {
    cancel();
    // The browser's own hold may have selected the words under the finger;
    // this menu is the answer to that press, not a selection.
    window.getSelection()?.removeAllRanges();
    setTarget({ id, text: text() });
  }, [cancel]);
  const close = useCallback(() => setTarget(null), []);
  const hold = useCallback((id: string, text: () => string): HoldHandlers => ({
    onPointerDown: (event) => {
      if (event.button !== 0) return;
      from.current = { x: event.clientX, y: event.clientY };
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => open(id, text), HOLD_MS);
    },
    onPointerMove: (event) => {
      const start = from.current;
      if (!start) return;
      if (Math.abs(event.clientX - start.x) > HOLD_SLOP || Math.abs(event.clientY - start.y) > HOLD_SLOP) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onContextMenu: (event) => {
      event.preventDefault();
      open(id, text);
    },
  }), [cancel, open]);
  return { hold, menu: target && <MessageMenu id={target.id} text={target.text} onClose={close} /> };
}
