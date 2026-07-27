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
