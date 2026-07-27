import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "jsdom",
    css: false,
    setupFiles: ["./src/test-setup.ts"],
    // The full suite runs heavy viewer renders + real-timer polls across many
    // parallel forks; the 5s default test timeout is too tight under that load
    // and trips otherwise-passing tests. Give them headroom.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
