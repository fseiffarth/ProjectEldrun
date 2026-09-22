import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/** The commit this bundle was built from, shown beside the version in the
 *  side panel. A dev server bakes it at start-up (hot reloads then run the
 *  working tree on top of it, hence `-dirty`); a frozen build bakes the commit
 *  it froze. Null outside a git checkout. */
function buildCommit(): string | null {
  try {
    const git = (...args: string[]) =>
      execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const sha = git("rev-parse", "--short", "HEAD");
    const dirty = git("status", "--porcelain", "--untracked-files=no") !== "";
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return null;
  }
}

export default defineConfig(async () => ({
  plugins: [react()],
  define: {
    "import.meta.env.VITE_APP_COMMIT": JSON.stringify(buildCommit()),
  },
  clearScreen: false,
  resolve: {
    alias: [
      // pdfjs-dist's package.json exposes only `main` (no `exports`/`module`),
      // which Vite's package-entry resolver handles inconsistently across
      // platforms — it fails on Windows ("Failed to resolve entry for package
      // pdfjs-dist"). Point the bare specifier straight at the file `main`
      // references. The regex anchors an exact match so subpath imports like
      // `pdfjs-dist/build/pdf.worker.min.mjs?url` are left untouched.
      {
        find: /^pdfjs-dist$/,
        replacement: fileURLToPath(
          new URL(
            "./node_modules/pdfjs-dist/build/pdf.mjs",
            import.meta.url,
          ),
        ),
      },
    ],
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // src/__tests__ is here because vite full-reloads the live window for a
      // changed file it watches but has no module-graph entry for — and test
      // files are exactly that. Concurrent agent sessions editing tests were
      // reloading the app the user was working in.
      //
      // dist/ and mobile-dist/ are here for the same reason and a worse case:
      // they are the BUILD's outputs, and `npm run build` is a mandated gate
      // (AGENTS.md) that anyone — a person or an agent — is expected to run
      // while a dev session is up. `mobile:build` writes mobile-dist/, the
      // watcher sees files with no module-graph entry, and every open Eldrun
      // webview full-reloads: the main window and each popout, several times
      // per build. Observed in hotreload.log as three `page reload
      // mobile-dist/index.html` lines per gate run. Running the tests must not
      // reload the window; neither must running the build.
      ignored: [
        "**/src-tauri/**",
        "**/target/**",
        "**/.eldrun/**",
        "**/src/__tests__/**",
        "**/dist/**",
        "**/mobile-dist/**",
      ],
    },
  },
}));
