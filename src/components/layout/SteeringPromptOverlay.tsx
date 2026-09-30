import { useEffect, useId, useState } from "react";
import { DialogShell } from "../common/PromptDialogs";
import { ErrorNote } from "../common/ErrorNote";
import { UntestedTag } from "../common/UntestedTag";
import { useT } from "../../lib/i18n";
import {
  STEERING_PROMPT_EVENT,
  sendSteeringPrompt,
  type SteeringPromptDetail,
} from "../../lib/shortcuts/steeringAgent";
import { useKeyboardSteeringStore } from "../../stores/keyboardSteering";

type Open = Omit<SteeringPromptDetail, "handled">;

/**
 * Steering's prompt box (the Prompt key, I by default): a text box in the
 * middle of the window for the active agent tab, so a prompt goes in without
 * leaving the keyboard mode for the terminal. Enter submits it
 * (`sendSteeringPrompt`), Shift+Enter breaks the line; Enter or Escape hands
 * the keyboard back to steering on the level the key was pressed on, as the
 * project jump does. A send that fails keeps the box and the text, with why.
 *
 * Mounted once in `AppShell`; opened by `STEERING_PROMPT_EVENT`. A modal
 * (`DialogShell`), so steering's key handler stands aside while it is up.
 */
export function SteeringPromptOverlay() {
  const [open, setOpen] = useState<Open | null>(null);

  useEffect(() => {
    const onRequest = (e: Event) => {
      const detail = (e as CustomEvent<SteeringPromptDetail>).detail;
      detail.handled = true;
      setOpen({ scope: detail.scope, tab: detail.tab, level: detail.level });
    };
    window.addEventListener(STEERING_PROMPT_EVENT, onRequest);
    return () => window.removeEventListener(STEERING_PROMPT_EVENT, onRequest);
  }, []);

  if (!open) return null;
  const close = () => {
    setOpen(null);
    const steering = useKeyboardSteeringStore.getState();
    steering.enter();
    if (open.level !== "tabs") steering.setLevel(open.level);
  };
  // Keyed by the tab, so a box reopened for another tab starts empty.
  return <PromptBox key={`${open.scope}:${open.tab.key}`} target={open} onClose={close} />;
}

function PromptBox({ target, onClose }: { target: Open; onClose: () => void }) {
  const t = useT();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const submittable = !busy && value.trim().length > 0;

  async function submit() {
    if (!submittable) return;
    setBusy(true);
    setError(null);
    try {
      await sendSteeringPrompt(target.tab, value);
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <DialogShell className="steering-prompt-dialog" onDismiss={() => !busy && onClose()}>
      <h2>
        {t("steering.prompt.title", { tab: target.tab.label })}
        <UntestedTag id="steering.agentPrompt" />
      </h2>
      <textarea
        className="file-paste-name steering-prompt-input"
        autoFocus
        rows={4}
        aria-label={t("steering.prompt.placeholder")}
        placeholder={t("steering.prompt.placeholder")}
        aria-invalid={!!error}
        aria-describedby={error ? errorId : undefined}
        value={value}
        disabled={busy}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
          e.preventDefault();
          void submit();
        }}
      />
      {error && <ErrorNote id={errorId} role="alert" className="file-delete-path file-delete-error" error={error} />}
      <div className="file-delete-actions">
        <span className="steering-prompt-hint">{t("steering.prompt.hint")}</span>
        <button type="button" onClick={onClose} disabled={busy}>
          {t("common.cancel")}
        </button>
        <button type="button" onClick={() => void submit()} disabled={!submittable}>
          {t("steering.prompt.send")}
        </button>
      </div>
    </DialogShell>
  );
}
