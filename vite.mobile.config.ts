import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "mobile-web",
  plugins: [react()],
  base: "/",
  build: {
    outDir: "../mobile-dist",
    emptyOutDir: true,
  },
});

