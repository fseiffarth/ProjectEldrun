use crate::gpustat::GpuSample;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct AppResourceUsage {
    pub cpu_percent: f64,
    pub rss_bytes: u64,
    pub process_count: usize,
    /// VRAM (bytes) in use by local models loaded in Ollama's memory. `0` when
    /// the Ollama server is down or no model is resident on the GPU. This is
    /// Ollama's *share* of the GPU — one line of the readout's breakdown, and
    /// the whole readout only on a machine whose GPU we cannot read (`gpus`
    /// empty). It is not part of Eldrun's own process tree.
    pub vram_bytes: u64,
    /// Every GPU in the machine and its memory, Ollama's models or not. Empty
    /// when no GPU can be read; see [`crate::gpustat`].
    pub gpus: Vec<GpuSample>,
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
        vram_bytes: crate::commands::ollama::total_vram_in_use(),
        gpus: crate::gpustat::snapshot(),
    })
}

/// Resident size (KiB) of the largest webview *renderer* process under the app.
///
/// The renderer (WebKitWebProcess on Linux) holds the whole UI's JS heap in a
/// child process, and WebKitGTK does not implement `performance.memory`, so the
/// renderer cannot measure its own heap — the memory watchdog
/// (`src/lib/rendererWatchdog.ts`) reads it from here and reloads before it
/// OOMs. Returns the MAX rather than the sum: the failure mode is one runaway
/// renderer growing without bound (a 44 GB JS-heap leak observed 2026-07-31 in
/// a long HMR-heavy dev session, which then OOM-aborted and got amplified by
/// apport into a multi-GB core dump). `0` means no renderer was found — an
/// unsupported platform, or a tree not yet resolvable — which the caller treats
/// as "nothing to act on", never as "healthy".
#[tauri::command]
pub fn webview_rss_kib() -> u64 {
    let root = eldrun_process_root(std::process::id());
    crate::sysstat::descendant_pids(&[root])
        .into_iter()
        .filter(|&pid| is_webview_renderer(pid))
        .map(|pid| crate::sysstat::sum_rss_kib(&[pid]))
        .max()
        .unwrap_or(0)
}

/// A webview *content* process, across the engines Eldrun ships on: WebKitGTK
/// (Linux), WebKit (macOS: `com.apple.WebKit.WebContent`), WebView2 (Windows:
/// `msedgewebview2`). Matched on the command line, not `comm` — Linux truncates
/// the latter to 15 bytes (`WebKitWebProces`), so a `comm` match would miss it.
fn is_webview_renderer(pid: u32) -> bool {
    crate::sysstat::cmdline(pid).is_some_and(|cmd| {
        cmd.contains("WebKitWebProcess")
            || cmd.contains("WebContent")
            || cmd.contains("msedgewebview2")
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
