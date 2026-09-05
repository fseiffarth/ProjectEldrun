# Prompt chart — one timeline for collected, scheduled and sent prompts

Status: **implemented, awaiting live verification.** Tracked as TODO #262 in
`todo/group-s-agents.md`.

Written against the repository on **2026-09-04**.

## 1. What it replaces, and what it keeps

The Agents view (`components/agents/AgentSchedulesView.tsx`, rendered by the
side panel and the Files tab through `ProjectFilesView`) is four stacked
sections: the scope's agent tabs with their composers, the collected-prompt
library, the scheduled prompts, and the sent-prompt history. The last three are
three lists holding the *same* prompt at three moments of its life, and the
seams between them are exactly where #256 had to be written: a prompt that was
scheduled looked like one nobody had touched, and one that had fired sat next
to its own receipt.

The chart replaces those three sections with one surface. The tabs section
stays above it unchanged — it is the place a tab is renamed, jumped to and
composed at, and the composer is the send path the chart's own gestures reuse.

Nothing below the view changes shape except one additive field:

- Collected prompts stay in `agent_prompts.json` (`services::agent_prompts`),
  the history stays there under `history[project]`, and schedules stay rules
  on tabs in `agent_tasks.json`. **A card gets a time only by landing on a
  tab.** There is no second scheduling mechanism and no "planned for" field on
  a tab-less prompt; a prompt with a time is a one-time rule, as today.
- Send now stays a one-time rule at the current minute (`lib/agentPromptSend`),
  so the phone's send and the chart's drag-to-now are the same delivery.
- `AgentScheduleHost` stays the only deliverer; the chart never writes to a PTY.
- The phone keeps reading the same rows through `mobile_control`; it never sees
  the chart and needs no change.

## 2. The chart

### Cards

One card is one prompt in one state. The state is read, not stored — the same
three sources the sections read today, joined by the ids they already share
(`sendCollectedPrompt` gives the queued rule the prompt's own id;
`deliveryRecordId` names a recurring delivery `id@occurrence`; the
text-keyed `lib/agentPromptScheduled` marks bridge a rule made in the dialog).

| State | Source | Reads as |
|-------|--------|----------|
| **draft** | collected prompt with no rule | card on the Drafts shelf |
| **scheduled** | rule with a future occurrence | card in a strand's future band at its `at`; a recurring rule draws its *next* occurrence with a ↻ badge and the rule's summary |
| **queued** | one-time rule at a passed minute, no record yet | card stacked just under the now line, "waiting for idle" |
| **sent** | history row with a `result` | card above the now line at `sent_at`, coloured by outcome (delivered / missed / failed) |
| **chained** | draft that is the `after` target of a link (section 4) | dashed card at the tail of the source's strand |

A card shows the first lines of the message, its tags (stored) and auto tags
(derived, section 3), the agent lamp, and the one fact of its state: next run,
waiting, sent at + result. Clicking it expands it in place: full text, tag
editor, session id with copy, blame files, and the row actions the lists have
today (Send now, Schedule…, Edit, Delete, Collect again, Go to tab). The card
copies the `.todo-card` treatment (`styles/mail-todo.css`) rather than a new
one; the `.agent-prompts-*` class family continues in `styles/projects-tabs.css`.

### Strands

A strand is a vertical lane. One per agent tab of the scope that carries a
`scheduleTargetId` (the same set the tabs section lists), headed by the tab's
name and its state pill, coloured per agent the way the tab ring is. Sent
rows whose tab is gone fold into one grey **closed** strand per session id (or
tab label when there is none), collapsed by default. The **Drafts shelf** is
the timeless column at the left: the library.

The panel is narrow. Above ~640px the strands are columns of 200px minimum
inside their own horizontal `overflow-x: auto` container; below that the chart
goes **compact**: one column, every card wearing its strand's colour stripe,
the time axis unchanged. The side panel will mostly show compact; the Files
tab shows columns.

### Time axis

Top is the past, bottom the future, a **now line** between. Time is not one
scale, because the two halves answer different questions:

- **Past band — ordinal.** Sent cards in `sent_at` order with day separators
  (and hour separators inside today). 200 rows across three weeks on a
  proportional scale would be whitespace; the question is "what went out, in
  what order".
- **Future band — proportional.** From now to `max(next occurrence, +2 h)`,
  zoomable (1 h / 6 h / 24 h / 48 h) from the toolbar, snapped to 5 minutes.
  Cards farther out than the zoom sit in a **later** bucket under the band,
  ordinal again. Proportional is what makes "drag it to 14:30" mean something.
- **Queue** — the queued cards sit as a stack immediately under the now line,
  in delivery order. Delivery order is `sortSchedules`' occurrence order, so
  reordering the stack rewrites the rules' `at` minutes inside the catch-up
  window to match the new order; the card's time reads "waiting", not the
  rewritten minute.

The existing `SentPromptFilter` window facet becomes the past band's depth
(Today / week / month / any).

## 3. Search and tags

One search bar for the whole chart, the existing facets (`lib/agentPromptFilter`:
text, `#tag`, agent, result, window) applied to every state. Matching cards
stay full; non-matching cards **dim** rather than vanish, so the chart's shape
and the links stay legible, with a *Hide others* toggle for the list-like read.
The filter stays view state, never persisted, as today.

**Auto tags** are derived by a pure `lib/agentPromptAutoTags.ts` from what a
card already carries, never stored, so the backend and the phone do not learn
them:

| Auto tag | From |
|----------|------|
| `agent:claude` … | the tab's / row's agent |
| `model:<name>` | the preface's `/model` pick (`lib/agentPrefaces.splitPreface`) |
| `cmd:clear` … | other preface commands |
| `file:<basename>`, `dir:<top dir>` | the row's blame files |
| `result:missed`, `result:failed` | the record |
| `recurring`, `queued`, `chained` | the state |
| `lang:<x>` | code-fence languages in the message |
| `long` | message over 2 KiB |

They render as hollow chips after the stored ones, and `#` search reaches
them (`matchesTagsOrText` takes stored and auto tags concatenated). The tag
chip bar counts both, marked apart. Stored tags keep the existing editor and
`normalizeTag` rules.

## 4. Gestures

All drags are **pointer-based**, not HTML5 DnD (WebKitGTK; see
`hooks/useListReorder` and the tab bar), and each has a keyboard route from
the expanded card, because a 5-minute drag on a 12px grid is not the only way
to say 14:30.

| Gesture | Does | Through |
|---------|------|---------|
| **+** in the toolbar | new draft card on the shelf, inline editor open (`MarkdownPromptField`, the composer's field), tags line under it | `agent_prompt_upsert` |
| Draft → strand, at the now line | Send now | `sendCollectedPrompt` |
| Draft → strand, in the future band | Schedule once at the snapped time; the card moves, the draft stays collected until delivery retires it (#256) | `agent_schedule_upsert` with the prompt's id |
| Scheduled/queued card ↑↓ in its strand | Retime | upsert the rule with the new `at`; recurring rules are not draggable — their card offers *Edit rule…* into the dialog |
| Card → another strand | Move the rule to that tab | delete + upsert |
| Card → above the now line | Send now | delete rule + `queuePromptForTab` |
| Card → Drafts shelf | Unschedule; a rule made in the dialog with no collected twin is collected first | delete rule (+ upsert) |
| Sent card → Drafts shelf | Collect again (tags ride along, as today) | `agent_prompt_upsert` |
| Expanded card: time field, ± 5 min, *Move to tab…* | the same three, by keyboard | same |

Sent cards do not otherwise move; the record is a record.

While a filter is on, the shelf's drop index into the collected order is
withheld exactly as the list withholds its grip today; drops onto strands are
unaffected because they write times, not positions.

## 5. Links

A link joins two cards. It is drawn as an SVG overlay over the chart
(`PromptChartLinks.tsx`; the mechanics of `embed/MdGraphView.tsx`: measured
card rects, one `<line>`/`<path>` per link, re-measured through a
`ResizeObserver` and on the container's scroll). Selecting a card highlights
its links. Two kinds:

- **related** — a plain line, no behaviour. "These two belong together."
- **after** — an arrow. **When the source is *delivered*, the target is
  queued.** This is the chart's queue: a chain of drafts is a sequence the
  scheduler works through one delivery at a time, on one tab or across tabs
  (Claude writes the tests → Codex reviews them).

Made by *Link* on an expanded card then a click on the target, or by dragging
from the card's port. A link records `{ id, from, to, kind, target? }` where
`target` is the strand (`scheduleTargetId`) an `after` target is queued on —
the one it was dropped on, else the source's tab.

Persisted **additively** in `agent_prompts.json` as `links[project]`, file
version unchanged (`#[serde(default)]`), through `agent_prompt_link_upsert` /
`agent_prompt_link_delete`, listed with the prompts. Ids name prompts or
history rows; a link whose end is gone is dropped on read-back, so a cleared
history takes its links with it and never resurrects.

**Chain runtime** lives in `AgentScheduleHost`'s retire step — the one place
that knows a delivery happened: after the `delivered` record for id X lands,
every `after` link from X whose target is still a draft is sent with
`sendCollectedPrompt` onto its strand. Rules that keep the chain honest:

- A *missed* or *failed* source fires nothing. The chained card wears a
  "chain stopped" chip until the source is re-sent or the link removed.
- A target whose strand tab is closed is not sent; the card says so and offers
  *Move to tab…*.
- A draft is consumed by its send, so a recurring source fires its chain
  **once**; the chart says "after the next delivery" on such a card.
- The chain is one hop per delivery; a chain of five is five deliveries, each
  waiting for idle, which is the scheduler's own gate and not a second one.

## 6. Files

New:

- `lib/agentPromptChart.ts` — pure. Cards and strands from prompts, history,
  per-tab schedules and the tab list; state derivation; past-band grouping;
  future-band scale and snapping; **drop → action** mapping (a shelf/strand,
  a y, a card in → one of the writes above). This is where the meaning lives
  and what the tests cover, as `lib/agentPromptFilter` does for the filter.
- `lib/agentPromptAutoTags.ts` — pure, section 3.
- `lib/agentPromptLinks.ts` — pure: validation, dangling pruning, chain
  resolution (`nextAfter(delivered, links, drafts, strands)`).
- `components/agents/PromptChart.tsx` (toolbar, axis, strands, DnD state),
  `PromptCard.tsx`, `PromptChartLinks.tsx`.

Changed:

- `components/agents/AgentSchedulesView.tsx` shrinks to the tabs section plus
  `<PromptChart>`; `promptRow`, the library/scheduled/history sections, the
  `library`/`filter`/`picking`/`unfolded` states and the target picker go.
- `components/layout/AgentScheduleHost.tsx` — chain step after the record.
- `stores/agentPrompts.ts` — `linksByProject`, `link`/`unlink`; `load` takes
  the links along.
- Backend: `schema/agent_prompts.rs` (`PromptLink`, `links` on the file),
  `services/agent_prompts.rs` (`apply_link_upsert`/`apply_link_delete`,
  pruning in `apply_delete`/`clear_history`), `commands/agent_prompts.rs`,
  `lib.rs` registration.
- `styles/projects-tabs.css` — chart, strands, axis, card (copying
  `.todo-card`), compact breakpoint. No animated box-shadows.
- `lib/i18n.ts` + `de`/`es`/`fr`/`it` — every new string; the removed list
  strings go with their sections.
- `src/CLAUDE.md`, `src-tauri/CLAUDE.md` rows; `UntestedTag` on the chart.

Tests: `AgentPromptChart.test.ts` (state derivation, joins by id and by text
key, band grouping, snapping, drop mapping, queue reorder rewriting minutes),
`AgentPromptAutoTags.test.ts`, `AgentPromptLinks.test.ts` (pruning, chain
resolution, the three honesty rules), `PromptChart.test.tsx` (renders the
five states, filter dims rather than hides, `+` collects, keyboard retime),
`AgentSchedulesView.test.tsx` updated for the lost sections,
`AgentScheduleRetire.test.tsx` extended with the chain step; cargo tests for
the link core.

## 7. Phases

1. **Chart, read-only.** Cards, strands, both bands, now line, compact mode,
   search with auto tags, expand-in-place with the existing row actions. The
   three sections are gone at the end of this phase; nothing new is written.
2. **Gestures.** `+`, the drop mapping, keyboard retime, queue reorder.
3. **Links.** Backend field and commands, the overlay, the chain step.
4. **Polish.** Closed-tab strands, zoom persistence per session (view state),
   later bucket, empty states.

Each phase ships behind the same `UntestedTag` with its own manual checklist in
#262; none of it is live-verified until the user runs it.

## 8. Decided against

- **A single proportional axis.** See section 2; the past would be whitespace.
- **A `planned_at` on collected prompts.** A second time-bearing shape beside
  rules would split the scheduler's gate and the phone's view of "queued".
- **Storing auto tags.** They are a function of the row; storing them is a
  cache that goes stale the moment a rule or blame changes.
- **A new rule type `after` in `agent_tasks.json`.** The schedule file's
  version and sweep must not grow a second shape (`src-tauri/CLAUDE.md`);
  links live beside the prompts they join.
- **A canvas / force layout.** Strands and time already fix every card's
  position; free placement would make "when" a matter of where it was dropped.
