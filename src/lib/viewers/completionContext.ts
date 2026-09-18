import { dirname, isPathWithin, normalizePath, relativePathWithin, resolvePath } from "../paths";

export type CompletionReference = { name: string; content: string };
// Mirror commands::ollama's byte budgets before crossing IPC too.
const PER_FILE = 6000;
const TOTAL = 24000;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function bounded(text: string, bytes: number): string {
  const encoded = encoder.encode(text);
  if (encoded.length <= bytes) return text;
  let end = bytes;
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end--;
  return decoder.decode(encoded.subarray(0, end));
}

/** Static local references only: never resolve packages, URLs or evaluate code. */
export function completionImports(text: string, path: string, root: string): string[] {
  const paths: string[] = [];
  const add = (target: string, base = dirname(path)) => {
    const resolved = resolvePath(base, target);
    if (isPathWithin(resolved, root) && normalizePath(resolved) !== normalizePath(path)) paths.push(resolved);
  };
  for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)["'](\.[^"']+)["']/g)) {
    const target = match[1];
    if (/\.[a-z\d]+$/i.test(target)) add(target);
    else for (const ext of [".ts", ".tsx", ".js", "/index.ts"]) add(target + ext);
  }
  for (const match of (/\.pyw?$/i.test(path) ? text : "").matchAll(/^\s*(?:from|import)\s+([.\w]+)/gm)) {
    const module = match[1];
    const dots = module.match(/^\.+/)?.[0].length ?? 0;
    const target = "../".repeat(Math.max(0, dots - 1)) + module.slice(dots).replace(/\./g, "/");
    add(target + ".py", dots ? dirname(path) : root);
    add(target + "/__init__.py", dots ? dirname(path) : root);
  }
  for (const match of text.matchAll(/\\(input|include|subfile|bibliography|addbibresource)(?:\[[^\]]*\])?\{([^}]+)\}/g)) {
    const bib = match[1] === "bibliography" || match[1] === "addbibresource";
    for (const name of match[2].split(",")) {
      const target = name.trim();
      if (!target || /[\\#$:]/.test(target) || target.startsWith("/")) continue;
      add(/\.[a-z\d]+$/i.test(target) ? target : target + (bib ? ".bib" : ".tex"));
    }
  }
  return [...new Set(paths)].slice(0, 16);
}

export async function completionContext(opts: {
  path: string; root: string; draft: string; openPaths: string[];
  manual: CompletionReference[]; keys?: string;
  read: (path: string) => Promise<string>; signal: AbortSignal;
}): Promise<CompletionReference[]> {
  const result: CompletionReference[] = [];
  let remaining = TOTAL;
  const add = (name: string, text: string) => {
    if (!remaining || !text.trim()) return;
    const content = bounded(text, Math.min(PER_FILE, remaining));
    remaining -= encoder.encode(content).length;
    result.push({ name: bounded(name, 256), content });
  };
  for (const file of opts.manual) add(file.name, file.content);
  if (opts.keys) add("LaTeX label / bibliography keys", opts.keys);
  if (!opts.root || !isPathWithin(opts.path, opts.root)) return result;
  const seen = new Set([normalizePath(opts.path), ...opts.manual.map((f) => normalizePath(resolvePath(opts.root, f.name)))]);
  const paths = [...completionImports(opts.draft, opts.path, opts.root), ...opts.openPaths];
  let reads = 0;
  for (const path of paths) {
    if (!remaining || opts.signal.aborted || reads >= 16) break;
    const normalized = normalizePath(path);
    if (seen.has(normalized) || !isPathWithin(path, opts.root)) continue;
    seen.add(normalized);
    reads++;
    try {
      const content = await opts.read(path);
      if (opts.signal.aborted) break;
      // Bib entries may be much larger than the budget; keys are more useful.
      const body = /\.bib$/i.test(path)
        ? [...content.matchAll(/@\w+\s*\{\s*([^,\s]+)\s*,/g)].map((m) => m[1]).join("\n")
        : content;
      add(relativePathWithin(opts.root, path) ?? path, body);
    } catch { /* Missing, binary or out-of-scope references are optional. */ }
  }
  return result;
}
