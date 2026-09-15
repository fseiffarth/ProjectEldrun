import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "jsdom",
    css: false,
    setupFiles: ["./src/test-setup.ts"],
    // `target/freeze-tree` is a full checkout of HEAD (package-dev.sh --head),
    // so without this every run collects a second, frozen copy of the suite.
    exclude: [...configDefaults.exclude, "target/**"],
    // The full suite runs heavy viewer renders + real-timer polls across many
    // parallel forks; the 5s default test timeout is too tight under that load
    // and trips otherwise-passing tests. Give them headroom.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
