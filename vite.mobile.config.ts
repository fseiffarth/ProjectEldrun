import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const BUILD_PLACEHOLDER = "__ELDRUN_BUILD__";

/* Stamp the emitted `sw.js` with this build's entry hash.
 *
 * The service worker lives in `public/`, so vite copies it byte-for-byte and
 * never fingerprints it. That left the browser with an unchanging `sw.js` — no
 * new worker was ever installed, its `activate` never purged the old cache,
 * and a phone could keep booting a superseded bundle out of it. Giving the
 * cache a per-build name fixes both halves at once: the bytes change, so the
 * browser installs; the name changes, so `activate` drops what came before.
 *
 * Runs in `closeBundle`, the one hook that is after vite has copied `public/`
 * into outDir. Failures throw rather than warn — a silently unstamped worker
 * is the exact bug this exists to prevent.
 */
function stampServiceWorker(): Plugin {
  let outDir = "";
  return {
    name: "eldrun-stamp-sw",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const shell = readFileSync(resolve(outDir, "index.html"), "utf8");
      const entry = /\/assets\/index-([A-Za-z0-9_-]+)\.js/.exec(shell)?.[1];
      if (!entry) {
        throw new Error("stamp-sw: no hashed entry script in the emitted index.html");
      }
      const worker = resolve(outDir, "sw.js");
      const source = readFileSync(worker, "utf8");
      if (!source.includes(BUILD_PLACEHOLDER)) {
        throw new Error(`stamp-sw: ${BUILD_PLACEHOLDER} is missing from sw.js`);
      }
      writeFileSync(worker, source.replaceAll(BUILD_PLACEHOLDER, entry));
    },
  };
}

export default defineConfig({
  root: "mobile-web",
  plugins: [react(), stampServiceWorker()],
  base: "/",
  build: {
    outDir: "../mobile-dist",
    emptyOutDir: true,
  },
});
