//! "Check for a new Eldrun" against the project's GitHub releases.
//!
//! Deliberately *not* the Tauri updater plugin: that wants a signed
//! `latest.json` published next to the artifacts and a private signing key in
//! CI, and Eldrun's releases are plain unsigned bundles built by
//! `.github/workflows/ci-cd.yml`. This reads the same public releases page a
//! user would open by hand, picks the artifact matching the running platform,
//! and hands it to the platform's own installer.
//!
//! Two rules hold the trust boundary, because this ends with *running a
//! downloaded executable*:
//!
//! 1. Every asset URL is checked against [`DOWNLOAD_PREFIX`] before it is
//!    fetched and again before anything is installed. The release JSON comes
//!    off the network, so `browser_download_url` is attacker-controlled input
//!    until it has been proven to live under this repository's release
//!    downloads.
//! 2. The frontend never names a path. `stage_download` remembers what it wrote
//!    in [`STAGED`], and `install` acts on *that*, so no renderer-supplied
//!    string can select what gets executed.
//!
//! `AppHandle`-free on purpose: everything here is unit-testable, and the
//! command layer in `commands::app_update` owns the progress events.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// The repository releases are published from. Any change here must also change
/// [`DOWNLOAD_PREFIX`] and [`RELEASES_PAGE`].
pub const REPO: &str = "fseiffarth/ProjectEldrun";

/// The one API endpoint. `/releases/latest` skips drafts and pre-releases,
/// which is exactly the "latest" the README's link points at.
const LATEST_API: &str = "https://api.github.com/repos/fseiffarth/ProjectEldrun/releases/latest";

/// Where a human goes when the in-app path can't finish the job.
pub const RELEASES_PAGE: &str = "https://github.com/fseiffarth/ProjectEldrun/releases/latest";

/// The only prefix a downloadable asset may have. GitHub serves release assets
/// from this exact shape; anything else in the JSON is not our release.
const DOWNLOAD_PREFIX: &str = "https://github.com/fseiffarth/ProjectEldrun/releases/download/";

/// Identify ourselves — GitHub rejects API requests with no `User-Agent`.
const USER_AGENT: &str = concat!(
    "Eldrun/",
    env!("CARGO_PKG_VERSION"),
    " (+https://github.com/fseiffarth/ProjectEldrun)"
);

const CHECK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// Refuse absurd downloads. The largest Eldrun artifact is well under 200 MB;
/// this only exists so a wrong or hostile `Content-Length` can't fill a disk.
const MAX_ASSET_BYTES: u64 = 512 * 1024 * 1024;

/// How the *running* build can apply an update, which is not the same question
/// as which artifact exists. A `.deb`-installed Eldrun can download the new
/// `.deb` but must not try to install it itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum InstallKind {
    /// Linux AppImage: swap the file we are running from, then restart.
    Appimage,
    /// Windows: run the NSIS installer, which offers to close Eldrun first.
    Nsis,
    /// macOS: open the `.dmg` and let the user drag it to Applications.
    Dmg,
    /// Downloadable, but the last step is the user's (`.deb`, raw binary, a
    /// package manager's copy). We stop after staging the file.
    Manual,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct UpdateAsset {
    pub name: String,
    pub url: String,
    pub size: u64,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    /// The running version, from `CARGO_PKG_VERSION`.
    pub current: String,
    /// Normalized latest version (tag with any leading `v` stripped).
    pub latest: Option<String>,
    pub tag: Option<String>,
    pub name: Option<String>,
    /// Release body (markdown), as written by the release workflow.
    pub notes: Option<String>,
    pub published_at: Option<String>,
    pub html_url: String,
    pub update_available: bool,
    /// The artifact for this platform, if the release published one.
    pub asset: Option<UpdateAsset>,
    pub install_kind: InstallKind,
}

/// What [`stage_download`] left on disk, and the only thing [`install`] will
/// act on. Process-local: a staged file does not survive a relaunch as an
/// install candidate, which is the conservative reading.
static STAGED: Mutex<Option<Staged>> = Mutex::new(None);

#[derive(Clone, Debug)]
pub struct Staged {
    pub path: PathBuf,
    pub name: String,
    pub version: String,
    pub kind: InstallKind,
}

/// The version this binary was built as.
pub fn current_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Compare two dotted version strings numerically.
///
/// Hand-rolled instead of pulling in `semver`: the tags this compares are
/// written by `scripts/bump-version.sh`, which only ever produces `x.y.z`. A
/// trailing suffix (`0.2.0-rc1`) is ignored for ordering but *loses* a tie, so
/// a pre-release never presents itself as newer than the same released number.
pub fn is_newer(latest: &str, current: &str) -> bool {
    let (lat_nums, lat_pre) = split_version(latest);
    let (cur_nums, cur_pre) = split_version(current);
    if lat_nums.is_empty() {
        return false;
    }
    let len = lat_nums.len().max(cur_nums.len());
    for i in 0..len {
        let l = lat_nums.get(i).copied().unwrap_or(0);
        let c = cur_nums.get(i).copied().unwrap_or(0);
        if l != c {
            return l > c;
        }
    }
    // Same numbers: only a release beats a pre-release of itself.
    cur_pre && !lat_pre
}

/// Split `1.2.3-rc1` into `([1,2,3], true)`. Anything unparseable stops the
/// numeric run rather than poisoning the whole comparison.
fn split_version(raw: &str) -> (Vec<u64>, bool) {
    let trimmed = raw.trim().trim_start_matches(['v', 'V']);
    let head = trimmed
        .split(['-', '+'])
        .next()
        .unwrap_or("")
        .trim_end_matches('.');
    let pre = trimmed.len() != head.len();
    let nums = head
        .split('.')
        .map(|part| part.trim().parse::<u64>())
        .take_while(|parsed| parsed.is_ok())
        .filter_map(Result::ok)
        .collect();
    (nums, pre)
}

/// Normalize a tag (`v0.1.52`) to a bare version (`0.1.52`).
pub fn version_from_tag(tag: &str) -> String {
    tag.trim().trim_start_matches(['v', 'V']).to_string()
}

/// How this build can install an update, given how it is running.
///
/// On Linux the deciding fact is the `APPIMAGE` environment variable, which the
/// AppImage runtime sets to the path of the `.AppImage` itself. A `.deb`
/// install or a `cargo build` binary has no such thing, and overwriting either
/// from inside the app would be Eldrun editing a package manager's files.
pub fn install_kind_for_running_build() -> InstallKind {
    if cfg!(target_os = "windows") {
        return InstallKind::Nsis;
    }
    if cfg!(target_os = "macos") {
        return InstallKind::Dmg;
    }
    match running_appimage_path() {
        Some(_) => InstallKind::Appimage,
        None => InstallKind::Manual,
    }
}

/// The `.AppImage` we are running from, if we are running from one.
fn running_appimage_path() -> Option<PathBuf> {
    let raw = std::env::var_os("APPIMAGE")?;
    let path = PathBuf::from(raw);
    if path.is_absolute() && path.is_file() {
        Some(path)
    } else {
        None
    }
}

/// File extensions worth downloading on this platform, best first.
fn wanted_extensions(kind: InstallKind) -> &'static [&'static str] {
    match kind {
        InstallKind::Nsis => &["exe", "msi"],
        InstallKind::Dmg => &["dmg"],
        // AppImage first even for a `.deb` install: it is the portable one, so
        // it is the artifact a `Manual` user can actually do something with.
        InstallKind::Appimage | InstallKind::Manual => &["appimage", "deb"],
    }
}

/// Name fragments that mark an asset as built for this CPU.
fn arch_tokens() -> &'static [&'static str] {
    if cfg!(target_arch = "aarch64") {
        &["aarch64", "arm64", "universal"]
    } else {
        &["x86_64", "amd64", "x64", "universal"]
    }
}

/// Pick the asset to offer, from `(name, url, size)` triples.
///
/// Extension decides first (a `.deb` is never an answer for Windows), arch
/// breaks ties, and a release that names no arch at all still resolves — the
/// current workflow publishes one artifact per platform.
pub fn pick_asset(assets: &[(String, String, u64)], kind: InstallKind) -> Option<UpdateAsset> {
    for ext in wanted_extensions(kind) {
        let matching: Vec<&(String, String, u64)> = assets
            .iter()
            .filter(|(name, url, _)| {
                is_repo_download_url(url)
                    && name
                        .rsplit('.')
                        .next()
                        .is_some_and(|got| got.eq_ignore_ascii_case(ext))
            })
            .collect();
        if matching.is_empty() {
            continue;
        }
        let chosen = matching
            .iter()
            .find(|(name, _, _)| {
                let lower = name.to_ascii_lowercase();
                arch_tokens().iter().any(|token| lower.contains(token))
            })
            .or(matching.first())?;
        return Some(UpdateAsset {
            name: chosen.0.clone(),
            url: chosen.1.clone(),
            size: chosen.2,
        });
    }
    None
}

/// Whether a URL is a release download from *this* repository.
///
/// The check is on the whole prefix, not the host: `https://github.com/` alone
/// would accept any repository's assets, which is the exact substitution this
/// guards against.
pub fn is_repo_download_url(url: &str) -> bool {
    url.starts_with(DOWNLOAD_PREFIX) && !url[DOWNLOAD_PREFIX.len()..].is_empty()
}

/// Parse a GitHub release JSON body into a check result.
///
/// Split out from the request so the shape can be tested without the network.
pub fn parse_release(body: &str, current: &str, kind: InstallKind) -> Result<UpdateCheck, String> {
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("release JSON: {e}"))?;
    let tag = value
        .get("tag_name")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let latest = tag.as_deref().map(version_from_tag);
    let assets: Vec<(String, String, u64)> = value
        .get("assets")
        .and_then(|v| v.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|asset| {
                    Some((
                        asset.get("name")?.as_str()?.to_string(),
                        asset.get("browser_download_url")?.as_str()?.to_string(),
                        asset.get("size").and_then(|v| v.as_u64()).unwrap_or(0),
                    ))
                })
                .collect()
        })
        .unwrap_or_default();
    let update_available = latest
        .as_deref()
        .is_some_and(|latest| is_newer(latest, current));
    Ok(UpdateCheck {
        current: current.to_string(),
        latest,
        tag,
        name: value
            .get("name")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(str::to_string),
        notes: value
            .get("body")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(str::to_string),
        published_at: value
            .get("published_at")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        html_url: value
            .get("html_url")
            .and_then(|v| v.as_str())
            .filter(|s| s.starts_with("https://github.com/"))
            .unwrap_or(RELEASES_PAGE)
            .to_string(),
        // Only offer an artifact when there is actually something newer.
        asset: if update_available {
            pick_asset(&assets, kind)
        } else {
            None
        },
        update_available,
        install_kind: kind,
    })
}

fn client() -> Result<reqwest::Client, String> {
    // `reqwest` is built with `rustls-no-provider`, and rustls 0.23 *panics*
    // when no process default is installed — see `browser_engine::reader_client`.
    crate::services::mail_engine::install_crypto_provider();
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(CHECK_TIMEOUT)
        .referer(false)
        .build()
        .map_err(|e| format!("update-client: {e}"))
}

/// Ask GitHub for the latest release.
pub async fn check() -> Result<UpdateCheck, String> {
    let kind = install_kind_for_running_build();
    let response = client()?
        .get(LATEST_API)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| format!("update check failed: {e}"))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err("no published release found".to_string());
    }
    if !response.status().is_success() {
        return Err(format!("GitHub answered {}", response.status()));
    }
    let body = response
        .text()
        .await
        .map_err(|e| format!("update check failed: {e}"))?;
    parse_release(&body, current_version(), kind)
}

/// Where downloads are staged. Outside the project tree, next to the rest of
/// Eldrun's own state.
pub fn staging_dir() -> PathBuf {
    crate::storage::state_dir().join("updates")
}

/// Strip an asset name down to something safe to join onto a directory.
///
/// The name comes from the release JSON, so it is untrusted: a `..` or a
/// separator in it must not be able to choose where the file lands.
fn safe_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        .collect();
    let cleaned = cleaned.trim_matches('.').to_string();
    if cleaned.is_empty() {
        "eldrun-update".to_string()
    } else {
        cleaned
    }
}

/// Download an asset into [`staging_dir`], reporting progress as it goes.
///
/// `on_progress` gets `(bytes_so_far, total_if_known)`. The file is written to
/// a `.part` sibling and renamed only on success, so an interrupted download
/// can never be mistaken for a complete one.
pub async fn stage_download(
    asset: &UpdateAsset,
    version: &str,
    kind: InstallKind,
    mut on_progress: impl FnMut(u64, Option<u64>),
) -> Result<Staged, String> {
    if !is_repo_download_url(&asset.url) {
        return Err("refusing to download an asset from outside the Eldrun releases".to_string());
    }
    let dir = staging_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("update staging dir: {e}"))?;

    let name = safe_file_name(&asset.name);
    let final_path = dir.join(&name);
    let part_path = dir.join(format!("{name}.part"));
    let _ = std::fs::remove_file(&part_path);

    let mut response = client()?
        .get(&asset.url)
        // The download itself has no deadline: a 150 MB artifact on a slow link
        // legitimately outlives the 20 s check timeout.
        .timeout(std::time::Duration::from_secs(60 * 60))
        .send()
        .await
        .map_err(|e| format!("download failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("download failed: HTTP {}", response.status()));
    }
    let total = response.content_length();
    if total.is_some_and(|len| len > MAX_ASSET_BYTES) {
        return Err("release asset is implausibly large; refusing".to_string());
    }

    {
        use std::io::Write;
        let mut file =
            std::fs::File::create(&part_path).map_err(|e| format!("update staging: {e}"))?;
        let mut written: u64 = 0;
        on_progress(0, total);
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| format!("download failed: {e}"))?
        {
            written += chunk.len() as u64;
            if written > MAX_ASSET_BYTES {
                let _ = std::fs::remove_file(&part_path);
                return Err("release asset exceeded the size cap; aborted".to_string());
            }
            file.write_all(&chunk)
                .map_err(|e| format!("update staging: {e}"))?;
            on_progress(written, total);
        }
        file.flush().map_err(|e| format!("update staging: {e}"))?;
    }

    std::fs::rename(&part_path, &final_path).map_err(|e| format!("update staging: {e}"))?;
    make_runnable(&final_path);

    let staged = Staged {
        path: final_path,
        name: asset.name.clone(),
        version: version.to_string(),
        kind,
    };
    *STAGED.lock().map_err(|_| "update state poisoned")? = Some(staged.clone());
    Ok(staged)
}

/// Give a staged artifact the execute bit on Unix. Harmless for a `.deb`, and
/// required for an AppImage to be runnable after the swap.
fn make_runnable(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755));
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// The currently staged download, if any.
pub fn staged() -> Option<Staged> {
    STAGED.lock().ok().and_then(|guard| guard.clone())
}

/// What `install` did, so the UI can say the right next step.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallOutcome {
    /// Whether Eldrun must be restarted by the user for the update to take.
    pub restart_required: bool,
    /// Whether an external installer was launched and now owns the process.
    pub installer_launched: bool,
    /// Where the artifact sits, for the "downloaded to …" line.
    pub path: String,
}

/// Install the staged artifact.
///
/// Takes no path on purpose — see the module docs. The AppImage path swaps the
/// running file with a rename, which is atomic and legal on Linux even while
/// the old inode is executing; the new binary is picked up on the next launch,
/// which the user performs.
pub fn install() -> Result<InstallOutcome, String> {
    let staged = staged().ok_or("no update has been downloaded")?;
    if !staged.path.is_file() {
        return Err("the downloaded update is no longer on disk".to_string());
    }
    let path_str = staged.path.to_string_lossy().to_string();
    match staged.kind {
        InstallKind::Appimage => {
            let target = running_appimage_path()
                .ok_or("this build is not running from an AppImage; install it by hand")?;
            swap_appimage(&staged.path, &target)?;
            Ok(InstallOutcome {
                restart_required: true,
                installer_launched: false,
                path: target.to_string_lossy().to_string(),
            })
        }
        InstallKind::Nsis => {
            // The Tauri NSIS installer detects a running Eldrun and offers to
            // close it, so handing it over mid-session is the supported flow.
            // A plain `Command`, deliberately not `paths::command_no_window`:
            // this child is meant to put a window on screen, and suppressing a
            // console for an installer is the opposite of what is wanted here.
            let mut cmd = std::process::Command::new(&staged.path);
            // Run it from the directory it landed in, so nothing resolves
            // against whatever Eldrun's cwd happens to be.
            if let Some(parent) = staged.path.parent() {
                cmd.current_dir(parent);
            }
            crate::paths::spawn_reaped(cmd)
                .map_err(|e| format!("could not start the installer: {e}"))?;
            Ok(InstallOutcome {
                restart_required: true,
                installer_launched: true,
                path: path_str,
            })
        }
        InstallKind::Dmg => {
            let mut cmd = crate::paths::command_no_window("open");
            cmd.arg(&staged.path);
            crate::paths::spawn_reaped(cmd).map_err(|e| format!("could not open the disk image: {e}"))?;
            Ok(InstallOutcome {
                restart_required: true,
                installer_launched: true,
                path: path_str,
            })
        }
        InstallKind::Manual => Ok(InstallOutcome {
            restart_required: false,
            installer_launched: false,
            path: path_str,
        }),
    }
}

/// Put `new` in place of `target`, keeping a `.old` copy until the swap lands.
///
/// A plain copy-over-the-running-file would fail with `ETXTBSY`; a rename onto
/// the path does not, because it replaces the directory entry rather than the
/// bytes the kernel is executing.
fn swap_appimage(new: &Path, target: &Path) -> Result<(), String> {
    let staged_beside = target.with_extension("new");
    std::fs::copy(new, &staged_beside)
        .map_err(|e| format!("could not write next to the installed AppImage: {e}"))?;
    make_runnable(&staged_beside);
    let backup = target.with_extension("old");
    let _ = std::fs::remove_file(&backup);
    // Keep the outgoing build reachable if the rename below is the last thing
    // that works today.
    if let Err(e) = std::fs::rename(target, &backup) {
        let _ = std::fs::remove_file(&staged_beside);
        return Err(format!("could not move the installed AppImage aside: {e}"));
    }
    if let Err(e) = std::fs::rename(&staged_beside, target) {
        let _ = std::fs::rename(&backup, target);
        return Err(format!("could not put the new AppImage in place: {e}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newer_versions_compare_numerically_not_lexically() {
        assert!(is_newer("0.1.53", "0.1.52"));
        assert!(is_newer("0.2.0", "0.1.99"));
        // The lexical trap: "0.1.9" > "0.1.10" as strings.
        assert!(is_newer("0.1.10", "0.1.9"));
        assert!(!is_newer("0.1.52", "0.1.52"));
        assert!(!is_newer("0.1.51", "0.1.52"));
        assert!(is_newer("v0.1.53", "0.1.52"));
    }

    #[test]
    fn a_prerelease_never_outranks_the_release_it_precedes() {
        assert!(!is_newer("0.2.0-rc1", "0.2.0"));
        assert!(is_newer("0.2.0", "0.2.0-rc1"));
        assert!(is_newer("0.2.0-rc1", "0.1.52"));
    }

    #[test]
    fn a_garbage_tag_is_never_newer() {
        assert!(!is_newer("", "0.1.52"));
        assert!(!is_newer("nightly", "0.1.52"));
    }

    #[test]
    fn only_this_repositorys_release_downloads_are_accepted() {
        assert!(is_repo_download_url(
            "https://github.com/fseiffarth/ProjectEldrun/releases/download/v0.1.53/Eldrun.AppImage"
        ));
        // A different repository, same host.
        assert!(!is_repo_download_url(
            "https://github.com/attacker/evil/releases/download/v1/Eldrun.AppImage"
        ));
        // A look-alike host.
        assert!(!is_repo_download_url(
            "https://github.com.example.org/fseiffarth/ProjectEldrun/releases/download/v1/x"
        ));
        assert!(!is_repo_download_url("http://github.com/fseiffarth/ProjectEldrun/releases/download/v1/x"));
        // The prefix alone names no file.
        assert!(!is_repo_download_url(
            "https://github.com/fseiffarth/ProjectEldrun/releases/download/"
        ));
    }

    fn asset(name: &str) -> (String, String, u64) {
        (
            name.to_string(),
            format!("https://github.com/fseiffarth/ProjectEldrun/releases/download/v0.1.53/{name}"),
            10,
        )
    }

    #[test]
    fn asset_selection_follows_the_platform_not_the_release_order() {
        let assets = vec![
            asset("eldrun_0.1.53_amd64.deb"),
            asset("Eldrun_0.1.53_x64-setup.exe"),
            asset("eldrun_0.1.53_amd64.AppImage"),
            asset("Eldrun_0.1.53_universal.dmg"),
        ];
        assert_eq!(
            pick_asset(&assets, InstallKind::Nsis).unwrap().name,
            "Eldrun_0.1.53_x64-setup.exe"
        );
        assert_eq!(
            pick_asset(&assets, InstallKind::Dmg).unwrap().name,
            "Eldrun_0.1.53_universal.dmg"
        );
        // AppImage wins over the .deb for both Linux kinds.
        assert_eq!(
            pick_asset(&assets, InstallKind::Appimage).unwrap().name,
            "eldrun_0.1.53_amd64.AppImage"
        );
        assert_eq!(
            pick_asset(&assets, InstallKind::Manual).unwrap().name,
            "eldrun_0.1.53_amd64.AppImage"
        );
    }

    #[test]
    fn an_asset_hosted_elsewhere_is_not_offered() {
        let assets = vec![(
            "Eldrun_0.1.53_x64-setup.exe".to_string(),
            "https://evil.example.org/Eldrun_0.1.53_x64-setup.exe".to_string(),
            10,
        )];
        assert!(pick_asset(&assets, InstallKind::Nsis).is_none());
    }

    #[test]
    fn a_release_with_no_artifact_for_us_picks_nothing() {
        let assets = vec![asset("eldrun_0.1.53_amd64.deb")];
        assert!(pick_asset(&assets, InstallKind::Nsis).is_none());
        assert!(pick_asset(&assets, InstallKind::Dmg).is_none());
    }

    #[test]
    fn an_untrusted_asset_name_cannot_choose_where_the_file_lands() {
        assert_eq!(safe_file_name("../../.bashrc"), "bashrc");
        assert_eq!(safe_file_name("a/b/c.AppImage"), "abc.AppImage");
        assert_eq!(safe_file_name(""), "eldrun-update");
        assert_eq!(safe_file_name("..."), "eldrun-update");
        assert_eq!(
            safe_file_name("Eldrun_0.1.53_amd64.AppImage"),
            "Eldrun_0.1.53_amd64.AppImage"
        );
    }

    const RELEASE_JSON: &str = r#"{
      "tag_name": "v0.1.53",
      "name": "Eldrun 0.1.53",
      "body": "- Linux: `.AppImage` (portable) and `.deb`",
      "published_at": "2026-08-20T10:00:00Z",
      "html_url": "https://github.com/fseiffarth/ProjectEldrun/releases/tag/v0.1.53",
      "assets": [
        {"name": "eldrun_0.1.53_amd64.AppImage", "size": 120,
         "browser_download_url": "https://github.com/fseiffarth/ProjectEldrun/releases/download/v0.1.53/eldrun_0.1.53_amd64.AppImage"},
        {"name": "Eldrun_0.1.53_x64-setup.exe", "size": 130,
         "browser_download_url": "https://github.com/fseiffarth/ProjectEldrun/releases/download/v0.1.53/Eldrun_0.1.53_x64-setup.exe"}
      ]
    }"#;

    #[test]
    fn a_newer_release_reports_an_asset_for_this_platform() {
        let check = parse_release(RELEASE_JSON, "0.1.52", InstallKind::Appimage).unwrap();
        assert!(check.update_available);
        assert_eq!(check.latest.as_deref(), Some("0.1.53"));
        assert_eq!(check.tag.as_deref(), Some("v0.1.53"));
        assert_eq!(
            check.asset.as_ref().unwrap().name,
            "eldrun_0.1.53_amd64.AppImage"
        );
        assert_eq!(check.asset.unwrap().size, 120);
    }

    #[test]
    fn being_current_offers_nothing_to_download() {
        let check = parse_release(RELEASE_JSON, "0.1.53", InstallKind::Appimage).unwrap();
        assert!(!check.update_available);
        assert!(check.asset.is_none());
        // A newer local build (a dev checkout ahead of the tag) is not "behind".
        let ahead = parse_release(RELEASE_JSON, "0.2.0", InstallKind::Appimage).unwrap();
        assert!(!ahead.update_available);
    }

    #[test]
    fn a_release_page_link_is_never_taken_from_an_arbitrary_host() {
        let hostile = r#"{"tag_name":"v9.9.9","html_url":"https://evil.example.org/x","assets":[]}"#;
        let check = parse_release(hostile, "0.1.52", InstallKind::Appimage).unwrap();
        assert_eq!(check.html_url, RELEASES_PAGE);
        assert!(check.asset.is_none());
    }

    #[test]
    fn an_empty_body_is_reported_as_no_notes_rather_than_an_empty_card() {
        let json = r#"{"tag_name":"v0.1.53","body":"   ","name":"","assets":[]}"#;
        let check = parse_release(json, "0.1.52", InstallKind::Appimage).unwrap();
        assert!(check.notes.is_none());
        assert!(check.name.is_none());
    }

    #[test]
    fn a_non_json_answer_is_an_error_not_a_panic() {
        assert!(parse_release("<html>502</html>", "0.1.52", InstallKind::Appimage).is_err());
    }
}
