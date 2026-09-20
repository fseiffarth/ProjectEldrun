// Reading the Focus chat aloud: the browser's own speech synthesis, so an
// answer's text never leaves the phone to be spoken.

/** Chrome on Android cuts an utterance off after about fifteen seconds, and an
 * utterance it cut never ends — the queue behind it hangs. Sentence-sized
 * pieces stay well under that. */
const MAX_CHUNK = 220;

export function speechOutputSupported(scope: Window = window): boolean {
  return "speechSynthesis" in scope && "SpeechSynthesisUtterance" in scope;
}

/**
 * An answer as it should be said: its prose, without the markup. A code block
 * is not read out symbol by symbol — `codeLabel` stands in for it — and a link
 * is its label, a table its cells.
 */
export function spokenText(markdown: string, codeLabel: string): string {
  return markdown
    .replace(/\r\n?/g, "\n")
    .replace(/^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(?:^[ \t]*\1[^\n]*$|(?![\s\S]))/gm, `\n${codeLabel}.\n`)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<?https?:\/\/\S+>?/g, " ")
    .replace(/^[ \t]*\|?[ \t:|-]*-{3,}[ \t:|-]*$/gm, "")
    .replace(/^[ \t]{0,3}>+[ \t]?/gm, "")
    // A heading or a list item rarely ends its own sentence, and the line
    // break that did is about to go.
    .replace(/^[ \t]*(?:#{1,6}[ \t]+|[-*+][ \t]+(?:\[[ xX]\][ \t]+)?|\d+[.)][ \t]+)(.*)$/gm,
      (_line, body: string) => (/[.!?:;,]\s*$/.test(body) || !body.trim() ? body : `${body}.`))
    // A table row is a sentence of its cells.
    .replace(/^[ \t]*\|[ \t]*(.*?)[ \t]*\|?[ \t]*$/gm, "$1.")
    .replace(/[ \t]*\|[ \t]*/g, ", ")
    .replace(/[`*_~]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/(?:[,.] ?){2,}/g, ". ")
    .replace(/^[,. ]+/, "")
    .trim();
}

/** `text` in pieces short enough to be spoken whole: sentences, packed
 * together while they fit, and a sentence too long for one piece cut at a
 * word. */
export function speechChunks(text: string, max = MAX_CHUNK): string[] {
  const chunks: string[] = [];
  let open = "";
  const close = () => {
    if (open) chunks.push(open);
    open = "";
  };
  for (const sentence of text.match(/[^.!?…]+[.!?…]*\s*/g) ?? []) {
    let rest = sentence.trim();
    if (!rest) continue;
    if (open && open.length + 1 + rest.length <= max) {
      open = `${open} ${rest}`;
      continue;
    }
    close();
    while (rest.length > max) {
      const space = rest.lastIndexOf(" ", max);
      const cut = space > 0 ? space : max;
      chunks.push(rest.slice(0, cut));
      rest = rest.slice(cut).trim();
    }
    open = rest;
  }
  close();
  return chunks;
}

interface QueuedSpeech { id: string; chunks: string[]; lang: string }

/** What is being said, by the id its caller gave it. One voice for the whole
 * app: a second message waits for the first rather than talking over it. */
let speakingId: string | null = null;
let queue: QueuedSpeech[] = [];
/** Bumped by every stop, so an utterance that ends afterwards starts nothing. */
let generation = 0;
const listeners = new Set<() => void>();

function announce(id: string | null) {
  if (speakingId === id) return;
  speakingId = id;
  listeners.forEach((listener) => listener());
}

function sayNext() {
  const current = queue[0];
  if (!current) {
    announce(null);
    return;
  }
  const chunk = current.chunks.shift();
  if (chunk === undefined) {
    queue = queue.slice(1);
    sayNext();
    return;
  }
  announce(current.id);
  const run = generation;
  const utterance = new SpeechSynthesisUtterance(chunk);
  utterance.lang = current.lang;
  const next = () => {
    if (run === generation) sayNext();
  };
  utterance.onend = next;
  // A refused or interrupted piece must not leave the button saying "stop"
  // over silence; the rest of that message goes with it.
  utterance.onerror = () => {
    if (run !== generation) return;
    queue = queue.slice(1);
    sayNext();
  };
  window.speechSynthesis.speak(utterance);
}

/** Says `text` after whatever is already queued; `replace` says it instead. */
export function speak(id: string, text: string, lang: string, replace = false): void {
  if (!speechOutputSupported()) return;
  const chunks = speechChunks(text);
  if (replace) stopSpeaking();
  if (chunks.length === 0) return;
  queue = [...queue, { id, chunks, lang }];
  if (queue.length === 1) sayNext();
}

export function stopSpeaking(): void {
  generation += 1;
  queue = [];
  if (speechOutputSupported()) window.speechSynthesis.cancel();
  announce(null);
}

/** Called from a tap: a browser that only lets a page speak after a gesture
 * (Safari) counts this silent utterance as the page having spoken. */
export function unlockSpeech(): void {
  if (!speechOutputSupported() || queue.length > 0) return;
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(""));
}

export function currentSpeechId(): string | null {
  return speakingId;
}

export function subscribeSpeech(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
