use std::{
    env, fs,
    path::{Path, PathBuf},
};

fn rust_bytes(bytes: &[u8]) -> String {
    let mut out = String::from("&[");
    for (index, byte) in bytes.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push_str(&byte.to_string());
    }
    out.push(']');
    out
}

fn collect(dir: &Path, root: &Path, out: &mut Vec<(String, Vec<u8>)>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect(&path, root, out);
        } else if let Ok(bytes) = fs::read(&path) {
            let name = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            out.push((format!("/{name}"), bytes));
        }
    }
}

/// The non-English dictionary chunks vite emits for `src/lib/i18n.ts`'s
/// `dictLoaders` (`/assets/de-<hash>.js` and siblings, ~0.5 MB each).
///
/// The phone can never request one, so they are not baked in. The only trigger
/// for a dictionary load is `ensureDict(cachedLang())`, `cachedLang()` reads the
/// `eldrun-lang` localStorage key, and that key is written only by
/// `applyLanguage` — desktop code the PWA never imports (it takes `useT` and
/// `TranslationKey` from i18n, nothing else) — on the desktop webview's own
/// origin, not the sidecar's. So on the phone the language is always `en`.
/// Were one ever requested, the sidecar answers a missing `/assets/` path with a
/// 404 and `ensureDict` falls back to English. **If the phone gains a language
/// switcher, delete this filter.**
///
/// The match is exact — a two-letter language, a dash, an 8-character rollup
/// hash, `.js`, directly under `/assets/` — so a vite hash-length change makes
/// it match nothing and bake everything in, the harmless direction.
fn is_unreachable_dict_chunk(name: &str) -> bool {
    let Some(file) = name.strip_prefix("/assets/") else {
        return false;
    };
    ["de", "es", "fr", "it"].iter().any(|lang| {
        file.strip_prefix(lang)
            .and_then(|rest| rest.strip_prefix('-'))
            .and_then(|rest| rest.strip_suffix(".js"))
            .is_some_and(|hash| {
                hash.len() == 8
                    && hash
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            })
    })
}

fn generate_mobile_assets() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let dist = manifest.join("../mobile-dist");
    println!("cargo:rerun-if-changed={}", dist.display());
    let mut assets = Vec::new();
    collect(&dist, &dist, &mut assets);
    assets.retain(|(name, _)| !is_unreachable_dict_chunk(name));
    if !assets.iter().any(|(name, _)| name == "/index.html") {
        assets.push(("/index.html".into(), b"<!doctype html><title>Eldrun Mobile</title><main>Mobile assets are not built. Run npm run mobile:build.</main>".to_vec()));
    }
    assets.sort_by(|a, b| a.0.cmp(&b.0));
    let rows = assets
        .into_iter()
        .map(|(name, bytes)| {
            let mime = match name.rsplit('.').next().unwrap_or("") {
                "html" => "text/html; charset=utf-8",
                "js" => "text/javascript; charset=utf-8",
                "css" => "text/css; charset=utf-8",
                "json" | "webmanifest" => "application/manifest+json",
                "svg" => "image/svg+xml",
                "png" => "image/png",
                _ => "application/octet-stream",
            };
            format!("({name:?}, {}, {mime:?})", rust_bytes(&bytes))
        })
        .collect::<Vec<_>>()
        .join(",\n");
    let generated = format!("pub static MOBILE_ASSETS: &[(&str, &[u8], &str)] = &[{rows}];\n");
    let out = PathBuf::from(env::var("OUT_DIR").expect("out dir")).join("mobile_assets.rs");
    fs::write(out, generated).expect("write mobile assets");
}

/// The desktop frontend is embedded by `generate_context!()` at macro expansion
/// time, and the only record of that is the crate's rustc depfile, which names
/// each asset by its vite content hash. On a rebuild those assets are not
/// modified, they are *renamed* — the recorded paths vanish — and cargo reused
/// the cached rlib rather than treating the deletion as dirty. The result was a
/// frozen `package:dev` binary whose frontend predated the `npm run build` that
/// had run three minutes earlier (2026-09-03), which the install-time assert
/// caught only as "does not embed the frontend". Watching the directory the way
/// mobile-dist is watched invalidates this script, and with it the crate, on
/// every bundle write.
fn watch_frontend_dist() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("manifest dir"));
    println!(
        "cargo:rerun-if-changed={}",
        manifest.join("../dist").display()
    );
}

fn main() {
    watch_frontend_dist();
    generate_mobile_assets();
    tauri_build::build()
}
