//! System-clipboard image paste: lets the file tree turn a screenshot (or any
//! image on the OS clipboard) into a PNG file inside the project. The path side
//! reuses `fs`'s relative-path confinement so a paste can only ever land inside
//! the project root.

use std::path::PathBuf;

use crate::commands::fs::enforce_confinement;

/// Whether the system clipboard currently holds an image. Used to decide if the
/// file tree's context menu should offer "Paste screenshot". Any failure
/// (no clipboard, no image, unsupported platform) reports `false` rather than
/// erroring so the menu simply omits the option.
#[tauri::command]
pub fn clipboard_has_image() -> bool {
    match arboard::Clipboard::new() {
        Ok(mut cb) => cb.get_image().is_ok(),
        Err(_) => false,
    }
}

/// Read the clipboard image and write it as a PNG at `project_dir`/`rel_path`.
/// The destination is confined to the project root and must not already exist.
#[tauri::command]
pub fn save_clipboard_image(project_dir: String, rel_path: String) -> Result<(), String> {
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    let img = cb
        .get_image()
        .map_err(|_| "no image on the clipboard".to_string())?;

    let root = std::fs::canonicalize(&project_dir).map_err(|e| e.to_string())?;
    let dest = root.join(&rel_path);
    let dest_c = canonical_or_new(&dest);
    enforce_confinement(&root, &dest_c)?;
    if dest_c.exists() {
        return Err(format!("'{}' already exists", dest.display()));
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let png = encode_png(img.width, img.height, &img.bytes)?;
    std::fs::write(&dest, png).map_err(|e| e.to_string())
}

/// Encode raw RGBA8 pixels as a PNG byte buffer.
fn encode_png(width: usize, height: usize, rgba: &[u8]) -> Result<Vec<u8>, String> {
    let expected = width.checked_mul(height).and_then(|p| p.checked_mul(4));
    if expected != Some(rgba.len()) {
        return Err("clipboard image has an unexpected size".to_string());
    }
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, width as u32, height as u32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
        writer.write_image_data(rgba).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

/// Resolve a (possibly not-yet-existing) destination for confinement: existing
/// paths canonicalize directly; new ones canonicalize the parent and re-join the
/// final component. Mirrors `fs::canonical_or_new` (kept local to avoid widening
/// that module's visibility for one helper).
fn canonical_or_new(path: &std::path::Path) -> PathBuf {
    if path.exists() {
        return path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    }
    match path.parent().and_then(|p| p.canonicalize().ok()) {
        Some(parent) => parent.join(path.file_name().unwrap_or_default()),
        None => path.to_path_buf(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_png_round_trips_dimensions() {
        // 2x1 RGBA image → decodes back to the same dimensions.
        let rgba = vec![255u8, 0, 0, 255, 0, 255, 0, 255];
        let png_bytes = encode_png(2, 1, &rgba).unwrap();
        let decoder = png::Decoder::new(png_bytes.as_slice());
        let reader = decoder.read_info().unwrap();
        let info = reader.info();
        assert_eq!((info.width, info.height), (2, 1));
    }

    #[test]
    fn encode_png_rejects_size_mismatch() {
        // 3 bytes can't be a 2x1 RGBA image (needs 8).
        assert!(encode_png(2, 1, &[0, 0, 0]).is_err());
    }
}
