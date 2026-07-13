//! AC-vs-battery power state for Energy Saver mode.
//!
//! A single read-only command backing the frontend `stores/power.ts` poller.
//! The classification is pulled out into a pure [`classify`] so it can be
//! unit-tested without a real `Manager` (which needs OS battery devices). We
//! follow the `commands::monitor` shape: a `supported` flag lets the frontend
//! degrade gracefully — when detection fails we report `supported: false` and
//! `on_battery: false` (fail open to AC) so a machine where the query breaks is
//! never left feeling sluggish.

use starship_battery::State;

#[derive(serde::Serialize)]
pub struct PowerState {
    /// True only when every present battery is discharging (i.e. unplugged).
    pub on_battery: bool,
    /// False when the battery manager could not be queried at all.
    pub supported: bool,
}

/// Decide whether we are running on battery from the states of all present
/// batteries. Pure so it can be tested without OS battery devices.
///
/// - No batteries (a desktop) → `false` (treated as AC).
/// - Any battery charging or full → `false` (a charger is attached).
/// - Otherwise (all discharging/empty/unknown) → `true`.
fn classify(states: &[State]) -> bool {
    if states.is_empty() {
        return false;
    }
    !states
        .iter()
        .any(|s| matches!(s, State::Charging | State::Full))
}

/// Read the states of every present battery, or `None` if the manager or its
/// enumeration fails. Split from the command so the command stays trivial.
fn read_states() -> Option<Vec<State>> {
    let manager = starship_battery::Manager::new().ok()?;
    let batteries = manager.batteries().ok()?;
    // A single battery that fails to read shouldn't sink the whole query; skip it.
    Some(batteries.flatten().map(|b| b.state()).collect())
}

#[tauri::command]
pub async fn get_power_state() -> PowerState {
    match read_states() {
        Some(states) => PowerState {
            on_battery: classify(&states),
            supported: true,
        },
        None => PowerState {
            on_battery: false,
            supported: false,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_batteries_is_ac() {
        assert!(!classify(&[]));
    }

    #[test]
    fn any_charging_is_ac() {
        assert!(!classify(&[State::Discharging, State::Charging]));
    }

    #[test]
    fn full_is_ac() {
        assert!(!classify(&[State::Full]));
    }

    #[test]
    fn all_discharging_is_on_battery() {
        assert!(classify(&[State::Discharging]));
        assert!(classify(&[State::Discharging, State::Discharging]));
    }
}
