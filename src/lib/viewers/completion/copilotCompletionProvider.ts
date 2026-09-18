import { invoke } from "@tauri-apps/api/core";
import type { Settings } from "../../../types";
import { isProseLang } from "./autocomplete";
import {
  CompletionAcceptance, inlineCandidate, offsetToPosition,
  type CompletionCandidate, type CompletionDocument, type CompletionProvider, type CompletionRange,
} from "./completionProvider";

/** Copilot serves a file only when every gate agrees: the experimental flag,
 * the chosen provider, a local project that opted in, and a code language.
 * Anything else keeps Ollama, which never leaves the machine. The backend
 * re-checks all of it (`services::copilot::policy`); this only picks the path. */
export function copilotServes(settings: Settings | null | undefined, enabled: boolean,
  projectId: string | null | undefined, remote: boolean, language: string): projectId is string {
  if (!enabled || !projectId || remote || settings?.code_completion_provider !== "copilot") return false;
  if (!language || language === "plain" || isProseLang(language)) return false;
  const policy = settings.completion_project_policies?.[projectId];
  return policy?.copilot === true && policy.local_only !== true;
}

type ServerCandidate = { id: string; insertText: string; range?: CompletionRange | null };

/** The language server owns model, length and context, so none of Ollama's
 * length modes or attached references apply. One adapter per request. */
export class CopilotCompletionProvider implements CompletionProvider {
  readonly id = "copilot";
  readonly capabilities = { streaming: false, lengthModes: false, references: false };

  constructor(private options: {
    projectId: string; editor: string; automatic: boolean; tabSize: number; insertSpaces: boolean;
  }) {}

  async complete(document: CompletionDocument, signal: AbortSignal,
    publish: (candidates: CompletionCandidate[]) => void): Promise<CompletionCandidate[]> {
    const position = offsetToPosition(document.text, document.caret);
    if (!position) return [];
    const { projectId, editor, automatic, tabSize, insertSpaces } = this.options;
    let requestId: string | undefined;
    const cancel = () => {
      if (requestId) void invoke("copilot_cancel", { projectId, editor, requestId }).catch(() => {});
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      signal.throwIfAborted();
      requestId = await invoke<string>("copilot_prepare", { projectId, editor });
      if (signal.aborted) { cancel(); signal.throwIfAborted(); }
      const items = await invoke<ServerCandidate[]>("copilot_complete", {
        projectId, requestId, path: document.path, editor, version: document.version, text: document.text,
        language: document.language, position, automatic, tabSize, insertSpaces,
      });
      signal.throwIfAborted();
      const result = items.flatMap((item) => {
        const candidate = inlineCandidate(document,
          { insertText: item.insertText, range: item.range ?? undefined }, item.id);
        return candidate ? [{ ...candidate, model: this.id }] : [];
      });
      publish(result);
      return result;
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }
}

/** Shown once, partial acceptance cumulatively, full acceptance once — for the
 * candidate currently ghosted in one editor. Ollama candidates are ignored. */
export class CopilotFeedback {
  private current: { id: string; acceptance: CompletionAcceptance } | null = null;

  constructor(private projectId: string, private editor: string) {}

  show(candidate: CompletionCandidate | undefined) {
    if (candidate?.provider !== "copilot") { this.current = null; return; }
    if (this.current?.id === candidate.id) return;
    this.current = { id: candidate.id, acceptance: new CompletionAcceptance(candidate) };
    this.send("copilot_shown", { candidate: candidate.id });
  }

  /** `text` is what just entered the document from the front of the ghost. */
  accept(text: string) {
    if (!this.current) return;
    const step = this.current.acceptance.accept(text);
    if (!step) { this.current = null; return; }
    this.send("copilot_accepted", {
      candidate: this.current.id, acceptedLength: step.full ? undefined : step.acceptedLength,
    });
    if (step.full) this.current = null;
  }

  close() {
    this.current = null;
    this.send("copilot_close_editor", {});
  }

  private send(command: string, payload: Record<string, unknown>) {
    void invoke(command, { projectId: this.projectId, editor: this.editor, ...payload }).catch(() => {});
  }
}
