## Group J — Web & Mail Surfaces: Routing, In-App Mail & Browser
*Three related surfaces for web/mail content sharing where-it-lives (right-panel
view vs. center tab vs. global-app surface), security, and auth decisions. #33
routes links **out** to the user's configured external apps; #65 and #61 are the
**in-app** counterparts (read mail / browse the web without leaving the
workspace). Files: `src/components/layout/GlobalAppBar.tsx` (roles +
launch-or-raise), `src-tauri/src/commands/apps.rs` (`launch_app`, `open_file`),
terminal/file-tree link handling (the global-apps suite is already implemented —
#33 is its last remaining item); plus, for the in-app surfaces, a new
`commands/mail.rs` + `schema/mail.rs` + `src/components/mail/` (mail) and a Tauri
webview surface + `src/components/browser/` (browser), and `types/index.ts`. No
mail or browser code exists today.*

33. **URI scheme routing** (migrated from TODO `G6.7`). Intercept `http://`,
    `https://`, `mailto:`, and `webcal:` links opened from within terminals or
    the file tree and route them through the global-app launch-or-raise flow
    (`launch_app`, keyed by the `browser` / `mail` / `calendar` roles) instead of
    a bare `xdg-open` call, so links open in the user's configured global app.

65. **Include a mail viewer in Eldrun.** Add an in-app email reader so mail can be
    read without leaving the workspace. Scope to be defined when picked; open
    questions to settle first: protocol (IMAP vs JMAP vs a provider API like
    Gmail), auth model (app password vs OAuth, mirroring the SSH "no in-app
    passwords" stance where possible), read-only vs send/reply, and where it lives
    (right-panel view like Git/Files, a dedicated center tab, or a global-app
    surface). Pairs naturally with #33 (`mailto:` routing) once present.
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test

61. **Include a browser in Eldrun. (BUILT — reader mode; live pages opt-in.)**
    Shipped as two surfaces, because the obvious third one is not buildable:
    `tauri-runtime-wry` packs a child webview into the window's `GtkBox`, where
    `set_bounds` is a no-op, so an in-pane embedded browser renders as a vertical
    stack on Linux (tauri#10420 / #11376). Plans:
    `docs/browser_plan_{a,b,c}.md`; audit findings and residual risk are in
    plan B and in `services/browser_engine.rs`'s module header.
    - **Reader tab** — backend fetches over rustls, sanitizes through the mail
      client's `ammonia` pipeline, renders inert HTML in a `sandbox=""` frame.
      No JavaScript ever runs. Every platform.
    - **Live page** — a separate hardened `WebviewWindow`, ephemeral profile,
      behind `browser_live_pages` (default off, and off in debug too). Refused
      on Windows: WebView2's default permission state draws Edge's own prompt.
    - [x] 🤖 Automated test — tripwire suites both sides; a defence that is
      deleted fails a test rather than shipping.
    - [ ] 🖐️ Manual test — **nothing here has been runtime-verified.** The
      gating check: from a live page's devtools, `invoke('list_projects')` must
      reject naming the ACL. If it resolves, stop.

61a. **Containerise live pages.** Plan: `docs/browser_sandbox_plan.md`. Run the
    live browser in a container with its own network namespace and a single
    writable bind mount, so the two findings the audit could not close — a page
    reaching loopback services by any hostname that resolves there, and `ws://`
    reaching them regardless of the scheme allowlist — are closed by topology
    rather than by policy. Reuses `services/sandbox.rs` (#38) rather than adding
    a second container manager. Reader mode is untouched.
    **Decide first whether it is wanted at all**: reader mode plus the user's own
    browser (already the `browser_link_target` default) beats this for most
    cases, and the plan's §0 says so. Build only if live pages *inside* the
    workspace earn their cost.
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test

---
