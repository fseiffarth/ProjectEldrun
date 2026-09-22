/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Build commit baked by vite.config.ts; null outside a git checkout. */
  readonly VITE_APP_COMMIT: string | null | undefined;
}
