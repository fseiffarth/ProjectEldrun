/**
 * The app stylesheet, re-assembled from the split files in the exact order
 * `styles/index.css` imports them. The CSS-invariant tests scan the WHOLE
 * corpus — a single offending rule anywhere undoes what they guard — so a
 * test must never read just one split file, and this loader fails loudly if
 * the index stops listing imports (an empty corpus would pass every
 * invariant vacuously).
 */
// @ts-expect-error node:fs has no type declarations in this project (no @types/node)
import { readFileSync } from "node:fs";

export function readAppStylesheet(): string {
  const index: string = readFileSync("src/styles/index.css", "utf8");
  const files = [...index.matchAll(/@import "\.\/(.+?)";/g)].map((m) => m[1]);
  if (files.length === 0) throw new Error("styles/index.css lists no @imports");
  return files.map((f) => readFileSync(`src/styles/${f}`, "utf8") as string).join("\n");
}
