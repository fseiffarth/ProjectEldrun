# Root console on the phone — plan

Status: implemented 2026-09-21, never run live. Design rationale, once
settled, lives in `docs/context/root_console.md` ("On the phone").

## Why the old rule went

`root_console.md` said "Never the phone": root agents hold rights no project
agent has, so the root scope was kept out of `mobile_control::discovery`.

The rule guarded against the wrong party. The rights in question separate a
*root agent* from a *project agent* — fenced, prompt-injectable processes. The
phone is neither: it is the user, on a paired device that signs a challenge
with its own P-256 key (`mobile_control::auth`), reached over Tailscale. And
the phone can already open an unfenced shell in any project with Mobile
access, which runs as the user and can read every store the root MCP serves.
Keeping root off the phone took nothing from an attacker holding the phone; it
only kept the user from their own root agent away from the desk.

What the root MCP adds for a phone-typed prompt:

- **Reads** — sanitized calendar/board views and the cross-project sweeps.
  Nothing a phone shell cannot already read.
- **Writes** — staged as proposals under the default `root_mcp_review = all`;
  approve/reject/undo are Tauri commands, and the phone API has no such route.
- **Mail** — a root tab never reads mail (role prohibition, no grant overrides
  it); its drafts have no recipient and sending is a Tauri command.

## The line that stays

**The device that drives the agent never approves its proposals.** Approval,
rejection, undo, the grants UI and Settings stay desktop-only. The phone sees
how many proposals wait, nothing more.

## Design

1. **One switch, default off.** `settings.eldrun_mobile_host.root_access`,
   in Settings → Eldrun Mobile beside the mail gates. Root is not a record in
   `projects.json`, so it cannot carry a per-project `eldrun_mobile_access`.
2. **`ScopeKind::Root` in discovery**, built from `paths::root_work_dir()` and
   `sessions/root/terminals.json`, with raw id `root`. The refusal of a
   *project record* whose id maps onto `root` stays: that guards the session
   directory against a hand-edited `projects.json`, a different question.
3. **Same spawn path as the desk.** A tab the phone creates goes through
   `hydrateThenCreateInScope("root")` and `pty_spawn` with no project id, so
   `root_mcp::apply_to_spawn` decides its tools exactly as for a desk-made
   tab (Root / MCP chips, `root_mcp`, `root_mcp_local_only`). No phone-only
   variant of a root agent exists. Existing root tabs attach like any tab.
4. **Closed while review is weaker than default.** Root is listed only when
   the switch is on **and** either the root MCP is off (then a root agent has
   no extra rights at all) or writes are staged behind a gate the agent cannot
   walk around: `root_mcp_review` is `all` and the fence would hold a root
   agent (`review_enforced`: policy on, platform fenceable, bubblewrap
   present). Otherwise a phone-typed prompt could write the calendar at once
   with nobody at the desk. The gate is evaluated per catalog load, so
   weakening review drops root from the phone and detaches its open terminals
   at `pty_bridge`'s next re-check. Settings says why when the switch is on
   but the gate is closed.
5. **Desktop bridge repeats the gate** (`MobileBridgeHost.mobileScope`): the
   bridge is reachable without the sidecar route, so it checks the switch, the
   review level and a cached `review_enforced`, failing closed until the
   status has been read once. Entering the root scope opens the root console
   (`useRootOverlayStore.show`), never a scope switch; restore is
   `ensureRootScopeHydrated`.
6. **Pending count.** The root row carries `pending_reviews`
   (`root_mcp_review::pending_count`); the phone's list shows "N awaiting
   approval at the desk". Read-only.
7. **Unchanged:** root Claude tabs still spawn without `--remote-control`
   (Anthropic's phone app is a different decision from Eldrun's paired phone).

## Accepted risk

Phone-typed prompts can fill the proposal queue (100 per tab / 500 total) and
a careless bulk-approve at the desk would apply them. The same holds for
prompts typed at the desk.

## Files

- `src-tauri/src/schema/settings.rs` — the switch (round-trip; the sidecar
  reads the raw key per catalog load, not its start-up `HostConfig`).
- `services/mobile_control/discovery.rs` — `ScopeKind::Root`, `RootEnv`, the
  gate, `pending_reviews`.
- `src/components/mobile/MobileBridgeHost.tsx` — root `MobileScope`.
- `src/components/mobile/MobileSettings.tsx`, `src/lib/i18n.ts`,
  `src/lib/untested.ts` — the toggle (`mobile.rootAccess`).
- `mobile-web/src/api.ts`, `projectOrder.ts` (`scopeCaption`),
  `screens/Home.tsx` — the row.
- `docs/context/root_console.md` — "Never the phone" → "On the phone".

## Manual QA

`todo/group-h-crossplatform.md` #31az: switch on → root row appears with its tabs;
attach a running root agent; create a root agent from the phone, ask for a
calendar entry, confirm it lands as a proposal and the row shows the count;
set review to `destructive` → row disappears and the open terminal detaches.
