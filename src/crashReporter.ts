import { invoke } from "@tauri-apps/api/core";

// Forward uncaught JS errors to the backend so they land in crash.log next
// to native crashes. Deduped and capped so an error inside a render loop
// cannot flood the backend with invoke calls.
const MAX_REPORTS = 25;
const seen = new Set<string>();
let reported = 0;

function report(kind: string, message: string, stack?: string): void {
  if (reported >= MAX_REPORTS) return;
  const key = `${kind}|${message}`;
  if (seen.has(key)) return;
  seen.add(key);
  reported += 1;
  void invoke("report_frontend_error", {
    kind,
    message,
    stack: stack ?? null,
  }).catch(() => {
    // Reporting must never throw — the app is already in trouble.
  });
}

export function installCrashReporter(): void {
  window.addEventListener("error", (event) => {
    report(
      "window.onerror",
      String(event.message ?? event),
      event.error instanceof Error ? event.error.stack : undefined,
    );
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason: unknown = event.reason;
    report(
      "unhandledrejection",
      reason instanceof Error ? reason.message : String(reason),
      reason instanceof Error ? reason.stack : undefined,
    );
  });
}
