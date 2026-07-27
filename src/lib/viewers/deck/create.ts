import { invoke } from "@tauri-apps/api/core";
import { emptyDeck } from "./model";
import { serializeDeck } from "./sidecar";

/**
 * Creating a deck from blank, shared by every file view that offers it.
 *
 * Both file views (the tree and the two-pane browser) grew a "New Presentation"
 * action, and a deck is not a file the generic "New File" can make: `create_file`
 * leaves it empty and `parseDeck("")` rejects that hard, so the file has to be
 * written with real contents to be a deck on disk from its first moment. That
 * rule belongs in one place rather than once per menu.
 */

/** `talk`, `talk.pdf` and `talk.eldeck.json` all name the same deck. */
export function deckStem(input: string): string {
  return input
    .trim()
    .replace(/\.eldeck\.json$/i, "")
    .replace(/\.pdf$/i, "");
}

/** The file a deck named `stem` lives in. */
export function deckFileName(stem: string): string {
  return `${stem}.eldeck.json`;
}

/**
 * Write a valid, empty `<stem>.eldeck.json` inside `relDir` and hand back where
 * it landed, so the caller can refresh its listing and open the new file with
 * whatever opener it already has.
 */
export async function createDeckFile(opts: {
  projectDir: string;
  projectId: string | null;
  /** Folder to create it in, relative to the project root ("" = root). */
  relDir: string;
  /** Raw user input; an extension is tolerated and stripped. */
  name: string;
}): Promise<{ stem: string; fileName: string; rel: string; abs: string }> {
  const stem = deckStem(opts.name);
  const fileName = deckFileName(stem);
  const rel = opts.relDir ? `${opts.relDir}/${fileName}` : fileName;
  const abs = `${opts.projectDir}/${rel}`;
  await invoke("create_file", { projectDir: opts.projectDir, relPath: rel });
  await invoke("write_file_text", {
    path: abs,
    content: serializeDeck(emptyDeck(`${stem}.pdf`)),
    projectId: opts.projectId,
  });
  return { stem, fileName, rel, abs };
}
