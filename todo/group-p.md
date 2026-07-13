## Group P — Git Hosting: Multi-Host Publishing (new feature)
*Builds on Group D.10 (#22 publish flow). Files: `src-tauri/src/commands/github.rs`
(`github_publish`, currently GitHub/`gh`-only), `git_hosting` creds, `ProjectPill.tsx`
(the "Publish to GitHub…" menu entry + Publish window + per-project "Git hosting…"
override), `src/stores/projects.ts` (`publishProject`), settings git-hosting
profile (URL + token). Today publishing is hardcoded to the GitHub `gh` CLI
(`gh repo create … --source=. --push`); there is no GitLab or generic remote path.*

79. **Publish to GitLab and to a generic remote.** Generalize the GitHub-only
    publish flow so a project can be connected to other hosts:
    - **GitLab support.** Add a GitLab publish path (via the `glab` CLI mirroring
      the `gh` approach, or the GitLab REST API + token from the git-hosting
      profile) that creates the project repo and pushes. Pick the host from the
      git-hosting profile rather than assuming GitHub.
    - **Generic remote URL.** Add a "set remote URL" path for self-hosted /
      arbitrary hosts: `git remote add origin <url>` + `git push -u origin
      <branch>`, no host CLI required — for users who already created the empty
      remote repo themselves.
    - **UI.** Rename the pill's "Publish to GitHub…" entry to a host-agnostic
      "Publish…"/"Connect remote…" that offers GitHub / GitLab / custom URL,
      reusing the existing visibility picker and per-project git-hosting override.
    - **Backend.** Decouple `github_publish` from `gh`: dispatch on a host enum,
      keep the SSH-work-remote case (run the host CLI where the bytes live), and
      keep recording `git_type = remote-<visibility>` on success.
    - [ ] 🤖 Automated test — host-dispatch + argv-escaping unit tests per host
      (mirroring `commands/github.rs` `shell_quote` tests); full publish flow stays manual.
    - [ ] 🖐️ Manual test — publish a local project to GitLab and to a custom
      remote URL; confirm the repo is created/pushed and `git_type` flips to
      `remote-<visibility>`.
