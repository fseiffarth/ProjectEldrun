---
id: keyboard
title: Keyboard shortcuts and steering mode
keywords: [keyboard, shortcut, hotkey, keys, steering, chord, rebind, f1, cheat sheet, navigation]
---

All chords below are defaults. Rebind them in Settings → General → Keyboard
Shortcuts, which warns about collisions and has Reset all. On macOS, ⌘ takes
the place of Ctrl. **F1** opens the cheat sheet with every effective binding.

## Fixed keys

| Key | Action |
|---|---|
| F11 | Toggle fullscreen for the window you're in — the main window or a popout (same as the fullscreen button beside minimize) |
| Super (Linux, when the desktop leaves it to the window) or F9 | Show/hide the side panels |
| Esc | Leave a pane's in-app fullscreen; close dialogs |
| Ctrl + / − / 0 | Zoom the interface in / out / reset |

## Navigation

| Default | Action |
|---|---|
| Ctrl+Shift+Tab | Next project |
| Alt+Shift+← | Previous project |
| Ctrl+Shift+PageDown / PageUp | Next / previous box |
| Ctrl+Shift+R | Open / close the root console |
| Shift+Space | Enter keyboard steering mode |
| F1 | Shortcut help |

## Tabs and panes

| Default | Action |
|---|---|
| Ctrl+Shift+← / Ctrl+Shift+→ | Previous / next tab in the pane — from a focused terminal too (a program in it then never gets these keys; plain Shift+←/→ is left to it, e.g. an agent CLI's own use of it) |
| Shift+Tab | Cycle tabs in the pane |
| Ctrl+Shift+↑ / Ctrl+Shift+↓ | Cycle pane focus up / down |
| Ctrl+Enter | Toggle the focused pane's fullscreen |
| Shift+F | Toggle the pane's docked file viewer |
| Ctrl+Shift+H | Hide the focused pane |
| Ctrl+W | Close the active tab |
| Ctrl+Shift+W | Close the focused pane |
| Ctrl+Shift+Alt+W | Close all tabs in the project |
| Ctrl+Shift+T | Reopen the last closed agent tab, resuming its conversation (works from a focused terminal; in a popout window it reopens into that window) |

## New tabs

Each opens a tab in the focused pane of the main window and puts the cursor
in it — from a focused terminal too. The + menu shows each chord beside its
entry.

| Default | Action |
|---|---|
| Ctrl+Shift+N | New shell |
| Ctrl+Shift+M | System Monitor (focuses it if the pane's scope already has one) |
| Ctrl+1 | New tab with your default agent (set in the 🧠 menu) |
| Ctrl+2 … Ctrl+9 | The + menu's other agents, in the order it lists them |

To choose which agent each number opens, reorder them with ↑/↓ in
**Settings → Agents → Manage CLIs** (also the 🧠 menu's Manage CLIs…); each installed agent shows
its chord there. Once you have moved one, the list order is the numbering —
Ctrl+1 is the top agent rather than the default one.

## Steering mode

Press **Shift+Space**. A legend appears at the bottom and the app answers
single keys, even while a terminal has focus. (Mid-word, with Shift still held
from a capital, Shift+Space stays a plain space.) The mode opens on the
current project's tabs; **E S D F** work like **↑ ← ↓ →** throughout.

| Key | Action |
|---|---|
| S F / ← → | Previous / next tab (on the subwindow level: subwindow; on the project level: project) |
| E / ↑ | Up a level: tabs → subwindows → projects |
| D / ↓ | Back down a level |
| 1–9 | Tabs: new agent tab. Projects: jump to a station (1 = root, 2 = first pill) |
| N / M | New shell / System Monitor tab (projects: new project / mail) |
| + | The new-tab menu, walked with E/D; **/** types into its search |
| V | Toggle the pane's file viewer |
| W | Close the active tab |
| B | Open the side panel |
| P | Toggle the side panels |
| Q / R / X | Next tab waiting for an answer / working / done (Shift: previous) |
| , | Open Settings (leaves the mode) |
| ? | Open the cheat sheet (leaves the mode) |
| Space / Esc / Enter | Leave steering mode (Esc inside a panel or menu backs out of it) |

## In editors and viewers

- **Ctrl+Space** asks the local model for an autocomplete suggestion (when
  autocomplete is on for that file type). Tab accepts it, Alt+→ takes one
  word, Shift+Tab cycles the length (sentence → block → scope), Esc dismisses.
- TeX workspace: Ctrl+Shift+B saves and compiles; Alt+Shift+↑ goes up to the
  parent document; Alt+Shift+↓ goes back to the previous file.

## In terminals

- Click a link to open it in your browser; **double-click** it to copy it to
  the clipboard instead.
- **Select to copy**: drag over text and it is on the clipboard when you let
  go (a toast confirms, or says the clipboard refused it). This works in agent
  tabs too, even while the agent has the mouse. Alt+drag selects a rectangle.
- **Right-click** on selected text copies it and clears the highlight; with
  nothing selected, right-click goes to the program (Claude Code pastes).
- **Ctrl+Shift+C** copies the selection, **Ctrl+Shift+V** pastes (in agent
  tabs a double-click off a link pastes too). Plain Ctrl+C still interrupts
  the program.
- **Ctrl+Shift+X — keyboard select.** A cursor appears on the terminal cursor
  (or on an existing mouse selection) with a legend at the bottom of the pane:
  arrows or h/j/k/l move, Ctrl+←/→ jump by word, Home/End go to the line's
  ends, PageUp/PageDown by a screen, g/G to the top/bottom of the scrollback.
  Hold **Shift** while moving (or press **v**) to select, **V** for whole lines.
  **Enter**, **y** or Ctrl+C copies (with nothing selected: the cursor's line),
  **Esc** or **q** leaves. While it is on, no key reaches the program.
