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
