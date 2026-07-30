## Group T — Smart / Native Shell Terminal (new feature, research done)

*Files (future): `src/components/terminal/TerminalView.tsx`,
`src-tauri/src/terminal/mod.rs`, `src-tauri/src/commands/ollama.rs`
(new shell-completion command, distinct from existing `complete_text`).*

- [ ] **Live incremental history-search overlay.** Auto-triggered
  type-to-filter dropdown over the terminal (reuse the `createPortal`
  overlay pattern from `FileTree.tsx`) instead of manual Ctrl+R; replays
  shell history and injects the chosen line via the existing `pty_write`
  path. No shell integration required.
- [ ] **Local-model shell-command autocomplete overlay.** New Ollama-backed
  completion command scoped to shell commands/history (separate from the
  existing code-file `complete_text`), surfaced as an overlay a user can
  accept into the PTY.
- [ ] **Terminal font settings.** Font family/size is currently hardcoded
  (`TerminalView.tsx`); only color scheme is configurable today. Add a
  settings UI control.
- [ ] ⛔ **Ghost-text autosuggestion + de-duplicated path display —
  blocked pending design.** Requires the shell to emit OSC 133/7 semantic
  prompt marks, which bash/zsh don't do by default; would need an
  **opt-in, user-installed** shell-integration snippet (never an automatic
  rc edit — violates the "no foreign app paths" policy). Needs a decision
  on the opt-in install UX before scoping further (see prior art: Warp,
  iTerm2, VS Code shell integration installers).

---
