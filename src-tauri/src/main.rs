#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `eldrun --agent-shim <cli> [args…]`: the shell-tab shim
    // (`services::agent_shim`) — builds the calling tab's fence and execs it.
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--agent-shim")) {
        let args: Vec<String> = std::env::args().skip(2).collect();
        let Some((cli, rest)) = args.split_first() else {
            eprintln!("agent shim: usage: eldrun --agent-shim <cli> [args…]");
            std::process::exit(2);
        };
        std::process::exit(eldrun_lib::services::agent_shim::run(cli, rest));
    }
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--mobile-host")) {
        let state_dir = eldrun_lib::storage::state_dir();
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("mobile runtime");
        // Every exit is announced, including the clean ones. A sidecar that
        // stops with `Restart=on-failure` watching it is gone until somebody
        // presses Reconnect, so "why did Mobile stop?" has to be answerable
        // from `journalctl --user -u eldrun-mobile-host` alone — a silent exit 0
        // leaves a dead process, a stale socket, and a desktop that can only
        // report `Connection refused (os error 111)`.
        match runtime.block_on(eldrun_lib::services::mobile_control::host::run(state_dir)) {
            // Disabled is a decision, not a failure: exiting non-zero would make
            // `Restart=on-failure` relaunch an enabled unit forever against a
            // configuration that says off.
            Err(error)
                if error == eldrun_lib::services::mobile_control::config::DISABLED_ERROR =>
            {
                eprintln!("eldrun-mobile-host: exiting: {error}");
            }
            Err(error) => {
                eprintln!("eldrun-mobile-host: {error}");
                std::process::exit(1);
            }
            Ok(()) => eprintln!("eldrun-mobile-host: exiting: shut down on admin request"),
        }
        return;
    }
    eldrun_lib::run()
}
