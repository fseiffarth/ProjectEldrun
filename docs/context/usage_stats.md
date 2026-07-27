# Usage stats

Referenced from `CLAUDE.md`.

**Usage stats are local-only** (`usage_stats.json`, `schema::usage_stats`): a
rolling hour+day counter store behind the daily recap (which agents/models you
used, prompts asked, shell commands, file churn, tabs). It clones
`schema::net_usage`'s bucket+prune shape but its payload is an **open
string-keyed counter map**, so adding a statistic costs one const in `metric`
(mirrored in `src/lib/usageMetrics.ts`) and one render line — no migration.
Deliberately NOT counted into it: **time** (`time_summary.json`), **network
bytes** (`net_usage.json`) and **git** (re-derived from `git log` on demand) —
the recap reads those at their source so they can never drift. Tab opens are
counted in the frontend's `addTab`, *not* at `pty_spawn`, because the backend
spawn fires again for every resumable agent tab respawned on relaunch. File
churn comes from a recursive `notify` watcher on the **active** project
(`services::usage_stats`); it cannot see an SFTP tree, so a remote project is
counted only via its local mirror. The recap (`components/stats/`) opens on the
first launch of each day (`daily_stats_recap`, default on) and from Settings.
