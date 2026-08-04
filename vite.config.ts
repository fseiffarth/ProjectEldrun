import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(async () => ({
  plugins: [react()],
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
      ignored: ["**/src-tauri/**", "**/target/**", "**/.eldrun/**", "**/src/__tests__/**"],
    },
  },
}));
