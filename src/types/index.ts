import type { LinkOpenTarget } from "./browser";
import type { PyMainVerdict } from "../lib/pythonMainCache";

export interface GlobalAppEntry {
  exec: string;
  visible: boolean;
  [key: string]: unknown;
}

/**
 * Per-file-type native-viewer preferences (#48). Keys are snake_case to match
 * the Rust `ViewerPref` serde serialization so settings.json round-trips. Keyed
 * by a viewer-type id (see VIEWER_PREF_TYPES in fileUtils).
 */
/**
 * Completion-length mode for local autocomplete (#45 modes), mirroring the Rust
 * `CompletionMode`: how much the model is asked to complete at the caret.
 *  - `"sentence"` — finish the current word/sentence/line (default).
 *  - `"block"` — finish the current code block / paragraph (multi-line).
 *  - `"scope"` — complete the whole enclosing function or scope.
 */
export type AutocompleteMode = "sentence" | "block" | "scope";

/**
 * Category of a local-model grammar/spelling issue, mirroring the Rust
 * `check_grammar` output. Drives the underline colour in the editor overlay.
 *  - `"spelling"` — a misspelled word / typo (red).
 *  - `"grammar"` — a grammar or punctuation mistake (blue).
 *  - `"style"` — a style/wording suggestion (green).
 */
export type GrammarCategory = "spelling" | "grammar" | "style";

/**
 * One proofreading issue returned by the local-model grammar check, mirroring the
 * Rust `GrammarIssue`. `bad` is the exact offending substring (the frontend
 * locates it in the draft to draw the underline); `line` is its 1-based line in
 * the checked text, used as a disambiguation hint when resolving the range.
 */
export interface GrammarIssue {
  line: number;
  bad: string;
  suggestion: string;
  category: GrammarCategory;
  message: string;
}

export interface ViewerPref {
  /** Whether this native viewer is used at all. Absent/true → render in-app;
   *  false → the type opts out and its files open in the external default app. */
  enabled?: boolean;
  /** Whether Ctrl+Space local autocomplete is enabled for this type (#45). */
  autocomplete?: boolean;
  /** Default completion-length mode for this type (#45 modes). Cycled live
   *  in-editor with Shift+Tab while a suggestion is showing; absent → "sentence". */
  autocomplete_mode?: AutocompleteMode;
  /** Whether the local-model grammar/spelling check is enabled for this type.
   *  Local-only (Ollama) and opt-in; default OFF. */
  grammar_check?: boolean;
  /** Editor font size in px for this type's in-app code editor. Adjusted from
   *  the viewer's A−/A+ controls (or Ctrl +/−/0); unset falls back to 12px. */
  font_size?: number;
}

/**
 * A serializable keyboard chord (Group L / #62). Mirrors the Rust `ChordDescriptor`
 * and `src/lib/shortcuts.ts`'s `ChordDescriptor`. `key` is a normalized
 * `KeyboardEvent.key`; modifier flags default to false when absent.
 */
export interface KeyboardChord {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
}

/**
 * A user-defined "custom agent" — an arbitrary CLI the user wants offered in the
 * add-tab menu's Agents group alongside the built-in agents (Claude, Codex, …).
 * It is just a launch command: Eldrun spawns `cmd` (+ `args`, `env`) in the
 * project directory as an `agent` tab. Persisted in `Settings.custom_agents` and
 * added/removed from the "＋ Add agent…" dialog.
 *
 * Unlike a built-in agent it carries no install command and no session-capture
 * machinery. The one optional capability is `resumeArgs`: a "continue the most
 * recent session" flag (e.g. `["--continue"]`) that, when set, promotes the tab
 * to the *cwd-continue* resume tier — it survives a restart and respawns with
 * these args (exactly how Qwen/OpenCode resume). Unset ⇒ launch-only, dropped on
 * restart like Gemini/Aider.
 */
export interface CustomAgent {
  /** Stable id minted at creation; also the persisted map key / React key. */
  id: string;
  /** Display label in the Agents menu. */
  label: string;
  /** Binary/command to spawn. Probed on PATH (or as a file path when it contains
   *  a separator) for the menu's installed/greyed state. */
  cmd: string;
  /** Optional launch args, prepended before any resume args. */
  args?: string[];
  /** Optional environment variables set on the tab's process. */
  env?: Record<string, string>;
  /** Optional "continue last session" flag(s). When non-empty the tab is
   *  restart-resumable (see the interface note). */
  resumeArgs?: string[];
  /** Optional one-line install command (e.g. `npm install -g @scope/pkg`). When
   *  the agent's binary isn't found, the manage dialog offers a one-click button
   *  that runs this in a fresh root terminal tab (Eldrun's install-via-tab
   *  policy — never a copy-it-yourself step). */
  installCmd?: string;
}

export interface Settings {
  debug?: boolean;
  eldrun_mobile_host?: {
    enabled: boolean;
    display_name?: string;
    port?: number;
    serve_origin?: string;
  };
  /** Show Eldrun Mobile's host-connection control in the desktop header. This
   * defaults to on when Mobile itself is enabled; an explicit false hides it. */
  mobile_indicator?: boolean;
  git_profile_url?: string;
  git_token?: string;
  color_scheme?: string;
  /** UI language for Eldrun's interface. Unset/unknown falls back to English.
   *  Applied live via `lib/i18n` (`applyLanguage`); the backend round-trips it. */
  language?: "en" | "de" | "es" | "fr" | "it";
  /** App-wide clock: `true` = 24-hour, `false` = 12-hour AM/PM. **Unset is not
   *  `false`** — it means "not chosen", and the clock is then derived from
   *  `language` (English → 12-hour, the rest → 24-hour). Read through
   *  `lib/timeFormat`'s `useUse24h()`, never off `settings` directly, or the
   *  language default is what gets missed. */
  time_format_24h?: boolean;
  /** The MAIN window's UI zoom factor (helps on high-DPI/4K monitors). `1` (or
   *  unset) is 100% — the default look; applied as the webview's native zoom.
   *  Clamped to [0.5, 3]. Zoom is **per window**: a detached popout persists its
   *  own zoom on its layout entry (see `DetachedGroup.zoom`), not here. */
  ui_zoom?: number;
  /** Calendar: first column of the week — `0` = Sunday (default), `1` = Monday. */
  calendar_week_start?: 0 | 1;
  /** Calendar: the view a fresh calendar tab opens on. Default `"month"`. */
  calendar_default_view?: CalendarViewKind;
  /** **Retired** — the calendar-only 24-hour switch, superseded by the app-wide
   *  `time_format_24h`. Nothing writes it; `lib/timeFormat.ts` reads it once as
   *  a fallback so a user who had set it keeps that clock everywhere. */
  calendar_time_format_24h?: boolean;
  /** Calendar: first/last hour the day and week grids scroll to. Default 8/20. */
  calendar_day_start_hour?: number;
  calendar_day_end_hour?: number;
  /** Calendar: minutes-before reminder pre-filled on a new event. `0` = none. */
  calendar_default_reminder_minutes?: number;
  /** Calendar: put a 📅 button in the header that opens the calendar overlay,
   *  badged with the events left today. Default false. The twin of the header's
   *  mail button, with no experimental gate above it — the calendar is a shipped
   *  feature and reads nothing off the network. */
  calendar_global_app?: boolean;
  /** To-do board: put a ☑ button in the header that opens the global todo board
   *  overlay, badged with what is due today. Default false.
   *
   *  A plain setting rather than an experimental flag, for `calendar_global_app`'s
   *  reasons: the board reads one already-shipped local file (`calendar.json` —
   *  its cards *are* the calendar's tasks) and reaches no network. Its one
   *  network-adjacent half, the urgent-mail rail, is already gated by
   *  `mail_client`, so a second experimental flag would gate the same thing twice
   *  — and `experimental()` additionally means "on in debug", which would put a
   *  third header button in every developer's window unasked. */
  todo_board?: boolean;
  /** Right panel: the **Alerts** group in the file viewer — urgent mail, the
   *  calendar entries about to start, and the to-do cards whose due date is here
   *  or past, merged into one time-ordered strip. **Default true.**
   *
   *  A plain setting rather than an experimental flag, for `todo_board`'s
   *  reasons: everything it shows is already on screen somewhere else, it reads
   *  the two stores that already own that data (`calendar.json`'s events and
   *  tasks, the local mail priority index) and it opens no socket of its own.
   *
   *  **This flag IS the group's visibility**, not a preference sitting above a
   *  separate shown/hidden state, and that is what makes the default safe to
   *  invert: the toolbar's 🔔 writes this key, so closing the group persists and
   *  survives a relaunch instead of coming back at the next remount — and this
   *  viewer is mounted many times over at once (the right panel, every Files
   *  tab, every subwindow's docked column, every popout), so a per-surface flag
   *  would have to be dismissed once per surface. The button is deliberately
   *  rendered whether or not the group is on: it is the way back, and gating it
   *  on the same key would make the × a one-way door.
   *
   *  Turning it off is therefore a real off — `useAlertsFeed` returns before
   *  every read, arms no timer and collapses its store selectors to frozen
   *  empties, so a hidden group costs nothing at all.
   *
   *  The mail half is additionally gated by the existing `mail_client`
   *  experimental flag, checked *before* the read (opening the mail store
   *  creates the mail database — the rule `TodoMailRail` already follows). With
   *  mail off the group is not withdrawn: it still shows calendar entries and
   *  to-dos, which are the two sources that cost nothing but a local file. */
  files_alerts?: boolean;
  /** Alerts group: how many days ahead an event/task may be to still show.
   *  Default 7 (`lib/alerts`' `DEFAULT_LOOKAHEAD_DAYS`). A short window is what
   *  keeps the strip an alert rather than an agenda. */
  files_alerts_days?: number;
  /** Alerts group: per-source opt-outs. **All default on when the group is on** —
   *  an absent key means "show it", so an existing settings file never has to be
   *  migrated to see a source, and turning the master switch on gives the
   *  complete picture rather than an empty strip that has to be configured. */
  files_alerts_sources?: { mail?: boolean; events?: boolean; tasks?: boolean };
  /** Alerts group: the `AlertItem.id`s the user muted from a row's 🔕 (newest
   *  last, bounded by `lib/alerts`' `MAX_MUTED_ALERTS`). Here rather than in the
   *  component because the file viewer is mounted many times over at once — a
   *  per-surface mute would have to be repeated once per surface — and because a
   *  mute that came back at the next launch would be a control that doesn't
   *  work. It hides a row and nothing else: the mail stays marked, the card
   *  stays due, and the group's reveal (🔕 N) is how a mute is taken back. */
  files_alerts_muted?: string[];
  /** Mail: the experimental gate for the embedded mail client (`lib/experimental`
   *  — unset means "on in debug mode", which is NOT the same as false).
   *
   *  The ONE mail switch. It turns on the header's ✉ button and the overlay
   *  behind it, which since the mail tab was retired is the whole client; the old
   *  `mail_global_app` sub-toggle is gone, because a switch that hides the only
   *  surface while leaving the feature "on" has nothing to mean. */
  mail_client?: boolean;
  /** Mail: the account the mail overlay opens on. Falls back to the first. */
  mail_default_account?: string;
  /** Mail: minutes between automatic checks. **Unset/0 = never**, which is the
   *  default and the reason the store's "nothing connects on its own" rule still
   *  holds: only an explicit opt-in here starts a timer, and only while the
   *  header's mail button is on (`MailIndicator` owns it). */
  mail_check_interval_min?: number;
  /** Mail: load remote images without asking. **Default false, and it should
   *  stay that way** — loading them tells the sender the message was opened. */
  mail_show_remote_images?: boolean;
  /** Mail: raise an OS notification for new inbox mail. Default true. */
  mail_notify_new?: boolean;
  /** Browser: the experimental gate for the in-app browser (#61). Read through
   *  `lib/experimental` — unset means "on in debug mode", NOT false. */
  web_browser?: boolean;
  /** Browser: where a fresh browser tab opens. **Empty/unset is the built-in
   *  start page, not a remote request** — a home page that fires on every new
   *  tab is an outbound request nobody asked for. */
  browser_home_url?: string;
  /** Browser: non-URL address-bar text becomes this, with `%s` replaced by the
   *  percent-encoded text. Clearable — with no template, text that is not a URL
   *  is refused rather than sent to a third party. */
  browser_search_template?: string;
  /** Browser: where clicked links open (#33). Default `"external"`, chosen
   *  deliberately — the user's real browser has their logins, their extensions
   *  and their password manager, and an experimental in-app engine should not
   *  silently start receiving their links. See `lib/linkTarget`. */
  browser_link_target?: LinkOpenTarget;
  /** Browser: a restored tab loads its page at launch instead of showing the
   *  resume card. **Default false** — restoring N tabs would otherwise be N
   *  automatic outbound requests before the user has looked at the screen. */
  browser_restore_navigate?: boolean;
  /** Browser: whether the hardened **live-page window** may be opened at all.
   *
   *  **Default false, and off in debug mode too** — deliberately not read through
   *  `useExperimental`, which would turn it on for anyone running a debug build.
   *  Reader mode needs no such switch: it runs no JavaScript and its bytes are
   *  sanitized in Rust. A live page runs the real web page, and two of its holes
   *  cannot be closed from app code — it can reach a service on this machine via
   *  any hostname that resolves to loopback, and `ws://` reaches one regardless
   *  because a WebSocket is not a navigation and has no CORS. The backend refuses
   *  `browser_open_live` without this, so the hidden control is the courtesy and
   *  not the boundary. */
  browser_live_pages?: boolean;
  /** The agent Eldrun picks on its own when a feature needs exactly one and the
   *  user hasn't chosen per-instance — an agent id/cmd from `AGENT_ITEMS`
   *  (`"claude"`, `"codex"`, …). Set from the 🧠 menu's Agents section; every
   *  reader falls back to `"claude"` when unset. */
  default_agent_cmd?: string;
  /** Built-in agent registry ids shown without searching in the compact Agents
   *  group of the + tab menu. Set by the 🧠 menu's “+ tab” chips. Unset keeps
   *  the familiar Claude/Codex/Gemini quick picks; an empty array is a deliberate
   *  choice to show agents only after searching. */
  compact_tab_agents?: string[];
  /** User-defined custom agents offered in the add-tab menu's Agents group,
   *  added/removed from the "＋ Add agent…" dialog. Round-trips through the
   *  backend settings `extra` catch-all — no Rust field needed. See CustomAgent. */
  custom_agents?: CustomAgent[];
  /** Built-in agent ids (the `cmd` in `AGENT_ITEMS`, e.g. `"codex"`) the user has
   *  turned off in "Manage Agents" despite being installed — hidden from every
   *  tab-choice menu (add-tab Agents group, Local Model drivers) without
   *  uninstalling the CLI. Round-trips through the backend settings `extra`
   *  catch-all — no Rust field needed. Unset/empty = nothing hidden. */
  disabled_agents?: string[];
  /** The default local (Ollama) model. Used by any task without its own
   *  per-task assignment in `ollama_roles`, and as the legacy "active model".
   *  Chosen in the 🧠 menu (click a loaded model's name). Unset = none. */
  ollama_model?: string;
  /** Where the Ollama server is, when it is not the default `127.0.0.1:11434` —
   *  a different port (a container publishing 11435, a second server) or, with
   *  {@link ollama_allow_remote_host}, another machine. Accepts `host:port`, a
   *  bare `host`, a bare `:port` or port, and an `http://` prefix; `https://` is
   *  **refused**, because the backend transport is plaintext HTTP/1.0 over a raw
   *  socket and downgrading a URL written as TLS would put prompts in the clear.
   *  There is no UI for it yet — it is edited in `settings.json` (group S #201a,
   *  which made it do something; it was declared and read by nothing for years).
   *  Unset = the default. */
  ollama_host?: string;
  /** Permit {@link ollama_host} to name a machine that is not this one.
   *  **Default false**, and separate from the host itself because the two are
   *  different decisions: another *port* is still local inference, another
   *  *host* means every prompt and every file an agent reads leaves this
   *  machine — the opposite of what the local-model feature is for. Judged on
   *  the literal that was typed, never on what it resolves to. */
  ollama_allow_remote_host?: boolean;
  /** Where Ollama saves the models it downloads — its `OLLAMA_MODELS`
   *  directory. Unset/empty means Ollama's own default (`~/.ollama/models`, or a
   *  system-service dir when one holds models). It reaches only a server Eldrun
   *  starts itself; a systemd-managed one is pointed at the same folder by the
   *  Settings panel's one-click drop-in (`ollama_models_dir_plan`). */
  ollama_models_path?: string | null;
  /** Per-task local-model assignments (🧠 menu role chips). Maps a task key —
   *  `"autocomplete"`, `"grammar"`, `"tabs"` or `"mail"` — to the model name that
   *  should serve it, so several loaded models can run different jobs in parallel.
   *  A task absent here falls back to `ollama_model`, then to any loaded model.
   *  `"mail"` is written by the chip and **read by nothing yet**: the mail task it
   *  names (importance scoring, summaries) is not built. It is offered ahead of
   *  its consumer because the choice is the user's — which model may see their
   *  mail — and is the kind of thing to have answered before the feature runs,
   *  not after; the chip's tooltip says nothing reads it so far. */
  ollama_roles?: Record<string, string>;
  /** The **Mail AI (local)** global master switch (Group Q, #203–#208) —
   *  "Allow Mail AI features", **default off**. The per-feature toggles now live
   *  **per account** (`MailAiPrefs` in `types/mail`); this one global flag gates
   *  them all. The AI path is loopback-only and stricter than
   *  {@link ollama_allow_remote_host}: nothing about a message ever leaves this
   *  machine. Read in the backend sync (it gates per-account autoclassify) and in
   *  the UI via `lib/mail`'s `mailAiResolvable`. */
  mail_ai_allow?: boolean;
  /** Local models to load into memory when Eldrun starts (🧠 menu "on start"
   *  chip / Ollama settings). Loading is what makes a model *usable* without a
   *  manual step, so a feature that wants one waiting — mail-importance scoring,
   *  autocomplete — finds it warm at launch. Sequential, in list order. Unset or
   *  empty = nothing is started. Round-trips through the backend's `extra`
   *  catch-all — no Rust field needed. */
  ollama_autoload_models?: string[];
  /** Whether {@link ollama_autoload_models} is honoured while Energy Saver is
   *  active. **Default false**: a resident model holds GPU/CPU memory and Ollama
   *  keeps it warm, which is exactly what Energy Saver exists to stop. When it
   *  suppresses a load the 🧠 menu says so and offers to load it anyway, rather
   *  than leaving the models silently absent. Round-trips through `extra`. */
  ollama_autoload_in_energy_saver?: boolean;
  /** Python Run/Debug arguments (#py), the raw `sys.argv` string typed into the
   *  Run button's right-click popover, keyed by the file's absolute path. Kept
   *  per file (not per tab) so every viewer of the same script shares one set of
   *  args, and here (global settings) so they survive closing the viewer and an
   *  Eldrun restart. Round-trips through the backend's `extra` catch-all — no Rust
   *  field needed. An entry set to "" means "cleared" and is pruned. */
  python_run_args?: Record<string, string>;
  /** Cached "is this a runnable script" verdicts for `.py` files (#py), keyed by
   *  absolute path — what gates the file tree's ▶ Run button. Each entry carries
   *  the `(size, mtime)` it was computed from, so an edited file is re-read and an
   *  untouched one never is, across viewer reopens and restarts alike. Persisted
   *  here precisely because the check needs the file's *content*: on a remote
   *  listing that is an SFTP round trip per file, which is why it used to be
   *  skipped there (and ▶ wrongly shown on every `.py`). Bounded and pruned by
   *  `lib/pythonMainCache`. Round-trips through the backend's `extra` catch-all —
   *  no Rust field needed. */
  python_main_scripts?: Record<string, PyMainVerdict>;
  run_scripts_in_background?: boolean;
  /** Header resource-monitor row toggles. Each defaults ON (undefined → shown).
   *  Independent of `debug`; the pill is available in every build. */
  show_cpu_usage?: boolean;
  show_ram_usage?: boolean;
  show_gpu_usage?: boolean;
  /** Header clock: show seconds. Off by default (hh:mm only). */
  show_clock_seconds?: boolean;
  /** When true (the default), Claude agent tabs are spawned with `--remote-control`
   *  so the running session can be monitored/steered from the Claude app/web. Only
   *  Claude supports this flag; other agents ignore the setting. */
  agent_remote_control?: boolean;
  /** When true (the default), the usage recap opens by itself on the first launch
   *  of each day. Turning it off stops the popup, not the counting — the recap
   *  stays reachable from Settings. */
  daily_stats_recap?: boolean;
  /** UTC date ("YYYY-MM-DD") the recap was last auto-shown, so it opens once a day
   *  rather than once per window. Written by the recap host. */
  daily_stats_last_shown?: string;
  /** EXPERIMENTAL, default OFF. Shows a Plan/Auto badge on agent tabs whose agent
   *  supports an absolute mode flag AND resumes on respawn (currently Claude only —
   *  see components/tabs/agentModes.ts). Switching restarts the agent; the
   *  conversation is resumed, the terminal scrollback is not. */
  agent_mode_toggle?: boolean;
  /** EXPERIMENTAL, default OFF. Gives a Python file in the code viewer its Run/Debug
   *  buttons and the breakpoint gutter (#87). Off by default because Run *executes
   *  the file* — one click away from an editor — so it is opt-in. Go-to-definition
   *  is not gated: it reads, it never runs anything. */
  python_run_debug?: boolean;
  /** EXPERIMENTAL, default OFF. The native presenter ("deck",
   *  `docs/deck_presenter_plan.md`): editable object layers over a base PDF, kept
   *  in a `*.eldeck.json` sidecar, plus the animate mode and the fullscreen
   *  presenter. Gated because it is the largest single viewer surface in the app
   *  and still moving — it registers a viewer, a file type, and a fullscreen mode. */
  deck_presenter?: boolean;
  /** EXPERIMENTAL, default OFF. Paint terminals with xterm's WebGL renderer (GPU
   *  glyph atlas — the tier VS Code ships) instead of the canvas renderer. Opt-in
   *  because it rides the GPU/driver path the DMABUF re-test failed on for this
   *  class of machine (flicker, missing content, renderer crash —
   *  `docs/typing_latency_plan.md` Step 4); a terminal whose WebGL fails, at load
   *  or via runtime context loss, demotes itself back to canvas. */
  terminal_webgl?: boolean;
  /** Persistent LOCAL (tmux) sessions (TODO #85): when true (the default on Unix),
   *  a local project's shell/script tabs run inside a tmux session on the machine,
   *  so a long run keeps going if Eldrun crashes and the tab reattaches on restart.
   *  `undefined`/`true` = on; `false` = off. No effect on Windows (no tmux). */
  persist_local_sessions?: boolean;
  /** When true (the default), remote SSH/OpenVPN connections are made headlessly
   *  in the background (Eldrun handles the password transiently). When false, they
   *  are launched as interactive terminal tabs in the Eldrun root scope, so the
   *  password is typed directly into the live terminal and Eldrun never handles
   *  it. Default ON (headless) preserves existing behaviour. */
  connections_headless?: boolean;
  /** Hosts marked **careful** — "this machine is shared and policed, keep
   *  Eldrun's background load off it" — keyed by canonical SSH target
   *  (`lib/machineSync`'s `targetKey`, i.e. `user@host:port`), because one login
   *  node is simultaneously a primary `remote`, a worker and a global machine.
   *  The value is the user's EXPLICIT answer; a target absent from the map is
   *  **careful** — the default for every remote machine — which is why this is a
   *  map and not a list: an explicit `false` ("this one is mine") must be
   *  distinguishable from an unanswered host, or the default would keep
   *  re-enabling itself. See `lib/carefulHost.ts`. */
  careful_hosts?: Record<string, boolean>;
  /** Machines tagged **HPC** — a shared cluster login node — keyed by the same
   *  SSH target as `careful_hosts`. Ticked on the login form and shown as a badge
   *  on the machine's row in the Machines menu. Where `careful_hosts` governs how
   *  much Eldrun *looks at*, this governs what it *does*: a tagged host is careful
   *  regardless, and its disk-usage scan, giant-folder census, background sync +
   *  lockstep loops, silent auto-connect and unannounced login-node compute are
   *  all gated behind it. See `lib/hpcHost.ts`. */
  hpc_hosts?: Record<string, boolean>;
  /** Path of the stored `.ovpn` config brought up automatically **on launch** —
   *  armed from the header's VPN menu, with no project behind it. Unset/null = no
   *  tunnel starts by itself. Only one config can be armed: a tunnel reroutes the
   *  whole machine, so two would fight over the routing. */
  vpn_auto_connect?: string | null;
  /** The `.ovpn` configs the user asked Eldrun to remember the credentials of.
   *  No secret here — those live in the OS keychain; this is the *intent*, kept
   *  because a locked keychain answers every read like an empty one, so the
   *  toggle and the connect path would otherwise read "nothing saved" over a
   *  perfectly good saved credential (see `lib/keyring.ts`). */
  vpn_saved_configs?: string[];
  /** When true, the header's OpenVPN indicator is shown. Default OFF — most
   *  projects are local-only, so the machine-wide tunnel control stays hidden
   *  until asked for (the first-run `RemoteFeaturesPrompt`, or Settings). */
  vpn_enabled?: boolean;
  /** When true, the header's global-machines indicator is shown. Default OFF,
   *  same reasoning as `vpn_enabled`. */
  machines_enabled?: boolean;
  /** True once the first-run "Using VPN or remote machines?" prompt has been
   *  shown/answered, so it never re-asks automatically. */
  remote_features_prompted?: boolean;
  /** Energy-saver mode. "off" never throttles; "battery" (the default) throttles
   *  only while running on battery; "always" throttles regardless of power. When
   *  active, Eldrun pauses the blob auto-spin, collapses idle animations, and
   *  widens always-on UI timers to reduce CPU/battery drain. */
  energy_saver?: "off" | "battery" | "always";
  /** Fast mode: drop the display aids that cost a directory walk, a standing
   *  poll or a per-file read. **Default false.** Read through `lib/fastMode`
   *  (`useFastMode` / `fastModeActive`), which is also where the exact list of
   *  what it withdraws lives — never off this key directly, so the list has one
   *  home and every surface withdraws the same things.
   *
   *  A separate switch from `energy_saver` rather than a fourth value of it:
   *  energy saver widens timers off a *battery reading*, this removes features
   *  off a *standing preference*, and one merged control could not say "plugged
   *  in, still want it lean" — which is the case that asks for this. */
  fast_mode?: boolean;
  /** When true, the right panel is docked open (reflows layout) instead of hover-revealed. */
  right_panel_pinned?: boolean;
  /** Width of the right (file/git) panel in px. Set by dragging the panel's left
   *  border; unset falls back to the default 280px. */
  right_panel_width?: number;
  /** Which edge the file panel docks against. Unset falls back to "right". Flipped
   *  by the ⇄ button in the panel header; round-trips through the settings `extra`
   *  catch-all, so no backend field is needed. */
  right_panel_side?: "left" | "right";
  /** Minimum subwindow (split pane) width in px a divider drag may shrink to.
   *  Unset falls back to DEFAULT_MIN_SUBWINDOW_PX. */
  min_subwindow_width?: number;
  /** Minimum subwindow (split pane) height in px a divider drag may shrink to.
   *  Unset falls back to DEFAULT_MIN_SUBWINDOW_PX. */
  min_subwindow_height?: number;
  /** When true, in-app editors debounce-save edits automatically (#47). Default OFF. */
  autosave?: boolean;
  /** When true (the default), the text/TeX editors tint recently typed runs with a
   *  sequential new→old colour trail that fades as you keep typing. Default ON;
   *  only an explicit `false` disables it. */
  change_tint?: boolean;
  /** Per-type native-viewer prefs (#48): opt-in local autocomplete (#45). */
  viewer_prefs?: Record<string, ViewerPref>;
  global_apps?: Record<string, GlobalAppEntry>;
  /**
   * User overrides for the rebindable navigation chords (Group L / #62), keyed
   * by `ShortcutAction` id (see `src/lib/shortcuts.ts`). Any action absent here
   * falls back to its built-in default; an empty/missing map preserves the
   * original hard-coded behaviour.
   */
  keyboard_shortcuts?: Record<string, KeyboardChord>;
  /** Download *source* folders scanned by the right-panel Downloads section
   *  (fast-copy of freshly downloaded files into a project). Machine-wide,
   *  read-only. Unset/empty → the frontend falls back to the OS Downloads dir. */
  download_sources?: string[];
  /** True once the first-run "How to start" welcome has been shown/dismissed, so
   *  it never re-opens automatically. Re-openable manually from Settings. */
  onboarding_seen?: boolean;
  /** Ids of contextual hints (see `src/lib/hints.ts`) the user has seen/dismissed
   *  or implicitly acted on, so each surfaces at most once. */
  hints_seen?: string[];
  /** Master switch for the contextual hint system; default ON when unset. */
  hints_enabled?: boolean;
  /** True once the guided "Take a tour" walkthrough has been completed or
   *  skipped. Cosmetic only (never auto-launches the tour); the tour is always
   *  replayable from the gear menu / Settings. */
  tour_completed?: boolean;
  /** Where the main window was when Eldrun last ran, so it reopens on the same
   *  monitor in the same place. Written by the debounced save in `AppShell`;
   *  consumed by the backend at startup, never rendered. */
  window_state?: WindowState;
  [key: string]: unknown;
}

/**
 * The main window's geometry in PHYSICAL desktop px — the canonical cross-window
 * space (`src/lib/coords.ts`), which is also what `outerPosition`/`outerSize`
 * report and what `setPosition`/`setSize` consume.
 *
 * `x`/`y`/`w`/`h` is the *restore* (non-maximized) rect: while the window is
 * maximized the rect is left alone and only `maximized` flips, so un-maximizing
 * after a restart lands on a real geometry instead of the full monitor.
 *
 * Mirrors `WindowState` in `src-tauri/src/schema/settings.rs`.
 */
export interface WindowState {
  x: number;
  y: number;
  w: number;
  h: number;
  maximized: boolean;
}

export interface OpenVpnSpec {
  /** Absolute path to the local `.ovpn` client config file. */
  config: string;
  /** Auth username for `auth-user-pass` configs (server-side username+password
   *  auth). Persisted (not a secret); the password is still prompted separately. */
  username?: string;
}

/** Verdict of `ssh_probe`: a silent, keychain-read-only reachability + auth check.
 *  `unreachable` distinguishes "this network can't reach the host" from "the host
 *  rejected the credential" — only the former warrants bringing a VPN tunnel up. */
export interface SshProbe {
  ok: boolean;
  unreachable: boolean;
  error: string;
}

/** A previously-used `.ovpn` config copied into Eldrun's store, offered for
 *  reuse so a config need only be browsed for once. */
export interface StoredVpnConfig {
  /** Absolute path to the stored copy (passed to `openvpn_connect`). */
  path: string;
  /** Friendly display name (the original `.ovpn` file name). */
  name: string;
}

/** A globally connected worker machine (`stores/globalMachines.ts`):
 *  authenticated once via the ordinary login mechanism, with no
 *  `remote_path` — project-free, unlike {@link ComputeHost}. Drag-and-dropped
 *  onto an SSH project to become a `shared_fs` compute host there (a value
 *  copy of this identity, not a reference). */
export interface GlobalMachine {
  id: string;
  user?: string;
  host: string;
  port?: number;
  label?: string;
  /** Opt-in to a silent connect on launch and whenever a VPN tunnel comes up
   *  (the machine-wide twin of a project's `RemoteSpec.auto_connect`). */
  auto_connect?: boolean;
}

/** One machine as it crosses the import/export boundary
 *  (`commands::global_machines::MachineIo`): the connection address + label
 *  only. An exported file carries no `user` and never a password — import
 *  supplies one shared username + password for the whole batch. `user` is an
 *  accepted field on a hand-authored file, so it is optional here. */
export interface MachineImportEntry {
  host: string;
  port?: number;
  label?: string;
  user?: string;
}

/** Which secrets a `.ovpn` config needs from the user (`openvpn_auth_needs`), so
 *  the UI shows exactly the fields that config will be asked for. The two are
 *  independent — a config can need both, and OpenVPN prompts for them separately,
 *  so supplying only one hangs the handshake on the other prompt. The local root
 *  password is a third secret, but polkit/`pkexec` collects that one, not Eldrun. */
export interface VpnAuthNeeds {
  /** Bare `auth-user-pass`: server-side account auth, so a username is required. */
  username: boolean;
  /** An encrypted private key, whose passphrase OpenVPN asks for separately. */
  keyPassphrase: boolean;
}

/** Whether the config's key passphrase is a *separate* field from its password.
 *  When a config has an encrypted key but no `auth-user-pass` account, the single
 *  password field already *is* the key passphrase (it goes to `--askpass`), so a
 *  second field would be asking for the same secret twice. */
export const needsSeparateKeyPassphrase = (needs: VpnAuthNeeds): boolean =>
  needs.username && needs.keyPassphrase;

/**
 * What a project remembers about its HPC **workspace** and its **home anchor**
 * (`docs/hpc_workspace_plan.md`; backend `schema::project::HpcInfo`).
 *
 * It is persisted rather than re-derived because none of it survives the
 * workspace: the tooling's recovery path (`ws_restore`) is keyed by the workspace
 * *name*, and the host tree that would have named it is exactly what expiry
 * deletes. `logs_dir` additionally rescues **Watch** on an older job — with
 * `--output` routed into the home anchor, `scontrol`'s `<WorkDir>/slurm-<id>.out`
 * fallback points at a file that never existed.
 */
export interface HpcInfo {
  workspace_id?: string;
  workspace_path?: string;
  filesystem?: string;
  anchor_dir?: string;
  /** The anchor as the `$HOME`-relative path it was created from — kept so a
   *  re-anchor (moving to another workspace) passes the rel back instead of
   *  guessing it by chopping segments off the absolute one. */
  anchor_rel?: string;
  logs_dir?: string;
}

export interface RemoteSpec {
  user?: string;
  host: string;
  port?: number;
  remote_path: string;
  /** Optional OpenVPN tunnel brought up before reaching the host. */
  openvpn?: OpenVpnSpec;
  /** Opt-in: connect this project on launch/activation instead of waiting for the
   *  user to bring it up from the pill's connection lamp. Only offered when the
   *  connect can complete with no prompt (saved SSH password, or `key_auth`), and
   *  the connect path re-checks that — it never prompts. */
  auto_connect?: boolean;
  /** Recorded by the backend, not user-set: the last successful connect to this
   *  host used no password at all (key/agent auth). A passwordless host has nothing
   *  in the keychain, so this is the only way the UI can tell it is auto-connectable. */
  key_auth?: boolean;
  /** Display name for this machine, e.g. "gpu-2"; falls back to `host`. Shown
   *  wherever a project's hosts are listed side by side (System Monitor's source
   *  picker, the pill's connection lamps, `hostsForProject`). Distinct from the
   *  *project* name — this labels the machine, not the project. */
  label?: string;
  /** Persistent remote sessions (TODO #85): run this project's remote shell/script
   *  AND remote agent tabs inside a **tmux** session on the host, so a long run (or a
   *  live agent) survives an SSH drop, a laptop sleep, or Eldrun quitting. **Default
   *  ON** — `undefined`/`true` mean enabled; only an explicit `false` (the pill's
   *  toggle) opts out. An agent tab's tmux persistence composes with its `--resume`
   *  restore (`tmux new-session -A` reattaches the live process, else runs `--resume`).
   *  See `persistSessionsEnabled`. */
  persist_sessions?: boolean;
  /** This spec reaches a **project VM** Eldrun itself booted
   *  (`docs/vm_projects_plan.md`): host is loopback and port the per-boot QEMU
   *  forward. Written by the backend at creation/boot, never user-set. What a
   *  VM-aware surface (the pill glyph, the spawn guard) dispatches on. */
  vm?: boolean;
}

/** Egress policy for a project VM (`docs/vm_projects_plan.md`): `off` = the
 *  guest reaches nothing; `proxy` (default) = only the allowlisting CONNECT
 *  proxy (agent APIs; denied CONNECTs are logged and surfaced); `open` = full
 *  NAT. The honest caveat the UI states for `proxy`: the agent can still
 *  exfiltrate *to the allowed endpoints* — the proxy narrows the channel, it
 *  cannot close it while a cloud agent runs. */
export type VmEgress = "off" | "proxy" | "open";

/** Per-project VM config (`docs/vm_projects_plan.md`) — the third trust tier:
 *  the whole project inside a locally booted QEMU/KVM VM, reached exclusively
 *  over SSH/SFTP, **no shared filesystem**. Chosen at creation (not a
 *  flip-anytime toggle); mutually exclusive with `sandbox`. */
export interface VmSpec {
  enabled: boolean;
  /** Guest memory in MiB (default 4096). */
  memory_mb?: number;
  /** Guest vCPUs (default 2). */
  cpus?: number;
  /** Overlay disk virtual size in GiB (default 32; qcow2 grows on demand). */
  disk_gb?: number;
  egress?: VmEgress;
  /** Extra allowlisted hosts for `proxy` egress (exact host or ".suffix"). */
  allow_hosts?: string[];
  /** Allow github.com (+ API/raw hosts) through the proxy. Opt-in, default
   *  off — the initial clone uses a *temporary* allow instead. */
  allow_github?: boolean;
}

/** `vm_doctor`'s verdict: can this machine boot project VMs, and if not, why
 *  (actionable, one reason per failed probe). A missing base image is not a
 *  failure — `fetch_command` is the one-click build-tab fetch. */
export interface VmDoctorReport {
  supported: boolean;
  ok: boolean;
  qemu: boolean;
  kvm: boolean;
  qemu_img: boolean;
  iso_tool?: string;
  disk_free_gb?: number;
  base_image_ready: boolean;
  baked_image_ready: boolean;
  reasons: string[];
  fetch_command?: string;
  bake_command?: string;
}

/** `vm_status`'s answer — what the pill glyph + VM settings render from. */
export interface VmStatus {
  configured: boolean;
  running: boolean;
  ssh_port?: number;
  egress?: VmEgress;
  blocked: VmBlockedReport;
}

/** Denied CONNECTs through the VM egress proxy — the exfiltration tripwire. */
export interface VmBlockedReport {
  total: number;
  recent: { target: string; at_secs: number }[];
}

/** An extra SSH "worker" machine a project runs experiments on
 *  (`docs/multi_host_remote_plan.md`). Its code is kept one-way in sync from the
 *  canonical source (the primary's local mirror) and its files are read-only —
 *  edits are forbidden, so there is no divergence and no destructive local-loss.
 *  The primary remote (`ProjectEntry.remote`) is unchanged. Extends `RemoteSpec`
 *  (flattened on the backend), so it carries the same user/host/port/remote_path/
 *  openvpn/auto_connect fields. */
export interface ComputeHost extends RemoteSpec {
  /** Stable id (e.g. "h1"); referenced by tab locations, the pool key, and the
   *  fan-out state. The primary is the implicit id `"primary"`. */
  id: string;
  /** Keep this worker's tracked tree synced to the source HEAD (default true). */
  sync_code?: boolean;
  /** Pull this worker's experiment OUTPUTS back only on demand (default false —
   *  outputs stay on the worker). */
  pull_outputs?: boolean;
  /** This machine reaches the project over a **shared filesystem**: it already
   *  sees the primary's project folder at `remote_path`, so Eldrun copies no code
   *  to it and never runs git on it — shells just `cd` into the shared tree and
   *  run there. The default for a newly added machine (untick "Sync a copy" for
   *  the synced-copy worker instead). Schema default false for back-compat. */
  shared_fs?: boolean;
}

/** Per-project container config (TODO #38). When `enabled`, every terminal and
 *  agent tab of the project execs into ONE session-lived Docker container that
 *  mounts only the project directory (plus minimal agent auth/state paths) at
 *  its identical host path. Absent = run on host. The hardening fields below
 *  are optional overrides; unset means the built-in default (see
 *  `services::sandbox` in the backend). */
/** Which of a project's tabs the container applies to.
 *
 *  `all` is the strict reading and the default (an older spec with no `scope`
 *  key deserializes to it, so no project loses containment on upgrade).
 *  `agents` contains agent tabs only and leaves shells, scripts and the viewer's
 *  Run/Debug tabs on the host — which is what makes a host toolchain (a `.venv`
 *  whose interpreter is a host symlink, conda, pyenv) usable without switching
 *  the container off. Classification is by the command that actually executes;
 *  see `services::sandbox::is_agent_cmd`. */
export type SandboxScope = "all" | "agents";

export interface SandboxSpec {
  enabled: boolean;
  /** Which tabs the container applies to. Unset = `"all"`. */
  scope?: SandboxScope;
  image?: string;
  /** In-repo Dockerfile (relative to the project dir); when set, the container
   *  is built from it (`eldrun-<id>:latest`) instead of pulling `image`. */
  dockerfile?: string;
  /** `--pids-limit` (fork-bomb guard). Unset = generous built-in default. */
  pids_limit?: number;
  /** Hard memory cap, e.g. "4g" (`--memory`). Unset = unlimited. */
  memory?: string;
  /** CPU cap, e.g. "2" (`--cpus`). Unset = unlimited. */
  cpus?: string;
  /** Docker network, e.g. "none" for no egress (`--network`). Unset = bridge. */
  network?: string;
  /** Read-only root filesystem (`--read-only` + tmpfs /tmp). Default false. */
  readonly_rootfs?: boolean;
  /** Hash of the in-repo Dockerfile/devcontainer image last confirmed (O#143);
   *  opaque to the frontend beyond echoing it back in a `SandboxSourceDecision`. */
  spec_source_hash?: string;
}

/** What an in-repo Dockerfile/devcontainer declares (O#143) — detection only,
 *  reported by `set_project_sandbox`'s `needs_confirmation` outcome. */
export interface DetectedSpecSource {
  kind: "dockerfile" | "devcontainer_image";
  /** The Dockerfile path (relative) or the devcontainer `image` string. */
  value: string;
  /** SHA-256 hex of the deciding content — echo back verbatim in the decision. */
  hash: string;
}

/** The answer to a `needs_confirmation` outcome: `hash` must be the detected
 *  source's `hash` verbatim (a mismatched hash is refused, not applied). */
export interface SandboxSourceDecision {
  hash: string;
  adopt: boolean;
}

export type SandboxToggleOutcome =
  | { outcome: "applied"; spec: SandboxSpec }
  | { outcome: "needs_confirmation"; source: DetectedSpecSource };

export interface RemoteEntry {
  name: string;
  is_dir: boolean;
}

/** Availability of the remote-project capabilities that depend on the platform.
 * Remote projects are SSH/SFTP-native (no FUSE mount), so only password auth and
 * VPN-gated (`openvpn`) hosts need anything beyond a stock `ssh`. */
export interface SshTooling {
  /** Whether non-interactive password auth works without installing anything.
   * Always true on Unix (OpenSSH's `SSH_ASKPASS`); on Windows it needs either
   * OpenSSH ≥ 8.4 (same askpass mechanism) or `sshpass` as the legacy fallback. */
  password_auth: boolean;
  /** `openvpn` + `pkexec` — required only for VPN-gated hosts. */
  openvpn: boolean;
  /** `rsync` on the local machine — enables the SSH-sync bulk fast-path. */
  rsync: boolean;
}

export interface ProjectEntry {
  id: string;
  name: string;
  /** "current" | "active" | "inactive" */
  status: string;
  position: number;
  local_file: string;
  directory?: string;
  description?: string;
  remote?: RemoteSpec;
  /** Extra "worker" machines this project runs experiments on
   *  (`docs/multi_host_remote_plan.md`). One-way, read-only; the primary is
   *  `remote`. Mirrored from project.json into the pill list. */
  compute_hosts?: ComputeHost[];
  /** Docker sandbox config; when `enabled`, agent tabs run in a container. */
  sandbox?: SandboxSpec;
  /** Project-VM config (`docs/vm_projects_plan.md`): present iff this project
   *  lives inside a locally booted VM (its `remote` then points at the VM's
   *  forwarded loopback port). Mutually exclusive with `sandbox`. */
  vm?: VmSpec;
  /** The interpreter the code viewer's Run/Debug buttons use (#87). Absent =
   *  auto-detect, which is right for almost every project; pinning it is for the
   *  environments auto-detect cannot see (a conda env, a Poetry venv outside the
   *  tree, a second venv). Set from the pill's "Python interpreter…" dialog. */
  python_interpreter?: string;
  /** Per-project override of the global "Claude remote control" setting
   *  (O#59). `true`/`false` force it on/off for this project's Claude agent
   *  tabs; absent inherits the global setting (`settings.agent_remote_control`,
   *  default ON). Set from the pill's "Remote control" menu item. */
  remote_control?: boolean;
  /** Which machine shells launched from this project run on — the persisted
   *  `RunHostPicker` choice (a `TabLocation`: "local" | "remote" | "host:<id>").
   *  Seeds the live `useRunHostPrefStore` on load so the choice survives a
   *  relaunch. Mirrored from project.json's `run_host` into the entry's flattened
   *  `extra`. Absent = the shell default (the primary). */
  run_host?: string;
  /** The HPC workspace this project's tree lives in + its home anchor
   *  (`docs/hpc_workspace_plan.md`). Mirrored from project.json's `hpc`. Absent
   *  for every project that isn't in a workspace. */
  hpc?: HpcInfo;
  /** Per-project git-hosting profile URL that overrides the global one. Mirrored
   *  from project.json into the pill list; the matching token lives in the OS
   *  keyring, never here. See `GitHostingInfo`. */
  git_profile_url?: string;
  /** Hosting provider this project was published to, recorded at publish time.
   *  Absent until published to a remote. */
  git_provider?: GitProvider;
  /** Provider sniffed from the local `origin` host at load time (host-only, no
   *  network). Decorates the pill badge for repos pushed to a host outside
   *  Eldrun's Publish flow. Transient — never persisted to projects.json. */
  detected_provider?: GitProvider;
  /** Raw `origin` remote URL sniffed alongside `detected_provider`. Shown as the
   *  git address in the project hover. Transient — never persisted. */
  git_origin_url?: string;
  /** User-assigned category tags. Group/color the project in the cloud + pills;
   *  set via the pill / blob-node right-click menu. Stored in the entry's
   *  flattened `extra` (mirrored into project.json). */
  categories?: string[];
  /** Explicit trusted-state opt-in for phone/tablet terminal access. */
  eldrun_mobile_access?: boolean;
  /** Built-in permanent workspace for disposable, strictly-contained agents. */
  eldrun_trash?: boolean;
  [key: string]: unknown;
}

/** A row in the Settings "Archived projects" list (from `list_archived_projects`).
 *  Archived projects live under `~/eldrun/archive/<id>/` until restored or
 *  permanently cleared. */
export interface ArchivedProject {
  id: string;
  name: string;
  /** ISO timestamp the project was archived (stamped at delete time). */
  archived_at: string;
  /** True for remote (SSH) projects — their host tree was never touched. */
  remote: boolean;
}

/** One local mirror branch carrying commits the host baseline lacks. */
export interface UnsyncedBranch {
  name: string;
  count: number;
}

/** Whether permanently deleting an archived remote project would discard
 * local-only mirror history. Computed offline from the archived files. */
export interface UnsyncedReport {
  /** Commits on the mirror's local branches not present on the host baseline. */
  total: number;
  branches: UnsyncedBranch[];
  /** False when there was no host baseline to compare against (the count is then
   * every local commit and should read as "could not verify"). */
  verified: boolean;
}

/** Supported git-hosting providers for publishing a project's repo. */
export type GitProvider = "github" | "gitlab";

/**
 * Which side a work-remote project publishes from. Not "where the files are":
 * the provider login (`gh auth login`, the tokens in Settings → Git Hosting) is
 * *this* machine's, and a work remote is typically a cluster login node with no
 * provider CLI and no GitHub credentials — while the lockstep mirror is a full
 * local repo holding the same commits. Hence `"local"` is the default;
 * `"remote"` is the opt-in for a host that does have its own `gh`/`glab` login.
 * Ignored for a local project, which has only one side.
 */
export type PublishFrom = "local" | "remote";

/**
 * Per-project git-hosting config as returned by `get_project_git_hosting`. The
 * token is never sent to the renderer — only whether one is stored — and the
 * global values are surfaced so the editor can show what is inherited by default.
 */
export interface GitHostingInfo {
  /** Per-project profile URL override, if set (else inherits `global_profile_url`). */
  profile_url: string | null;
  /** Whether a per-project token is stored in the keyring. */
  has_token: boolean;
  /** Global fallback profile URL (from settings), shown as the inherited default. */
  global_profile_url: string | null;
  /** Whether a global token exists to fall back on. */
  has_global_token: boolean;
}

/**
 * A directed relation between two members of a box ("a change in `source` may
 * influence `target`"). Mirrors the Rust `BoxRelation` (#41 Phase 2: stored).
 */
export interface BoxRelation {
  source: string;
  target: string;
  kind?: string;
  hint?: string;
}

/**
 * A project box — meta-project grouping (#13 + #41). Mirrors the Rust
 * `ProjectBox` (serde-synced snake_case fields), persisted in `boxes.json`.
 */
export interface ProjectBox {
  id: string;
  name: string;
  member_ids: string[];
  position: number;
  /** Absolute box-folder path; filled lazily on first open (#41 Phase 2). */
  folder?: string;
  /** Directed inter-project relations (#41 Phase 2 stored, Phase 4 surfaced). */
  relations?: BoxRelation[];
}

/**
 * The native calendar's model, mirroring `src-tauri/src/schema/calendar.rs`.
 *
 * All timestamps are **local wall-clock**: `"YYYY-MM-DDTHH:MM"` when timed,
 * `"YYYY-MM-DD"` when all-day. Ends are **exclusive** (an all-day event on the
 * 8th ends `"2026-07-09"`). See `src/lib/calendarTime.ts` for the math.
 */

/** The views a calendar tab can show. */
export type CalendarViewKind =
  | "day"
  | "week"
  | "multiweek"
  | "month"
  | "agenda"
  | "tasks";

/** One named, colored calendar in the sidebar list. */
export interface Calendar {
  id: string;
  name: string;
  /** CSS color its events render in. */
  color: string;
  /** Unchecked in the sidebar → its events drop out of every view. */
  visible: boolean;
  readonly: boolean;
  /**
   * The ICS feed URL this calendar was subscribed from (e.g. TimeTree's
   * calendar-export URL), if any — set on first "Refresh from URL" import and
   * read back to find which calendar a later refresh replaces. Rides the
   * Rust schema's `#[serde(flatten)] extra` map, so an older build reading
   * this file simply doesn't recognize the key rather than failing to parse.
   * Absent for a calendar imported from a local file or created by hand.
   */
  source_url?: string;
  /**
   * The `CalDavAccount.id` this calendar is synced from, and the collection's
   * own URL on that account. Both ride the Rust schema's `extra` flatten, the
   * same way `source_url` does.
   *
   * Deliberately **only the pointer**: the login, the sync cursors and the
   * keychain reference live in `caldav/accounts.json`, not here — this file is
   * read by every calendar tab on mount and exported alongside a calendar, and
   * account plumbing has no business in either (`docs/caldav_plan.md`).
   */
  caldav_account_id?: string;
  caldav_href?: string;
}

/** How often a recurring event repeats. */
export type Freq = "daily" | "weekly" | "monthly" | "yearly";

/** A recurrence rule. `until` and `count` are mutually exclusive ends. */
export interface Rrule {
  freq: Freq;
  /** Repeat every N periods. */
  interval: number;
  /** Weekly only: weekdays to fire on, `0` = Sunday … `6` = Saturday. */
  byweekday?: number[];
  /** Monthly only: day of month (1-31). Absent → the event's own day. */
  bymonthday?: number | null;
  /** Inclusive last date (`"YYYY-MM-DD"`) the rule may fire on. */
  until?: string | null;
  /** Total occurrences, counting the first. */
  count?: number | null;
}

/** A single occurrence edited away from its master ("this event only"). */
export interface EventOverride {
  /** The occurrence's start as the rule generated it — the key. */
  occurrence_start: string;
  start?: string | null;
  end?: string | null;
  title?: string | null;
  location?: string | null;
  notes?: string | null;
}

/** A reminder, fired `minutes_before` the occurrence starts. */
export interface Alarm {
  minutes_before: number;
}

/** `"confirmed"` (default) | `"tentative"` | `"cancelled"`. */
export type EventStatus = "confirmed" | "tentative" | "cancelled";

/** A calendar event. `end` is exclusive. */
export interface CalendarEvent {
  id: string;
  calendar_id: string;
  start: string;
  end: string;
  all_day: boolean;
  title: string;
  location?: string;
  notes?: string;
  /** The video call's join URL (`http(s)` only). Its own field rather than a
   *  convention on `location`, because a Join button must not be a guess about
   *  what a room name means — see `lib/conference.ts`, which still *derives* one
   *  from `location`/`notes` for the imported invitations that carry it there. */
  conference?: string;
  category?: string;
  status?: EventStatus | "";
  rrule?: Rrule | null;
  /** Occurrence starts deleted from the series. */
  exdates?: string[];
  overrides?: EventOverride[];
  alarms?: Alarm[];
  /** The CalDAV resource this row was synced from, and its ETag. Present only
   *  on rows a CalDAV sync created; they are what the reconciliation matches on,
   *  so nothing else may write them. */
  caldav_href?: string;
  caldav_etag?: string;
  /** The iCalendar `UID` this row arrived with — the calendar object's identity
   *  everywhere outside this app. Empty for a row written here, which serializes
   *  under a stable synthetic uid instead (`lib/ics.ts`'s `icsUid`). Never
   *  displayed; it exists so a row can go *back* to the server as the object it
   *  came from rather than as a second copy of it. */
  uid?: string;
  /** Set on a row that **is** a single-occurrence override of a repeating series
   *  — the rule-generated slot it replaces (`RECURRENCE-ID`). CalDAV has no
   *  separate occurrence object, so master and overrides arrive as separate rows
   *  sharing one `caldav_href`, and this is what says which is which. An event
   *  authored here keeps its occurrence edits in `overrides` instead; the
   *  serializer writes both shapes the same way. */
  recurrence_id?: string;
}

/** One checklist item inside a task. */
export interface Subtask {
  id: string;
  title: string;
  done: boolean;
}

/** The mail a card was converted from — identifiers plus a snapshot taken at
 *  conversion, never a path. `message_id` is the `MailHeader.id` store key that
 *  `mail_body`/`mail_flag`/`mail_priority_set` take. The subject/from are frozen
 *  so the card still reads after the message is deleted from the server. */
export interface TaskMailLink {
  message_id: string;
  account_id?: string;
  folder_id?: string;
  subject?: string;
  from?: string;
  priority_at_convert?: string;
}

/** The appointment a card was converted from — `TaskMailLink`'s twin, built the
 *  same way and for the same reasons: identifiers plus a snapshot frozen at
 *  conversion, so the card still reads after the event is deleted.
 *
 *  It names an **occurrence**, never a series: `occurrence_start` is what makes
 *  next week's instance of a weekly meeting a card of its own rather than a
 *  duplicate of this week's. */
export interface TaskEventLink {
  event_id: string;
  /** The occurrence's local start stamp (`"YYYY-MM-DDTHH:MM"`). */
  occurrence_start?: string;
  calendar_id?: string;
  title?: string;
  location?: string;
}

/** One column of the todo board. */
export interface TaskColumn {
  id: string;
  name: string;
  position: number;
  /** **The** completion column: dropping a card here completes it. At most one
   *  column carries it; zero is legal and turns the coupling off. */
  done: boolean;
  /** An **archive**: a resting place that outranks the completion coupling, so a
   *  finished card filed here stays instead of snapping back to Done. Nothing
   *  auto-moves a card here, and an unplaced card is never filed here. */
  archived?: boolean;
  color?: string;
  /** Advisory WIP cap; `0` = none. Nothing ever refuses a move because of it. */
  limit?: number;
}

/** A to-do (VTODO) — and a card on the todo board. */
export interface CalendarTask {
  id: string;
  calendar_id: string;
  title: string;
  notes?: string;
  due?: string | null;
  start?: string | null;
  /** iCalendar priority: `0` = unset, `1` = highest … `9` = lowest. */
  priority: number;
  /** 0-100; `100` implies done. */
  percent: number;
  completed?: string | null;
  category?: string;
  alarms?: Alarm[];
  /** Board column id. Absent means "never placed" — the backend deliberately
   *  does not backfill one on read, so a card acquires it on its first move. */
  column?: string;
  /** Fractional rank within `column`, ascending. Absent = unranked (sorts last). */
  rank?: number | null;
  tags?: string[];
  subtasks?: Subtask[];
  mail?: TaskMailLink | null;
  /** The appointment this card was converted from. A card carries at most one of
   *  `mail`/`event` — both conversions build the same card, they differ only in
   *  which object they record. */
  event?: TaskEventLink | null;
  /** `ProjectEntry.id`, or absent. Never validated against `projects.json` — an
   *  unresolvable id still filters and renders as an unknown-project chip. */
  project_id?: string;
  /** Local wall-clock stamp minted at creation (`"YYYY-MM-DDTHH:MM"`). */
  created?: string;
  /** The CalDAV resource this card was synced from, and its ETag. Everything
   *  above from `column` down is Eldrun's own and is **never** overwritten by a
   *  sync — that is the whole point of matching on the href. */
  caldav_href?: string;
  caldav_etag?: string;
  /** The iCalendar `UID` this card arrived with. See `CalendarEvent.uid`: a
   *  push writes the object back under the identity it came with, never a fresh
   *  one, or the server keeps the old VTODO and files ours beside it. */
  uid?: string;
}

/** One card's target position after a drag, for `todo_move_tasks`. The backend
 *  takes an **index**, not a rank, so the rank algebra lives in one place and a
 *  replayed placement is a no-op. */
export interface TaskPlacement {
  id: string;
  column: string;
  index: number;
  /** Stamp to use if this move completes the card (the frontend owns the clock —
   *  the backend has no local-time source). */
  completed_stamp?: string | null;
}

/** The whole of `calendar.json`. */
export interface CalendarData {
  version: number;
  calendars: Calendar[];
  events: CalendarEvent[];
  tasks: CalendarTask[];
  /** The todo board's columns. **Absent until the board's first write** — a read
   *  never creates one, so a calendar-only user's file never grows board state.
   *  Until then the board renders `DEFAULT_COLUMNS` from `lib/todoBoard`. */
  task_columns?: TaskColumn[];
}

/**
 * One materialized instance of an event on the timeline. A non-recurring event
 * yields exactly one; a recurring one yields many, all sharing `eventId`.
 * `occurrenceStart` is the start the *rule* generated — the stable key used for
 * exdates and overrides, which survives the occurrence being moved.
 */
export interface Occurrence {
  eventId: string;
  occurrenceStart: string;
  start: string;
  end: string;
  allDay: boolean;
  title: string;
  location: string;
  notes: string;
  /** The master's join URL, carried onto every occurrence so a list of
   *  occurrences can offer Join without going back to the event. */
  conference: string;
  category: string;
  status: EventStatus | "";
  calendarId: string;
  /** True when it came from a recurring master (so the UI can offer this/all). */
  recurring: boolean;
  alarms: Alarm[];
}

/**
 * Sanitize a box name into a folder segment. Mirrors the backend
 * `commands::projects::sanitize_name` so the frontend can preview the box-folder
 * path consistently.
 */
export function boxFolderName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function resolveProjectDirectory(project: ProjectEntry | null | undefined): string {
  if (!project) return "";
  if (project.directory) return project.directory;
  const match = /^(.*)[/\\]project\.json$/i.exec(project.local_file);
  return match?.[1] ?? "";
}

/**
 * Format a remote project's location as `user@host:remote_path` (the `user@`
 * prefix is dropped when no user is set). Port is intentionally omitted — this
 * is an at-a-glance display string, and `host:port:path` would be ambiguous.
 */
export function formatRemoteTarget(remote: RemoteSpec): string {
  return `${remote.user ? `${remote.user}@` : ""}${remote.host}:${remote.remote_path}`;
}

/**
 * The paired local working-copy ("mirror") path for a remote project, read from
 * the flattened `extra["mirror"]` field mirrored onto the entry. Returns null
 * when unset (legacy remote projects created before the mirror was persisted).
 */
export function resolveLocalMirror(project: ProjectEntry | null | undefined): string | null {
  const mirror = project?.mirror;
  return typeof mirror === "string" && mirror.trim() ? mirror : null;
}

export type Theme =
  | "fancy_dark"
  | "dark"
  | "light"
  | "fancy_light"
  | "light_lavender";

export const THEMES: { value: Theme; label: string }[] = [
  { value: "fancy_dark", label: "Fancy Dark" },
  { value: "dark", label: "Plain Dark" },
  { value: "light", label: "Plain Light" },
  { value: "fancy_light", label: "Fancy Light" },
  { value: "light_lavender", label: "Light Lavender" },
];
