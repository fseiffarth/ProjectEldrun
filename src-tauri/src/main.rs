#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--mobile-host")) {
        let state_dir = eldrun_lib::storage::state_dir();
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("mobile runtime");
        if let Err(error) =
            runtime.block_on(eldrun_lib::services::mobile_control::host::run(state_dir))
        {
            eprintln!("eldrun-mobile-host: {error}");
            // Disabled is a decision, not a failure: exiting non-zero would make
            // `Restart=on-failure` relaunch an enabled unit forever against a
            // configuration that says off.
            if error != eldrun_lib::services::mobile_control::config::DISABLED_ERROR {
                std::process::exit(1);
            }
        }
        return;
    }
    eldrun_lib::run()
}
