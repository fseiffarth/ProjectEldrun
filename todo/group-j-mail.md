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

33. **URI scheme routing** (migrated from TODO `G6.7`). ✅ Implemented ·
    🧪 Awaiting live QA. Intercept `http://`,
    `https://`, `mailto:`, and `webcal:` links opened from within terminals or
    the file tree and route them through the global-app launch-or-raise flow
    (`launch_app`, keyed by the `browser` / `mail` / `calendar` roles) instead of
    a bare `xdg-open` call, so links open in the user's configured global app.
    - Shipped as a pure/total router plus a separate performer:
      `src/lib/linkTarget.ts:124 routeUri` (URI + context → `LinkTarget`) and
      `:341 openRoutedUri` (performs it: browser tab, `launch_app`, or fallback).
    - [x] 🤖 Automated test — `src/__tests__/LinkTarget.test.ts:22-64` covers the
      scheme→role mapping and the fallback path.
    - [ ] 🖐️ Manual — click an `http`/`mailto`/`webcal` link in a terminal and in
      the file tree; confirm each raises the configured global app rather than
      `xdg-open`'s default.

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
    - **Keyword filters (BUILT 2026-07-29, untested).** The manual half of
      "file it for me": a rule is a list of words plus where to look (subject,
      sender, recipients, or the stored body *snippet*), and a message arriving
      with a hit is marked Important or Urgent. Deliberately literal rather than
      model-driven — the words are the user's own, so *why* something was filed
      is answerable by reading the rule; a local-model classifier is a separate,
      later thing (#169) and must not be able to pass for this one.
      - `services/mail_filters.rs` is the whole matcher, pure and tested;
        `filters.json` (sealed beside `accounts.json`, its own AAD) is the store;
        `mail_filters_{list,set,apply}` the surface; the dialog is
        `src/components/mail/MailFiltersDialog.tsx` + `src/lib/mailFilters.ts`.
      - Four limits, each stated in the dialog rather than in a tooltip: the mark
        is local (nothing moves, nothing uploads), rules run on **arriving** mail
        plus an explicit re-run, they search the preview and not the body (a sync
        fetches headers — full text would mean downloading every message of every
        folder on every check), and Sent/Drafts/Trash/Junk are out of scope.
      - **A message the user has filed by hand is never touched**, on either
        path, and the automatic pass runs once per message — otherwise every
        re-sync would resurrect a filing the user had corrected.
      - Order is data: the first matching rule wins, so the list is reorderable
        and saved wholesale. "Test" is a **dry run of the apply itself**, not a
        second matcher in TypeScript.
    - [x] 🤖 Automated test — `src/__tests__/MailPriority.test.ts` (the
      folder/priority fork), `services::mail_store::tests` (the column, the
      cross-account query, that a re-sync never wipes a mark, and the filter
      scan's folder-kind refusals), `services::mail_filters::tests` (14 cases:
      case-folding, whole-word boundaries, `match_all` across fields, first-rule-
      wins, never overwriting a mark), `src/__tests__/MailFilters.test.ts`
      (term parsing, field toggles, ordering, the i18n coverage check)
    - [ ] 🖐️ Manual test — write a rule, check mail, confirm the arrival lands in
      the named list and the strip says how many were filed; then "Apply to mail
      I already have" and confirm the count matches the dry run
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work
    - **The rail is two zones now** (2026-07-29): account-*independent* above
      (Important/Urgent + the filter rules that fill them), account-*dependent*
      below (the accounts, and the selected one's folders, whose heading now
      names that account). One column of four headings had made two
      cross-account lists read as though they belonged to the first account.
      The toolbar carries the same split as a hairline: account actions left,
      mailbox-wide ones (the store key, the keyring) right.

166b. **Fixed 2026-07-29 — "my configured mail account vanished".** On an
    encrypted store the account list is `accounts.json.enc`, and
    `read_accounts` could only find it once `SESSION_KEYS` was published — which
    only *opening the database* did. But `mail_accounts_list` is the first mail
    command a launch runs (the header badge calls it), so on a cold process it
    found no key, skipped the sealed file, looked for the plaintext one the
    migration had deleted, and answered **an empty list**. The account had not
    gone anywhere; nothing had asked for the key yet. The write half was worse:
    re-adding the account in that state wrote a *cleartext* `accounts.json`
    beside the sealed file that every later read prefers — vanished twice, and
    with an unencrypted copy of the account list left on disk.
    - Fix: the sealed files resolve the key themselves (`file_keys`, one silent
      unlock attempt per process, degrading to `None`), and a plaintext write is
      **refused** while a sealed twin exists (`sealed_write_refusal`) instead of
      being silently shadowed. The sealed twin is now derived from the path the
      caller passed, so a read against any other directory can no longer reach
      the real mailbox.
    - Reproduced and verified with `cargo run --example mail_probe` — 0 accounts
      before, 1 after, on the same on-disk store.
    - [x] 🤖 Automated test — `commands::mail::tests::{a_plaintext_write_is_
      refused_while_a_sealed_file_exists, the_sealed_files_resolve_their_own_key}`
    - [ ] 🖐️ Manual test — launch with the mail overlay closed, open it, confirm
      the account is listed on the first paint.
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

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
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

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
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

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
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

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
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

---

167. **Reuse one IMAP session per account instead of logging in per operation.**
    ✅ Implemented · 🧪 Awaiting live QA. The gating defect for pointing the mail
    client at a **primary** account, and the reason it was found: every
    `MailEngine` method opened its own connection — `imap_login` → `SELECT` →
    one command → `logout`, eight times over in `services/mail_engine.rs`. So
    reading twenty messages was twenty TLS handshakes and twenty `LOGIN`s, and
    the cost is not latency but **the provider's opinion of it**: Gmail,
    Fastmail and every hosted Exchange rate-limit authentication attempts long
    before they rate-limit commands, and answer a client that reauthenticates
    per click with throttling, a temporary lock, or a "suspicious sign-in"
    mail. `set_flags_bulk` already existed *for exactly this reason* ("a few
    hundred logins, and a server with any connection-rate limit answers that
    with a ban") — this generalizes that insight from one method to the module.
    - **A process-wide pool keyed by `host:port|user`**, not an engine field:
      `InProcessEngine` is a unit struct constructed at each call site
      (`InProcessEngine.body(…)`), so making the pool an instance field would
      have meant threading state through 2 789 lines of `commands/mail.rs` for
      no gain. The pool is genuinely process-global — one app, one mailbox.
    - **`keep` defaults to `false`**, and only `Lease::finish` sets it true.
      Anything that is not a clean success — an error, an early `?`, a panic, a
      future dropped mid-command by a cancelled sync — therefore closes the
      socket instead of pooling it. The inverse default is the bug this design
      exists to make unwritable: a session returned mid-command hands the *next*
      caller a stream positioned inside someone else's response.
    - **Test on borrow, but only when it can have gone stale** (`NOOP` above 30 s
      idle, 10 s cap; entries over 5 min are closed unread). A server closing an
      idle connection is normal, so a pool without a liveness check trades
      logins for intermittent failures — which is a worse client, not a cheaper
      one.
    - **`SELECT` is cached per session** (`ensure_selected`) for the operations
      that only address messages by UID (flag, bulk flag, move, body fetch).
      `headers` still `SELECT`s unconditionally, because it reads `EXISTS` off
      the response and a cached selection would page from a stale count.
    - **`probe` is deliberately exempt** (`Acquire::Fresh`): "Test account" that
      answers out of a pool tests nothing, and would report success for a
      password the user had just changed to a wrong one.
    - Pooled sessions are evicted on account upsert, account delete and
      "forget password" — the three moments the credential behind a live
      authenticated socket stops being the one the user believes is in use.
    - SMTP is untouched: a send is user-initiated and rare, and many providers
      cap messages per connection, so there is no login storm to fix there.
    - [x] 🤖 Automated test — `services::mail_engine::tests::{pool_key_*,
      pool_entry_*, every_imap_operation_goes_through_the_pool}`; the last is a
      tripwire that reads this module's own source and fails if a method starts
      logging in directly again (the same shape as
      `no_certificate_verification_escape_hatch`).
    - [ ] 🖐️ Manual test — with a real account: read ten messages and confirm
      the provider's "recent activity" page shows **one** sign-in, not ten; then
      leave the app idle 10 min and read another to confirm the stale-session
      path recovers rather than erroring.
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

168. **OAuth 2.0 / `XOAUTH2` for the big providers.** Not built, and the plan is
    mostly *not* about IMAP. Today `imap_login` sends `LOGIN user pass`, which
    means: **Microsoft consumer accounts cannot connect at all** (basic auth for
    IMAP/SMTP was withdrawn for outlook.com in 2024), Gmail needs an app
    password with 2-Step on (`docs/mail_qa_gmail.md` already walks that), and
    Yahoo/AOL likewise. Everything self-hosted, university, Fastmail and
    Mailbox.org is unaffected — which is why this ranks below #167.
    - **The protocol half is nearly free.** Both crates already support it:
      `async_imap::Client::authenticate("XOAUTH2", …)` takes an `Authenticator`
      whose `process` returns the `user=…\x01auth=Bearer …\x01\x01` string, and
      `mail_send::Credentials::new_xoauth2` exists for the SMTP side. Neither
      needs a new dependency.
    - **The cost is the flow around it**, and it is all Eldrun-side: a loopback
      `http://127.0.0.1:<port>` redirect listener, PKCE, the refresh token in
      the OS keychain beside the passwords (`remote_credentials`), silent
      refresh before each connect, and a `MailAccount.auth` discriminant so a
      password account and a token account can coexist. The token — not a
      password — becomes the thing the sealed store must never touch.
    - **The consent page opens in the user's own browser, never in a webview.**
      Google blocks embedded-webview OAuth outright, and the reasons this repo
      already refuses to embed live pages (`browser.rs`'s `LIVE_SUPPORTED`,
      #61a) apply with more force to a page the user types a password into.
      Thunderbird's own table has grown `useExternalBrowser` /
      `useSchemeRedirect` fields for exactly this migration.
    - **Refresh belongs inside `acquire` (#167), single-flight.** A token
      client that refreshed per operation would burn refresh quota the same way
      the per-operation login burned auth quota — and with a pool in place, N
      concurrent leases must not each mint a token.
    - **The two providers are not one job, and should not be one item.**
      Checked 2026-07-29:
      - **Microsoft is cheap and is the whole point.** An Entra app
        registration is free, self-service and carries **no security review**:
        audience "any organizational directory *and* personal Microsoft
        accounts", a Mobile-and-desktop platform with an `http://localhost`
        loopback redirect (public client, no secret), delegated
        `https://outlook.office.com/IMAP.AccessAsUser.All` +
        `…/SMTP.Send` + `offline_access`, against
        `login.microsoftonline.com/common`. Microsoft's own doc settles the
        question third-party guides get wrong: OAuth2 for IMAP/POP/SMTP "is
        available for both Microsoft 365 … and **Outlook.com** users" — the
        "not supported for personal accounts" claim found elsewhere is about
        the *client-credentials* flow, not the interactive one.
      - **Google is disproportionate, and for one user it is worse than what
        we have.** `https://mail.google.com/` is a **restricted** scope. In
        "Testing" publishing status the app is capped at 100 test users **and
        Google revokes the refresh token after 7 days** — i.e. re-authenticate
        every week, which is strictly worse than an app password. Lifting that
        means publishing, verification, and for a restricted scope a **CASA
        Tier 2 third-party assessment, annually**, for an app with no
        publisher entity.
    - **Therefore: build Microsoft, keep app passwords for Gmail.** An app
      password is individually revocable, has no 7-day clock, and needs no code
      at all; a Google refresh token would be a longer-lived credential bought
      at a much higher price. `docs/mail_qa_gmail.md` already documents the
      app-password path.
    - **Do not copy Thunderbird's client id.** Its issuer table
      (`mailnews/base/src/OAuth2Providers.sys.mjs`) ships ids and "secrets" in
      public source — legitimately, because a native app is a *public* client
      and PKCE, not the secret, is what protects it — but the file says in as
      many words: "Don't copy these values for your own application — register
      one for yourself!" Reusing it would attribute this app's traffic to
      Mozilla's client and put their quota at risk.
    - **`privacy-check.sh` will flag the client id**, since a public client id
      is indistinguishable from a leaked token by pattern. It needs an explicit
      expected-match entry or the pre-push hook blocks every push.
    - Sequencing: after #167 (a token client that reauthenticates per operation
      would burn refresh quota the same way), and after #65/#66's live QA — this
      is the wrong thing to build against a client that has never met a server.
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

202. **The local model a mail task runs on — the tag exists, the task does not.**
    The 🧠 menu's role chips gained a **Mail** tag (2026-07-30), stored at
    `settings.ollama_roles.mail` beside `autocomplete`/`grammar`/`tabs`, and
    **nothing reads it yet**. Only the tag shipped, deliberately: which model may
    see someone's mail is the user's statement, and the honest order is to let
    them make it in the same menu they assign every other local job in, rather
    than bolt a model picker onto whatever mail feature lands first.
    - What would read it: an **importance/urgency classifier** — the model-driven
      half of the filing #65's keyword filters do by hand — plus summaries or a
      draft reply. The filters' rule stands and must not be blurred: a keyword
      rule is answerable by *reading the rule*, a model's verdict is not, so a
      classifier is a **separate** mark path and may never present itself as a
      filter hit. (The stale `#169` reference in #65's filter note above meant
      exactly this item; that number belongs to Group Z's CalDAV push.)
    - Prerequisites it inherits rather than invents: the model has to be
      **resident** to answer unattended, which is what `ollama_autoload_models`
      (the "On start" chip) already exists for; the mail store may be **locked**
      (`Unlock::Unavailable`), in which case there is nothing to classify and the
      absence must read as "locked", never as "nothing important"; and mail is off
      by default (`mail_client`), so no timer here may run before that gate and
      the tag are both set.
    - The chip's tooltip and the lesson text say **nothing reads this yet**, in
      all five languages. Both come out when the consumer lands (the `pending`
      flag on `MODEL_ROLES` in `LocalModelMenu.tsx` is the single switch), and the
      fallback chain is the existing one: no tag ⇒ `ollama_model` ⇒ any loaded
      model — an unassigned tag must not mean "never run".
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

---
