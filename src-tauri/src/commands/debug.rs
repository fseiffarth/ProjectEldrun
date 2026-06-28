use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct AppResourceUsage {
    pub cpu_percent: f64,
    pub rss_bytes: u64,
    pub process_count: usize,
}

/// Debug-only live resource usage for Eldrun's own process tree.
///
/// In `tauri dev`, the useful total is the npm/tauri/vite tree that owns the
/// running app process. In a packaged build, this naturally resolves to the app
/// process and any descendants.
#[tauri::command]
pub async fn debug_app_resource_usage() -> Result<AppResourceUsage, String> {
    use crate::sysstat;

    let root = eldrun_process_root(std::process::id());
    let pids = sysstat::descendant_pids(&[root]);
    let interval = std::time::Duration::from_millis(300);
    let t0 = sysstat::sum_jiffies(&pids);
    tokio::time::sleep(interval).await;
    let t1 = sysstat::sum_jiffies(&pids);

    let busy_secs = t1.saturating_sub(t0) as f64 / sysstat::clk_tck() as f64;
    let cpu_percent = busy_secs / interval.as_secs_f64() * 100.0;
    let rss_bytes = sysstat::sum_rss_kib(&pids) * 1024;

    Ok(AppResourceUsage {
        cpu_percent: (cpu_percent * 10.0).round() / 10.0,
        rss_bytes,
        process_count: pids.len(),
    })
}

/// Walk up to the process that owns the running app. In `tauri dev` the useful
/// total is the npm/tauri/vite tree, so we climb to the highest ancestor whose
/// command line names the dev runner. Where the backend can't read command lines
/// (Windows, and packaged builds), no ancestor matches and this returns `pid`
/// itself — which is exactly the app process in a packaged build.
fn eldrun_process_root(pid: u32) -> u32 {
    let mut current = pid;
    let mut best = pid;

    for _ in 0..16 {
        let Some(ppid) = crate::sysstat::ppid(current) else {
            break;
        };
        if ppid <= 1 {
            break;
        }

        let cmd = crate::sysstat::cmdline(ppid).unwrap_or_default();
        if cmd.contains("tauri dev") || cmd.contains("npm run tauri") {
            best = ppid;
        }
        current = ppid;
    }

    best
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_root_includes_current_process() {
        assert!(eldrun_process_root(std::process::id()) > 0);
    }
}
