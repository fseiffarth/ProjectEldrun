# Reference image for Eldrun's per-project "Run agents in Docker sandbox" toggle.
#
# When the toggle is on for a project, Eldrun launches each agent tab as:
#   docker run --rm -it --user <uid>:<gid> -e HOME=<host-home> -w <project> \
#     -v <project>:<project> \
#     -v <home>/.claude:<home>/.claude -v <home>/.codex:<home>/.codex \
#     -v <state_dir>:<state_dir> [optional -v <home>/.config:<home>/.config] \
#     -e <agent-auth/env vars> eldrun-agent-sandbox:latest <agent> <args>
#
# The container therefore needs the agent CLIs on PATH. Auth + session-resume
# state lives in the bind-mounted host dirs (run as the host uid, with HOME set
# to the host home), so this image carries no credentials.
#
# Build:
#   docker build -t eldrun-agent-sandbox:latest docker/agent-sandbox
#
# The container is started with `--user <host-uid>:<host-gid>` and is NOT root,
# so install everything to global locations at build time (below). The named
# user does not need to exist in /etc/passwd; HOME is provided via `-e HOME`.

FROM node:22-bookworm-slim

# Tools agents commonly shell out to. Add your project toolchain (python, go,
# rustup, etc.) here if your agents need to build/run code inside the sandbox.
RUN apt-get update && apt-get install -y --no-install-recommends \
        git ca-certificates ripgrep less procps curl \
    && rm -rf /var/lib/apt/lists/*

# Agent CLIs. Pin versions in your own fork if you want reproducible builds.
#   - Claude Code:  @anthropic-ai/claude-code  (provides `claude`)
#   - Codex:        @openai/codex               (provides `codex`)
#   - Gemini CLI:   @google/gemini-cli          (provides `gemini`)
# Vibe and any other agents you use should be added here as well.
RUN npm install -g \
        @anthropic-ai/claude-code \
        @openai/codex \
        @google/gemini-cli \
    && npm cache clean --force

# Make global npm bins resolvable regardless of the (host) uid we run as, and
# give npm a writable cache/prefix under a world-writable dir so a non-root,
# /etc/passwd-less user can still operate.
ENV NPM_CONFIG_CACHE=/tmp/.npm
ENV PATH=/usr/local/bin:$PATH

# No ENTRYPOINT: Eldrun passes the agent command + args as the container command.
