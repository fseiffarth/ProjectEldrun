//! Print a PDF the way a PDF app does: the system print dialog, then the PDF
//! itself goes to the printer.
//!
//! The in-app print path (`lib/viewers/print.ts`) prints an HTML document
//! through the webview, and WebKitGTK has no PDF engine — so a PDF reaches
//! paper there as one raster image per page. However high the resolution, that
//! is not what Evince or Firefox print: they hand the *document* to the print
//! system, text stays vector, and CUPS renders it at the printer's own
//! resolution. This command does the same, through the same GTK machinery
//! those apps use: `GtkPrintUnixDialog` for the choice, then a `GtkPrintJob`
//! whose source file is the PDF (CUPS accepts PDF natively, and the dialog's
//! page range / copies / pages-per-sheet travel as job options).
//!
//! gtk-rs 0.18 has no bindings for the unix-print half of GTK 3, so the eight
//! functions used are declared here; they live in the `libgtk-3` the window
//! already links.
//!
//! What crosses the IPC boundary is **bytes, never a path**: the print manager
//! deliberately has no print-this-file command (see `printing.rs`), and this is
//! not one — the frontend builds the arranged PDF (`buildPdf`, blackouts burned
//! in) and nothing prints without the user confirming the native dialog.

/// Returned when this platform has no native PDF print path; the frontend
/// falls back to its own print preview on seeing it.
pub const UNSUPPORTED: &str = "eldrun-native-print-unsupported";

/// Outcome of a native print: `"sent"` once the job reached the print system,
/// `"cancelled"` when the user closed the dialog.
#[tauri::command]
pub async fn print_pdf_native(
    window: tauri::WebviewWindow,
    bytes: Vec<u8>,
    title: String,
) -> Result<String, String> {
    imp::print(window, bytes, title).await
}

#[cfg(not(target_os = "linux"))]
mod imp {
    pub async fn print(
        _window: tauri::WebviewWindow,
        _bytes: Vec<u8>,
        _title: String,
    ) -> Result<String, String> {
        Err(super::UNSUPPORTED.into())
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use std::ffi::{c_char, c_int, c_uint, c_void, CString};
    use std::io::Write;
    use std::os::unix::ffi::OsStrExt;

    use gtk::glib;
    use gtk::glib::translate::{FromGlibPtrNone, ToGlibPtr};
    use gtk::prelude::*;
    use tokio::sync::oneshot;

    type Gp = *mut c_void;
    type Done = oneshot::Sender<Result<String, String>>;

    /// `GTK_PRINT_CAPABILITY_GENERATE_PDF` (`1 << 5` in `gtkprinter.h`): tells
    /// the dialog the document is a PDF, so "Print to File" offers PDF output.
    /// Nothing else is declared manual — page range, copies, collate, reverse
    /// and pages-per-sheet are left to the printer backend, which is what makes
    /// CUPS apply them to the PDF it receives.
    const CAPABILITY_GENERATE_PDF: c_uint = 1 << 5;

    #[link(name = "gtk-3")]
    extern "C" {
        fn gtk_print_unix_dialog_new(title: *const c_char, parent: Gp) -> Gp;
        fn gtk_print_unix_dialog_set_manual_capabilities(dialog: Gp, caps: c_uint);
        fn gtk_print_unix_dialog_set_embed_page_setup(dialog: Gp, embed: c_int);
        /// transfer none
        fn gtk_print_unix_dialog_get_selected_printer(dialog: Gp) -> Gp;
        /// transfer full
        fn gtk_print_unix_dialog_get_settings(dialog: Gp) -> Gp;
        /// transfer none
        fn gtk_print_unix_dialog_get_page_setup(dialog: Gp) -> Gp;
        fn gtk_printer_accepts_pdf(printer: Gp) -> c_int;
        /// transfer full
        fn gtk_print_job_new(title: *const c_char, printer: Gp, settings: Gp, setup: Gp) -> Gp;
        fn gtk_print_job_set_source_file(
            job: Gp,
            filename: *const c_char,
            error: *mut *mut glib::ffi::GError,
        ) -> c_int;
        fn gtk_print_job_send(
            job: Gp,
            callback: unsafe extern "C" fn(Gp, Gp, *const glib::ffi::GError),
            user_data: Gp,
            dnotify: Option<unsafe extern "C" fn(Gp)>,
        );
    }

    pub async fn print(
        window: tauri::WebviewWindow,
        bytes: Vec<u8>,
        title: String,
    ) -> Result<String, String> {
        if bytes.is_empty() {
            return Err("nothing to print".into());
        }
        // A private (0600, unique) spool file. GTK opens it when the job is
        // given it, so it is deleted as soon as that has happened.
        let spool = tauri::async_runtime::spawn_blocking(move || {
            let mut f = tempfile::Builder::new()
                .prefix("eldrun-print-")
                .suffix(".pdf")
                .tempfile()
                .map_err(|e| format!("print spool: {e}"))?;
            f.write_all(&bytes).map_err(|e| format!("print spool: {e}"))?;
            f.flush().map_err(|e| format!("print spool: {e}"))?;
            Ok::<_, String>(f)
        })
        .await
        .map_err(|e| e.to_string())??;

        let (tx, rx) = oneshot::channel::<Result<String, String>>();
        let on_main = window.clone();
        window
            .run_on_main_thread(move || open_dialog(&on_main, spool, title, tx))
            .map_err(|e| e.to_string())?;
        rx.await
            .unwrap_or_else(|_| Err("the print dialog closed without an answer".into()))
    }

    /// Main thread. Shows the dialog without a nested main loop — the answer
    /// arrives through `response` — so the window keeps running behind it.
    fn open_dialog(
        window: &tauri::WebviewWindow,
        spool: tempfile::NamedTempFile,
        title: String,
        tx: Done,
    ) {
        let c_title = CString::new(title.replace('\0', "")).unwrap_or_default();
        // SAFETY: a new toplevel widget, owned by GTK's toplevel list until
        // destroyed; `from_glib_none` takes our own reference to it.
        let dialog: gtk::Dialog = unsafe {
            let raw = gtk_print_unix_dialog_new(c_title.as_ptr(), std::ptr::null_mut());
            gtk_print_unix_dialog_set_manual_capabilities(raw, CAPABILITY_GENERATE_PDF);
            gtk_print_unix_dialog_set_embed_page_setup(raw, 1);
            gtk::Dialog::from_glib_none(raw as *mut gtk::ffi::GtkDialog)
        };
        if let Ok(parent) = window.gtk_window() {
            dialog.set_transient_for(Some(&parent));
        }
        dialog.set_modal(true);

        let pending = std::cell::RefCell::new(Some((spool, c_title, tx)));
        dialog.connect_response(move |dialog, response| {
            let Some((spool, c_title, tx)) = pending.borrow_mut().take() else {
                return;
            };
            if response != gtk::ResponseType::Ok {
                let _ = tx.send(Ok("cancelled".into()));
            } else {
                // SAFETY: `dialog` is the GtkPrintUnixDialog created above.
                let raw: *mut gtk::ffi::GtkDialog = dialog.to_glib_none().0;
                if let Err((tx, msg)) = unsafe { send_job(raw as Gp, &spool, &c_title, tx) } {
                    let _ = tx.send(Err(msg));
                }
            }
            // The job holds its own open handle on the spool file by now.
            drop(spool);
            // SAFETY: the dialog is finished with; this ends the toplevel.
            unsafe { dialog.destroy() };
        });
        dialog.show();
    }

    /// Builds the job from the dialog's choices and sends it. On failure the
    /// sender comes back with the message, for the caller to deliver.
    ///
    /// SAFETY: `dialog` must be a live `GtkPrintUnixDialog`.
    unsafe fn send_job(
        dialog: Gp,
        spool: &tempfile::NamedTempFile,
        c_title: &CString,
        tx: Done,
    ) -> Result<(), (Done, String)> {
        let printer = gtk_print_unix_dialog_get_selected_printer(dialog);
        if printer.is_null() {
            return Err((tx, "no printer selected".into()));
        }
        if gtk_printer_accepts_pdf(printer) == 0 {
            return Err((tx, "this printer does not accept PDF documents".into()));
        }
        let settings = gtk_print_unix_dialog_get_settings(dialog);
        let setup = gtk_print_unix_dialog_get_page_setup(dialog);
        let job = gtk_print_job_new(c_title.as_ptr(), printer, settings, setup);
        // The job keeps its own references to both.
        glib::gobject_ffi::g_object_unref(settings as *mut _);
        if job.is_null() {
            return Err((tx, "the print job could not be created".into()));
        }
        let path = CString::new(spool.path().as_os_str().as_bytes()).unwrap_or_default();
        let mut err: *mut glib::ffi::GError = std::ptr::null_mut();
        if gtk_print_job_set_source_file(job, path.as_ptr(), &mut err) == 0 {
            let msg = gerror_message(err);
            if !err.is_null() {
                glib::ffi::g_error_free(err);
            }
            glib::gobject_ffi::g_object_unref(job as *mut _);
            return Err((tx, msg));
        }
        // Our reference to `job` rides into the callback and is dropped there.
        let data = Box::into_raw(Box::new(tx)) as Gp;
        gtk_print_job_send(job, job_sent, data, None);
        Ok(())
    }

    unsafe extern "C" fn job_sent(job: Gp, data: Gp, error: *const glib::ffi::GError) {
        // SAFETY: `data` is the boxed sender `send_job` leaked for this call,
        // and GTK calls this exactly once.
        let tx = Box::from_raw(data as *mut Done);
        let result = if error.is_null() {
            Ok("sent".to_string())
        } else {
            Err(gerror_message(error))
        };
        let _ = tx.send(result);
        glib::gobject_ffi::g_object_unref(job as *mut _);
    }

    unsafe fn gerror_message(err: *const glib::ffi::GError) -> String {
        if err.is_null() || (*err).message.is_null() {
            return "the print job failed".into();
        }
        std::ffi::CStr::from_ptr((*err).message)
            .to_string_lossy()
            .into_owned()
    }
}
