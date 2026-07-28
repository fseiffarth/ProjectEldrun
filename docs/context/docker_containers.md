# Docker project containers

Referenced from `CLAUDE.md`.

**A project can run in a container** (#38, `services::sandbox`,
`docs/docker_projects_plan.md`): with the pill's "Run this project in a
container" toggle on, every shell/agent tab `docker exec`s into ONE
session-lived, capability-dropped container (`eldrun-<id>`); `local_agent`
tabs stay on the host. The project dir stays on the host, bind-mounted at its
**identical absolute path** — file tree/git/viewers/usage watcher keep reading
host bytes, and agent resume keeps working — which is what makes it a toggle,
not a data move. Container lifetime = project session (created on
activation/first spawn; removed on deactivate *unless tabs are still live in
it*, at exit, and swept at startup). The toggle is spec-preserving (knobs in
the pill's "Container settings…" survive off/on), the first enable
auto-adopts an in-repo `Dockerfile`/devcontainer image, and a missing image
becomes a one-click build tab. Flipping the toggle respawns every live tab —
the pill confirms when a non-resumable agent conversation would be lost.
Local projects only; hidden on Windows.

**It is also asked at creation** (`ProjectDialog`), because that is the one
moment it is free: flipping it later restarts every tab. The row defaults **on
for an import** (a folder, a clone, a fork — code the user hasn't read, whose
build scripts and agent-facing docs are about to run) and **off for a new
project** (nothing to contain yet, and the image/toolchain cost would be paid
for a folder holding a README). An explicit choice sticks; the same
`set_project_sandbox` + preflight the pill's toggle uses runs before the
project reaches the store, so activation already warms the right container.

**Claude transcripts are the one cross-project mount**, and the rule is *read
every project, write only our own*. `~/.claude/projects` is keyed by encoded
cwd, not by Eldrun project, so it is mounted **per entry, explicitly**: this
project's transcript dirs rw, **every other project's `:ro`**. Reading another
project's history is allowed; rewriting one is not — the rewritten log is what
an *uncontained* future session reads back as its own history. Membership comes
from the `cwd` recorded **inside** a transcript, never from decoding the dir
name (that encoding maps both `/` and `.` to `-`, so `…-proj-panel` is either a
subdir of `proj` or the sibling project `proj-panel`). A cwd with no host dir at
create time has nothing to mount, so the mount *parent* is a per-project stage
dir: the new transcript lands there and teardown harvests it into the real
`~/.claude/projects`. The transcript set is deliberately **excluded from the
spec fingerprint** — it changes whenever any project gains a dir, and a
fingerprint mismatch means recreate, i.e. an unrelated project's agent could
otherwise kill every live tab of this one.
