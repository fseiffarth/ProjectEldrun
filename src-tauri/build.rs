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

fn generate_mobile_assets() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let dist = manifest.join("../mobile-dist");
    println!("cargo:rerun-if-changed={}", dist.display());
    let mut assets = Vec::new();
    collect(&dist, &dist, &mut assets);
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

fn main() {
    generate_mobile_assets();
    tauri_build::build()
}
