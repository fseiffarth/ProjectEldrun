//! Names the app wrote *into* its own JSON state: the settings key of the
//! phone host, the key that opens a project or box to the phone, the id of
//! the app's own row in the time log, the commands saved tabs of built-in
//! views carry, and the app's variables in a saved tab's environment.
//!
//! One pass over the state dir's JSON files at launch, before anything reads
//! them, so the typed readers (the desktop's and the phone host's, whose
//! serde keys are literals) only ever see the current names. A file is
//! rewritten only when something in it changed.

use serde_json::{Map, Value};

use super::{Env, Outcome, StepResult};
use crate::brand::{Name, Pair};

/// The old → current spellings a file is searched for.
pub struct Renames {
    /// Object keys and string values replaced as a whole.
    whole: Vec<(String, String)>,
    /// Old and current prefix of a saved built-in tab command (`__<slug>_`).
    tab_command: Option<(String, String)>,
    /// Old and current prefix of the app's environment variables.
    env: Option<(String, String)>,
}

impl Renames {
    pub fn new(pair: &Pair) -> Self {
        let mut whole = Vec::new();
        for name in [Name::MOBILE_HOST_KEY, Name::MOBILE_ACCESS_KEY, Name::APP_TIMER_ID] {
            if let Some(old) = pair.legacy(name) {
                whole.push((old, pair.cur(name)));
            }
        }
        Self {
            whole,
            tab_command: pair
                .legacy(Name::TAB_COMMAND_PREFIX)
                .map(|old| (old, pair.cur(Name::TAB_COMMAND_PREFIX))),
            env: (pair.cur.upper != pair.legacy.upper).then(|| (pair.legacy.env_prefix(), pair.cur.env_prefix())),
        }
    }

    fn is_empty(&self) -> bool {
        self.whole.is_empty() && self.tab_command.is_none() && self.env.is_none()
    }

    /// The current spelling of a key or string value, when it is an old one.
    fn current(&self, text: &str) -> Option<String> {
        if let Some((_, new)) = self.whole.iter().find(|(old, _)| old == text) {
            return Some(new.clone());
        }
        let (old, new) = self.tab_command.as_ref()?;
        let view = text.strip_prefix(old.as_str())?;
        (view.len() > 2 && view.ends_with("__")).then(|| format!("{new}{view}"))
    }

    /// Rewrite `value` in place. Returns whether anything changed.
    pub fn apply(&self, value: &mut Value) -> bool {
        self.walk(value, false)
    }

    fn walk(&self, value: &mut Value, in_env: bool) -> bool {
        match value {
            Value::String(text) => match self.current(text) {
                Some(new) => {
                    *text = new;
                    true
                }
                None => false,
            },
            Value::Array(items) => items.iter_mut().fold(false, |changed, item| self.walk(item, false) | changed),
            Value::Object(map) => {
                let mut changed = self.rename_keys(map, in_env);
                for (key, item) in map.iter_mut() {
                    changed |= self.walk(item, key == "env");
                }
                changed
            }
            _ => false,
        }
    }

    /// Rename the keys of one object. A key whose current spelling is already
    /// there is merged when both hold numbers (two tallies of the same row)
    /// and otherwise left as it is: the current key is the one that is read,
    /// and nothing is dropped.
    fn rename_keys(&self, map: &mut Map<String, Value>, in_env: bool) -> bool {
        let renames: Vec<(String, String)> = map
            .keys()
            .filter_map(|key| {
                let new = self.current(key).or_else(|| {
                    let (old, new) = self.env.as_ref().filter(|_| in_env)?;
                    Some(format!("{new}{}", key.strip_prefix(old.as_str())?))
                })?;
                Some((key.clone(), new))
            })
            .collect();
        let mut changed = false;
        for (old, new) in renames {
            match (map.get(&old).and_then(Value::as_f64), map.get(&new).and_then(Value::as_f64)) {
                _ if !map.contains_key(&new) => {
                    if let Some(item) = map.remove(&old) {
                        map.insert(new, item);
                        changed = true;
                    }
                }
                (Some(a), Some(b)) => {
                    map.remove(&old);
                    map.insert(new, serde_json::json!(a + b));
                    changed = true;
                }
                _ => {}
            }
        }
        changed
    }
}

/// Step `persisted-names`.
pub fn rewrite_persisted_names(env: &Env) -> StepResult {
    let renames = Renames::new(&env.pair);
    if renames.is_empty() {
        return Ok(Outcome::NothingToDo);
    }
    let mut rewritten = 0usize;
    for file in super::state_dir::state_json_files(&env.live_state_dir()) {
        env.checkpoint("names:before-file")?;
        let Ok(mut value) = crate::storage::read_json::<Value>(&file) else {
            continue;
        };
        if renames.apply(&mut value) {
            crate::storage::write_json_atomic(&file, &value).map_err(|e| format!("rewrite {}: {e}", file.display()))?;
            rewritten += 1;
        }
    }
    if rewritten == 0 {
        Ok(Outcome::NothingToDo)
    } else {
        Ok(Outcome::Done(format!("{rewritten} file(s) rewritten")))
    }
}

#[cfg(test)]
mod tests {
    use super::super::testing::RENAMED;
    use super::*;
    use crate::brand::{LEGACY, PAIR};
    use serde_json::json;

    #[test]
    fn the_unchanged_pair_renames_nothing() {
        if PAIR.renamed() {
            return;
        }
        let renames = Renames::new(&PAIR);
        assert!(renames.is_empty());
        let mut value = json!({ crate::brand::MOBILE_HOST_KEY: { "enabled": true }, "cmd": crate::app_tab_command!("mail") });
        let before = value.clone();
        assert!(!renames.apply(&mut value));
        assert_eq!(value, before);
    }

    #[test]
    fn the_phone_keys_move_and_the_rest_of_the_file_stays() {
        let renames = Renames::new(&RENAMED);
        let mut settings = json!({
            "theme": "dark",
            LEGACY.name(Name::MOBILE_HOST_KEY): { "enabled": true, "port": 8742 },
        });
        assert!(renames.apply(&mut settings));
        assert_eq!(settings, json!({ "theme": "dark", "newname_mobile_host": { "enabled": true, "port": 8742 } }));
        let mut projects = json!([{ "id": "p", LEGACY.name(Name::MOBILE_ACCESS_KEY): true, "name": "P" }, { "id": "q" }]);
        assert!(renames.apply(&mut projects));
        assert_eq!(projects, json!([{ "id": "p", "newname_mobile_access": true, "name": "P" }, { "id": "q" }]));
        assert!(!renames.apply(&mut projects), "a second pass changes nothing");
    }

    #[test]
    fn a_saved_tab_moves_its_command_and_its_environment() {
        let renames = Renames::new(&RENAMED);
        let old_cmd = format!("{}mail__", LEGACY.name(Name::TAB_COMMAND_PREFIX));
        let mut tabs = json!({ "tabs": [
            { "id": "a", "cmd": old_cmd, "env": {} },
            { "id": "b", "cmd": "claude", "env": { LEGACY.env_name("TAB_UID"): "u-1", "PATH": "/bin" },
              "label": LEGACY.env_name("NOT_AN_ENV_KEY") },
        ] });
        assert!(renames.apply(&mut tabs));
        assert_eq!(
            tabs,
            json!({ "tabs": [
                { "id": "a", "cmd": "__newname_mail__", "env": {} },
                { "id": "b", "cmd": "claude", "env": { "NEWNAME_TAB_UID": "u-1", "PATH": "/bin" },
                  "label": LEGACY.env_name("NOT_AN_ENV_KEY") },
            ] })
        );
    }

    #[test]
    fn the_apps_time_log_row_moves_and_two_tallies_add_up() {
        let renames = Renames::new(&RENAMED);
        let old_id = LEGACY.name(Name::APP_TIMER_ID);
        let mut summary = json!({ "days": {
            "2026-09-30": { old_id.clone(): 120.0, "p1": 5.0 },
            "2026-10-01": { old_id.clone(): 30.0, "__newname__": 12.5 },
        } });
        assert!(renames.apply(&mut summary));
        assert_eq!(
            summary,
            json!({ "days": {
                "2026-09-30": { "__newname__": 120.0, "p1": 5.0 },
                "2026-10-01": { "__newname__": 42.5 },
            } })
        );
        let mut entries = json!([{ "project_id": old_id, "duration_s": 3 }]);
        assert!(renames.apply(&mut entries));
        assert_eq!(entries[0]["project_id"], "__newname__");
    }

    #[test]
    fn a_key_that_cannot_be_merged_is_left_under_both_names() {
        let renames = Renames::new(&RENAMED);
        let old_key = LEGACY.name(Name::MOBILE_HOST_KEY);
        let mut settings = json!({ old_key.clone(): { "enabled": true }, "newname_mobile_host": { "enabled": false } });
        let before = settings.clone();
        assert!(!renames.apply(&mut settings));
        assert_eq!(settings, before);
    }
}
