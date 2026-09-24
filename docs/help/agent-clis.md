---
id: agent-clis
title: AI agent CLIs — install, sign in, open
keywords: [agent, cli, install, claude, codex, gemini, npm, node, manage clis, sign in, login, resume, custom agent, skills]
---

Eldrun runs AI coding agents as terminal tabs. It does not bundle them: each
agent is its vendor's own command-line tool (CLI), installed once per machine.
Eldrun detects installed CLIs, offers them in every `+` menu, and resumes
their conversations after a restart where the CLI allows it.

## Install an agent CLI

1. Open **Settings → Agents → Manage CLIs** (or **Manage CLIs…** in the
   Models & agents menu in the header).
2. Find the agent. Installed ones are listed first; use the search box for
   the rest.
3. Click **Install <name>**. Eldrun runs the vendor's official installer and
   streams its output right there. Alternatively click **Run in terminal** to
   run the same command in a visible terminal tab (in the root console), where
   you can answer prompts such as a sudo password.
4. When it finishes, the agent shows as installed. If not, click
   **Re-check**; a fresh terminal may be needed so the install folder is on
   PATH.
5. Open a project, click `+` on its tab bar and pick the agent.

For npm-based agents, a **Run with sudo** button is offered too. Use it only
when Node.js was installed system-wide (not with nvm) and npm fails with a
permission error (EACCES).

On a remote project, the same panel can install an agent onto a chosen remote
machine instead of this one.

## Prerequisite: Node.js for npm-based agents

Claude, Codex, Antigravity, Mistral, Kiro, Cursor, OpenCode (Linux/macOS),
Droid and several others install with their own script and need no Node.js.
Gemini, Copilot, Qwen, Cline, Auggie, Continue, CodeBuddy, Crush, Amp and
Pi install with `npm install -g` and need Node.js 24 or newer.

When npm is missing or Node is too old, Manage CLIs shows a Node.js helper:

- Linux/macOS: installs nvm and the current Node LTS for your user (no
  administrator rights): `curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash`, then `nvm install --lts`.
- Windows: `winget install OpenJS.NodeJS.LTS`.

Click **Run in terminal**, wait for it to finish, then **Re-check**.

## The main agents

| Agent | Command | Linux / macOS install | Windows install |
|---|---|---|---|
| Claude (Claude Code) | `claude` | `curl -fsSL https://claude.ai/install.sh \| bash` | `irm https://claude.ai/install.ps1 \| iex` (PowerShell) |
| Codex | `codex` | `curl -fsSL https://chatgpt.com/codex/install.sh \| sh` | `irm https://chatgpt.com/codex/install.ps1 \| iex` |
| Google Gemini | `gemini` | `npm install -g @google/gemini-cli` | same |
| Google Antigravity | `agy` | `curl -fsSL https://antigravity.google/cli/install.sh \| bash` | `irm https://antigravity.google/cli/install.ps1 \| iex` |
| Mistral (Vibe) | `vibe` | `curl -LsSf https://mistral.ai/vibe/install.sh \| bash` | Install Vibe in the Ollama Models panel (installs uv, then `uv tool install mistral-vibe`) |
| OpenCode | `opencode` | `curl -fsSL https://opencode.ai/install \| bash` | `npm install -g opencode-ai` |
| Copilot | `copilot` | `npm install -g @github/copilot` | same |
| Aider | `aider` | `curl -LsSf https://aider.chat/install.sh \| sh` | `irm https://aider.chat/install.ps1 \| iex` |

Manage CLIs lists about thirty more (Kiro, Cline, Cursor, Droid, Grok, Qwen,
OpenClaw, Auggie, Kilo Code, Continue, Junie, CodeBuddy, Goose, Pi, Plandex,
SWE-agent, mini-SWE-agent, Crush, Amp, Kimi Code, Qoder, Meta Muse Code), each
with its official installer. Where no one-line Windows installer exists the
panel links the vendor's install docs. Detailed guides: `claude-code`,
`codex`, `gemini-cli`.

## Sign in

Eldrun never handles agent logins. Open the agent's tab; on first start the
CLI asks you to sign in (usually a browser approval) and remembers it. If no
browser opens, copy the sign-in link the CLI prints into your browser.

## Open an agent tab

- In a project: `+` on the tab bar → **Agents & CLIs** → the agent. The tab
  starts in the project folder.
- The compact list shows Claude, Codex and Gemini by default; change it with
  the "+ tab" chips in the Models & agents menu. **More agents & CLIs…** lists
  every installed agent.
- The **Default** chip picks the agent Eldrun uses when it must choose one
  itself (e.g. filling scaffold files).
- Root console: agents are off there until you turn on their **Root** chip.

## Resume after a restart

Claude, Codex and Mistral tabs reopen their exact conversation. Gemini, Qwen,
Grok, Cursor, Copilot, OpenCode and Antigravity continue the project's most
recent conversation. Others start fresh.

## Permission modes

Plan mode, auto-accept, sandbox or approval policies are set inside each
agent's own CLI. Eldrun adds no mode flag and has no mode toggle.

## The Linux agent fence

On Linux, local agent tabs run inside a bubblewrap filesystem fence by
default: the project is writable, your home folder (SSH keys, other
credentials, other projects) is hidden. If `bwrap` is missing the agent does
not start, and Eldrun offers `sudo apt install bubblewrap` in a terminal tab.
A project can switch the fence off explicitly. Windows has no fence.

## Custom agents and skills

- `+` → **Add agent…** registers any command as a custom agent.
- **Skills library…** (Models & agents menu or `+` menu) installs reusable
  Agent Skills into one project (`.claude/skills/`) or for every project on
  this machine (`~/.claude/skills/`).
