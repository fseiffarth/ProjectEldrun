use crate::commands::apps::{do_launch, WindowRegistryState, ORIGIN_RESTORED};
use crate::schema::project::OpenApp;

/// Launch apps from `open_apps` for the given project, skipping already-running ones.
/// Returns registry IDs of newly launched windows.
pub fn restore_project_apps(
    registry: &WindowRegistryState,
    open_apps: &[OpenApp],
    project_id: &str,
) -> Vec<String> {
    let mut launched = Vec::new();
    for app in open_apps {
        if app.mode.as_deref() == Some("embedded") {
            continue;
        }
        {
            let reg = registry.lock().unwrap();
            if reg
                .windows
                .values()
                .any(|w| w.exec == app.exec && w.project_id.as_deref() == Some(project_id))
            {
                continue;
            }
        }
        if let Ok(win) = do_launch(
            registry,
            &app.exec,
            &[],
            app.file.as_deref(),
            Some(project_id),
            None,
            ORIGIN_RESTORED,
        ) {
            launched.push(win.id);
        }
    }
    launched
}
