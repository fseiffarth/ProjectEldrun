# Agent sandbox image

Reference Docker image for Eldrun's per-project **"Run agents in Docker sandbox"**
toggle (right-click a project pill → *Run agents in Docker sandbox*).

When enabled for a (local) project, every **agent** tab (Claude, Codex, Gemini,
Vibe — anything with `kind: "agent"`) is launched inside an ephemeral
`docker run --rm` container that bind-mounts **only the project directory**, so
the agent cannot read or write host files outside the project. Plain shell/files
tabs keep running on the host. The toggle is **off by default** and per project.

## Build

```bash
docker build -t eldrun-agent-sandbox:latest docker/agent-sandbox
```

`eldrun-agent-sandbox:latest` is the default image name the backend looks for.
If the image (or `docker` itself) is missing, opening a sandboxed agent tab fails
loudly in the terminal with a `[spawn error: …]` message rather than silently
running the agent on the host.

## How it runs

The backend (`src-tauri/src/services/sandbox.rs`) wraps the agent command as:

```
docker run --rm -it \
  --user <host-uid>:<host-gid> \
  -e HOME=<host-home> \
  -w <project-dir> \
  -v <project-dir>:<project-dir> \
  -v <home>/.claude:<home>/.claude \
  -v <home>/.codex:<home>/.codex \
  -v <state_dir>:<state_dir> \          # ~/.local/share/eldrun (live_sessions + hooks)
  [ -v <home>/.config:<home>/.config ] \ # if present (Gemini creds)
  -e ELDRUN_TAB_UID=… -e TERM=… -e <agent auth vars> \
  eldrun-agent-sandbox:latest <agent> <args>
```

The `~/.claude` / `~/.codex` / `state_dir` mounts (at identical paths, as the host
uid, with `HOME` set to the host home) are what keep **agent auth and session
resume** working inside the container. Do not remove them.

## Customizing

- Add your project toolchain (python, go, rustup, …) to the `Dockerfile` if your
  agents need to build/run code inside the sandbox.
- Network is the default Docker bridge (full network). To harden egress, base
  this image / its run on an allowlist firewall (see Anthropic's reference
  devcontainer `init-firewall.sh`).
- Remote (SSH) projects are out of scope: the sandbox toggle is hidden for them,
  and the backend ssh-wraps remote agent tabs instead of docker-wrapping them.
