//! What the app keeps inside a project: its own folder (inbox, outbox,
//! sessions, linked worktrees), the `info/exclude` rule for it, and its ref
//! namespace. Lazy: a project is brought over when it is opened (and its
//! local mirror and its remote side when a remote project connects), never
//! all at once at launch — a project folder may be on a disk that is not
//! mounted, or behind an SSH session that is not open.
//!
//! A project folder is not trusted. This renames a real directory only (a
//! link under the old name is left alone), touches nothing else in the tree,
//! and runs git only through the hardened, hook-less command builder. The
//! `.gitignore` is the project's own and is never edited; the app's rule
//! lives in `info/exclude`.
//!
//! Nothing here deletes data: the folder is renamed, and a ref is removed
//! under its old name only after the same commit is verified under the new
//! one. That is why these moves are not reported through
//! `services::local_loss` — its log raises a "local files were lost" warning,
//! and nothing is.

use std::path::Path;

use crate::brand::{Name, Pair};

/// What one project's migration did.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ProjectReport {
    /// The app's folder was renamed.
    pub folder_renamed: bool,
    /// Linked worktrees inside it that git was told the new path of.
    pub worktrees_repaired: usize,
    /// The `info/exclude` rule now names the current folder.
    pub exclude_updated: bool,
    /// Refs moved to the current namespace.
    pub refs_moved: usize,
    /// Why something was left under its old name.
    pub left: Vec<String>,
}

impl ProjectReport {
    pub fn changed(&self) -> bool {
        self.folder_renamed || self.exclude_updated || self.refs_moved > 0 || self.worktrees_repaired > 0
    }
}

fn git(root: &Path, args: &[&str]) -> Option<std::process::Output> {
    crate::commands::git::hookless_git_command_in(root, args).output().ok()
}

fn git_stdout(root: &Path, args: &[&str]) -> Option<String> {
    let out = git(root, args)?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// The repository's common git dir, absolute; `None` when `root` is not in a
/// repository.
fn git_common_dir(root: &Path) -> Option<std::path::PathBuf> {
    let dir = git_stdout(root, &["rev-parse", "--git-common-dir"])?;
    if dir.is_empty() {
        return None;
    }
    let dir = Path::new(&dir);
    Some(if dir.is_absolute() { dir.to_path_buf() } else { root.join(dir) })
}

/// Bring the project at `root` to the current names. Idempotent, and a no-op
/// while the name is unchanged.
pub fn migrate_project(pair: &Pair, root: &Path) -> ProjectReport {
    let mut report = ProjectReport::default();
    if !pair.renamed() || !root.is_dir() || !needs_work(pair, root) {
        return report;
    }
    rename_folder(pair, root, &mut report);
    if let Some(git_dir) = git_common_dir(root) {
        if report.folder_renamed {
            repair_worktrees(pair, root, &mut report);
        }
        update_exclude(pair, &git_dir, &mut report);
        exclude_folder_ignored_under_old_name(pair, root, &git_dir, &mut report);
        move_refs(pair, root, &mut report);
    }
    report
}

/// Whether anything of the app's under its old name is left in the project,
/// judged from the file system alone. The launch sweep asks this of every
/// known project, so a project that is done costs a few `stat`s and no `git`.
fn needs_work(pair: &Pair, root: &Path) -> bool {
    let old_folder = pair.legacy(Name::PROJECT_DIR).map(|old| root.join(old));
    if old_folder.is_some_and(|old| std::fs::symlink_metadata(old).is_ok_and(|meta| meta.is_dir())) {
        return true;
    }
    let git_dir = root.join(".git");
    match std::fs::symlink_metadata(&git_dir) {
        // A pointer file (the root is itself a linked worktree or a
        // submodule): the refs live elsewhere, so let git answer.
        Ok(meta) if meta.is_file() => true,
        Ok(meta) if meta.is_dir() => {
            let old_ns = pair.legacy(Name::GIT_REF_NAMESPACE);
            let old_rule = pair.legacy(Name::PROJECT_DIR_EXCLUDE_RULE);
            old_ns.as_ref().is_some_and(|ns| {
                has_file_under(&ns.split('/').fold(git_dir.clone(), |dir, part| dir.join(part)))
                    || std::fs::read_to_string(git_dir.join("packed-refs"))
                        .is_ok_and(|refs| refs.contains(&format!(" {ns}/")))
            }) || old_rule.is_some_and(|rule| {
                std::fs::read_to_string(git_dir.join("info").join("exclude"))
                    .is_ok_and(|rules| rules.lines().any(|line| line.trim() == rule))
            }) || gitignore_names_old_folder_only(pair, root, &git_dir)
        }
        _ => false,
    }
}

/// Whether any file sits under `dir` (git leaves the emptied folders of
/// deleted loose refs behind).
fn has_file_under(dir: &Path) -> bool {
    let mut stack = vec![dir.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            match entry.file_type() {
                Ok(kind) if kind.is_dir() => stack.push(entry.path()),
                Ok(_) => return true,
                Err(_) => {}
            }
        }
    }
    false
}

fn rename_folder(pair: &Pair, root: &Path, report: &mut ProjectReport) {
    let Some(old_name) = pair.legacy(Name::PROJECT_DIR) else { return };
    let old = root.join(&old_name);
    let new = root.join(pair.cur(Name::PROJECT_DIR));
    let Ok(meta) = std::fs::symlink_metadata(&old) else { return };
    if !meta.is_dir() {
        report.left.push(format!("{old_name} is not a plain folder"));
        return;
    }
    if std::fs::symlink_metadata(&new).is_ok() {
        // Both exist: a current build already works in the new one. Nothing
        // is merged; the old folder stays for the user to look through.
        crate::brand::legacy_hit("project-dir");
        report.left.push(format!("{old_name} stays: the current folder exists too"));
        return;
    }
    match std::fs::rename(&old, &new) {
        Ok(()) => report.folder_renamed = true,
        Err(error) => {
            crate::brand::legacy_hit("project-dir");
            report.left.push(format!("{old_name} could not be renamed: {error}"));
        }
    }
}

/// A linked worktree and the repository point at each other by absolute
/// path (`<worktree>/.git` and `.git/worktrees/<id>/gitdir`). After the
/// folder moved, `git worktree repair <paths>` rewrites both ends.
fn repair_worktrees(pair: &Pair, root: &Path, report: &mut ProjectReport) {
    let dir = root.join(pair.cur(Name::WORKTREES_DIR));
    let Ok(entries) = std::fs::read_dir(&dir) else { return };
    let moved: Vec<String> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.join(".git").is_file())
        .map(|path| path.to_string_lossy().into_owned())
        .collect();
    if moved.is_empty() {
        return;
    }
    let mut args = vec!["worktree", "repair"];
    args.extend(moved.iter().map(String::as_str));
    match git(root, &args) {
        Some(out) if out.status.success() => report.worktrees_repaired = moved.len(),
        Some(out) => report
            .left
            .push(format!("git worktree repair: {}", String::from_utf8_lossy(&out.stderr).trim())),
        None => report.left.push("git worktree repair could not run".into()),
    }
}

/// Replace the app's old rule in `info/exclude` by the current one. A repo
/// that never had the rule gets none here (the worktree code adds it when it
/// first needs it).
fn update_exclude(pair: &Pair, git_dir: &Path, report: &mut ProjectReport) {
    let Some(old_rule) = pair.legacy(Name::PROJECT_DIR_EXCLUDE_RULE) else { return };
    let new_rule = pair.cur(Name::PROJECT_DIR_EXCLUDE_RULE);
    let file = git_dir.join("info").join("exclude");
    let Ok(text) = std::fs::read_to_string(&file) else { return };
    if !text.lines().any(|line| line.trim() == old_rule) {
        return;
    }
    let has_new = text.lines().any(|line| line.trim() == new_rule);
    let mut out = String::with_capacity(text.len());
    for line in text.split_inclusive('\n') {
        if line.trim() == old_rule {
            if !has_new {
                out.push_str(&line.replace(&old_rule, &new_rule));
            }
        } else {
            out.push_str(line);
        }
    }
    if std::fs::write(&file, out).is_ok() {
        report.exclude_updated = true;
    }
}

/// Whether one line of an ignore file names `dir` at the top of the tree
/// (`.x`, `.x/`, `/.x/`).
fn names_dir(rules: &str, dir: &str) -> bool {
    rules
        .lines()
        .any(|line| line.trim().trim_start_matches('/').trim_end_matches('/') == dir)
}

/// The launch sweep's cheap look for what
/// [`exclude_folder_ignored_under_old_name`] fixes: the project's own
/// `.gitignore` names the old folder, nothing names the current one, and the
/// current one is there. No `git`.
fn gitignore_names_old_folder_only(pair: &Pair, root: &Path, git_dir: &Path) -> bool {
    let Some(old_dir) = pair.legacy(Name::PROJECT_DIR) else { return false };
    let new_dir = pair.cur(Name::PROJECT_DIR);
    if !root.join(&new_dir).is_dir() {
        return false;
    }
    let gitignore = std::fs::read_to_string(root.join(".gitignore")).unwrap_or_default();
    let exclude = std::fs::read_to_string(git_dir.join("info").join("exclude")).unwrap_or_default();
    names_dir(&gitignore, &old_dir) && !names_dir(&gitignore, &new_dir) && !names_dir(&exclude, &new_dir)
}

/// An older scaffold wrote the old folder's name into the project's own
/// `.gitignore`. That file is never edited, so once the folder is renamed git
/// sees it, and every tab-layout save shows up in `git status`. When git
/// ignored the folder under its old name and does not under the current one,
/// the current rule goes into `info/exclude`, where the app keeps it anyway.
/// Runs after the rename and again on a project renamed before this existed.
fn exclude_folder_ignored_under_old_name(pair: &Pair, root: &Path, git_dir: &Path, report: &mut ProjectReport) {
    let Some(old_dir) = pair.legacy(Name::PROJECT_DIR) else { return };
    let new_dir = pair.cur(Name::PROJECT_DIR);
    if !root.join(&new_dir).is_dir() {
        return;
    }
    // A trailing slash makes git match a directory rule against a folder that
    // no longer exists. Exit 0 = ignored, 1 = not; anything else is an error.
    let ignored = |dir: &str| {
        git(root, &["check-ignore", "-q", "--", &format!("{dir}/")]).and_then(|out| out.status.code())
    };
    if ignored(&old_dir) != Some(0) || ignored(&new_dir) != Some(1) {
        return;
    }
    let rule = pair.cur(Name::PROJECT_DIR_EXCLUDE_RULE);
    let info = git_dir.join("info");
    let file = info.join("exclude");
    let mut rules = std::fs::read_to_string(&file).unwrap_or_default();
    if !rules.is_empty() && !rules.ends_with('\n') {
        rules.push('\n');
    }
    rules.push_str(&rule);
    rules.push('\n');
    if std::fs::create_dir_all(&info).is_ok() && std::fs::write(&file, rules).is_ok() {
        report.exclude_updated = true;
    }
}

/// `refs/<old>/…` → `refs/<current>/…`: create the new ref at the same
/// commit, read it back, and only then delete the old one. A new ref that
/// already exists at another commit is left, and so is its old twin.
fn move_refs(pair: &Pair, root: &Path, report: &mut ProjectReport) {
    let Some(old_ns) = pair.legacy(Name::GIT_REF_NAMESPACE) else { return };
    let new_ns = pair.cur(Name::GIT_REF_NAMESPACE);
    let old_prefix = format!("{old_ns}/");
    let Some(listing) = git_stdout(root, &["for-each-ref", "--format=%(objectname) %(refname)", &old_prefix]) else {
        return;
    };
    for line in listing.lines() {
        let Some((sha, old_ref)) = line.split_once(' ') else { continue };
        let Some(rest) = old_ref.strip_prefix(&old_prefix) else { continue };
        let new_ref = format!("{new_ns}/{rest}");
        let at_new = git_stdout(root, &["rev-parse", "-q", "--verify", &new_ref]);
        match at_new.as_deref() {
            Some(existing) if existing == sha => {}
            Some(_) => {
                crate::brand::legacy_hit("git-refs");
                report.left.push(format!("{old_ref} stays: {new_ref} is at another commit"));
                continue;
            }
            None => {
                // The all-zero old value makes this a create: it fails rather
                // than overwrite a ref that appeared meanwhile.
                let created = git(root, &["update-ref", &new_ref, sha, &"0".repeat(sha.len())])
                    .is_some_and(|out| out.status.success());
                if !created || git_stdout(root, &["rev-parse", "-q", "--verify", &new_ref]).as_deref() != Some(sha) {
                    crate::brand::legacy_hit("git-refs");
                    report.left.push(format!("{old_ref} stays: {new_ref} could not be written"));
                    continue;
                }
            }
        }
        // Delete only while the old ref is still at the commit that was copied.
        if git(root, &["update-ref", "-d", old_ref, sha]).is_some_and(|out| out.status.success()) {
            report.refs_moved += 1;
        }
    }
}

/// The same migration as a POSIX shell script, for the remote side of a
/// project: run over the live SSH session with the project's remote path as
/// the working directory. `None` while the name is unchanged.
///
/// Every name in it is the app's own, built here; nothing from the project
/// is interpolated.
pub fn remote_script(pair: &Pair) -> Option<String> {
    let old_dir = pair.legacy(Name::PROJECT_DIR)?;
    let new_dir = pair.cur(Name::PROJECT_DIR);
    let old_rule = pair.legacy(Name::PROJECT_DIR_EXCLUDE_RULE)?;
    let new_rule = pair.cur(Name::PROJECT_DIR_EXCLUDE_RULE);
    let old_ns = pair.legacy(Name::GIT_REF_NAMESPACE)?;
    let new_ns = pair.cur(Name::GIT_REF_NAMESPACE);
    let old_bundle = pair.legacy(Name::WORKER_BUNDLE)?;
    Some(format!(
        r#"set -u
if [ -d '{old_dir}' ] && [ ! -L '{old_dir}' ] && [ ! -e '{new_dir}' ] && [ ! -L '{new_dir}' ]; then
  if mv '{old_dir}' '{new_dir}'; then
    if git rev-parse --git-dir >/dev/null 2>&1; then
      for wt in '{new_dir}'/worktrees/*/; do
        [ -f "${{wt}}.git" ] && git -c core.hooksPath=/dev/null worktree repair "$wt" >/dev/null 2>&1
      done
    fi
    echo renamed
  fi
fi
rm -f '{old_bundle}'
git rev-parse --git-dir >/dev/null 2>&1 || exit 0
exclude="$(git rev-parse --git-common-dir)/info/exclude"
if [ -f "$exclude" ] && grep -qxF '{old_rule}' "$exclude"; then
  if grep -qxF '{new_rule}' "$exclude"; then
    grep -vxF '{old_rule}' "$exclude" > "$exclude.tmp$$" || true
  else
    sed 's|^{old_rule}$|{new_rule}|' "$exclude" > "$exclude.tmp$$"
  fi
  mv "$exclude.tmp$$" "$exclude" && echo exclude
fi
if [ -d '{new_dir}' ] && git check-ignore -q -- '{old_dir}/'; then
  git check-ignore -q -- '{new_dir}/'
  if [ $? -eq 1 ] && mkdir -p "${{exclude%/*}}"; then
    {{ [ -s "$exclude" ] && [ -n "$(tail -c 1 "$exclude")" ] && echo; printf '%s\n' '{new_rule}'; }} >> "$exclude" && echo exclude
  fi
fi
git for-each-ref --format='%(objectname) %(refname)' '{old_ns}/' | while read -r sha ref; do
  new="{new_ns}/${{ref#{old_ns}/}}"
  have="$(git rev-parse -q --verify "$new" 2>/dev/null || true)"
  if [ -z "$have" ]; then
    git update-ref "$new" "$sha" "$(printf '%0*d' "${{#sha}}" 0)" || continue
    have="$(git rev-parse -q --verify "$new" 2>/dev/null || true)"
  fi
  [ "$have" = "$sha" ] || continue
  git update-ref -d "$ref" "$sha" && echo "ref $ref"
done
exit 0
"#
    ))
}

/// Bring a project to the current names when it is opened: its folder (the
/// local mirror, for a remote project). Returns at once while the name is
/// unchanged; safe to call on every activation.
pub fn on_project_open(project_id: &str) {
    let pair = crate::brand::PAIR;
    if !pair.renamed() {
        return;
    }
    let root = if crate::services::remote::remote_target_for(project_id).is_some() {
        Some(crate::services::remote_sync::mirror_dir(project_id))
    } else {
        crate::services::sandbox::project_dir_for(project_id).map(std::path::PathBuf::from)
    };
    let Some(root) = root else { return };
    let report = migrate_project(&pair, &root);
    for line in &report.left {
        eprintln!("brand migration: project '{project_id}': {line}");
    }
    if report.changed() {
        super::lazy_ran(
            &pair,
            &crate::storage::state_dir(),
            "project-folders",
            &format!("last: {project_id}"),
        );
    }
}

/// Bring every known project on this machine to the current names, on a
/// background thread: local projects and the mirrors of remote ones. A
/// project is otherwise brought over when it is opened; this is what makes
/// the phone host and the sync layers — which reach a project without the
/// desktop opening it — find the app's folder where they look. Returns at
/// once while the name is unchanged.
pub fn sweep_at_launch() {
    if !crate::brand::PAIR.renamed() {
        return;
    }
    std::thread::spawn(|| {
        let list: crate::schema::projects::ProjectsList =
            crate::storage::read_json(&crate::storage::state_dir().join("projects.json")).unwrap_or_default();
        for project in &list {
            on_project_open(&project.id);
        }
    });
}

/// Bring the remote side of a project to the current names, over the live
/// SSH session. Blocking; called off the connect's critical path. Never on a
/// host the user called shared or a cluster login node: nothing runs there
/// in the background, and the old folder stays beside the new one.
pub fn on_remote_connect(project_id: &str, spec: &crate::schema::project::RemoteSpec) {
    let pair = crate::brand::PAIR;
    let Some(script) = remote_script(&pair) else { return };
    if crate::services::hpc_mode::is_careful_host(spec) {
        return;
    }
    let script = format!(
        "cd {} || exit 0\n{script}",
        crate::services::ssh_exec::shell_quote(&spec.remote_path)
    );
    match crate::services::ssh_exec::run_remote_script(spec, &script) {
        Ok(out) if !out.stdout.is_empty() => super::lazy_ran(
            &pair,
            &crate::storage::state_dir(),
            "remote-projects",
            &format!("last: {project_id}"),
        ),
        Ok(_) => {}
        Err(error) => eprintln!("brand migration: remote side of '{project_id}': {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::super::hits;
    use super::super::testing::*;
    use super::*;
    use crate::brand::LEGACY;

    fn run(root: &Path, args: &[&str]) -> String {
        let out = crate::commands::git::hookless_git_command_in(root, args)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.invalid")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.invalid")
            .output()
            .expect("git runs");
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// A repository as a build named `forms` leaves it: a commit, the app's
    /// folder with an inbox file and a linked worktree, the exclude rule,
    /// and refs in the app's namespace.
    fn seed_repo(root: &Path, forms: &crate::brand::Forms) -> String {
        std::fs::create_dir_all(root).expect("mkdir");
        run(root, &["init", "-q", "-b", "main"]);
        write(&root.join("a.txt"), "a\n");
        run(root, &["add", "a.txt"]);
        run(root, &["commit", "-q", "-m", "first"]);
        let head = run(root, &["rev-parse", "HEAD"]);
        write(&root.join(forms.name(Name::INBOX_DIR)).join("from-phone.txt"), "hello\n");
        let worktree = root.join(forms.name(Name::WORKTREES_DIR)).join("feature");
        run(root, &["worktree", "add", "-q", "-b", "feature", &worktree.to_string_lossy()]);
        let exclude = root.join(".git").join("info").join("exclude");
        let mut rules = std::fs::read_to_string(&exclude).unwrap_or_default();
        rules.push_str(&format!("# mine\n*.log\n{}\n", forms.name(Name::PROJECT_DIR_EXCLUDE_RULE)));
        write(&exclude, &rules);
        run(root, &["update-ref", &format!("{}/1700000000/main", forms.name(Name::GIT_REF_BACKUP)), &head]);
        run(root, &["update-ref", &format!("{}/main", forms.name(Name::GIT_REF_PEER)), &head]);
        run(root, &["update-ref", &format!("{}/heads/main", forms.name(Name::GIT_REF_INCOMING)), &head]);
        head
    }

    fn assert_migrated(root: &Path, head: &str) {
        let new_dir = root.join(RENAMED.cur(Name::PROJECT_DIR));
        assert!(!root.join(LEGACY.name(Name::PROJECT_DIR)).exists());
        assert_eq!(
            std::fs::read_to_string(new_dir.join("inbox").join("from-phone.txt")).expect("inbox file"),
            "hello\n"
        );
        // The worktree under the renamed folder still works, from both ends.
        let worktree = root.join(RENAMED.cur(Name::WORKTREES_DIR)).join("feature");
        assert_eq!(run(&worktree, &["rev-parse", "--abbrev-ref", "HEAD"]), "feature");
        assert_eq!(run(&worktree, &["status", "--porcelain"]), "");
        let listed = run(root, &["worktree", "list", "--porcelain"]);
        assert!(
            listed.contains(&format!("{}/worktrees/feature", RENAMED.cur(Name::PROJECT_DIR))),
            "{listed}"
        );
        assert!(!listed.contains(&LEGACY.name(Name::WORKTREES_DIR)), "{listed}");
        write(&worktree.join("b.txt"), "b\n");
        run(&worktree, &["add", "b.txt"]);
        run(&worktree, &["commit", "-q", "-m", "in the worktree"]);
        // The exclude rule follows, the user's own rules stay, and the new
        // folder is ignored.
        let rules = std::fs::read_to_string(root.join(".git").join("info").join("exclude")).expect("exclude");
        assert!(rules.contains("# mine\n*.log\n"));
        assert!(rules.lines().any(|line| line == RENAMED.cur(Name::PROJECT_DIR_EXCLUDE_RULE)));
        assert!(!rules.lines().any(|line| line == LEGACY.name(Name::PROJECT_DIR_EXCLUDE_RULE)));
        assert_eq!(run(root, &["status", "--porcelain"]), "");
        // Every ref moved, at the same commit.
        let refs = run(root, &["for-each-ref", "--format=%(objectname) %(refname)", "refs/"]);
        for moved in [
            format!("{}/1700000000/main", RENAMED.cur(Name::GIT_REF_BACKUP)),
            format!("{}/main", RENAMED.cur(Name::GIT_REF_PEER)),
            format!("{}/heads/main", RENAMED.cur(Name::GIT_REF_INCOMING)),
        ] {
            assert!(refs.contains(&format!("{head} {moved}")), "{moved} missing in:\n{refs}");
        }
        assert!(!refs.contains(&format!("{}/", LEGACY.name(Name::GIT_REF_NAMESPACE))), "{refs}");
    }

    #[test]
    fn a_project_is_brought_over_and_its_worktree_still_works() {
        let machine = Machine::new();
        let root = machine.home.join("alpha");
        let head = seed_repo(&root, &LEGACY);

        let report = migrate_project(&RENAMED, &root);
        assert_eq!(
            report,
            ProjectReport {
                folder_renamed: true,
                worktrees_repaired: 1,
                exclude_updated: true,
                refs_moved: 3,
                left: vec![],
            }
        );
        assert_migrated(&root, &head);

        // A second run changes nothing.
        let before = snapshot(&root.join(RENAMED.cur(Name::PROJECT_DIR)));
        assert_eq!(migrate_project(&RENAMED, &root), ProjectReport::default());
        assert_eq!(snapshot(&root.join(RENAMED.cur(Name::PROJECT_DIR))), before);
    }

    #[test]
    fn the_unchanged_pair_leaves_a_project_alone() {
        let machine = Machine::new();
        let root = machine.home.join("alpha");
        seed_repo(&root, &UNCHANGED.cur);
        let before = snapshot(&root);
        assert_eq!(migrate_project(&UNCHANGED, &root), ProjectReport::default());
        assert_eq!(snapshot(&root), before);
        assert_eq!(remote_script(&UNCHANGED), None);
    }

    /// The launch sweep's fast path: once a project is done, nothing in it
    /// asks for git — and packed refs under the old namespace still count.
    #[test]
    fn a_finished_project_needs_no_work_and_packed_refs_still_do() {
        let machine = Machine::new();
        let root = machine.home.join("alpha");
        seed_repo(&root, &LEGACY);
        assert!(needs_work(&RENAMED, &root));
        migrate_project(&RENAMED, &root);
        assert!(!needs_work(&RENAMED, &root));

        let packed = machine.home.join("packed");
        let head = seed_repo(&packed, &LEGACY);
        std::fs::rename(packed.join(LEGACY.name(Name::PROJECT_DIR)), packed.join("moved-away")).expect("rename");
        let exclude = packed.join(".git").join("info").join("exclude");
        write(&exclude, "*.log\n");
        run(&packed, &["pack-refs", "--all", "--prune"]);
        assert!(needs_work(&RENAMED, &packed), "packed refs under the old namespace");
        let report = migrate_project(&RENAMED, &packed);
        assert_eq!(report.refs_moved, 3, "{report:?}");
        assert_eq!(
            run(&packed, &["rev-parse", &format!("{}/main", RENAMED.cur(Name::GIT_REF_PEER))]),
            head
        );
        assert!(!needs_work(&RENAMED, &packed));
        // A plain folder with nothing of the app's in it.
        let plain = machine.home.join("plain-folder");
        write(&plain.join("notes.txt"), "n");
        assert!(!needs_work(&RENAMED, &plain));
    }

    #[test]
    fn a_folder_that_is_not_a_repository_is_only_renamed() {
        let machine = Machine::new();
        let root = machine.home.join("plain");
        write(&root.join(LEGACY.name(Name::OUTBOX_DIR)).join("x.pdf"), "pdf");
        let report = migrate_project(&RENAMED, &root);
        assert!(report.folder_renamed && report.refs_moved == 0 && report.left.is_empty(), "{report:?}");
        assert!(root.join(RENAMED.cur(Name::OUTBOX_DIR)).join("x.pdf").is_file());
    }

    #[test]
    fn a_folder_under_both_names_is_not_merged() {
        let machine = Machine::new();
        let root = machine.home.join("both");
        write(&root.join(LEGACY.name(Name::INBOX_DIR)).join("old.txt"), "old");
        write(&root.join(RENAMED.cur(Name::INBOX_DIR)).join("new.txt"), "new");
        let before = snapshot(&root);
        let _ = hits::taken();
        let report = migrate_project(&RENAMED, &root);
        assert!(!report.folder_renamed && report.left.len() == 1, "{report:?}");
        assert_eq!(snapshot(&root), before);
        assert_eq!(hits::taken_here(), ["project-dir"]);
    }

    #[cfg(unix)]
    #[test]
    fn a_link_under_the_old_name_is_left_alone() {
        let machine = Machine::new();
        let root = machine.home.join("linked");
        let elsewhere = machine.home.join("elsewhere");
        write(&elsewhere.join("secret.txt"), "s");
        std::fs::create_dir_all(&root).expect("mkdir");
        std::os::unix::fs::symlink(&elsewhere, root.join(LEGACY.name(Name::PROJECT_DIR))).expect("symlink");
        let before = snapshot(&machine.home);
        let report = migrate_project(&RENAMED, &root);
        assert!(!report.folder_renamed, "{report:?}");
        assert_eq!(snapshot(&machine.home), before);
    }

    #[test]
    fn a_ref_the_current_namespace_already_has_elsewhere_keeps_both() {
        let machine = Machine::new();
        let root = machine.home.join("alpha");
        let head = seed_repo(&root, &LEGACY);
        write(&root.join("c.txt"), "c\n");
        run(&root, &["add", "c.txt"]);
        run(&root, &["commit", "-q", "-m", "second"]);
        let second = run(&root, &["rev-parse", "HEAD"]);
        let new_peer = format!("{}/main", RENAMED.cur(Name::GIT_REF_PEER));
        let old_peer = format!("{}/main", LEGACY.name(Name::GIT_REF_PEER));
        run(&root, &["update-ref", &new_peer, &second]);

        let report = migrate_project(&RENAMED, &root);
        assert_eq!(report.refs_moved, 2, "{report:?}");
        assert_eq!(run(&root, &["rev-parse", &new_peer]), second);
        assert_eq!(run(&root, &["rev-parse", &old_peer]), head);
    }

    /// A repository whose committed `.gitignore` (an older scaffold's) names
    /// the app's folder as a build named `forms` called it, with a session
    /// file in that folder, and no exclude rule.
    fn seed_gitignored_repo(root: &Path, forms: &crate::brand::Forms) {
        std::fs::create_dir_all(root).expect("mkdir");
        run(root, &["init", "-q", "-b", "main"]);
        write(&root.join(".gitignore"), &format!("*.log\n{}\n", forms.name(Name::PROJECT_DIR_EXCLUDE_RULE)));
        run(root, &["add", ".gitignore"]);
        run(root, &["commit", "-q", "-m", "first"]);
        write(&root.join(forms.name(Name::PROJECT_DIR)).join("sessions").join("terminals.json"), "{}\n");
        assert_eq!(run(root, &["status", "--porcelain"]), "");
    }

    #[test]
    fn a_folder_the_gitignore_named_under_the_old_name_stays_ignored() {
        let machine = Machine::new();
        let root = machine.home.join("alpha");
        seed_gitignored_repo(&root, &LEGACY);
        let gitignore = std::fs::read_to_string(root.join(".gitignore")).expect("gitignore");

        let report = migrate_project(&RENAMED, &root);
        assert!(report.folder_renamed && report.exclude_updated, "{report:?}");
        assert_eq!(run(&root, &["status", "--porcelain"]), "");
        // The project's own file is untouched; the rule went into info/exclude.
        assert_eq!(std::fs::read_to_string(root.join(".gitignore")).expect("gitignore"), gitignore);
        assert!(!needs_work(&RENAMED, &root));
        assert_eq!(migrate_project(&RENAMED, &root), ProjectReport::default());
    }

    /// A project renamed by a build without this step: the folder already
    /// carries the current name and shows in `git status`.
    #[test]
    fn a_project_renamed_before_is_healed() {
        let machine = Machine::new();
        let root = machine.home.join("alpha");
        seed_gitignored_repo(&root, &LEGACY);
        std::fs::rename(root.join(LEGACY.name(Name::PROJECT_DIR)), root.join(RENAMED.cur(Name::PROJECT_DIR)))
            .expect("rename");
        assert_ne!(run(&root, &["status", "--porcelain"]), "");
        assert!(needs_work(&RENAMED, &root));

        let report = migrate_project(&RENAMED, &root);
        assert_eq!(report, ProjectReport { exclude_updated: true, ..ProjectReport::default() });
        assert_eq!(run(&root, &["status", "--porcelain"]), "");
        assert!(!needs_work(&RENAMED, &root));

        // A `.gitignore` that already names both folders needs nothing.
        let both = machine.home.join("both");
        seed_gitignored_repo(&both, &LEGACY);
        std::fs::rename(both.join(LEGACY.name(Name::PROJECT_DIR)), both.join(RENAMED.cur(Name::PROJECT_DIR)))
            .expect("rename");
        let mut rules = std::fs::read_to_string(both.join(".gitignore")).expect("gitignore");
        rules.push_str(&format!("{}\n", RENAMED.cur(Name::PROJECT_DIR_EXCLUDE_RULE)));
        write(&both.join(".gitignore"), &rules);
        assert!(!needs_work(&RENAMED, &both));
    }

    #[cfg(unix)]
    #[test]
    fn the_remote_script_keeps_a_gitignored_folder_ignored() {
        let machine = Machine::new();
        let root = machine.home.join("remote");
        seed_gitignored_repo(&root, &LEGACY);
        // An exclude file without a final newline must not have its last
        // rule glued to ours.
        write(&root.join(".git").join("info").join("exclude"), "*.tmp");
        let script = remote_script(&RENAMED).expect("a script when renamed");
        let run_script = || {
            let out = std::process::Command::new("sh")
                .args(["-c", &script])
                .current_dir(&root)
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_SYSTEM", "/dev/null")
                .output()
                .expect("sh runs");
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
            String::from_utf8_lossy(&out.stdout).into_owned()
        };
        let said = run_script();
        assert!(said.contains("renamed") && said.contains("exclude"), "{said}");
        assert_eq!(run(&root, &["status", "--porcelain"]), "");
        let rules = std::fs::read_to_string(root.join(".git").join("info").join("exclude")).expect("exclude");
        assert_eq!(rules, format!("*.tmp\n{}\n", RENAMED.cur(Name::PROJECT_DIR_EXCLUDE_RULE)));
        assert_eq!(run_script(), "");
    }

    /// The remote side runs the shell twin over SSH; here it runs in a local
    /// shell against the same seeded repository and must leave it the same.
    #[cfg(unix)]
    #[test]
    fn the_remote_script_does_the_same_as_the_local_migration() {
        let machine = Machine::new();
        let root = machine.home.join("remote");
        let head = seed_repo(&root, &LEGACY);
        write(&root.join(LEGACY.name(Name::WORKER_BUNDLE)), "stale bundle");
        let script = remote_script(&RENAMED).expect("a script when renamed");
        let run_script = || {
            let out = std::process::Command::new("sh")
                .args(["-c", &script])
                .current_dir(&root)
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_SYSTEM", "/dev/null")
                .output()
                .expect("sh runs");
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
            String::from_utf8_lossy(&out.stdout).into_owned()
        };
        let said = run_script();
        assert!(said.contains("renamed") && said.contains("exclude"), "{said}");
        assert_eq!(said.matches("ref ").count(), 3, "{said}");
        assert!(!root.join(LEGACY.name(Name::WORKER_BUNDLE)).exists());
        assert_migrated(&root, &head);
        // Idempotent: a second run says nothing.
        assert_eq!(run_script(), "");
    }
}
