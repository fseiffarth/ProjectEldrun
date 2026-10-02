/**
 * The desktop PDF viewer's markup mode, the parts with no React in them
 * (`docs/pdf_markup_rounds_plan.md` §2.6): when the Mark up button shows and
 * when it is held back, where an on-disk change of the PDF goes while marks are
 * on it, which viewer of a window may mark a given file, and the typed call
 * into `pdf_markup_submit` with its refusal codes in the reader's words.
 *
 * The layer itself — marks, rounds, storage, the pill's machine — is the
 * phone's pure core in `mobile-web/src/markup/`, imported as is.
 */
import { invoke } from "@tauri-apps/api/core";
import type { TranslationKey } from "../i18n";
import type { Mark } from "../../../mobile-web/src/markup/layer";
import { BOX_SCOPE_PREFIX } from "../terminal/ptyId";

/** The largest PDF the backend reads for a bake (`outbox::MAX_OUTBOX_FILE`,
 * what `files::read` serves). */
export const MAX_MARKUP_PDF = 24 * 1024 * 1024;

/** Why the Mark up button is not offered, or offered but held back. */
export type MarkupGate =
  | { show: false }
  | { show: true; blocked: null | "arranged" | "claimed" };

/**
 * Whether this viewer offers Mark up. Hidden — not merely disabled — where v1
 * has no answer: the root scope and boxes (no one project's agent tab to send
 * to), a remote project (the bake reads the local tree), a popout window (the
 * scheduler's hold that types the prompt in lives in the main window), and a
 * PDF past what the backend reads. Held back where it would mark the wrong
 * pages: an arrangement that is not the file's own page order, or unsaved
 * edits — sheet *i* must be file page *i*. And one viewer per file per window.
 */
export function markupGate(input: {
  scope: string | null;
  source: "remote" | "local" | "none";
  detached: boolean;
  /** The loaded file's size in bytes; `null` until a document is loaded. */
  size: number | null;
  /** The arrangement is the file's own pages, in order, unturned. */
  pristine: boolean;
  dirty: boolean;
  claimedElsewhere: boolean;
}): MarkupGate {
  const { scope } = input;
  if (!scope || scope === "root" || scope.startsWith(BOX_SCOPE_PREFIX)) return { show: false };
  if (input.source !== "none" || input.detached) return { show: false };
  if (input.size === null || input.size > MAX_MARKUP_PDF) return { show: false };
  if (!input.pristine || input.dirty) return { show: true, blocked: "arranged" };
  if (input.claimedElsewhere) return { show: true, blocked: "claimed" };
  return { show: true, blocked: null };
}

/** Where an on-disk change of the open PDF goes. */
export type DiskChange = "stale" | "markup" | "reload";

/**
 * The one rule for all three ways the viewer learns its file changed — the
 * mtime poll, a compile's plain re-read request, and a SyncTeX reveal after a
 * compile. Unsaved page edits keep the stale banner they always had. Marks on
 * screen (or a round in flight) hold the new pages back: they would slide in
 * under marks drawn on the old ones, so the markup strip offers Reload instead.
 * Otherwise the PDF reloads on its own, exactly as without markup.
 */
export function diskChangeAction(state: { dirty: boolean; markupHolds: boolean }): DiskChange {
  if (state.dirty) return "stale";
  if (state.markupHolds) return "markup";
  return "reload";
}

// ── One marking viewer per file per window ────────────────────────────────
// Two panes marking one PDF would both write its one IndexedDB record, each
// over the other's strokes. Module state, so it is per window — which is the
// scope of that risk: a popout never offers Mark up.

const claims = new Map<string, string>();
const claimListeners = new Set<() => void>();
let claimVersion = 0;

function claimsChanged(): void {
  claimVersion += 1;
  for (const listener of claimListeners) listener();
}

/** Takes `key` for `owner`; `false` when another viewer holds it. */
export function claimMarkup(key: string, owner: string): boolean {
  const holder = claims.get(key);
  if (holder !== undefined && holder !== owner) return false;
  if (holder === undefined) {
    claims.set(key, owner);
    claimsChanged();
  }
  return true;
}

/** Gives `key` back — only by the viewer that holds it. */
export function releaseMarkup(key: string, owner: string): void {
  if (claims.get(key) !== owner) return;
  claims.delete(key);
  claimsChanged();
}

/** Who marks `key` in this window, if anyone. */
export function markupHolder(key: string): string | undefined {
  return claims.get(key);
}

/** For `useSyncExternalStore`: hear a claim change. */
export function subscribeMarkupClaims(listener: () => void): () => void {
  claimListeners.add(listener);
  return () => {
    claimListeners.delete(listener);
  };
}

export function markupClaimsVersion(): number {
  return claimVersion;
}

export function _clearMarkupClaimsForTest(): void {
  claims.clear();
  claimsChanged();
}

// ── The command ───────────────────────────────────────────────────────────

/** One marked page as `pdf_markup_submit` takes it: the phone's own shape,
 * with the layer PNG inline (standard base64, no `data:` prefix). */
export type PdfMarkupPage = { n: number; size: [number, number]; marks: Mark[]; layerPng: string };
export type PdfMarkupResult = { prompt: string; marked: string | null };

/**
 * Bakes the marked copy of `path` into the project's `.eldrun/inbox/` and
 * answers the prompt to queue (`commands/pdf_markup.rs`). Rejects with the
 * backend's plain code string (see `markupReasonKey`).
 */
export function submitPdfMarkup(projectId: string, path: string, pages: PdfMarkupPage[]): Promise<PdfMarkupResult> {
  return invoke<PdfMarkupResult>("pdf_markup_submit", { projectId, path, pages });
}

/** A refusal's code, from whatever the call threw: the command rejects with
 * a bare code; queueing the prompt throws an `Error` whose message is one, or
 * the backend's sentence for the per-tab schedule cap. */
export function markupErrorCode(error: unknown): string {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (/at most \d+ schedules/.test(text)) return "schedule_cap";
  return /^[a-z_]+$/.test(text) ? text : "other";
}

const REASONS: Record<string, TranslationKey> = {
  remote_project: "pdfMarkup.reason.remote",
  project_not_found: "pdfMarkup.reason.project",
  project_unavailable: "pdfMarkup.reason.project",
  outside_project: "pdfMarkup.reason.outside",
  hidden_path: "pdfMarkup.reason.hidden",
  file_not_found: "pdfMarkup.reason.gone",
  file_too_large: "pdfMarkup.reason.tooLarge",
  read_failed: "pdfMarkup.reason.read",
  empty_file: "pdfMarkup.reason.read",
  unsupported_source: "pdfMarkup.reason.unsupported",
  invalid_markup: "pdfMarkup.reason.invalid",
  invalid_layer: "pdfMarkup.reason.invalid",
  layer_missing: "pdfMarkup.reason.invalid",
  inbox_full: "pdfMarkup.reason.inboxFull",
  write_failed: "pdfMarkup.reason.write",
  markup_failed: "pdfMarkup.reason.failed",
  message_too_long: "pdfMarkup.reason.tooLong",
  schedule_cap: "pdfMarkup.reason.scheduleCap",
};

/** The words for a refusal code; `other` (with the code) for one this build
 * does not know. */
export function markupReasonKey(code: string): TranslationKey {
  return REASONS[code] ?? "pdfMarkup.reason.other";
}

/** A blob as standard base64, no `data:` prefix — how a layer PNG crosses IPC. */
export function blobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? "");
      const comma = url.indexOf(",");
      resolve(comma >= 0 ? url.slice(comma + 1) : url);
    };
    reader.onerror = () => reject(reader.error ?? new Error("read_failed"));
    reader.readAsDataURL(blob);
  });
}
