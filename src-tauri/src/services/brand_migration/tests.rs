//! The migrator as a whole: the no-op guarantee, a fresh install, an upgrade,
//! and a crash. Each step's own cases sit with the step.

use super::testing::*;
use super::*;
use crate::brand::{LEGACY, PAIR};

/// THE guarantee of this module while the name is unchanged: a launch of the
/// production pair over a used install moves nothing and writes nothing —
/// no record, no fallback log, no link. Not even an "all done" record: a step
/// marked done now would be skipped on the launch after the rename.
#[test]
fn with_the_name_unchanged_a_launch_touches_nothing() {
    if PAIR.renamed() {
        // After the rename this build *is* the migrating one; the guarantee
        // is then covered by `an_upgrade_runs_once`.
        return;
    }
    let machine = Machine::new();
    machine.seed_install(&PAIR.cur);
    let before = snapshot(&machine.home);
    let _ = hits::taken();

    let env = machine.env(PAIR);
    assert_eq!(env.legacy_state_dir, None);
    assert_eq!(env.webview_data, None);
    let report = run_startup(&env);

    assert_eq!(report, Report::default());
    assert!(!report.ran);
    assert_eq!(snapshot(&machine.home), before);
    assert!(machine.world.calls.borrow().is_empty());
    assert!(hits::taken().is_empty());
    assert!(!env.state_dir.join(RECORD_FILE).exists());
    assert!(!hits::path_in(&env.state_dir).exists());
    // The lazy entry points write nothing either.
    lazy_done(&PAIR, &env.state_dir, "mail-store", "");
    lazy_ran(&PAIR, &env.state_dir, "project-folders", "");
    lazy_pending(&PAIR, &env.state_dir, "keyring", "locked");
    assert_eq!(snapshot(&machine.home), before);
}

/// Every name's dual read collapses to a single lookup while the name is
/// unchanged: there is no old spelling to try.
#[test]
fn with_the_name_unchanged_no_name_has_an_old_spelling() {
    if PAIR.renamed() {
        return;
    }
    for (name, _, _) in crate::brand::Name::ALL {
        assert_eq!(PAIR.legacy(*name), None, "{name:?}");
    }
    assert_eq!(PAIR.legacy_env_name("TAB_UID"), None);
}

#[test]
fn a_fresh_install_never_spells_the_old_name() {
    let machine = Machine::new();
    let env = machine.env(RENAMED);
    let report = run_startup(&env);
    assert!(report.ran && report.pending.is_empty(), "{report:?}");
    // First launch creates the state dir afterwards, as `run` does.
    std::fs::create_dir_all(&env.state_dir).expect("state dir");
    let report = run_startup(&env);
    assert!(report.pending.is_empty(), "{report:?}");

    let tree = snapshot(&machine.home);
    assert_eq!(spellings(&tree, LEGACY.slug), Vec::<String>::new());
    assert!(!machine.state_dir(&LEGACY).exists());
    assert!(std::fs::symlink_metadata(machine.state_dir(&LEGACY)).is_err(), "no link under the old name");
}

#[test]
fn an_upgrade_moves_the_state_dir_and_leaves_a_link() {
    let machine = Machine::new();
    machine.seed_install(&LEGACY);
    let old_state = machine.state_dir(&LEGACY);
    let new_state = machine.state_dir(&RENAMED.cur);
    let seeded = snapshot(&old_state);
    let _ = hits::taken();

    let env = machine.env(RENAMED);
    let report = run_startup(&env);
    assert!(report.pending.is_empty(), "{report:?}");

    // The folder is under the current name, with everything in it, and the
    // old path leads there.
    assert!(new_state.is_dir());
    assert!(std::fs::symlink_metadata(&old_state).expect("old path").file_type().is_symlink());
    assert_eq!(old_state.canonicalize().expect("link"), new_state);
    let moved = snapshot(&new_state);
    for path in seeded.keys().filter(|path| !path.contains("mobile-control/bin")) {
        assert!(moved.contains_key(path), "{path} is missing after the move");
    }
    // The old host was retired first, from the folder it ran in, and its
    // old-named copy is gone.
    assert_eq!(
        *machine.world.calls.borrow(),
        [format!("retire-mobile-host {}", old_state.display())]
    );
    assert!(!new_state
        .join("mobile-control")
        .join("bin")
        .join("1.0.0")
        .join(LEGACY.name(crate::brand::Name::MOBILE_HOST_BIN))
        .exists());

    let record = env.record();
    for id in ["mobile-host", "state-dir", "share-dir", "state-paths", "webview-data"] {
        assert_eq!(record.state_of(id), Some(StepState::Done), "{id}");
    }
}

#[test]
fn an_upgrade_runs_once() {
    let machine = Machine::new();
    machine.seed_install(&LEGACY);
    let env = machine.env(RENAMED);
    run_startup(&env);
    let after_first = snapshot(&machine.home);
    machine.world.calls.borrow_mut().clear();

    let report = run_startup(&env);
    assert_eq!(report, Report { ran: true, ..Report::default() });
    assert_eq!(snapshot(&machine.home), after_first);
    assert!(machine.world.calls.borrow().is_empty());
}

#[test]
fn stored_paths_into_the_state_dir_follow_it() {
    let machine = Machine::new();
    machine.seed_install(&LEGACY);
    let old_state = machine.state_dir(&LEGACY);
    let new_state = machine.state_dir(&RENAMED.cur);
    let env = machine.env(RENAMED);
    run_startup(&env);

    let mirror = new_state.join("remote-projects").join("beta").join("mirror");
    let projects = read_json(&new_state.join("projects.json"));
    assert_eq!(projects[1]["directory"], serde_json::json!(mirror));
    // A path outside the state dir is not touched, and neither is the rest
    // of the entry.
    assert_eq!(
        projects[0]["directory"],
        serde_json::json!(machine.home_tree(&LEGACY).join("projects").join("alpha"))
    );
    assert_eq!(projects[1]["remote"]["host"], "example.org");
    let tabs = read_json(&new_state.join("sessions").join("beta").join("tabs.json"));
    assert_eq!(tabs["tabs"][0]["cwd"], serde_json::json!(mirror));
    let sync = read_json(&new_state.join("remote-projects").join("beta").join("sync.json"));
    assert_eq!(sync["mirror"], serde_json::json!(mirror));
    let archived = read_json(&machine.home_tree(&LEGACY).join("archive").join("gamma").join("entry.json"));
    assert_eq!(archived["state"], serde_json::json!(new_state.join("remote-projects").join("gamma")));

    // No stored path names the old folder any more.
    let old_prefix = old_state.to_string_lossy().into_owned();
    for (path, content) in snapshot(&new_state) {
        if path != RECORD_FILE {
            assert!(!content.contains(&old_prefix), "{path} still names the old state dir");
        }
    }
}

#[test]
fn the_webview_data_is_copied_and_the_old_copy_stays() {
    let machine = Machine::new();
    machine.seed_install(&LEGACY);
    let env = machine.env(RENAMED);
    run_startup(&env);
    let old = machine.webview_data(&LEGACY);
    let new = machine.webview_data(&RENAMED.cur);
    assert_eq!(snapshot(&new), snapshot(&old));
    assert!(!snapshot(&old).is_empty());
}

#[test]
fn webview_data_the_current_identifier_already_has_is_not_overwritten() {
    let machine = Machine::new();
    machine.seed_install(&LEGACY);
    let new = machine.webview_data(&RENAMED.cur);
    write(&new.join("localstorage").join("app.localstorage"), "theme=light");
    run_startup(&machine.env(RENAMED));
    assert_eq!(
        std::fs::read_to_string(new.join("localstorage").join("app.localstorage")).expect("read"),
        "theme=light"
    );
}

/// Pull the plug at every checkpoint in turn; the launch after it finishes
/// the job, and the result is what an uninterrupted upgrade produces.
#[test]
fn a_crash_at_any_checkpoint_is_finished_by_the_next_launch() {
    let reference = Machine::new();
    reference.seed_install(&LEGACY);
    run_startup(&reference.env(RENAMED));
    let expected = snapshot(&reference.home);

    for checkpoint in [
        "dir:before-rename",
        "dir:after-rename",
        "paths:before-file",
        "copy:before-file",
        "webview:after-copy",
    ] {
        let machine = Machine::new();
        machine.seed_install(&LEGACY);
        let mut env = machine.env(RENAMED);
        env.crash_at = Some(checkpoint);
        let report = run_startup(&env);
        assert!(report.crashed, "{checkpoint} was never reached");

        env.crash_at = None;
        let report = run_startup(&env);
        assert!(!report.crashed && report.pending.is_empty(), "{checkpoint}: {report:?}");
        // Same tree as the uninterrupted run, with this machine's own home
        // in the stored paths.
        let got = snapshot(&machine.home);
        let reference_home = reference.home.to_string_lossy().into_owned();
        let home = machine.home.to_string_lossy().into_owned();
        assert_eq!(got.len(), expected.len(), "{checkpoint}");
        for (path, content) in &expected {
            assert_eq!(
                got.get(path).map(|got| got.replace(&home, &reference_home)).as_ref(),
                Some(content),
                "{checkpoint}: {path}"
            );
        }
    }
}

#[test]
fn a_state_dir_under_both_names_is_left_for_the_user() {
    let machine = Machine::new();
    machine.seed_install(&LEGACY);
    let new_state = machine.state_dir(&RENAMED.cur);
    write(&new_state.join("settings.json"), "{}");
    // Everything but the old phone host's copy, which is retired either way.
    let kept = |dir: &std::path::Path| {
        let mut tree = snapshot(dir);
        tree.retain(|path, _| !path.starts_with("mobile-control/bin/1.0.0/"));
        tree
    };
    let before = kept(&machine.state_dir(&LEGACY));
    let _ = hits::taken();

    let report = run_startup(&machine.env(RENAMED));
    assert!(report.pending.iter().any(|(id, _)| *id == "state-dir"), "{report:?}");
    assert_eq!(kept(&machine.state_dir(&LEGACY)), before);
    assert!(hits::taken().contains(&"state-dir".to_string()));
}

#[test]
fn an_empty_folder_under_the_current_name_does_not_block_the_move() {
    let machine = Machine::new();
    machine.seed_install(&LEGACY);
    std::fs::create_dir_all(machine.state_dir(&RENAMED.cur)).expect("mkdir");
    let report = run_startup(&machine.env(RENAMED));
    assert!(report.pending.is_empty(), "{report:?}");
    assert!(machine.state_dir(&RENAMED.cur).join("projects.json").is_file());
}

#[test]
fn a_sandboxed_instance_leaves_the_machine_alone() {
    let machine = Machine::new();
    machine.seed_install(&LEGACY);
    let before = snapshot(&machine.home);
    let mut env = machine.env(RENAMED);
    // What `Env::for_this_machine` builds when the environment names the
    // state dir.
    env.machine_wide = false;
    env.state_dir = machine.home.join("sandbox-state");
    env.legacy_state_dir = None;
    env.webview_data = None;
    std::fs::create_dir_all(&env.state_dir).expect("mkdir");
    let report = run_startup(&env);
    assert!(report.pending.is_empty(), "{report:?}");
    assert!(machine.world.calls.borrow().is_empty());
    let mut after = snapshot(&machine.home);
    after.retain(|path, _| !path.starts_with("sandbox-state"));
    assert_eq!(after, before);
}

#[test]
fn the_named_dir_resolution_prefers_the_current_name_and_counts_the_old_one() {
    let machine = Machine::new();
    let name = crate::brand::Name::HOME_DIR_NAME;
    let _ = hits::taken();
    // Neither exists: the current name, and nothing is counted.
    assert_eq!(
        resolve_named_dir(&RENAMED, name, &machine.home, "home-tree"),
        machine.home_tree(&RENAMED.cur)
    );
    assert!(hits::taken().is_empty());
    // Only the old one exists: it is used, and counted.
    std::fs::create_dir_all(machine.home_tree(&LEGACY)).expect("mkdir");
    assert_eq!(resolve_named_dir(&RENAMED, name, &machine.home, "home-tree"), machine.home_tree(&LEGACY));
    assert_eq!(hits::taken(), ["home-tree"]);
    // Both exist: the current one.
    std::fs::create_dir_all(machine.home_tree(&RENAMED.cur)).expect("mkdir");
    assert_eq!(
        resolve_named_dir(&RENAMED, name, &machine.home, "home-tree"),
        machine.home_tree(&RENAMED.cur)
    );
    assert!(hits::taken().is_empty());
}

#[test]
fn the_record_keeps_what_a_later_build_added() {
    let machine = Machine::new();
    let env = machine.env(RENAMED);
    std::fs::create_dir_all(&env.state_dir).expect("mkdir");
    write(
        &env.state_dir.join(RECORD_FILE),
        r#"{"steps":{"future-step":{"state":"done","at":"t","note":"x"}},"schema":7}"#,
    );
    run_startup(&env);
    let record = read_json(&env.state_dir.join(RECORD_FILE));
    assert_eq!(record["schema"], 7);
    assert_eq!(record["steps"]["future-step"]["note"], "x");
    assert_eq!(record["steps"]["state-dir"]["state"], "done");
}
