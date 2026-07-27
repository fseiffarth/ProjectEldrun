## Group E — Git Worktree (new feature)
*Implemented in `src-tauri/src/commands/git.rs` + `src/components/files/GitHistory.tsx`.*

23. **Git worktree support.** [DONE] Backend commands
    `git_worktree_list`/`git_worktree_add`/`git_worktree_remove`/`git_worktree_prune`
    (porcelain parser, registered in `lib.rs`) plus a "Worktrees" section in the
    history view (list, create-from-branch, remove). STRETCH "open worktree as
    project" intentionally deferred.

---
