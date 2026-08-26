fn main() {
    let state_dir = eldrun_lib::storage::state_dir();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("mobile runtime");
    if let Err(error) = runtime.block_on(eldrun_lib::services::mobile_control::host::run(state_dir))
    {
        eprintln!("eldrun-mobile-host: {error}");
        std::process::exit(1);
    }
}
