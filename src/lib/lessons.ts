import type { TourStep } from "./tour";

/**
 * Task "lessons" — short, replayable narrated walkthroughs for specific jobs
 * (add a project, install an agent, use a local model, …). Each lesson is a
 * step list run through the same engine as the high-level tour (`TourHost` /
 * `useTourStore.startLesson`), so it reuses the spotlight, click-blocking, and
 * Back/Next navigation. Picked from the `LessonsMenu`.
 *
 * Most steps spotlight a persistent entry-point control (the + button, the gear,
 * the 🧠 menu) by a verified selector; menu/dialog internals — which only exist
 * while open and which the narrated, click-blocking overlay can't keep pinned —
 * are described as centered cards (`anchor: null`). Copy matches the terse,
 * friendly onboarding voice.
 *
 * Order is meaningful: lessons run easiest → hardest and are grouped into tiers
 * (`LESSON_CATEGORIES`). `LESSONS` stays sorted so each category's lessons are
 * contiguous and the picker can render a header per tier just by walking the
 * array. Within a tier the lessons themselves also ramp from simplest to most
 * involved.
 */

/** Difficulty tiers, in the order the picker shows them (easy → hard). */
export const LESSON_CATEGORIES = ["Basics", "Agents & models", "Advanced"] as const;
export type LessonCategory = (typeof LESSON_CATEGORIES)[number];

export interface Lesson {
  /** Stable id (also the React key in the picker). */
  id: string;
  /** Difficulty tier; groups the lesson under a header in the picker. */
  category: LessonCategory;
  /** Menu label. */
  title: string;
  /** One-line description shown under the title in the picker. */
  blurb: string;
  steps: TourStep[];
}

/** Reveal the right-side file panel so a step's anchor exists to spotlight.
 *  AppShell listens for this (the panel is otherwise hover-revealed). */
const revealFilePanel = () => window.dispatchEvent(new Event("eldrun:reveal-right-panel"));

export const LESSONS: Lesson[] = [
  // ── Basics ──────────────────────────────────────────────────────────────
  {
    id: "add-project",
    category: "Basics",
    title: "Add a new project",
    blurb: "Create or import a project — each gets its own terminal, tabs, and file tree.",
    steps: [
      {
        id: "pill-strip",
        anchor: ".project-pills-region",
        placement: "top",
        title: "Your projects live here",
        body: "Every active project shows up as a pill in this strip. Click one to switch to it — each project keeps its own terminal, tabs, and file tree.",
      },
      {
        id: "add-button",
        anchor: '[data-hint-anchor="add-project"]',
        placement: "bottom",
        title: "The + button",
        body: "Click + to open the add menu. It's your single entry point for starting a brand-new project, importing an existing folder, or grouping projects into a box.",
      },
      {
        id: "add-menu",
        anchor: null,
        placement: "bottom",
        title: "New, Import, or Box",
        body: "The menu offers New Project (scaffold a fresh project), Import Project (register a folder you already have), and New Box (a meta-group for related pills). Pick New Project.",
      },
      {
        id: "new-dialog",
        anchor: null,
        placement: "bottom",
        title: "Fill in the details",
        body: "The New Project dialog asks for a name and an optional description, and lets you pick a Git hosting option (no git, a local-only repo, or push to GitHub/GitLab as private or public). Flip the \"Remote (SSH) project\" toggle to host it on another machine instead.",
      },
      {
        id: "scaffold-create",
        anchor: null,
        placement: "bottom",
        title: "What you get",
        body: "Hit Create and Eldrun makes the project folder under your projects directory (~/eldrun/projects by default — the Location picker changes it), scaffolds AGENTS.md, CLAUDE.md, .gitignore, README and friends, and initializes the repo. Tick \"Skip scaffolding\" if you'd rather start empty.",
      },
      {
        id: "publish-remote",
        anchor: ".project-pills-region",
        placement: "top",
        title: "Advanced: connect a remote",
        body: "To put it on GitHub or GitLab, pick a \"Push to GitHub/GitLab\" hosting option in the dialog — or later, right-click the project's pill → \"Publish to GitHub / GitLab…\", choose the provider and public/private. Eldrun runs that provider's CLI (gh or glab) to create the repo and push. Needs the chosen CLI installed and signed in, or a token under ⚙ Settings → Git Hosting.",
      },
    ],
  },
  {
    id: "import-project",
    category: "Basics",
    title: "Import a project",
    blurb: "Register an existing folder — or a remote SSH host — without touching its contents.",
    steps: [
      {
        id: "open-add-menu",
        anchor: '[data-hint-anchor="add-project"]',
        placement: "top",
        title: "Open the add menu",
        body: "Click the + button beside your project pills. It opens a small menu with New Project, Import Project, and New Box.",
      },
      {
        id: "pick-import",
        anchor: null,
        placement: "bottom",
        title: "Choose \"Import Project\"",
        body: "Pick Import Project from that menu. A centered dialog opens for registering a folder you already have.",
      },
      {
        id: "browse-folder",
        anchor: null,
        placement: "bottom",
        title: "Point at your folder",
        body: "Under Source folder, hit Browse… and select the existing project directory. Eldrun reads it in place and does not modify its contents.",
      },
      {
        id: "import-mode",
        anchor: null,
        placement: "bottom",
        title: "Keep, copy, or move",
        body: "Import mode lets you keep the folder where it is, or copy/move it into Eldrun's projects folder. Set a name and a Git hosting option, then confirm to add the pill.",
      },
      {
        id: "remote-import",
        anchor: null,
        placement: "bottom",
        title: "Remote? Flip the SSH toggle",
        body: "Tick \"Remote (SSH) project\" to import a folder living on another host. Eldrun pairs it with a synced local working copy: agent tabs work in the local copy by default, while shells, file browsing, and git reach the host over SSH/SFTP (with an optional OpenVPN step). No local mount needed.",
      },
      {
        id: "publish-remote",
        anchor: ".project-pills-region",
        placement: "top",
        title: "Advanced: connect a remote",
        body: "Imported a folder that isn't on a remote yet? Right-click its pill → \"Publish to GitHub / GitLab…\", choose the provider and public/private, and Eldrun runs that provider's CLI (gh or glab) to create the repo and push your code. Needs the chosen CLI installed and authenticated, or a token under ⚙ Settings → Git Hosting.",
      },
    ],
  },
  {
    id: "add-tab",
    category: "Basics",
    title: "Add a tab",
    blurb: "Open a new agent, shell, or file-browser tab in any subwindow.",
    steps: [
      {
        id: "find-plus",
        anchor: '[data-hint-anchor="tab-add"]',
        placement: "bottom",
        title: "The + button",
        body: "Every tab bar ends with a + button. Click it to open the new-tab menu for that subwindow.",
      },
      {
        id: "the-menu",
        anchor: null,
        placement: "bottom",
        title: "Pick what to open",
        body: "The menu groups your choices: an Agents section (Claude, Codex, Gemini and any other installed CLIs), a Local Model section, plus Shell and Files.",
      },
      {
        id: "shell-files",
        anchor: null,
        placement: "bottom",
        title: "Shell & Files",
        body: "Choose Shell for a plain terminal in the project folder, or Files for an in-app file browser. The new tab opens focused in this subwindow.",
      },
      {
        id: "rename-close",
        anchor: null,
        placement: "bottom",
        title: "Rename, close, reopen",
        body: "Right-click a tab for its menu — Rename, Close, Close others, or close everything to one side. Shift+right-click renames inline straight away; the × on a tab closes it. Reopening a closed agent respawns it fresh from the same + menu.",
      },
    ],
  },
  {
    id: "native-viewer",
    category: "Basics",
    title: "Open a file in the viewer",
    blurb: "Reveal the file tree and open files in Eldrun's built-in viewers — no external app.",
    steps: [
      {
        id: "reveal-tree",
        anchor: '[data-hint-anchor="file-tree-edge"]',
        placement: "left",
        title: "Reveal the file tree",
        body: "Push your cursor to the right edge of the window to slide out the project file tree.",
        prepare: revealFilePanel,
      },
      {
        id: "pin-panel",
        anchor: ".right-panel-pin",
        placement: "left",
        title: "Pin it open",
        body: "The panel auto-hides when your cursor leaves. Click the 📌 to keep it docked while you browse.",
        prepare: revealFilePanel,
      },
      {
        id: "open-file",
        anchor: null,
        placement: "bottom",
        title: "Double-click a file",
        body: "Double-click any file to open it; single-click a folder to step into it. You can also drag a file onto a tab bar to open it there.",
      },
      {
        id: "viewer-pane",
        anchor: null,
        placement: "bottom",
        title: "It opens in-app",
        body: "PDFs, images, markdown, code, notebooks, tables, diffs, audio/video, and TeX render in Eldrun's native viewer — no external app. The built-in viewer wins whenever one applies.",
      },
      {
        id: "default-app",
        anchor: null,
        placement: "bottom",
        title: "Change the handler",
        body: "Right-click a file → \"Set default app…\" to send a type to an external app instead. Toggle native viewers per type under the file panel's own ⚙ (Project settings → Native Viewers).",
      },
    ],
  },
  {
    id: "arrange-tabs",
    category: "Basics",
    title: "Arrange tabs",
    blurb: "Reorder tabs, split panes, drag files in from the tree, and pop tabs into their own window.",
    steps: [
      {
        id: "intro",
        anchor: null,
        placement: "bottom",
        title: "Make room your way",
        body: "Drag to arrange everything: reorder tabs, split the view, pull files in from the file tree, and pop panes out into their own windows. Let's walk through it.",
      },
      {
        id: "tab-bar",
        anchor: ".tab-bar",
        placement: "bottom",
        title: "The tab bar",
        body: "Each subwindow has its own tab strip. Drag a tab left or right within this bar to reorder it.",
      },
      {
        id: "split",
        anchor: null,
        placement: "bottom",
        title: "Split a pane",
        body: "Drag a tab onto the edge of a pane — top, bottom, left, or right — to split the view and tile it side-by-side or stacked. Drop it in the middle instead to move it into that group.",
      },
      {
        id: "drag-from-tree",
        anchor: '[data-hint-anchor="file-tree-edge"]',
        placement: "left",
        title: "Drag a file in from the tree",
        body: "Slide out the file tree on the right and drag an openable file straight into the layout — drop it on a tab bar to add it there, on a pane edge to split, or in a pane's center to merge. It opens right where you drop it.",
        prepare: revealFilePanel,
      },
      {
        id: "detach",
        anchor: null,
        placement: "bottom",
        title: "Pop out a window",
        body: "Drag a tab (or a whole tab bar) out of the app to detach it into its own floating OS window. Drag it back over Eldrun to dock it again.",
      },
      {
        id: "drag-to-detached",
        anchor: null,
        placement: "bottom",
        title: "Drop across windows",
        body: "That same drag reaches popped-out windows: drag a tab — or a file from the tree — onto a detached window that's in front and it docks there. Release over empty desktop instead to open it in a brand-new window.",
      },
      {
        id: "outro",
        anchor: null,
        placement: "bottom",
        title: "That's it",
        body: "Reorder within a bar, drop on an edge to split or a center to merge, pull files in from the tree, and drag tabs out to detach or onto another window. Rearrange freely — your layout is saved.",
      },
    ],
  },

  // ── Agents & models ─────────────────────────────────────────────────────
  {
    id: "install-agent",
    category: "Agents & models",
    title: "Choose an AI agent",
    blurb: "Pick an AI coding agent for a tab, and install its CLI so it shows up.",
    steps: [
      {
        id: "open-add-menu",
        anchor: '[data-hint-anchor="tab-add"]',
        placement: "bottom",
        title: "Add an agent tab",
        body: "The + button on any tab bar opens the add menu. That's where you pick which AI agent to launch in a new tab.",
      },
      {
        id: "pick-from-list",
        anchor: null,
        placement: "bottom",
        title: "Pick an agent",
        body: "The menu lists agents like Claude, Codex, Gemini, Mistral, Aider, OpenCode, Cursor, Copilot, Grok, Qwen, and OpenClaw. Click one to spawn a tab running that agent in the project folder.",
      },
      {
        id: "only-installed",
        anchor: null,
        placement: "bottom",
        title: "Only installed agents appear",
        body: "The menu hides any agent whose CLI isn't on your system — Eldrun probes each one's command first. If yours is missing, you just need to install it.",
      },
      {
        id: "manage-agents",
        anchor: '[data-hint-anchor="settings"]',
        placement: "bottom",
        title: "Install a missing agent",
        body: "Open ⚙ → Manage Agents to install an agent CLI with one click (the installer's output streams right there), or run its vendor command in a terminal tab. Most CLIs need npm — the panel offers to install Node.js first if it's missing. The agent then appears in the + menu.",
      },
      {
        id: "set-default",
        anchor: '[data-hint-anchor="settings"]',
        placement: "bottom",
        title: "Agents come back after a relaunch",
        body: "Shell and Files tabs are always restored when Eldrun relaunches. Claude and Codex agent tabs are restored too — they resume their previous conversation. Other agents start fresh from the + menu.",
      },
    ],
  },
  {
    id: "local-model",
    category: "Agents & models",
    title: "Models & agents",
    blurb: "The 🧠 menu hubs your on-device Ollama models and your installed AI agents.",
    steps: [
      {
        id: "brain-button",
        anchor: '[aria-label="Local model"]',
        placement: "bottom",
        title: "The model & agent menu",
        body: "This 🧠 button is your model-and-agent hub: loaded and installed local (Ollama) models up top — those run on-device, nothing leaves your machine — and your installed AI agents below. Hover it to open; if Ollama isn't installed yet it offers \"Install Ollama…\".",
      },
      {
        id: "pick-default",
        anchor: null,
        placement: "bottom",
        title: "Pick a model",
        body: "Models loaded in memory show a green lamp. Click a model's name to make it your default local model; models on disk can be loaded into memory from the same list.",
      },
      {
        id: "role-chips",
        anchor: null,
        placement: "bottom",
        title: "Assign tasks",
        body: "Tag a loaded model with the Autocomplete, Grammar, or Tabs chips to pin it to that job. Several models can each own a different task; load just one and it auto-handles everything.",
      },
      {
        id: "manage-models",
        anchor: '[data-hint-anchor="settings"]',
        placement: "bottom",
        title: "Manage models",
        body: "\"Manage local models…\" (or the gear → Settings → Ollama) is where you pull new models, watch download progress, and delete ones you no longer need.",
      },
      {
        id: "agents-section",
        anchor: null,
        placement: "bottom",
        title: "Agents live here too",
        body: "Below the models, the Agents section lists every AI agent CLI Eldrun detected (a green lamp means it's installed). \"Manage agents…\" installs missing ones — the same agents you then launch from any tab's + menu.",
      },
      {
        id: "use-autocomplete",
        anchor: null,
        placement: "bottom",
        title: "Use it while editing",
        body: "In native file viewers, ghost-text suggestions appear when you pause typing — or press Ctrl+Space to ask directly. Tab accepts the whole suggestion, → takes just the next word, Shift+Tab cycles the completion length (sentence → block → scope). It's opt-in per file type (a privacy gate).",
      },
    ],
  },
  {
    id: "add-local-model",
    category: "Agents & models",
    title: "Add a local model or agent",
    blurb: "Pull an on-device Ollama model, or install an AI agent CLI so it shows up.",
    steps: [
      {
        id: "open-brain",
        anchor: '[aria-label="Local model"]',
        placement: "bottom",
        title: "Open the 🧠 menu",
        body: "This button is your model-and-agent hub. Hover it to open. Local (Ollama) models run on-device — nothing leaves your machine — and your installed agent CLIs are listed below them.",
      },
      {
        id: "manage-models",
        anchor: null,
        placement: "bottom",
        title: "Manage local models…",
        body: "Click \"Manage local models…\" at the bottom of the menu (it reads \"Install Ollama…\" instead if Ollama isn't on your system yet — install that first). It opens the Ollama panel under ⚙ Settings.",
      },
      {
        id: "pull-from-catalog",
        anchor: null,
        placement: "bottom",
        title: "Pull a model",
        body: "Browse the catalog, sort by size or popularity, and hit Pull on one you want. A progress bar tracks the download — you can pause and resume it, and the model loads into the 🧠 menu when it's done.",
      },
      {
        id: "pull-by-name",
        anchor: null,
        placement: "bottom",
        title: "Or pull any model by name",
        body: "Not in the catalog? Type any Ollama registry ref (e.g. qwen2.5-coder:7b) into the free-text pull field and confirm. Eldrun fetches it the same way.",
      },
      {
        id: "manage-agents",
        anchor: '[data-hint-anchor="settings"]',
        placement: "bottom",
        title: "Add an AI agent instead",
        body: "Back in the 🧠 menu, \"Manage agents…\" (or ⚙ → Manage Agents) one-click-installs an agent CLI — Claude, Codex, Gemini and friends — or runs its vendor command in a terminal tab. Installed agents then appear in any tab's + menu.",
      },
    ],
  },

  // ── Advanced ────────────────────────────────────────────────────────────
  {
    id: "project-boxes",
    category: "Advanced",
    title: "Group projects into a box",
    blurb: "Bundle related projects under one box pill — drag them in, switch between them, open the box scope.",
    steps: [
      {
        id: "why-boxes",
        anchor: ".project-pills-region",
        placement: "top",
        title: "When pills pile up",
        body: "Once you have a lot of projects, this strip gets crowded. A box is a single pill that meta-groups related projects together so the strip stays tidy.",
      },
      {
        id: "new-box",
        anchor: '[data-hint-anchor="add-project"]',
        placement: "bottom",
        title: "Create a box",
        body: "Click + beside your pills and pick New Box from the menu. Give it a name — an empty box pill (marked ▣) appears in the strip with a member count of 0.",
      },
      {
        id: "assign-members",
        anchor: ".project-pills-region",
        placement: "top",
        title: "Drag projects in",
        body: "Drag any project pill onto the box pill to add it as a member; the count badge ticks up. The same drag that reorders pills assigns them — drop on the box instead of the strip. Shortcut: Alt-drag one pill onto another to box the two together in one move.",
      },
      {
        id: "box-dropdown",
        anchor: null,
        placement: "bottom",
        title: "Hover to see inside",
        body: "Hover the box pill to drop down its member list. Click a member to switch straight to it, or hit the × beside one to ungroup it (the project stays, it just leaves the box).",
      },
      {
        id: "box-scope",
        anchor: null,
        placement: "bottom",
        title: "Open, rename, delete",
        body: "Click the box pill itself to open the box scope, like opening a project. Right-click it for Open, Rename, or Delete — deleting a box never deletes its projects, only the grouping.",
      },
    ],
  },
  {
    id: "docker-sandbox",
    category: "Advanced",
    title: "Run agents in a Docker sandbox",
    blurb: "Confine a project's agent tabs to an ephemeral container that mounts only that project.",
    steps: [
      {
        id: "why-sandbox",
        anchor: ".project-pills-region",
        placement: "top",
        title: "Box the agent in",
        body: "By default agents run on your host with your full filesystem in reach. A Docker sandbox confines a project's agent tabs to an ephemeral, capability-dropped container that mounts only that project's directory plus the agent's own login/session files — so a misbehaving agent can't wander into unrelated host files. (The agent's auth dirs are shared so login and resume keep working; the hook script is read-only and its config is a throwaway per-tab copy, so the sandbox can't make code run on the host.)",
      },
      {
        id: "open-pill-menu",
        anchor: ".project-pills-region",
        placement: "top",
        title: "Right-click the project pill",
        body: "The toggle is per-project. Right-click the pill of the project you want to sandbox to open its context menu. (It's offered for local projects only — remote SSH projects run their agents on the host — and needs Linux or macOS; on Windows sandboxed agent tabs refuse to launch rather than silently run unconfined.)",
      },
      {
        id: "flip-toggle",
        anchor: null,
        placement: "bottom",
        title: "Enable the sandbox",
        body: "Click \"Run agents in Docker sandbox\". A ✓ appears beside it once it's on; click again to turn it back off. From now on, every new agent tab in this project launches inside a fresh container instead of on the host.",
      },
      {
        id: "build-image",
        anchor: null,
        placement: "bottom",
        title: "Provide the image",
        body: "The sandbox needs Docker installed and the image eldrun-agent-sandbox:latest present. Build it once with `docker build -t eldrun-agent-sandbox:latest docker/agent-sandbox`. If Docker or the image is missing, the agent tab opens with a clear error instead of silently running on the host.",
      },
      {
        id: "what-mounts",
        anchor: null,
        placement: "bottom",
        title: "What the container sees",
        body: "Each agent tab is its own `docker run --rm` container: it mounts the project folder plus the agent state it needs to resume (~/.claude, ~/.codex, Eldrun's state dir) and nothing else. Close the tab and the container is gone. Shell and Files tabs still run on the host as usual.",
      },
    ],
  },
  {
    id: "add-ssh-project",
    category: "Advanced",
    title: "Add an SSH project",
    blurb: "Work on a folder living on another machine — Eldrun runs it over SSH/SFTP (no mount).",
    steps: [
      {
        id: "open-add-menu",
        anchor: '[data-hint-anchor="add-project"]',
        placement: "top",
        title: "Open the add menu",
        body: "Click the + button beside your project pills, then pick New Project or Import Project. Both dialogs can host the project on a remote machine.",
      },
      {
        id: "flip-ssh-toggle",
        anchor: null,
        placement: "bottom",
        title: "Flip the SSH toggle",
        body: "Tick \"Remote (SSH) project\" at the top of the dialog. The dialog switches to remote mode: pick a Local location — where the project's synced local working copy will live — and the SSH connection fields appear below.",
      },
      {
        id: "optional-vpn",
        anchor: null,
        placement: "bottom",
        title: "Behind a VPN? (optional)",
        body: "If the host is only reachable over a VPN, tick \"Connect via OpenVPN\", pick a .ovpn config (copied into Eldrun) and enter its passphrase, then hit Connect VPN before connecting SSH. Needs openvpn + polkit installed.",
      },
      {
        id: "connect-ssh",
        anchor: null,
        placement: "bottom",
        title: "Connect to the host",
        body: "Type the SSH address as user@host or host:2222. Leave the password blank to use your SSH key/agent, or fill it in for password auth. Click Connect — Eldrun verifies it can reach the host.",
      },
      {
        id: "browse-remote",
        anchor: null,
        placement: "bottom",
        title: "Pick the remote folder",
        body: "Once connected, a remote file browser appears. Step into the directory you want, then click \"Use this folder\". On New it creates a subfolder there; on Import it registers it in place.",
      },
      {
        id: "create-mount",
        anchor: null,
        placement: "bottom",
        title: "Create and connect",
        body: "Finish naming and pick a Git hosting option, then Create/Import. Eldrun pairs the remote folder with your synced local copy: agent tabs work locally in it by default, shells run on the host, and file browsing and git go over SSH/SFTP — no sshfs/FUSE. Later, the pill's connection lamp reconnects the project on demand.",
      },
    ],
  },
  {
    id: "ssh-via-openvpn",
    category: "Advanced",
    title: "SSH project via OpenVPN",
    blurb: "Reach a host that's only available behind a VPN, then mount its folder over SSH.",
    steps: [
      {
        id: "open-add-menu",
        anchor: '[data-hint-anchor="add-project"]',
        placement: "top",
        title: "Open the add menu",
        body: "Click the + button beside your project pills and pick New Project or Import Project. Either dialog can host the project on a VPN-gated remote.",
      },
      {
        id: "flip-ssh-toggle",
        anchor: null,
        placement: "bottom",
        title: "Flip the SSH toggle",
        body: "Tick \"Remote (SSH) project\" at the top. The dialog switches to remote mode: a Local location picker for the synced local working copy, then the SSH connection fields — with an OpenVPN tunnel section above them.",
      },
      {
        id: "enable-vpn",
        anchor: null,
        placement: "bottom",
        title: "Enable the VPN tunnel",
        body: "Tick \"Connect via OpenVPN\" when the host is only reachable through the tunnel — Eldrun brings the tunnel up first, then connects SSH through it. Needs openvpn + polkit (pkexec) installed locally.",
      },
      {
        id: "pick-ovpn",
        anchor: null,
        placement: "bottom",
        title: "Choose your .ovpn config",
        body: "Hit Browse… next to \"OpenVPN config\" and select your .ovpn file. Eldrun copies it into its own config store so the tunnel can be re-established later.",
      },
      {
        id: "connect-vpn",
        anchor: null,
        placement: "bottom",
        title: "Enter the credentials and connect",
        body: "Type the VPN passphrase — or the account username and password, if your .ovpn uses those — then click \"Connect VPN\". pkexec prompts for elevation, openvpn dials the tunnel, and the button flips to \"Connected\" once it's up.",
      },
      {
        id: "connect-ssh",
        anchor: null,
        placement: "bottom",
        title: "Now connect SSH",
        body: "With the tunnel up, type the SSH address as user@host or host:2222. Leave the password blank to use your SSH key/agent, or fill it in for password auth. Click Connect — Eldrun reaches the host through the VPN.",
      },
      {
        id: "browse-and-create",
        anchor: null,
        placement: "bottom",
        title: "Pick the folder and create",
        body: "Step through the remote browser to your directory and click \"Use this folder\". Finish naming, pick a Git hosting option, then Create/Import. Eldrun connects over SSH/SFTP and pairs the folder with a synced local working copy — no local mount.",
      },
    ],
  },
  {
    id: "extend-to-remote",
    category: "Advanced",
    title: "Extend a local project to a remote",
    blurb: "Pair an existing local project with an SSH host — files stay local, git keeps the two in lockstep.",
    steps: [
      {
        id: "why-extend",
        anchor: ".project-pills-region",
        placement: "top",
        title: "Take a local project remote",
        body: "Already have a local project and want a copy on another machine? Extending pairs it with an SSH host without moving your files: your local folder stays put and becomes the mirror, Eldrun creates a matching folder on the host, and git keeps the two in lockstep. It's the reverse of adding a fresh SSH project.",
      },
      {
        id: "right-click-pill",
        anchor: ".project-pills-region",
        placement: "top",
        title: "Right-click the project pill",
        body: "Right-click the pill of the local project you want to extend to open its context menu, then pick \"Extend to remote…\". (It only shows for local projects — a project that's already remote has nothing to extend.)",
      },
      {
        id: "connect-host",
        anchor: null,
        placement: "bottom",
        title: "Connect to the host",
        body: "Type the SSH address as user@host or host:2222. Leave the password blank to use your SSH key/agent, or fill it in for password auth. If the host sits behind a VPN, flip \"Connect via OpenVPN\" (off by default) and bring up the tunnel first. Click Connect, then Next.",
      },
      {
        id: "pick-remote-folder",
        anchor: null,
        placement: "bottom",
        title: "Choose the remote folder",
        body: "A remote file browser appears. Step into the parent directory where the host copy should live and click \"Use this folder\" — Eldrun creates the project's folder there. Hit Next to review.",
      },
      {
        id: "review-and-extend",
        anchor: null,
        placement: "bottom",
        title: "Review Local ↔ Remote, then extend",
        body: "The summary shows your existing Local path paired with the new Remote path. Click \"Extend to remote\". Your local files aren't touched — they become the git-lockstep mirror, and you push them up to the host through git when you're ready.",
      },
    ],
  },
];
