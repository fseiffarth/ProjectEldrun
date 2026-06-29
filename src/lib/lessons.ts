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
 */
export interface Lesson {
  /** Stable id (also the React key in the picker). */
  id: string;
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
  {
    id: "add-project",
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
        body: "The New Project dialog asks for a name and an optional description, and lets you pick a Git mode (none, local repo, or a private/public remote). Flip the \"Remote (SSH) project\" toggle to host it on another machine instead.",
      },
      {
        id: "scaffold-create",
        anchor: null,
        placement: "bottom",
        title: "What you get",
        body: "Hit Create and Eldrun makes ~/eldrun/projects/<name>/, scaffolds AGENTS.md, CLAUDE.md, .gitignore, README and friends, and initializes the repo. Tick \"Skip scaffolding\" if you'd rather start empty.",
      },
    ],
  },
  {
    id: "import-project",
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
        body: "Import mode lets you keep the folder where it is, or copy/move it into Eldrun's projects folder. Set a name and git option, then confirm to add the pill.",
      },
      {
        id: "remote-import",
        anchor: null,
        placement: "bottom",
        title: "Remote? Flip the SSH toggle",
        body: "Tick \"Remote (SSH) project\" to import a folder living on another host. If configured, Eldrun mounts it over sshfs (with an optional OpenVPN step) and keeps it in place on the remote.",
      },
    ],
  },
  {
    id: "add-ssh-project",
    title: "Add an SSH project",
    blurb: "Work on a folder living on another machine — Eldrun mounts it over sshfs.",
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
        body: "Tick \"Remote (SSH) project\" at the top of the dialog. The local folder pickers disappear and the SSH connection fields take their place.",
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
        body: "Type the SSH address as user@host or host:2222. Leave the password blank to use your SSH key/agent, or fill it in (needs sshpass). Click Connect — Eldrun verifies it can reach the host.",
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
        title: "Create and mount",
        body: "Finish naming and pick a Git mode, then Create/Import. Eldrun mounts the remote folder over sshfs under its mounts directory and treats it like any local project. Requires sshfs/FUSE locally.",
      },
    ],
  },
  {
    id: "add-tab",
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
        body: "Right-click a tab to rename it inline; the × on a tab closes it. Reopening a closed agent respawns it fresh from the same + menu.",
      },
    ],
  },
  {
    id: "install-agent",
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
        body: "Open ⚙ → Manage Agents to install an agent CLI with one click, or copy its vendor command (e.g. npm i -g …). It then appears in the + menu.",
      },
      {
        id: "set-default",
        anchor: '[data-hint-anchor="settings"]',
        placement: "bottom",
        title: "Set your default agent",
        body: "In ⚙ → Settings, the Terminal picker chooses the default agent new tabs use. A missing command falls back to a shell, and closed agents respawn.",
      },
    ],
  },
  {
    id: "local-model",
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
        body: "In native file viewers, press Ctrl+Space to request a suggestion, then Tab to accept the ghost text. It's opt-in per file type (a privacy gate); Ctrl+Shift+Space cycles the completion length.",
      },
    ],
  },
  {
    id: "native-viewer",
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
        body: "PDFs, images, markdown, code, notebooks, tables, diffs, and TeX render in Eldrun's native viewer — no external app. The built-in viewer wins whenever one applies.",
      },
      {
        id: "default-app",
        anchor: '[data-hint-anchor="settings"]',
        placement: "bottom",
        title: "Change the handler",
        body: "Right-click a file → \"Set default app…\" to send a type to an external app instead. Toggle native viewers per type under ⚙ Settings.",
      },
    ],
  },
  {
    id: "arrange-tabs",
    title: "Arrange tabs",
    blurb: "Reorder tabs, split panes, and pop tabs into their own window.",
    steps: [
      {
        id: "intro",
        anchor: null,
        placement: "bottom",
        title: "Make room your way",
        body: "Every tab can be dragged. Reorder it, split the view, or pop it out into a separate window — all by dragging its tab. Let's walk through it.",
      },
      {
        id: "tab-bar",
        anchor: ".tab-bar",
        placement: "bottom",
        title: "The tab bar",
        body: "Each subwindow has its own tab strip. Drag a tab left or right within this bar to reorder it.",
      },
      {
        id: "add-tab",
        anchor: '[data-hint-anchor="tab-add"]',
        placement: "bottom",
        title: "Add a tab",
        body: "The + button opens a new shell, agent, or files tab in this group. More tabs means more to arrange.",
      },
      {
        id: "split",
        anchor: null,
        placement: "bottom",
        title: "Split a pane",
        body: "Drag a tab onto the edge of a pane — top, bottom, left, or right — to split the view and tile it side-by-side or stacked. Drop it in the middle instead to move it into that group.",
      },
      {
        id: "detach",
        anchor: null,
        placement: "bottom",
        title: "Pop out a window",
        body: "Drag a tab (or a whole tab bar) out of the app to detach it into its own floating OS window. Drag it back over Eldrun to dock it again.",
      },
      {
        id: "outro",
        anchor: null,
        placement: "bottom",
        title: "That's it",
        body: "Reorder within a bar, drop on an edge to split, drop in the center to merge, drag out to detach. Rearrange freely — your layout is saved.",
      },
    ],
  },
];
