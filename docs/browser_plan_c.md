# Browser in Eldrun — Plan C: engine / platform feasibility

*TODO J #61. This is the **reality check** document. Planner A designs the UI
surface, Planner B designs the security architecture; this one establishes what
Tauri 2 + the three platform webviews can actually do in **this** dependency
set, on **this** repo, today (2026-07-26), and says where the other two plans
will break against the platform.*

**Nothing here was recalled. Every claim is either a file:line in a vendored
crate source on this machine, a line in this repo, or a cited upstream
document. Claims I could not verify are tagged `UNVERIFIED` in place.**

---

## 0. Verdict

**Do not build an in-pane embedded browser webview. It is not buildable on
Linux in this dependency set — not "buggy", structurally impossible.** Tauri's
multiwebview (`WebviewBuilder` + `Window::add_child`) is gated behind the
opt-in `unstable` cargo feature, and on Linux `tauri-runtime-wry` builds every
child webview into the window's `default_vbox()` — a `GtkBox` — where wry
`pack_start`s it (`wry-0.55.1/src/webkitgtk/mod.rs:596-599`), sets
`is_in_fixed_parent = false` and leaves `x11: None`, which makes
`WebView::set_bounds` a **complete no-op** (`same file:853-875`). A GtkBox
stacks its children vertically and ignores x/y, which is exactly the still-open
upstream report of four webviews rendering as a vertical stack
([tauri#10420](https://github.com/tauri-apps/tauri/issues/10420), open;
[tauri#11376](https://github.com/tauri-apps/tauri/issues/11376), open). Linux
is the only platform this repo can verify locally, so a design that only works
on Windows is not a design.

**Recommendation — a two-surface browser, neither of which is an embedded
pane webview:**

1. **In-pane "reader" tab (`TabKind: "browser"`)** — fetched in Rust, sanitized
   in Rust by the *existing* `services::mail_sanitize` pipeline, rendered in
   `<iframe sandbox="" srcdoc=…>` exactly as `mail/MailMessageView.tsx` already
   does. No JS, no network from the renderer, no new engine, no new attack
   surface class, identical on all three OSes. This is the surface Planner A
   should design against.
2. **A hardened "live page" OS window** — one `WebviewWindow` per live page,
   built with the **stable** `WebviewWindowBuilder` + `WebviewUrl::External`
   (the same API `commands/presenter.rs` and `commands/subwindow.rs` already
   use), in an **ephemeral** (incognito) web context, with
   `on_navigation` / `on_new_window` / `on_download` handlers, and — critically
   — **its own capability file that grants nothing**. Opened from the reader
   tab's "Open live page", and from #33 link routing. This surface carries one
   accepted, unfixable risk: on Linux its renderer is **not sandboxed** and
   cannot be (§7.6).

The live-page window is a real OS window, not a pane overlay. Overlaying a
borderless window on a pane rect is the frameless-embedding problem this repo
**already deliberately dropped** (`src-tauri/src/commands/apps.rs:3-5`: "Eldrun's
X11 window embedding model is intentionally dropped in the Tauri rewrite"), it
is X11-only, and it would need continuous geometry-following, z-order arbitration
and dialog-occlusion handling for zero security benefit.

The single loudest security finding for Planner B is in §2: **you cannot remove
the Tauri IPC bridge from a webview Tauri creates.** It is injected
unconditionally. The boundary is the ACL origin check, and Eldrun's current
capability file would hand a browser webview every permission it has.

---

## 1. Verified dependency baseline

Read from `Cargo.lock` (workspace root — note it is at the **repo root**, not
`src-tauri/`) and from the vendored sources under
`~/.cargo/registry/src/index.crates.io-*/`.

| Component | Version | Notes |
|---|---|---|
| `tauri` | **2.11.3** | `src-tauri/Cargo.toml` declares `features = []` |
| `tauri-runtime` / `tauri-runtime-wry` | **2.11.3** | |
| `wry` | **0.55.1** | |
| `tao` | **0.35.3** | |
| `webkit2gtk` (Rust) | **=2.0.2** | pinned as a *direct* dep in `src-tauri/Cargo.toml`, feature `v2_40` |
| `webview2-com` | **0.38.2** | Windows |
| `objc2-web-kit` | **0.3.2** | macOS |
| `gtk` (Rust) | 0.18.2 | GTK **3** |
| System WebKitGTK (dev box) | **2.52.3** | `libwebkit2gtk-4.1-0 2.52.3-0ubuntu0.26.04.2`; GTK 3.24.52 |

**Cargo features currently enabled on `tauri`: none.** `tauri`'s default set is
`["wry", "compression", "common-controls-v6", "dynamic-acl", "x11", "dbus"]`
(`tauri-2.11.3/Cargo.toml`). Consequently:

- `unstable` is **off** → `WebviewBuilder` and `Window::add_child` are
  `pub(crate)` today (`tauri-2.11.3/src/webview/mod.rs:257-281`,
  `src/window/mod.rs:1127`). The app literally cannot construct a child webview
  without a Cargo.toml change.
- `macos-proxy` is **off** → `proxy_url()` is a no-op on macOS
  (`wry-0.55.1/src/wkwebview/mod.rs:326` is `#[cfg(feature = "mac-proxy")]`).
- `isolation` is **off** → the Isolation Pattern is not in play.

Existing multi-window machinery in this repo (all **stable** API,
`WebviewWindowBuilder` + `WebviewUrl::App`):

- `src-tauri/src/commands/subwindow.rs` — detached popouts (#42): labels
  `detached-<scope>-<group>`, physical-px geometry, X11 native-id resolution via
  `platform::x11::find_window_for_title`, registered as project-owned
  `TrackedWindow`s so `project_runtime::switch` parks them.
- `src-tauri/src/commands/presenter.rs` — the deck audience window, labels
  `present-*`, deliberately **not** registered/parked.
- Both are `async` commands **on purpose**: `WebviewWindowBuilder::build()` on
  Windows blocks on the main-thread event loop pumping WebView2's controller
  callback (wry#583 / tauri#4121) → deadlock from a sync command. `add_child`
  has the *same* hazard and worse: it does `run_on_main_thread(…)` then blocks
  on `rx.recv()` (`tauri-2.11.3/src/window/mod.rs:1129-1146`).

---

## 2. Can the app deny an embedded webview the Tauri IPC bridge? — **No, not by removing it**

This is Planner B's #1 requirement and the answer is nuanced enough that
getting it wrong is a vulnerability.

### 2.1 The bridge is injected unconditionally. There is no opt-out.

`tauri-2.11.3/src/manager/webview.rs:166-224` builds
`all_initialization_scripts` for **every** pending webview with no condition on
the URL, the label, or any builder flag:

```
all_initialization_scripts.push(main_frame_script(r"
    Object.defineProperty(window, 'isTauri', { value: true });
    if (!window.__TAURI_INTERNALS__) { … }
"));
all_initialization_scripts.push(main_frame_script(self.invoke_initialization_script.clone()));
all_initialization_scripts.push(main_frame_script(/* currentWindow/currentWebview metadata */));
all_initialization_scripts.push(main_frame_script(self.initialization_script(…ipc_init…)));
```

Below that, wry attaches the raw message handler for every webview it builds,
also unconditionally (`wry-0.55.1/src/webkitgtk/mod.rs:341`):

```
Object.defineProperty(window, 'ipc', { value: Object.freeze({ postMessage: … }) })
```

**Consequence:** a page loaded at `https://attacker.example` inside a
Tauri-created webview has `window.isTauri === true`, a populated
`window.__TAURI_INTERNALS__`, and a live `window.ipc.postMessage` channel to
the Rust process. `withGlobalTauri` is irrelevant — it only controls whether
the *convenience* `window.__TAURI__` wrapper is added; the internals object is
always there. There is no `dangerous*` flag in Tauri 2 that turns this off
(`dangerousRemoteDomainIpcAccess` exists only in `tauri-utils`' **v1 config
compatibility module**, `tauri-utils-2.9.3/src/config_v1/mod.rs:1302` — it is
not part of the v2 config schema).

### 2.2 `invoke_key` is **not** a boundary against page content

Tauri 2 gates invokes on a per-run random key
(`tauri-2.11.3/src/webview/mod.rs:1747-1758`). But the key is baked into the
init script that is injected into the page (`src/app.rs:1688`,
`.replace("__INVOKE_KEY__", …)`), so any script running in that webview can
read it. `invoke_key` stops content that never received the init script —
notably **sub-frames**, since every script above is pushed as
`main_frame_script(…)` with `for_main_frame_only: true`. It does not stop the
top-level page.

### 2.3 The real boundary: the ACL origin check

`tauri-2.11.3/src/webview/mod.rs:1787-1852`:

```rust
let acl_origin = if is_local { Origin::Local } else { Origin::Remote { url: request.url.clone() } };
…
// Check ACL on plugin commands, when the app defined its ACL manifest,
// or when the request comes from a non-local (remote) origin.  This
// ensures remote content can never reach custom commands unless an
// explicit `remote` capability has been configured for them.
if (plugin_command.is_some() || has_app_acl_manifest || !is_local) && … && invoke.acl.is_none() {
    invoke.resolver.reject(format!("Command {} not allowed by ACL", request.cmd));
    return;
}
```

`Origin::Remote` only matches a capability whose `remote.urls` URL-pattern list
matches (`src/ipc/authority.rs:57-67`). Eldrun's `capabilities/default.json`
has **no** `remote` block, so a genuinely remote-origin page is denied every
command. **That is the guarantee, and it holds identically on all three
platforms** because it is pure Rust with no platform code path.

### 2.4 Two traps that break the guarantee — both live in this repo

**Trap 1 — the `windows` glob outranks `webviews`.** `tauri-utils-2.9.3/src/acl/capability.rs:150-158`:

> "If a window label matches any of the patterns in this list, the capability
> will be enabled on **all the webviews of that window, regardless of the value
> of `Self::webviews`**. On multiwebview windows, prefer specifying
> `Self::webviews` and omitting `Self::windows`."

`src-tauri/capabilities/default.json` today is
`"windows": ["main", "detached-*", "present-*"]`. **A child webview added to the
`main` window inherits the entire default capability set** — `core:default`,
window destroy, `dialog:default`, `drag:default`, `notification:default`.
Combined with §2.3 this is only saved by the origin check; if the browser is
ever pointed at anything `is_local_url` calls local, it is a full compromise.
Any browser work **must** first migrate `default.json` from `windows` globs to
explicit `webviews` globs, and add a second capability file for the browser
label that grants nothing.

**Trap 2 — `is_local_url` treats the dev server as local.**
`tauri-2.11.3/src/webview/mod.rs:1698-1739` returns true when the current URL is
relative to `get_app_url()`, which in a **dev build** is
`build.devUrl = http://localhost:1420` (`src-tauri/tauri.conf.json`). So in a
`tauri dev` build, browsing the in-app browser to *any* `http://localhost:1420/…`
URL yields `Origin::Local` → full ACL. It also returns true for any URL under a
registered custom protocol, and on Windows for `http://<protocol>.localhost`.
A blocklist on the navigation handler must reject the app origin, the dev URL,
`tauri://`, `asset://`, `ipc://` and `*.localhost` — in the backend, not the
frontend.

### 2.5 What to do instead

- Build the live-page window as an **OS window with its own label**
  (`browser-<id>`), never a child webview of `main`.
- Ship `src-tauri/capabilities/browser.json` with
  `{"identifier":"browser","webviews":["browser-*"],"local":false,"permissions":[]}`
  and **remove** `browser-*` from every other capability's reach. `local:false`
  is the belt to the `remote`-absent braces.
- Rewrite `default.json` to use `webviews` rather than `windows`, so no future
  child webview can silently inherit it.
- Add a Rust unit test asserting `resolve_access` returns `None` for a sample of
  Eldrun commands under `Origin::Remote { url: https://example.invalid }` **and**
  under `Origin::Local` for the `browser-*` webview label. This is testable
  without launching Eldrun (`tauri-2.11.3/src/ipc/authority.rs` has exactly this
  test shape at lines 1041-1190).

---

## 3. Request interception / navigation control

### 3.1 The single most misleading API: `on_web_resource_request` does **not** see network traffic

`WebviewBuilder::on_web_resource_request` (`tauri-2.11.3/src/webview/mod.rs:487`)
reads like a request interceptor. It is not. Its only call site is
`src/protocol/tauri.rs:188` — the handler for Tauri's **own `tauri://` custom
protocol**. It never fires for an `https://` request. `grep -rn
web_resource_request_handler tauri-2.11.3/src/` returns exactly the builder,
the pending-webview plumbing, and `protocol/tauri.rs`. It is also absent from
`tauri-runtime-wry` entirely.

**If Plan B budgets on `on_web_resource_request` for subresource filtering,
that budget is zero.**

### 3.2 What actually exists, per platform

| Hook | Exposed by Tauri 2 | Linux / WebKitGTK | Windows / WebView2 | macOS / WKWebView |
|---|---|---|---|---|
| Navigation veto (`on_navigation`, returns bool) | ✅ `WebviewBuilder::on_navigation` (`webview/mod.rs:528`) → `wry::with_navigation_handler` | ✅ `decide-policy` | ✅ `NavigationStarting` | ✅ `WKNavigationDelegate` |
| `window.open` veto (`on_new_window`) | ✅ `webview/mod.rs:585`; **Android/iOS unsupported** | ✅ — but wry documents "**Linux**: the new webview must be *related* to the caller webview" (`wry/src/lib.rs:469,496`), i.e. it needs `with_related_view` / `Webview::with_related_view` (`tauri webview/mod.rs:1276`) | ✅ (handler runs on a separate thread to avoid deadlock) | ✅ `createWebViewWithConfiguration` (`wry/src/wkwebview/class/wry_web_view_ui_delegate.rs:139`) |
| Sub-resource / XHR interception | ❌ **not exposed** | ❌ no UI-process API in WebKitGTK 4.1; needs a **web process extension** `.so` (`WebKitWebPage::send-request`) — `set_web_extensions_directory` is reachable (`wry/src/webkitgtk/web_context.rs:88-93`) but writing/shipping the extension is a large lift | ⚠️ possible via raw `ICoreWebView2::add_WebResourceRequested`, reachable through `WebViewExtWindows::webview()` (`wry/src/lib.rs:2234`) + `with_webview` | ⚠️ `WKURLSchemeHandler` is **custom schemes only** (Apple forbids http/https); declarative blocking via `WKContentRuleList` only — not exposed by wry |
| Custom protocol handler | ✅ `register_uri_scheme_protocol` | ✅ | ✅ (`http://<name>.localhost`) | ✅ |
| **Proxy** (the only cross-platform egress chokepoint) | ✅ `WebviewBuilder::proxy_url` (`webview/mod.rs:1010`) | ✅ `WebKitNetworkProxySettings`, `NetworkProxyMode::Custom` (`wry/src/webkitgtk/mod.rs:267-277`) — **set on the WebContext**, so it needs a dedicated `data_directory` | ✅ via `--proxy-server=` browser arg (`wry/src/webview2/mod.rs:304-313`) — per **environment**, i.e. also per `data_directory` | ⚠️ **requires the `macos-proxy`/`mac-proxy` feature, which is OFF**, and macOS 14+ |
| Raw platform handle escape hatch | ✅ `Webview::with_webview` (`webview/mod.rs:1668`) → `PlatformWebview::inner()`/`controller()`/`ns_window()` | ✅ `webkit2gtk::WebView` — already used by `install_webview_crash_reporter` in `src-tauri/src/lib.rs:244-272` | ✅ `ICoreWebView2Controller` | ✅ `WKWebView` |

**Practical conclusion:** navigation-level control is available and uniform.
Sub-resource control is available on **no** platform through Tauri's API. If
Plan B wants request-level policy (blocking trackers, forcing HTTPS,
stripping headers, logging egress), the only cross-platform mechanism is a
**local proxy Eldrun runs itself** and points the browser webview at via
`proxy_url` — and that is macOS-broken until `macos-proxy` is enabled and the
minimum macOS version is raised to 14 (Eldrun currently ships
`minimumSystemVersion: 10.15`, `src-tauri/tauri.macos.conf.json`).

### 3.3 Note on egress and the VPN

`docs/context/openvpn.md` states the tunnel is machine-wide and a config that
pushes `redirect-gateway` reroutes "*the whole computer's* traffic — browser
included". An in-app browser is now one of those consumers, and unlike an
external browser it is *inside* Eldrun's process tree. Any Plan-B claim of
"per-project egress isolation" must reckon with the fact that Eldrun already
manipulates machine-wide routing and offers no split tunnelling (TODO #82).

---

## 4. Storage partitioning

| Platform | Mechanism | Ephemeral? | Verified at |
|---|---|---|---|
| **Linux / WebKitGTK** | `WebviewBuilder::data_directory(PathBuf)`. `tauri-runtime-wry` uses `data_directory` as the **key of the `WebContextStore` HashMap** (`tauri-runtime-wry-2.11.3/src/lib.rs:4793-4813`), so a distinct path ⇒ a distinct `WryWebContext` ⇒ a distinct `WebsiteDataManager` with its own `base_cache_directory`, `base_data_directory` and a text cookie jar at `<dir>/cookies` (`wry/src/webkitgtk/web_context.rs:32-49`). | ✅ `incognito(true)` → `WebContext::new_ephemeral()` → `webkit2gtk::WebContext::new_ephemeral()` (`wry/src/webkitgtk/mod.rs:255`, `web_context.rs:54-60`) — nothing touches disk | strong |
| **Windows / WebView2** | Same `data_directory`, mapped to the WebView2 user-data folder. wry documents the constraint: "Webview instances with different `CoreWebView2EnvironmentOptions` must have different `data_directory`s" (`wry/src/web_context.rs:41-45`). | ✅ `SetIsInPrivateModeEnabled(incognito)` (`wry/src/webview2/mod.rs:407`); docs.rs notes it needs **WebView2 Runtime ≥ 101.0.1210.39**, and *"does nothing on older versions"* — a silent downgrade | strong |
| **macOS / WKWebView** | `data_directory` is **not** the mechanism. `data_store_identifier([u8;16])` (`tauri webview/mod.rs:1088` → `wry` `WebViewBuilderExtDarwin::with_data_store_identifier`, `wry/src/lib.rs:1540`) — **macOS ≥ 14 / iOS ≥ 17 only**; wry's own doc calls it "a replacement for data_directory not being available in WKWebView". | ✅ `incognito` → `nonPersistent` `WKWebsiteDataStore` | strong for the API, `UNVERIFIED` at runtime (cannot compile macOS here) |

**Cleanup story.**

- *On quit, ephemeral:* nothing to clean on any platform — the store never
  existed on disk. This is why **ephemeral should be the default** for the
  browser.
- *On quit, persistent:* `Webview::clear_all_browsing_data()`
  (`tauri webview/mod.rs:2123`) plus `cookies()` / `delete_cookie()`
  (`:2173`, `:2195`) exist and are cross-platform. A persistent profile
  directory under `~/.local/share/eldrun/browser/<profile>/` is Eldrun's to
  delete on quit.
- *On crash:* nothing runs. A persistent profile leaves cookies, cache and
  IndexedDB on disk indefinitely. **This alone argues for ephemeral-by-default**:
  the repo's own crash history (§7) says a hard renderer kill is not
  hypothetical here. If a persistent profile is ever offered, a
  startup sweep is required (the pattern `services::sandbox` already uses for
  orphaned containers).
- *macOS ≥ 14 extra:* `WebViewExtDarwin::fetch_data_store_identifiers` /
  `remove_data_store` (`wry/src/lib.rs:2342,2348`) allow a startup sweep of
  orphaned stores. No Linux/Windows equivalent — there, sweeping means
  `remove_dir_all` on Eldrun's own profile root.

---

## 5. Permission prompts (camera / mic / geolocation / notifications)

**wry 0.55.1 registers no permission handler on Linux or Windows.** `grep -rni
permission wry-0.55.1/src/webkitgtk/ wry-0.55.1/src/webview2/` → **zero
matches**. Tauri exposes no permission API on `WebviewBuilder` at all. So the
behaviour is entirely each platform's default:

| Platform | Default behaviour | Verdict |
|---|---|---|
| **Linux / WebKitGTK** | wry connects nothing to `WebKitWebView::permission-request`. WebKitGTK documents: *"By default, if the signal is not handled, `webkit_permission_request_deny()` will be called"* ([signal.WebView.permission-request](https://webkitgtk.org/reference/webkit2gtk/2.41.4/signal.WebView.permission-request.html)). → **denied silently**. | ✅ Safe by default, but the *user cannot grant* anything either. Note `enable-media-stream` **defaults to TRUE** on the installed 2.52.3 (`/usr/share/gir-1.0/WebKit2-4.1.gir`, `default-value="TRUE"`), so `getUserMedia` *exists* and is only stopped by the deny; `enable-webrtc` defaults to FALSE. |
| **Windows / WebView2** | No `PermissionRequested` handler ⇒ `COREWEBVIEW2_PERMISSION_STATE_DEFAULT` ⇒ **WebView2 renders its own browser-style permission prompt**, and the answer is **persisted into the profile** ([WebView2Feedback#2406](https://github.com/MicrosoftEdge/WebView2Feedback/issues/2406), [PermissionManagement.md](https://github.com/MicrosoftEdge/WebView2Feedback/blob/main/specs/PermissionManagement.md)). | ⚠️ A prompt Eldrun neither drew nor logged, whose "Allow" is remembered in the profile. Fixable only via the raw `ICoreWebView2` handle. |
| **macOS / WKWebView** | 🔴 **wry's `WKUIDelegate` unconditionally GRANTS camera and microphone.** `wry-0.55.1/src/wkwebview/class/wry_web_view_ui_delegate.rs:126-137`: `fn request_media_capture_permission(…) { (*decision_handler).call((WKPermissionDecision::Grant,)); }` — no origin check, no callback, no builder flag. | 🔴 **This is the finding.** Any page in any wry webview on macOS gets `getUserMedia` granted at the WebKit layer with no prompt and no app hook. |

**macOS mitigating factor (partial, `UNVERIFIED`):** `src-tauri/entitlements.plist`
does **not** contain `com.apple.security.device.camera` or
`…device.audio-input`, and `hardenedRuntime: true` is set
(`tauri.macos.conf.json`). A hardened-runtime app without the entitlement and
without `NSCameraUsageDescription`/`NSMicrophoneUsageDescription` in Info.plist
is expected to be *terminated by TCC* rather than to record silently. That
converts a silent-capture bug into a crash bug — better, but still a defect,
and it is `UNVERIFIED` because macOS cannot be compiled or run in this
environment.

**Mandatory mitigation, whichever surface ships:** connect
`permission-request` (Linux, via the `webkit2gtk` crate already in
`Cargo.toml`), `PermissionRequested` (Windows, via `webview2-com` already in
the lock file) and — if macOS live pages are ever enabled — override the UI
delegate or accept the finding in writing. Deny-all with an explicit Eldrun-drawn
prompt is the only defensible default, and it must be Eldrun's own dialog
(consistent with the "unified menu layout" rule) rather than the platform's.

**Notifications** are a separate hazard: Eldrun ships
`tauri-plugin-notification` and grants `notification:default` in the default
capability. A browser webview inheriting that capability (§2.4 Trap 1) could
raise OS notifications indistinguishable from Eldrun's own calendar reminders.

---

## 6. Downloads

| Platform | Signal | Interceptable? |
|---|---|---|
| Linux | `WebKitWebContext::download-started` → `WebKitDownload::decide-destination` (`wry/src/webkitgtk/web_context.rs:317-360`) | ✅ Full: the handler receives the URI + a mutable destination and returns `bool`; `false` → `download.cancel()` |
| Windows | WebView2 `DownloadStarting` | ✅ (`UNVERIFIED` in detail — not read at source, but `with_download_started_handler` is wired for all desktop backends) |
| macOS | `WKDownloadDelegate` | ⚠️ `with_download_completed_handler` documents "**macOS**: the second parameter indicating the path the file was saved to is always empty, due to API limitations" (`wry/src/lib.rs:1296-1305`) |

Exposed through Tauri as **one** unified callback: `WebviewBuilder::on_download`
(`tauri webview/mod.rs:643`), `Fn(Webview, DownloadEvent) -> bool`.

**Silent auto-download is preventable** — `on_download` returning `false`
cancels before any byte is written, and wry's default is documented as
"allows all downloads to match browser behaviour", i.e. **you must opt out
explicitly**. The default destination wry computes is `dirs::download_dir()`
(`web_context.rs:325`), i.e. `~/Downloads` — outside any project.

**Interaction with TODO #60.** `todo/group-o-security.md:50` records that Eldrun
deliberately removed all browser-download-path manipulation, with the reason
"routing a download into a project is a security risk if the file is then
pushed with the project's git". #60 forbids touching *other apps'* config —
it does not forbid Eldrun handling its own downloads — but its **rationale
still applies**: an in-app browser must not default a download into the active
project directory. Recommended policy: `on_download` returns `false` unless the
user has just confirmed a destination in an Eldrun-raised
`tauri-plugin-dialog` save dialog, defaulting to `~/Downloads`, never to the
project root, with an explicit opt-in for "save into this project" that names
the git consequence.

---

## 7. Repo-history hazards that will bite a browser pane specifically

Each of these is a *known, already-worked-around* problem in this codebase.
Each gets **worse** with an arbitrary web page in the process.

1. **DMABUF is disabled process-wide.** `src-tauri/src/lib.rs:419-421` sets
   `WEBKIT_DISABLE_DMABUF_RENDERER=1` unconditionally on Linux, because WebKit's
   DMA-BUF renderer SIGBUSed inside Mesa (2026-06-11, Mesa 26.0.3). This puts
   **every repaint on the CPU** — the codebase says so in two places
   (`src/components/files/FileTree.tsx:1384`,
   `src/components/embed/PresentationOverlay.tsx:210`) and the memory note
   "never animate a blurred box-shadow" exists for this reason. A modern
   JS-heavy web page (scroll-linked animation, video, canvas) in a
   software-rendered WebKitGTK view will be materially slower than in the user's
   real browser, and on a shared GTK main loop the *compositing* half of that
   cost lands in Eldrun's UI process. **This is the strongest technical argument
   for the JS-free reader tab as the default surface.**
2. **Renderer crashes are a live failure mode here, not a theoretical one.**
   `install_webview_crash_reporter` (`lib.rs:244-272`) hooks
   `web-process-terminated` and reloads, capped at 5. Note it iterates
   `app.webview_windows()` **once, at setup** — a browser window created later
   would not be hooked. Any browser work must extend that loop, or the crash
   that a hostile page induces produces a blank pane with no `crash.log` line.
3. **WebKitGTK drops HTML5 drag-and-drop.** Recorded repeatedly in
   `src/CLAUDE.md` (`files/importDrop.tsx`: "WebKitGTK withholds dropped paths
   from HTML5 drops"; `TabBar`/`YamlTree`/`MachinesIndicator` all use pointer
   events instead). **TODO #53 ("drag a tab into a browser upload field") is
   therefore not achievable on Linux through HTML5 DnD** — it needs
   `tauri-plugin-drag` (already a dependency) doing a *native* OS drag onto the
   webview, and the browser webview receiving it as a native drop. Treat #53 as
   unproven, not as a follow-up.
4. **WebView2 black/dead tab.** The repo's memory records agent tabs rendering
   black on Windows because the webview never `open()`s; `subwindow.rs` and
   `presenter.rs` both build **hidden** on Windows and reveal in a deferred
   kick. A browser window must copy that dance verbatim.
5. **Main-thread deadlock.** Both existing window commands are `async` with a
   comment explaining why. `Window::add_child` blocks on `rx.recv()` after
   `run_on_main_thread` — strictly worse. Any browser-window/webview command
   must be `async` and hold no lock across an `.await`.
6. **The WebProcess is unsandboxed, and Eldrun cannot fix it alone.** wry never
   calls `webkit_web_context_set_sandbox_enabled` — `grep -rn sandbox
   wry-0.55.1/src/webkitgtk/` returns nothing, and
   [wry#935](https://github.com/tauri-apps/wry/issues/935) ("Enable sandbox on
   WebkitGTK", opened 2023-04-20) is **still open**. WebKitGTK's bubblewrap
   sandbox is **off by default** and "must be called before any web process has
   been created … calling it later is a fatal error"
   ([WebContext.set_sandbox_enabled](https://webkitgtk.org/reference/webkit2gtk/2.42.2/method.WebContext.set_sandbox_enabled.html)).
   **Right now, a page rendered in an Eldrun webview runs its renderer with
   Eldrun's full filesystem access.**

   I first assumed Eldrun could fix this locally (the `webkit2gtk` crate is a
   direct dependency and `lib.rs:244-272` already reaches the raw `WebView` via
   `with_webview`). **It cannot.** The only hook Tauri offers runs too late:
   `tauri-2.11.3/src/app.rs:2521-2532` builds every window declared in
   `tauri.conf.json` **before** invoking the user's `.setup()` closure, so by the
   time any Eldrun code can touch a `WebContext`, a WebProcess already exists and
   the call is a documented fatal error. `WebContext` creation itself lives
   inside `tauri-runtime-wry`'s `create_webview` with no pre-build hook, and an
   `incognito` webview does not even use the pooled context — wry constructs a
   *function-local* `WebContext::new_ephemeral()` (`wry/src/webkitgtk/mod.rs:254-257`).

   **Therefore: renderer sandboxing on Linux requires an upstream wry/Tauri
   change and must be treated as a standing accepted risk, not a mitigation.**
   This raises the bar on (c) reader mode considerably — it is the only option
   where no untrusted content reaches a renderer at all. (`UNVERIFIED` avenue
   worth one experiment: whether the `WEBKIT_FORCE_SANDBOX` environment variable
   still exists on WebKitGTK 2.52 and would apply process-wide the way
   `WEBKIT_DISABLE_DMABUF_RENDERER` already does in `lib.rs:419`.)

---

## 8. Alternatives assessment

Scored 1–5 (5 = best). "Parity" = behaves the same on Linux/Windows/macOS.
Effort in rough engineer-weeks.

| # | Option | Security | Feasibility | Parity | Effort | Verdict |
|---|---|---|---|---|---|---|
| **a1** | **Embedded child webview as a pane** (`unstable` + `add_child`) | 3 | **1** | **1** | 4–6w + upstream | ❌ **Reject.** Structurally unpositionable on Linux (§0); requires opting the whole app into `unstable`, whose API Tauri reserves the right to break in minor releases; two open upstream rendering bugs; still inherits the IPC bridge. |
| **a2** | **Hardened separate `WebviewWindow`** (stable API, `WebviewUrl::External`) | 3 | **5** | 4 | 2–3w | ✅ **Recommended as the "live page" surface.** Uses only stable API already exercised twice in this repo; full `on_navigation`/`on_new_window`/`on_download`/`incognito`/`proxy_url`; own capability label. Security is 3, not 4, because of two things nothing in the app can fix: the IPC bridge is present in the page (§2.1) and the Linux renderer is unsandboxed (§7.6). Cost: it is a *window*, not a pane — it will not clip, dock, split or tile with tabs. |
| **b** | **`<iframe sandbox>` inside the existing webview** | **1** | 5 | 5 | 1w | ❌ **Reject for live web.** An iframe cannot navigate cross-origin freely under Eldrun's CSP (`connect-src 'self' ipc:` etc.), most real sites set `X-Frame-Options`/`frame-ancestors` and simply refuse to load, and a `sandbox` escape puts attacker script in the **app origin** with the IPC bridge. Acceptable only for *already-sanitized, srcdoc, no-network* content — which is option (c). |
| **c** | **Fetch-and-sanitize reader mode** (Rust `reqwest`/`ammonia`, `mail_sanitize` shape) | **5** | 5 | **5** | 1–2w | ✅ **Recommended as the default in-pane surface.** Reuses `services::mail_sanitize` verbatim (`SANITIZER_VERSION`, `MAX_HTML_BYTES`, `MAX_ELEMENTS`, href-stripping, `<iframe sandbox="" srcdoc>` + inline meta CSP). Zero JS, zero renderer network, zero new engine, identical on all OSes, no permission/download/storage surface at all. Cost: it is a *reader*, not a browser — no login, no SPA, no forms. |
| **d** | **Bundle a separate engine (Servo, CEF, …)** | 3 | 1 | 2 | 12w+ | ❌ **Reject.** CEF adds ~150–250 MB per platform to a bundle whose Linux target is a `.deb` depending on the *system* `libwebkit2gtk-4.1-0`; it needs its own update/CVE pipeline, its own crash reporting, its own sandbox helper binaries, and a second GPU/rendering stack in a process that already had to disable DMABUF. Servo is not a shippable general-purpose engine as of 2026 (`UNVERIFIED` — not re-checked; the bundle-size and maintenance arguments stand regardless). Adds three more platform code paths to a project that already cannot compile one of its three targets locally. |

**Recommended composition: (c) as the tab, (a2) as the escape hatch.** The
reader tab is what #33 link routing and the file tree open by default; a
single explicit "Open live page ↗" action in the reader's header spawns the
hardened window. This gives Planner A a real in-pane surface to design, gives
Planner B a threat model that is mostly *already implemented and tested*, and
keeps the only untrusted-JS execution inside a window with its own empty
capability and its own ephemeral data store.

---

## 9. Cross-platform parity gap table

Per this repo's constraints: **Linux is the only locally verifiable platform;
Windows is CI-verified only; macOS cannot be compiled here at all (no SDK).**

| Capability | Linux / WebKitGTK 2.52 | Windows / WebView2 | macOS / WKWebView |
|---|---|---|---|
| Child webview positioned as a pane | 🔴 **Broken** — GtkBox parent, `set_bounds` no-op | 🟡 works (`build_as_child`) but `unstable` + [#11376](https://github.com/tauri-apps/tauri/issues/11376) open | 🟡 same; [#11376](https://github.com/tauri-apps/tauri/issues/11376) reported *on macOS* |
| Separate `WebviewWindow` + `External` URL | 🟢 stable | 🟢 stable (must build hidden, reveal in deferred kick) | 🟢 stable (`UNVERIFIED` at runtime) |
| IPC bridge removable from the page | 🔴 no | 🔴 no | 🔴 no |
| ACL denies remote origin | 🟢 yes (pure Rust, no platform path) | 🟢 yes | 🟢 yes |
| Navigation veto | 🟢 | 🟢 | 🟢 |
| `window.open` veto | 🟡 needs `with_related_view` | 🟢 | 🟢 |
| Sub-resource interception | 🔴 needs a web-process extension `.so` | 🟡 raw `ICoreWebView2` only | 🔴 declarative `WKContentRuleList` only, not exposed |
| Proxy (egress chokepoint) | 🟢 per-WebContext | 🟢 per-environment | 🔴 **off** — needs `macos-proxy` feature **and** macOS 14+ (bundle targets 10.15) |
| Isolated persistent storage | 🟢 `data_directory` | 🟢 `data_directory` | 🟡 `data_store_identifier`, macOS 14+ only |
| Ephemeral storage | 🟢 `new_ephemeral` | 🟡 needs Runtime ≥ 101.0.1210.39, **silently no-ops below** | 🟢 `nonPersistent` |
| Camera/mic default | 🟢 **denied** (unhandled `permission-request`) | 🟡 **platform prompt**, answer persisted to profile | 🔴 **GRANTED unconditionally by wry** |
| Download interception | 🟢 full (URI + destination + cancel) | 🟢 (`UNVERIFIED` in detail) | 🟡 completed-path always empty |
| Renderer sandbox | 🔴 **off** (wry never enables bubblewrap) and **not fixable from app code** — the only hook runs after the first WebProcess exists (§7.6) | 🟢 Chromium sandbox on by default | 🟢 WebKit sandbox on by default |
| GPU-accelerated paint | 🔴 **off** — `WEBKIT_DISABLE_DMABUF_RENDERER=1` app-wide | 🟢 | 🟢 |
| Drag a tab into an upload field (#53) | 🔴 HTML5 DnD non-functional; needs native drag | 🟡 `UNVERIFIED` | 🟡 `UNVERIFIED` |
| Locally verifiable by an agent | 🟢 `cargo test` + `tsc` | 🟡 CI only | 🔴 not at all |

---

## 10. Minimum viable spike

**The smallest commit that proves the chosen architecture, verifiable by
`npx tsc --noEmit` + `cargo test --manifest-path src-tauri/Cargo.toml` alone.
No agent may launch Eldrun.**

### Spike scope (one commit, no UI polish)

**Backend**

1. `src-tauri/capabilities/browser.json` — new capability:
   `{"identifier":"browser","description":"…","webviews":["browser-*"],"local":false,"permissions":[]}`.
2. `src-tauri/capabilities/default.json` — replace
   `"windows": ["main","detached-*","present-*"]` with the equivalent
   `"webviews": [...]` list, so no future child webview inherits it. *(This is a
   behaviour-preserving refactor for today's single-webview windows and is the
   single most valuable line of the spike.)*
3. `src-tauri/src/commands/browser.rs` — pure helpers + one `async` command:
   - `pub fn valid_browser_label(&str) -> bool` — mirrors
     `presenter::valid_presenter_label`: `browser-` prefix, ≤64, `[A-Za-z0-9_-]`.
   - `pub fn is_blocked_url(&Url, dev_url: Option<&str>) -> bool` — **pure**,
     the §2.4 Trap-2 blocklist: app origin, `devUrl`, `tauri:`, `asset:`,
     `ipc:`, `file:`, `about:` (except `about:blank`), any `*.localhost` host,
     any non-`http(s)` scheme.
   - `pub fn browser_profile_dir(app_data: &Path, profile: &str) -> PathBuf` —
     pure, confined under `<state>/browser/`.
   - `pub async fn open_browser_window(app, url) -> Result<String,String>`
     — `WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))`
     `.incognito(true)`, `.on_navigation(|u| !is_blocked_url(u, …))`,
     `.on_new_window(|_,_| NewWindowResponse::Deny)`,
     `.on_download(|_,_| false)`, hidden-then-reveal on Windows.

   **`incognito` and `data_directory` are mutually exclusive, not
   complementary** — wry documents "WebContext will be ignored if incognito is
   enabled" (`wry/src/lib.rs:741-742`) and on Linux builds a function-local
   `WebContext::new_ephemeral()` that discards the pooled context entirely
   (`wry/src/webkitgtk/mod.rs:254-257`). The spike ships **incognito only**;
   `browser_profile_dir` exists (and is tested) for the later persistent-profile
   follow-up, and must not be passed alongside `incognito`.
4. Extend `install_webview_crash_reporter` to hook newly created windows
   (hazard §7.2) — today it iterates `app.webview_windows()` once at setup.
5. *(Not in the spike — see §7.6.)* Renderer sandboxing on Linux is not
   reachable from application code and must be recorded as an accepted risk in
   whatever Plan B ships.

**Frontend**

6. `TabKind` gains `"browser"` (`src/stores/tabs.ts:48-60`), non-restorable,
   non-locatable, non-PTY.
7. `src/components/browser/ReaderPane.tsx` — renders a sanitized body in
   `<iframe sandbox="" srcdoc>` reusing `lib/mail.ts`'s `buildMessageSrcdoc`
   shape, plus an "Open live page ↗" button invoking `open_browser_window`.
8. Gate the whole thing behind an experimental flag `browser` in
   `src/lib/experimental.ts` (off for users, on in debug), and tag every new UI
   affordance with `UntestedTag`.

### Acceptance criteria — all machine-checkable, none require running Eldrun

| # | Check | How |
|---|---|---|
| A1 | `cargo test --manifest-path src-tauri/Cargo.toml` green | gate |
| A2 | `npx tsc --noEmit` green | gate |
| A3 | `is_blocked_url` rejects `http://localhost:1420/x`, `tauri://localhost`, `http://tauri.localhost`, `asset://…`, `file:///etc/passwd`, `ipc://localhost`, `javascript:alert(1)`, `http://evil.localhost/` | Rust unit test |
| A4 | `is_blocked_url` accepts `https://example.com/a?b=c` and `http://example.com` | Rust unit test |
| A5 | `valid_browser_label` rejects `../`, spaces, `present-x`, `main`, 65-char labels | Rust unit test |
| A6 | `browser_profile_dir` never escapes the state dir for adversarial profile names (`..`, `/etc`, `a/../..`) | Rust unit test |
| A7 | Every capability file parses and **no** capability's `webviews`/`windows` globs match `browser-*` except `browser.json`, whose `permissions` is empty | Rust unit test over `capabilities/*.json` (serde + glob) — the regression guard for §2.4 Trap 1 |
| A8 | `capabilities/default.json` no longer uses `windows` globs | same test |
| A9 | `TabKind "browser"` is excluded from `isRestorableKind`, `isPtyTabKind`, `isLocatableKind` | Vitest in `src/__tests__/` |
| A10 | The reader iframe srcdoc contains no `href`, no `src`, and carries the `default-src 'none'` meta CSP | Vitest, mirroring the existing mail assertions |

### Explicitly **out** of the spike

Proxy/egress policy, permission-request handlers, persistent profiles, history,
bookmarks, tab-into-upload-field (#53), and any in-pane live webview. Each is a
follow-up with its own gate.

---

## 11. Assumptions in Plans A and B that will not hold

`docs/browser_plan_a.md` and `docs/browser_plan_b.md` did not exist when this
was written. These are the assumptions I predict and pre-emptively constrain;
whoever integrates the three plans should diff this list against what A and B
actually wrote.

**Predicted in Plan A (UI surface):**

- **"The browser is a center tab like the mail/calendar tab."** ❌ Not with a
  live webview on Linux (§0). It can be a *reader* tab (option c). If A wants a
  live in-pane page, A's plan does not build.
- **"It tiles/splits/pops out with the existing subwindow machinery."** ❌ A
  native webview is not a DOM node; it cannot be clipped by a React pane, cannot
  be `overflow: hidden`-ed, and will not respect the tab z-order. Only the
  reader tab composes with `CenterPanel`/`Subwindow`.
- **"Drag a tab into a browser upload field (#53)."** ❌ HTML5 DnD is
  non-functional under WebKitGTK — the repo has worked around this five separate
  times. Needs `tauri-plugin-drag` and is unproven (§7.3).
- **"Zoom / find-in-page / reader toggle are free."** 🟡 `set_zoom` exists
  (`webview/mod.rs:2098`); find-in-page does **not** exist in Tauri's API and on
  Linux needs the raw `WebKitFindController`.
- **"Smooth like a real browser."** ❌ DMABUF is off app-wide (§7.1).

**Predicted in Plan B (security):**

- **"We deny the browser webview the IPC bridge."** ❌ Impossible — it is
  injected unconditionally (§2.1). Reframe as: *the bridge is present, the ACL
  denies every command at a remote origin, and the capability files are the
  artifact under test.*
- **"`withGlobalTauri: false` / an init script removes `__TAURI__`."** ❌
  Cosmetic; `__TAURI_INTERNALS__` and `window.ipc.postMessage` remain.
- **"`invoke_key` protects us."** ❌ The key is in the page (§2.2).
- **"We intercept every request with `on_web_resource_request`."** ❌ That hook
  only fires for the `tauri://` custom protocol (§3.1).
- **"Per-project egress isolation / per-project proxy."** 🟡 Possible on
  Linux+Windows via `proxy_url` + a dedicated `data_directory`; **not on
  macOS** (feature off, macOS 14+, bundle targets 10.15) (§3.2). And OpenVPN is
  machine-wide with no split tunnelling (§3.3).
- **"Camera/mic are denied by default everywhere."** ❌ True on Linux, a
  persisted platform prompt on Windows, **unconditionally granted on macOS**
  (§5).
- **"Downloads are safe because we do not route them."** 🟡 wry's documented
  default *allows every download*; you must return `false` (§6).
- **"The renderer is sandboxed."** ❌ Not on Linux — and **not fixable from
  application code**, because Tauri builds config windows before `.setup()` runs
  and WebKit refuses the call once a WebProcess exists (§7.6). This must appear
  in Plan B as an accepted risk with a named owner, not as a TODO.
- **"Ephemeral storage means nothing survives."** 🟡 True — *if* incognito
  actually engages. On Windows it silently no-ops below WebView2 Runtime
  101.0.1210.39 (§4). Needs a runtime-version check that fails closed.

---

## 12. Manual QA checklist (for the **user**, not an agent)

An agent must never launch Eldrun — a second instance corrupts workspace state.
Everything below requires a human at a running instance.

**Linux (primary):**

1. Open a reader tab on a plain article URL; confirm text renders, no images
   load, no links are clickable without the confirm-host dialog.
2. Reader tab on a JS-heavy SPA — confirm it degrades to "nothing to read"
   rather than hanging the window.
3. Reader tab on a deliberately huge page (>5 MB HTML) — confirm the size cap
   refuses it with a typed error, and the UI stays responsive.
4. "Open live page ↗" → confirm a separate OS window appears with the page.
5. In that window, open devtools (debug build) and run
   `typeof window.__TAURI_INTERNALS__` → expect `"object"` (it *is* there), then
   `window.__TAURI_INTERNALS__.invoke('list_projects')` → **expect a rejection
   naming the ACL**. If it resolves, stop and file a blocker.
6. Same window: `window.open('https://example.com')` → expect nothing opens.
7. Navigate the live window to `http://localhost:1420` (dev build) → **expect
   the navigation to be blocked**. This is Trap 2.
8. Trigger a download (any `.zip` link) → expect an Eldrun save dialog, expect
   nothing written until confirmed, expect the default path to be `~/Downloads`
   and **not** the active project.
9. Visit a `getUserMedia` test page → expect denial with no prompt.
10. Close the live window, then check `~/.local/share/eldrun/browser/` → expect
    **no** residue (ephemeral).
11. `kill -9` the `WebKitWebProcess` of the browser window → expect a
    `=== WEBVIEW … TERMINATED …` line in `~/.local/share/eldrun/crash.log` and a
    reload, and expect the **main** window to stay alive and responsive.
12. Play a 1080p video in the live window while scrolling the file tree — record
    whether the main UI janks (the DMABUF-off cost, §7.1). This is a
    go/no-go signal for whether live pages are usable at all.
13. Switch projects while a live browser window is open — confirm it parks/
    unparks like a detached popout and does not float across projects.
14. With an OpenVPN tunnel up, confirm the browser's traffic goes through it
    (whatismyip-style page) — and that this is *documented*, not surprising.

**Windows (CI-built artifact):**

15. Live window renders at all (not black) on first open — the §7.4 hazard.
16. Camera test page → note whether a WebView2 prompt appears and whether the
    answer persists across restarts. Record the WebView2 Runtime version.
17. Confirm incognito actually engages (visit a site, restart, check you are
    logged out). Below Runtime 101 this silently fails.

**macOS (cannot be built here at all):**

18. 🔴 **Priority:** visit a `getUserMedia` page. Expect either a TCC crash or a
    silent grant. **If the camera activates with no prompt, live pages must be
    disabled on macOS** until wry's UI delegate is overridden.
19. Confirm the live window opens and is positioned/decorated sanely with
    `titleBarStyle: "Overlay"`.
20. Confirm ephemeral storage leaves nothing in
    `~/Library/WebKit/io.github.fseiffarth.eldrun/`.

---

## 13. `UNVERIFIED` register

Everything below is asserted nowhere in this document as fact.

- macOS runtime behaviour of anything (no SDK, cannot compile — see the repo's
  own OS-support note). All macOS rows above are read from source and docs only.
- Whether the missing camera entitlement + hardened runtime converts wry's
  unconditional macOS `Grant` into a TCC termination rather than a silent
  capture (§5).
- WebView2 `DownloadStarting` details — the wry Windows backend's download path
  was not read at source (§6).
- Servo's 2026 shippability (§8d). The bundle-size and maintenance arguments
  against a bundled engine do not depend on it.
- Whether `tauri#10420` / `tauri#11376` have had activity after their creation
  dates; both showed as **open** when fetched on 2026-07-26 but the fetched
  pages did not render comment threads.
- Whether enabling the `unstable` cargo feature is otherwise additive to this
  crate's build. It *appears* additive (it only widens `pub(crate)` → `pub`),
  but it was not compiled.
- Whether `#53` (drag a tab into an upload field) is achievable via
  `tauri-plugin-drag` on any platform.
