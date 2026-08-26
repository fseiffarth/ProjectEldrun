## Group P — Git Hosting: Multi-Host Publishing (new feature)
**Status (reconciled 2026-07-28): the GitLab half is shipped and was never
recorded.** `commands/github.rs` has been **deleted** and replaced by
`commands/git_publish.rs` with a `Provider` enum (`:57-69`) dispatching `gh` and
`glab` (`:124,148`); the pill entry already reads "Publish to GitHub / GitLab…"
(`src/lib/i18n.ts:1026`). Only the **generic remote URL** bullet is still open —
`git_publish.rs:69` rejects anything that isn't github or gitlab, and
`git remote add origin` appears nowhere in the tree.

*Builds on Group D.10 (#22 publish flow). Files (as built):
`src-tauri/src/commands/git_publish.rs`, `git_hosting` creds, `ProjectPill.tsx`
(the publish menu entry + Publish window + per-project "Git hosting…"
override), `src/stores/projects.ts` (`publishProject`), settings git-hosting
profile (URL + token).*

79. **Publish to GitLab and to a generic remote.** Generalize the GitHub-only
    publish flow so a project can be connected to other hosts:
    - ✅ **GitLab support — DONE.** Add a GitLab publish path (via the `glab` CLI mirroring
      the `gh` approach, or the GitLab REST API + token from the git-hosting
      profile) that creates the project repo and pushes. Pick the host from the
      git-hosting profile rather than assuming GitHub.
    - **Generic remote URL.** Add a "set remote URL" path for self-hosted /
      arbitrary hosts: `git remote add origin <url>` + `git push -u origin
      <branch>`, no host CLI required — for users who already created the empty
      remote repo themselves.
    - ✅ **UI — DONE** (`src/lib/i18n.ts:1026`). Rename the pill's "Publish to GitHub…" entry to a host-agnostic
      "Publish…"/"Connect remote…" that offers GitHub / GitLab / custom URL,
      reusing the existing visibility picker and per-project git-hosting override.
    - ✅ **Backend — DONE** (`git_publish.rs:57-69` `Provider`). Decouple `github_publish` from `gh`: dispatch on a host enum,
      keep the SSH-work-remote case (run the host CLI where the bytes live), and
      keep recording `git_type = remote-<visibility>` on success.
    - [x] 🤖 Automated test — `git_publish.rs:926` `provider_parse_defaults_and_validates`
      and `:1048` `provider_failures_are_not_mistaken_for_transport_ones`;
      full publish flow stays manual. (Covers the two shipped hosts; a generic-URL
      case will need adding when that bullet lands.)
    - [ ] 🖐️ Manual test — publish a local project to GitLab and to a custom
      remote URL; confirm the repo is created/pushed and `git_type` flips to
      `remote-<visibility>`.
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

80. **The hosting choice at creation is honored, not just recorded** (fixed
    2026-08-26). "Push to GitHub/GitLab · private/public" in the new-project
    dialog wrote `git_type = remote-<visibility>` and stopped: no repository was
    created, no `origin` was wired, nothing was pushed — and since the Files
    view's Push button keys off an upstream branch, such a project had no push
    affordance either. Creating a project now runs the same
    `publish_project` the pill's Publish… window drives (`ProjectDialog.tsx`,
    `publishCreated`), and the pill's git menu asks `project_has_origin`
    (`git_publish.rs`) so a project *labeled* as published but lacking an origin
    is offered Publish… instead of the manage-a-repo actions that would all fail.
    - [x] 🤖 Automated test — `src/__tests__/ProjectDialogPublish.test.tsx`
      (publishes on create, keeps the dialog open + retries publish-only on
      failure, leaves a `local` git type alone) and
      `src/__tests__/ProjectPillPublishMenu.test.tsx` (menu follows the real
      origin, not the label).
    - Still open, deliberately:
      - A **work-remote** or **VM** project keeps the recorded push target and
        publishes from the pill later — the mirror has to be in lockstep first,
        and a VM guest has no hosting login. The dialog now says so instead of
        implying the repo exists.
      - Publishing needs `gh`/`glab` on PATH; a saved access token alone is not
        enough. The dialog blocks with a one-click install banner rather than
        failing at the end. A token-only path (provider REST API + `git remote
        add origin` + token push) would subsume this and the generic-URL bullet
        in #79.
      - The pill's *badge* still reads the label ("GitHub · private") for a
        never-published project; only the menu is origin-aware.
    - [ ] 🖐️ Manual test — create a project with "Push to GitHub · private" and
      confirm the repo appears on GitHub with the scaffold commit pushed, the
      pill shows the hosting badge, and the Files view offers Push after the
      next commit.
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work
