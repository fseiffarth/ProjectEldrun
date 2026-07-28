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
webview surface + `src/components/browser/` (browser), and `types/index.ts`.
Mail (#65) and the browser (#61) are both built as of 2026-07-26 and share one
sanitizer (`services/web_safety.rs`); neither has been runtime-verified.*

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
    - **Where it lives is settled: the header's ✉ overlay, and only that.** It
      was built as a tab *and* a global-app overlay; the tab is retired
      (`stores/tabs`' `RETIRED_TAB_CMDS`), because the mail store is global — a
      scoped tab could only ever show the same mailbox the overlay does while
      still belonging to a project you switch away from. One switch too:
      `mail_global_app` went with the tab, since a toggle hiding the only
      surface while leaving mail "on" has nothing left to mean.
    - **Important / Urgent lists (BUILT, untested).** A right-click on any row
      files a message under one of two marks, and each mark has a rail entry
      listing **every account's** marked mail together. It is a *mark, not a
      move*, and that is forced rather than chosen: no IMAP folder can hold two
      accounts' mail, so a cross-account list can only be a local column
      (`messages.priority`, `schema::mail::MailPriority`). Cost stated in the
      UI: the mark is this machine's and no other mail client sees it.
    - [x] 🤖 Automated test — `src/__tests__/MailPriority.test.ts` (the
      folder/priority fork), `services::mail_store::tests` (the column, the
      cross-account query, and that a re-sync never wipes a mark)
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

61a. **Containerise live pages. (DEFERRED — do not build without new evidence.)**
    Plan, kept for reference: `docs/browser_sandbox_plan.md`. It would run the
    live browser in a container with its own network namespace and a single
    writable bind mount, closing the two findings the audit could not — a page
    reaching loopback services by any hostname that resolves there, and `ws://`
    reaching them regardless of the scheme allowlist — by topology rather than by
    policy. Reuses `services/sandbox.rs` (#38). Reader mode is untouched either
    way. Deferred on 2026-07-26 for four reasons, in order of weight:
    - **It would buy a browser's patch cadence, permanently** (plan §6 q2). A
      stale browser in a container is a worse browser than a current one outside
      it, so this is an ongoing upstream-CVE commitment for a side feature —
      plus image provenance and size, a supply-chain question the current
      feature does not have.
    - **The go/no-go is only knowable after it is built** (plan §5.6). Usability
      runs through a nested display server on a host that software-renders
      because DMABUF is off app-wide (`project_webkit_paint_perf`). Phases 0–5
      would be built to discover whether scrolling and video are tolerable.
    - **Zero UX gain.** Plan §1.1: the container's window is still a separate
      top-level OS window, exactly what ships today. Pure security spend.
    - **Linux-only.** Windows is already refused; macOS Docker Desktop is a VM
      with a different display story again (§6 q4). A one-platform feature with
      a three-way matrix in every doc and settings pane.
    The standing alternative — reader mode as an in-app tab plus the user's own
    browser for live pages, already the `browser_link_target` default — has none
    of these holes and comes with the user's password manager, extensions and
    Mozilla's patch cadence.
    **What would reverse this:** using live pages often enough in real work to be
    annoyed that they are a detached window with disclosed holes. That is a
    verdict from use, not from analysis, so the next step on this axis is #61's
    manual QA, never Phase 0 here. If the answer instead turns out to be "never
    reach for them", the live window should be *deleted* (plan §0) and reader
    mode kept.
    - [ ] 🤖 Automated test — n/a while deferred
    - [ ] 🖐️ Manual test — n/a while deferred

61b. **Readability extraction for reader mode.** The change that would make the
    reader tab a *reading* surface rather than a sanitized document dump, and the
    one worth making instead of #61a. Today `fetch_reader` sanitizes the whole
    document: `<style>` elements are dropped with their contents
    (`mail_sanitize.rs` `RM_WITH_CONTENTS`), external CSS never loads, and only
    inline `style=` survives against the property allowlist. Typography is
    **not** the gap — `lib/browser.ts`'s `READER_FRAME_STYLE` already sets a
    46rem measure, 1.7 line-height, capped images, wrapped `pre`. The gap is
    **boilerplate**: nav menus, sidebars, footers and cookie banners arrive as
    long bullet lists ahead of the article, because there is no extraction pass
    anywhere in `browser_engine.rs`.
    Extract the article and drop the page chrome **before** handing the fragment
    to the sanitizer, so the security pipeline is unchanged and extraction is a
    pure pre-pass. It **must** run pre-sanitizer: Readability scores nodes on
    `class`/`id` hints, and `mail_sanitize` sets `generic_attributes(HashSet::
    new())`, so afterwards the signal it needs is gone. Cross-platform, no
    container, no new attack surface — the opposite trade to #61a on every axis.
    **The crate** (checked 2026-07-26): `dom_smoothie` (MIT, 0.18.0, ~18 minor
    releases since Dec 2024, by `dom_query`'s author) returns an `Article` with
    both `content: StrTendril` (HTML — the field to feed `ammonia`) and
    `text_content`. Most of its tree is **already in `Cargo.lock`** via ammonia
    and Tauri — `html5ever` 0.39, `tendril` 0.5, `cssparser` 0.37, `foldhash`
    0.2, `phf`, `bit-set`, `once_cell`, `unicode-segmentation`, `thiserror` 2 —
    so the genuinely new crates are `dom_query`, `selectors` 0.38 (beside the
    existing 0.36), `flagset`, `gjson`, `html-escape`. Its `is_probably_readable()`
    is the honest-failure gate below, for free. Rejected: `readabilityrs` (0.1.x,
    one author, pulls **two** DOM libraries — `kuchikikiki` *and* `scraper` — and
    an exact-pinned `v_htmlescape`); `readable-readability` (last release 2022).
    Note it is 0.x on a fast minor cadence: pin it, and expect an upgrade to be
    a real edit every few months.
    **Sequencing:** do #61's manual QA first on ten pages actually worth reading
    in a work session. That says whether the reader tab is a docs-and-articles
    surface worth investing in, or a niche tool for opening agent-supplied links
    safely (no JS, no cookies, no `Referer`, `resolve_hop` closing the DNS hole)
    — which is worth keeping either way, and is the thing the user's own browser
    is genuinely worse at.
    Watch for: a JS-rendered SPA has no article to extract and must keep failing
    honestly rather than rendering an empty frame; extraction must never
    reintroduce a tag or attribute the sanitizer would have removed.
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test

---

66. **Encrypt the local mail store, and add OpenPGP. (BUILT — every phase,
    never live-tested.)** Two features, deliberately sequenced, both from
    `docs/mail_encryption_plan.md`.

    **At rest (phases 1–2).** Every sensitive value in the mail store is an
    XChaCha20-Poly1305 envelope (`services/mail_crypt.rs`), sealed *per value*
    rather than per file — which is what keeps plaintext out of the WAL and the
    freelist, and why converting an existing store ends in `VACUUM INTO` a new
    file rather than an in-place `UPDATE`. Every ciphertext is bound to its row
    by AAD, so an attacker with disk *write* access cannot relocate one
    message's body onto another's row. Search becomes bounded decrypt-on-scan
    and **says when it stopped**; blind indexes were rejected (a deterministic
    per-token fingerprint answers "does this mailbox contain word X", which is
    most of what the encryption was for). An unreachable key **degrades to a
    memory-only store** rather than locking the mailbox — the locked-keyring
    failure class this project has already been bitten by.

    **End to end (phases 3–8).** OpenPGP via rPGP; S/MIME is detected, named and
    deferred (no certificate is issued, so there is no credential to load). Key
    generation is **Curve25519 only**, which is a security decision rather than
    a preference: `pgp` depends on `rsa` unconditionally and RUSTSEC-2023-0071
    is unpatched, but the oracle is in RSA decryption and nobody can encrypt to
    a key we do not have. Sign-inside-then-encrypt; a missing recipient key
    **refuses the send** rather than degrading to plaintext; decrypted bodies
    are never written to disk (caching one would make the store key equivalent
    to the mail private key). IMAP `APPEND` lands last and only with
    encrypt-to-self — before it there was no Sent copy at all, which was
    accidentally the most private behaviour available.

    Only `verified` earns positive chrome, and only an explicit "I compared this
    fingerprint" produces it: OpenPGP has no authority to ask instead.

    - **Open, and the user's call:** whether to un-defer S/MIME if a work
      certificate ever appears (plan §5, pre-costed, drops in behind the §4
      seam); whether inline (pre-MIME) signatures are worth verifying rather
      than merely reporting.
    - **Known limitation, recorded not hidden:** folder ids are an unkeyed
      `sha256(path)[..8]`, so a wordlist recovers folder names. Keying them
      means re-deriving every message id — which is also every AAD row key.
    - [x] 🤖 Automated test — `services::mail_crypt` (AAD relocation, envelope
      rejection, Argon2 round-trip), `services::mail_store::tests::encrypted`
      (nothing readable on disk, migration, restartability, bounded search),
      `services::mail_pgp` (sign/verify/encrypt round trips, sign-inside-encrypt),
      `tests/mail_hostile_crypto.rs` (a decrypted body still meets the sanitizer;
      a real signature over a different body is refused),
      `src/__tests__/MailCryptoDisplay.test.ts` (only `verified` is positive)
    - [ ] 🖐️ Manual test — **the whole feature.** Nothing here has run against a
      real server or a real correspondent: interop with Thunderbird and Outlook,
      unlock latency on the slowest machine, keychain-locked behaviour, and the
      migration of a store that actually holds mail.

---
