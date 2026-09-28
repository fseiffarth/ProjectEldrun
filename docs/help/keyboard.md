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
| Ctrl+Shift+Space | Enter keyboard steering mode |
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

## Steering mode

Press **Ctrl+Shift+Space**. A legend appears at the bottom and the app answers
single keys, even while a terminal has focus:

| Key | Action |
|---|---|
| 1–9 | Jump to a station: 1 is the root, 2 the first project pill (leaves the mode) |
| ↑ ↓ ← → | Move pane focus (each pane shows its step count) |
| Tab / Shift+Tab | Next / previous tab in the focused pane |
| F | Toggle the pane's file viewer |
| P | Toggle the side panels |
| W | Close the active tab |
| S | Open Settings (leaves the mode) |
| ? | Open the cheat sheet (leaves the mode) |
| Esc / Enter | Leave steering mode |

## In editors and viewers

- **Ctrl+Space** asks the local model for an autocomplete suggestion (when
  autocomplete is on for that file type). Tab accepts it, Alt+→ takes one
  word, Shift+Tab cycles the length (sentence → block → scope), Esc dismisses.
- TeX workspace: Ctrl+Shift+B saves and compiles; Alt+Shift+↑ goes up to the
  parent document; Alt+Shift+↓ goes back to the previous file.

## In terminals

- Click a link to open it in your browser; **double-click** it to copy it to
  the clipboard instead.
