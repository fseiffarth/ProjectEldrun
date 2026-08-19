# Typing Latency Under CPU Load — Investigation & Plan

> ## Where this stands (2026-08-05, end of the GPU evaluation)
>
> **Shipped and staying.** The PTY batcher fix (Step 2 — no idle wakeups, echo
> latency untouched) and blur-quiescence (Step 3 — unfocused windows throttle
> their timers and pause all animations). Both arm on the next normal launch.
>
> **Closed: GPU compositing, in both configurations.** Plain DMABUF (flicker,
> silently missing PDF images, renderer crash) and CPU-paint + GPU-composite
> (`WEBKIT_SKIA_ENABLE_CPU_RENDERING=1`, same artifacts). The compositor itself
> is broken on WebKitGTK 2.52.3 + Mesa 26.0.3 on this GPU. Worth **one** retry
> after a future driver/WebKit upgrade, nothing before that. Details and the
> "does this apply to other GPUs?" question: **Step 4** below.
>
> **Still open — the actual payoff measurement.** Run the bench load in a plain
> session and type. Say when the load is up and the renderer's run-vs-runqueue-
> wait and context-switch numbers get read off `/proc` and compared against this
> plan's baseline (61% starved, 647 switches/sec at rest) to see what Steps 2–3
> bought. Also still open, and possibly larger than everything else here:
> **Step 1**, the release-build comparison — see "Is it just the dev build?".
>
> **Mitigation for heavy days, regardless of any of the above.** Launch the
> bench jobs under `systemd-run --user --slice=batch.slice`, or `renice +10`
> them, so Eldrun is not scheduled one-for-one against them (Step 0).
>
> **2026-08-07 — Step 0 validated live, and visible-only streaming shipped.**
> Under a real load 43 (24 Monte-Carlo workers + pytest at nice 0), the
> renderer measured 57% runqueue-wait; `renice +10` on the jobs cut it to 24%
> and `chrt -i -p 0` (SCHED_IDLE) to ~12%, with typing restored — the model
> above holds end-to-end. And item 2 gained its biggest missing piece: a
> hidden pane's PTY now stops emitting output over IPC entirely
> (backend-gated in `terminal/mod.rs`'s routing block; throttled
> `terminal-activity` digests keep the pills honest, `terminal-replay` drains
> the Rust-side buffer on show). Until then every hidden agent tab's stream
> still woke the GTK main thread and a JS listener per chunk — with ~50
> streaming agents, a large share of the renderer's measured 29%-of-a-core
> at rest. Backend change: arms on the next restart.

Where the shipped fixes live: Step 2 is `batch_output` in
`src-tauri/src/terminal/mod.rs`, which parks on `recv()` when idle (zero
timers; leading-edge flush preserved, unit-tested under a paused tokio clock —
backend change, needs a restart to arm). Step 3 is `useQuiesce` in
`src/stores/power.ts`, wired into every `saverInterval` site and the
`data-energy-saver` root attribute in AppShell/DetachedApp, plus the
`[data-blurred]` rule in themes.css that pauses every CSS animation wholesale.

> **History: investigated 2026-08-04, reanalyzed against develop 2026-08-05.** The reanalysis confirmed items 1 and 3 unchanged in the code,
> corrected the Step 2 fix sketch (the original would have regressed typing echo),
> repointed Step 3 at the mechanism that actually exists (`saverInterval`, not
> `PaneVisibleContext`), and dropped the old Step 5 as pointless — the batch window
> does not delay keystroke echo in the first place. The measurements below
> were taken against a live dev session (`target/debug/eldrun` pid 2342867, renderer
> pid 2345241) while the machine carried a real load — 24 × `bench_mc.py` at ~83%
> each, load average 71 on 24 cores. Every number in the "Measurements" section was
> read off `/proc`; the per-keystroke *attribution* in "Contributors" is inferred
> from the idle profile, not measured, because the investigation could not type into
> the window. See **Open question** at the end for what would settle it.

Symptom, as reported: under heavy CPU load, typing in Eldrun is very slow, while
other applications on the same machine stay responsive.

## Root cause

**Eldrun is never idle, so the scheduler stops treating it as interactive.**

Other apps sleep between keystrokes. When a key arrives they wake, do a fraction of
a millisecond of work, and finish inside a single timeslice — so they never pay a
requeue penalty at all. Eldrun's renderer thread has a permanent backlog of work, so
it is continuously runnable, and EEVDF schedules it like a batch job: it is round-
robined against the CPU hogs. A keystroke then needs *many* slices, and pays a full
runqueue wait at every slice boundary.

The scheduler is behaving correctly. The problem is that Eldrun asks it for far more
CPU per keystroke than a text field has any right to need, and never sleeps long
enough to earn the low-latency treatment that would hide it.

## Measurements

Renderer (WebKitWebProcess, pid 2345241), 20 s sample under the load above:

| | value |
|---|---|
| run vs runqueue wait | 1540 ms run / **2431 ms waiting** → 61% starved |
| run per slice / wait per slice | 0.76 ms / 1.20 ms → **work stretched ~2.6×** |
| context switches (10 s) | 116 voluntary sleeps vs **1164 involuntary preemptions** (91%) |
| lifetime CPU | 8508 s over a 9.5 h session = **25% of a core, continuously, while idle** |
| thread concentration | **852 128 of 852 500 jiffies on a single thread** |
| RSS | 1.1 GB |

System and control:

| | value |
|---|---|
| `cpu.pressure` some avg300 (system) | **60%** |
| wake latency of a genuinely idle process, same load | **0.06 ms median**, 0.07 ms p95, 2.3 ms worst |

That control row is the entire comparison. At load 72, an idle process still gets the
CPU in 60 microseconds. An app whose keystroke handling fits in one 0.76 ms slice pays
**zero** stretch penalty. Eldrun does not fit.

Backend (pid 2342867):

| | value |
|---|---|
| threads | 83, of which **54 `tokio-rt-worker`** |
| tokio worker CPU, lifetime | **8291 s** |
| context switches at rest | **647/sec** |
| open PTY masters | **51** (40 `claude`, 96 `ssh` children) |

Scheduler grouping — measured share over 10 s:

| group | cores |
|---|---|
| autogroup-140 (eldrun + renderer + vite) | **0.10** |
| autogroup-13851 (24 bench jobs) | **14.42** |

## Contributors, in the order they were found

### 1. Software rendering, all serialized on one thread

`src-tauri/src/lib.rs:452` forces `WEBKIT_DISABLE_DMABUF_RENDERER=1` (confirmed
present in the renderer's `/proc/PID/environ`). No GPU compositing — every repaint is
CPU-rasterized. And with DMABUF off there is no threaded compositor either: **852 128
of the renderer's 852 500 jiffies sit on one thread**, so JS, layout, paint and
composite all serialize through the single thread that is 61% starved.

The GPU is idle throughout. Other apps composite on it; Eldrun does not.

This is the disable added for the Mesa SIGBUS renderer crash (see
`project_webview_freeze`), so it is load-bearing until that driver bug is confirmed
gone — it is not simply removable.

### 2. A permanent renderer backlog

Roughly 50 `setInterval`s across `src/`, plus infinite CSS animations —
`tab-glow-working`, `tab-glow-decision`, `pill-bar-working`, `conn-lamp-busy-pulse`,
`conn-lamp-busy-halo-strong`, `file-viewer-spin`, and others — repainting at 60 fps,
in software, on the thread from item 1.

The animations themselves are already written the cheap way (opacity and transform,
per the `project_webkit_paint_perf` lesson; the one `box-shadow` keyframe left is
`right-panel-drop-pulse`, which only runs during a drag). The cost is not any single
animation being expensive — it is that *something is always animating*, so the thread
never sleeps. That is precisely what forfeits the 0.06 ms fast path measured above.

One qualifier: the glows are conditional on activity (`tab-glow-working` only while
an agent is producing output, `conn-lamp-busy` only while connecting), so a quiet
session may already reach idle. The measured session had ~40 Claude PTYs, so
something was effectively always glowing — and that is also the realistic population
for this machine, which is why the item stands.

Partially built since 2026-08-04: commit `66b55da` landed the hidden-pane gating
sweep, but `PaneVisibleContext` is wired only into *viewers* (`FileViewerPane`,
`GifView`, `OdtView`, `PdfViewer`, `DeckView`). Header indicators are always
visible, so pane visibility can never gate them — see the corrected Step 3.

### 3. A backend poll storm — an outright bug

`src-tauri/src/terminal/mod.rs:476`, the per-PTY output batcher:

```rust
loop {
    let chunk = tokio::time::timeout(BATCH_INTERVAL, rx.recv()).await;
    match chunk {
        Ok(Some(data)) => batch.extend_from_slice(&data),
        Ok(None) => break,
        Err(_timeout) => {}          // falls through, re-arms, goes again
    }
    // ... should_flush is false when batch is empty
}
```

On timeout the loop simply re-arms, so **every idle terminal wakes a tokio task
62.5×/s forever, with zero output to deliver**. With 51 open PTYs that is the
explanation for 54 tokio workers, 8291 s of lifetime CPU, and 647 context switches
per second at rest. Tokio's timer wheel coalesces some of it, which is why the
measured rate is 647/s rather than ~3200/s — but the correct idle rate is zero.

This one is wrong regardless of machine load.

### 4. No scheduler grouping to fall back on

Autogroup is enabled (`kernel.sched_autogroup_enabled = 1`) and Eldrun does sit in
its own autogroup (`/autogroup-140`) — but it is **inert**. systemd has the `cpu`
controller enabled on `user.slice`, and puts *everything* — Eldrun, the bench jobs,
node, Firefox; 231 processes — into one flat `session-2.scope` at weight 100.
Autogroup only applies to tasks in the root task group, so it never engages.

Consequence: Eldrun's threads compete with the bench threads one-for-one, ungrouped.
Hence 0.10 cores vs 14.42.

This is environmental, not an Eldrun defect, but it removes the safety net that would
otherwise have hidden items 1–3.

### 5. Dev-build tax

The session under measurement was `target/debug/` — unoptimized Rust — with vite
(8:33 of CPU) and esbuild competing in the same pool, and React in dev mode. This
multiplies work-per-keystroke severalfold, and that inflated figure is then multiplied
again by the 2.6× stretch. **No conclusion about release-build behaviour should be
drawn from these numbers.**

### 6. The echo path is long — but the batch window is *not* part of it

X11 → GTK main thread → renderer → xterm `onData` → IPC → tokio → PTY write → shell
echo → PTY reader thread → batcher → `app.emit` → GTK main thread → renderer → xterm
parse → software paint. Roughly ten sequential thread hops, each landing on a thread
that waits ~1.2 ms to be scheduled.

**Correction (2026-08-05):** the original writeup counted "up to 16 ms batch window"
into this path. It does not apply to typing. The batcher flushes when
`now - last_emit >= BATCH_INTERVAL`, and after any quiet period `last_emit` is stale
— so the *first* chunk after quiet flushes on the very next loop iteration, with ~0
added delay. At normal typing speed the inter-key gap far exceeds 16 ms, so every
keystroke echo is that first-chunk-after-quiet case. The window only delays output
*mid-burst* (bulk output streaming), where latency doesn't matter. The cost of a
keystroke is the thread hops under starvation, nothing more.

## Plan

Ordered by cost-to-confidence, not by size. Steps 0–1 are diagnosis and must come
first: item 5 may account for a large fraction of the symptom, and fixing anything
else before ruling it out risks optimizing the wrong thing.

**Step 0 — environmental workaround, no code.** Confirm the diagnosis end-to-end by
removing the contention rather than the cost: `renice +10 -p $(pgrep -f <load>)`, or
launch heavy jobs under `systemd-run --user --slice=batch.slice`, which restores the
grouping systemd currently defeats. If typing goes back to normal, the model above
holds. This is also the practical day-to-day mitigation.

**Step 1 — reproduce in a release build, and test DMABUF for free.** Same load, same
measurements, against `npm run package` output rather than `tauri dev`. This bounds
item 5 and tells us how much of the remaining plan is worth doing. Expect a materially
smaller gap.

### Is it just the dev build? Partly — and this is now the biggest unmeasured lever.

Now that GPU compositing is closed, this is the largest remaining unknown in
the document, and it is entirely untested. Every measurement in this plan was
taken against a hot-reload `tauri dev` session, which is *not* the thing that
ships. Four separate taxes stack in that configuration:

- **Rust unoptimized.** `target/debug/` — no inlining, no optimization,
  debug assertions on. Multiplies every backend hop in the item 6 echo path.
- **React in dev mode.** Development builds of React do extra bookkeeping on
  every render and ship the unminified reconciler; StrictMode double-invokes
  render bodies and effects.
- **Vite serving unbundled ES modules.** The renderer parses hundreds of
  separate module requests instead of one bundle, and keeps HMR client
  machinery live in the page.
- **Vite + esbuild competing for the same CPU.** Measured at 8:33 of CPU in the
  baseline session — competing in the very pool that is already starved.

None of that exists in a packaged build. So the honest read: **some fraction of
the observed slowness is measurement apparatus, and nobody knows which
fraction.** The dev-build tax is multiplied by the 2.6× scheduling stretch, so
it is not a small correction — it could plausibly be most of the gap.

This does not invalidate the fixes already made — the PTY poll storm (item 3)
was a real bug in shipped code at any optimization level, and the renderer
never reaching idle (item 2) is a property of the app, not of the build. But it
does mean **no number in the Measurements section should be quoted as
release-build behaviour**, and the payoff measurement is worth running twice:
once in a dev session (comparable to the baseline) and once against
`npm run package` output (comparable to what users get).

While here, the item 1 experiment costs nothing: `lib.rs:452` only sets
`WEBKIT_DISABLE_DMABUF_RENDERER` when the variable is *absent*, so one launch with
`WEBKIT_DISABLE_DMABUF_RENDERER=0` in the environment re-enables GPU compositing with
zero code change. Two things fall out of a session run that way: whether the Mesa
SIGBUS from `project_webview_freeze` still reproduces, and how much of the latency the
threaded compositor buys back. There is no reason to leave the biggest lever
unmeasured until the end of the plan.

**Step 2 — fix the PTY poll storm (item 3). ✅ Implemented 2026-08-05** (as
`batch_output`, unit-tested; needs a backend restart to arm). Independent of everything else, and
worth doing on its own merits. Park on `rx.recv()` when the batch is empty — but
**preserve the leading-edge flush** the current code has. (An earlier version of this
step said "first chunk arrives → start the batch window → flush on expiry"; that
would add up to 16 ms to every keystroke echo, regressing exactly the path this plan
protects — see the item 6 correction.) The correct shape:

- batch empty → park on `rx.recv()`, no timer, zero wakeups
- chunk arrives with `last_emit` ≥ `BATCH_INTERVAL` ago → emit immediately
  (this is the keystroke-echo case; it keeps its ~0 ms flush)
- chunk arrives inside the window → arm a timeout for the *remainder* of the
  window; flush on expiry or at `BATCH_MAX_BYTES`, then park again

Unit-testable via the existing terminal tests; the observables are `647 → ~0` context
switches per second at rest with N idle tabs, *and* first-echo-after-quiet latency not
getting worse. Backend change, so it will not appear in a running window until the
user restarts (`npm run backend:stale`).

**Step 3 — quiesce the renderer when nothing is happening (item 2). ✅ Implemented
2026-08-05** (blur-engaged: `useQuiesce`/`startFocusTracking` in `stores/power.ts`
widen every `saverInterval` timer and collapse the glows while the window is
unfocused, and `[data-blurred]` pauses all animations wholesale; a *focused*
window's glows still run — CPU-pressure auto-engage remains open). The goal is not
to make any one animation cheaper but to let the thread reach a genuine idle state.
The original version of this step pointed at extending `PaneVisibleContext` to the
header indicator timers; that doesn't fit — header indicators are always visible, so
pane visibility can never gate them. The hooks that actually exist:

- `saverInterval()` in `src/stores/power.ts:92` — the energy-saver mode that
  stretches intervals 3×, already wired into `Clock`, `AppTimerDisplay`,
  `AppResourceDisplay`, `HeaderBar`, `LocalModelMenu`, `ProjectSwitcher`. Extend it
  to the remaining always-on timers and/or auto-engage it on window blur or CPU
  pressure, rather than inventing a new gate.
- The 14 `prefers-reduced-motion` blocks in `themes.css` already collapse the
  infinite animations — the same collapse can be applied on window blur (e.g. a
  root class toggled on focus change) without touching each animation.
- `PaneVisibleContext` stays what it is: the viewer-pane gate (already covers
  `FileViewerPane`, `GifView`, `OdtView`, `PdfViewer`, `DeckView`).

Observable: renderer lifetime CPU falls well below the measured 25%-of-a-core idle
draw, and its voluntary/involuntary context-switch ratio inverts.

**Step 4 — re-evaluate DMABUF (item 1) as a code change. ❌ Closed 2026-08-05:
the bug still reproduces.** A live session with `WEBKIT_DISABLE_DMABUF_RENDERER=0`
(WebKitGTK 2.52.3, current Mesa) confirmed the GPU path works — scrolling was
visibly faster, `gpu_busy_percent` rose 7%→46%, the renderer grew amdgpu/Skia
threads — but showed flicker and silently missing PDF images within minutes, and
the renderer then **crashed under stress** (`WEBVIEW 'main' TERMINATED
reason=Crashed`, renderer died alone, app survived). The middle path — `WEBKIT_SKIA_ENABLE_CPU_RENDERING=1` with DMABUF on (CPU
paint, GPU composite) — was tested the same day and shows the *same* artifacts,
pinning the fault on the DMABUF compositor itself rather than GPU
rasterization. The disable stays; Steps 2–3 are the win. Re-test only after a
Mesa/WebKitGTK upgrade, and treat *visual artifacts* as failure, not just the
SIGBUS: silently unrendered PDF content is a correctness hazard for a viewer
that prints and redacts. The original rationale:
re-enabling GPU compositing moves paint off the starved thread entirely and gives
WebKit its threaded compositor back. The Step 1 env-var run supplies the evidence;
this step is only the decision to flip the default in `lib.rs`, gated on the Mesa
SIGBUS being confirmed gone on the current driver. If it still reproduces, this stays
shut and steps 2–3 are what we get.

### Is the Mesa version a property of the GPU? No.

Worth stating plainly, because it decides what "wait for an upgrade" means.
`Mesa 26.0.3-1ubuntu1` is a **distro package**, not a per-GPU download. The one
package carries every driver — `radeonsi`, `iris`, `nouveau`, `zink`, `llvmpipe`
— and picks one at runtime. On this machine that is:

| | |
|---|---|
| GPU | AMD Radeon 890M (RDNA 3.5 iGPU, Ryzen AI 300) |
| Mesa driver in use | `radeonsi`, chip codename `strix1`, ACO compiler |
| Mesa version | 26.0.3-1ubuntu1 (Ubuntu's) |
| Vulkan | RADV, same package version |
| Kernel DRM | amdgpu, DRM 3.64, kernel 7.0.0-28 |

So: the **version** comes from Ubuntu, and moves when Ubuntu moves (or via a
PPA such as `kisak-mesa`); the **code path** that is misbehaving is
GPU-specific — `radeonsi` on Strix. Changing GPUs would change the code path;
it would not change the version number. An upgrade retry means a newer Mesa
package and/or a newer WebKitGTK, not new hardware.

### Does GPU compositing work on other GPUs? Very likely yes — which makes the global disable a real cost.

The DMABUF renderer is WebKitGTK's *default* on Linux and has been since 2.42.
It is what mainstream Intel and AMD desktop stacks run every day; it is not a
niche path that happens to be broken everywhere. WebKit itself carries
driver-specific fallbacks for the stacks known to mishandle it (the NVIDIA
proprietary driver being the notorious one). The failure profile seen here —
recent silicon (RDNA 3.5, released well after the compositor was written) on a
recent Mesa, with buffer-sharing artifacts rather than outright non-function —
is the shape of a driver/generation-specific bug, not a universal one.

The consequence is a product decision this plan has been ducking:
`src-tauri/src/lib.rs:452` sets `WEBKIT_DISABLE_DMABUF_RENDERER=1`
**unconditionally on every Linux machine**. Every user on a GPU where the
compositor is fine is therefore paying for software rendering — the single
biggest item in this document (item 1) — because of one iGPU's driver bug. The
env-var escape hatch exists (the code only sets the variable when absent), but
it is undiscoverable.

Options, in ascending cost, none of them done:

1. **Leave it.** Safe by construction; wrong for everyone else. Current state.
2. **Expose it as a setting** — a "GPU compositing (experimental)" toggle that
   sets the variable before webview creation, defaulting off. Cheap, honest
   about the risk, and gives the retry-after-upgrade path a UI instead of a
   shell incantation.
3. **Narrow the disable to the affected stack** — apply it only for `radeonsi`
   on the affected chip generations, read from the DRM device. More correct,
   but it means maintaining a driver blocklist with a sample size of one
   machine, and getting it wrong silently reintroduces the crash.

Option 2 is the recommendation if this is ever picked up; option 3 needs
failure reports from more than one GPU before its blocklist is anything but
a guess.

~~**Step 5 — shorten the echo path.**~~ **Dropped.** The premise was that
`BATCH_INTERVAL` sits in the keystroke echo path; the item 6 correction shows it does
not (leading-edge flush already gives typing ~0 ms batching delay). Shortening the
window would buy nothing for typing and only add wakeups during bulk output.

## Open question

The split of per-keystroke cost between items 1, 2 and 5 is inferred, not measured.
The dev perf monitor (`Ctrl+Alt+P`, `src/dev/`, see `project_dev_perf_monitor`) would
settle it: its stall traces and slow-commit list, captured under this same load, show
directly whether the time goes to paint or to JS. That capture needs someone typing in
the window, so it is the user's to run.

## Not addressed here

The renderer's 1.1 GB RSS is in `project_renderer_watchdog` territory. It is unrelated
to input latency, though it does add GC pressure to the same starved thread. Tracked
separately.
