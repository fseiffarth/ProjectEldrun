//! System-clipboard image bridge, in both directions:
//!
//! - **In:** the file tree turns an image already on the OS clipboard into a PNG
//!   file inside the project ([`clipboard_has_image`] / [`save_clipboard_image`]).
//!   The path side reuses `fs`'s relative-path confinement so a paste can only
//!   ever land inside the project root.
//! - **Out:** [`copy_image_to_clipboard`] / [`copy_png_file_to_clipboard`] put an
//!   image *on* the clipboard, so a screenshot Eldrun files into the project is
//!   also pasteable straight into a chat, an editor, or an agent tab.

use std::borrow::Cow;
use std::path::{Path, PathBuf};

use crate::commands::fs::enforce_confinement;

/// Whether the system clipboard currently holds an image. Used to decide if the
/// file tree's context menu should offer "Paste screenshot". Any failure
/// (no clipboard, no image, unsupported platform) reports `false` rather than
/// erroring so the menu simply omits the option.
///
/// Runs on a blocking worker rather than the main thread: on X11 the `arboard`
/// probe stalls while negotiating the clipboard selection (notably when there is
/// *no* image, where it waits out a transfer timeout). A synchronous Tauri
/// command executes on the main thread and would freeze the webview for that
/// whole stall — which made the file-tree context menu take a long time to
/// appear, since it fires this probe as it opens. Keeping the work off-thread
/// lets the menu paint immediately and the "Paste screenshot" item appear once
/// the probe resolves.
#[tauri::command]
pub async fn clipboard_has_image() -> bool {
    tauri::async_runtime::spawn_blocking(|| match arboard::Clipboard::new() {
        Ok(mut cb) => cb.get_image().is_ok(),
        Err(_) => false,
    })
    .await
    .unwrap_or(false)
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

/// Put raw RGBA8 pixels on the system clipboard as an image.
///
/// On X11/Wayland the clipboard has no OS-owned store: the *owning process*
/// serves the data on request, and arboard tears its serving window down as soon
/// as the last `Clipboard` handle drops — so a set-then-drop would leave nothing
/// to paste. Hence the Linux path hands the image to a thread that calls
/// `.wait()`, which keeps serving until another app takes the selection over
/// (including the next Eldrun screenshot). It therefore returns before the image
/// is necessarily on the clipboard, and a failure there is silent. Windows and
/// macOS copy the bytes into an OS-owned clipboard, so there they are set inline.
pub fn copy_image_to_clipboard(width: usize, height: usize, rgba: Vec<u8>) -> Result<(), String> {
    let expected = width.checked_mul(height).and_then(|p| p.checked_mul(4));
    if expected != Some(rgba.len()) {
        return Err("image has an unexpected size".to_string());
    }
    let image = arboard::ImageData {
        width,
        height,
        bytes: Cow::Owned(rgba),
    };

    #[cfg(target_os = "linux")]
    {
        use arboard::SetExtLinux;
        std::thread::spawn(move || {
            if let Ok(mut cb) = arboard::Clipboard::new() {
                let _ = cb.set().wait().image(image);
            }
        });
        Ok(())
    }

    #[cfg(not(target_os = "linux"))]
    {
        let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
        cb.set_image(image).map_err(|e| e.to_string())
    }
}

/// Read a PNG file and put it on the system clipboard as an image.
pub fn copy_png_file_to_clipboard(path: &Path) -> Result<(), String> {
    let (width, height, rgba) = decode_png_rgba(path)?;
    copy_image_to_clipboard(width, height, rgba)
}

/// Decode a PNG file to RGBA8. Capture tools emit whatever color type they like
/// (grayscale, palette, RGB, 16-bit), while the clipboard wants plain RGBA8:
/// `normalize_to_color8` folds palette/16-bit/sub-byte-gray down to 8-bit
/// channels, leaving only the four channel layouts expanded below.
fn decode_png_rgba(path: &Path) -> Result<(usize, usize, Vec<u8>), String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut decoder = png::Decoder::new(std::io::BufReader::new(file));
    decoder.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = decoder.read_info().map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).map_err(|e| e.to_string())?;
    let px = &buf[..info.buffer_size()];

    let rgba = match info.color_type {
        png::ColorType::Rgba => px.to_vec(),
        png::ColorType::Rgb => px
            .chunks_exact(3)
            .flat_map(|c| [c[0], c[1], c[2], 0xFF])
            .collect(),
        png::ColorType::GrayscaleAlpha => px
            .chunks_exact(2)
            .flat_map(|c| [c[0], c[0], c[0], c[1]])
            .collect(),
        png::ColorType::Grayscale => px.iter().flat_map(|&g| [g, g, g, 0xFF]).collect(),
        png::ColorType::Indexed => return Err("indexed PNG was not expanded".to_string()),
    };
    Ok((info.width as usize, info.height as usize, rgba))
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

    /// Capture tools emit plain RGB PNGs (no alpha); the clipboard needs RGBA, so
    /// the decoder has to widen them rather than reject them.
    #[test]
    fn decode_png_rgba_widens_an_rgb_png() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rgb.png");
        let file = std::fs::File::create(&path).unwrap();
        let mut encoder = png::Encoder::new(file, 2, 1);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        writer.write_image_data(&[255, 0, 0, 0, 255, 0]).unwrap();
        drop(writer);

        let (width, height, rgba) = decode_png_rgba(&path).unwrap();
        assert_eq!((width, height), (2, 1));
        assert_eq!(rgba, vec![255, 0, 0, 255, 0, 255, 0, 255]);
    }

    /// An RGBA PNG (what Eldrun itself writes) round-trips unchanged.
    #[test]
    fn decode_png_rgba_round_trips_rgba() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rgba.png");
        let rgba = vec![1u8, 2, 3, 4, 5, 6, 7, 8];
        std::fs::write(&path, encode_png(2, 1, &rgba).unwrap()).unwrap();

        assert_eq!(decode_png_rgba(&path).unwrap(), (2, 1, rgba));
    }

    #[test]
    fn copy_image_rejects_size_mismatch() {
        assert!(copy_image_to_clipboard(2, 1, vec![0, 0, 0]).is_err());
    }
}
