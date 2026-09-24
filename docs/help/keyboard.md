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
| F11 | Toggle the app window's fullscreen |
| Super (Linux, when the desktop leaves it to the window) or F9 | Show/hide the side panels |
| Esc | Leave a pane's in-app fullscreen; close dialogs |
| Ctrl + / − / 0 | Zoom the interface in / out / reset |

## Navigation

| Default | Action |
|---|---|
| Ctrl+Shift+Tab | Next project |
| Ctrl+Shift+← | Previous project |
| Ctrl+Shift+PageDown / PageUp | Next / previous box |
| Ctrl+Shift+R | Open / close the root console |
| Ctrl+Shift+Space | Enter keyboard steering mode |
| F1 | Shortcut help |

## Tabs and panes

| Default | Action |
|---|---|
| Shift+← / Shift+→ | Previous / next tab in the pane |
| Shift+Tab | Cycle tabs in the pane |
| Shift+↑ / Shift+↓ | Cycle pane focus up / down |
| Ctrl+Enter | Toggle the focused pane's fullscreen |
| Shift+F | Toggle the pane's docked file viewer |
| Ctrl+Shift+H | Hide the focused pane |
| Ctrl+W | Close the active tab |
| Ctrl+Shift+W | Close the focused pane |
| Ctrl+Shift+Alt+W | Close all tabs in the project |

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
- TeX workspace: Ctrl+Shift+B saves and compiles; Ctrl+Shift+↑ goes up to the
  parent document; Ctrl+Shift+↓ goes back to the previous file.
