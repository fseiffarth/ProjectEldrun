/**
 * Thin entry. In dev, the perf monitor must be fully installed before the app
 * module graph (react, react-dom, the stores) is pulled in — react-scan's
 * fiber hook has to exist when react-dom evaluates, and the IPC tracer wants
 * to see the first invokes — so the real entry (`bootstrap.tsx`) is imported
 * only after `installDevPerf()` settles. In production the dev branch is
 * compiled out (`import.meta.env.DEV` is statically false) and bootstrap
 * loads immediately; `src/dev/` never ships.
 */
if (import.meta.env.DEV) {
  void import("./dev/perfMonitor")
    .then((m) => m.installDevPerf())
    .catch(() => undefined)
    .then(() => import("./bootstrap"));
} else {
  void import("./bootstrap");
}

export {};
