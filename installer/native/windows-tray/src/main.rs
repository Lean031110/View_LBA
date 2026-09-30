// viewlba-tray — Native Windows tray binary for ViewLBA Server
//
// Replaces the PowerShell ViewLBA-Tray.ps1 (mission §5 — "Eliminar dependencia
// de PowerShell como bandeja final").
//
// Single-instance, autostart with user session, IPC client to viewlba-service.
// Status icons: green = active, red = stopped, yellow = starting/stopping.

#![windows_subsystem = "windows"]

use std::env;
use std::process::ExitCode;

mod config;
mod ipc;
mod single_instance;
mod tray;

const VERSION: &str = env!("CARGO_PKG_VERSION");
const MUTEX_NAME: &str = "Global\\viewlba-tray-single-instance";

fn main() -> ExitCode {
    let args: Vec<String> = env::args().collect();
    let mut pico = pico_args::Arguments::from_vec(args[1..].to_vec());

    if pico.contains("--version") {
        println!("viewlba-tray {}", VERSION);
        return ExitCode::SUCCESS;
    }

    if pico.contains("--help") {
        print_help();
        return ExitCode::SUCCESS;
    }

    // Single instance check
    let _guard = match single_instance::acquire(MUTEX_NAME) {
        Some(g) => g,
        None => {
            // Another instance is already running — exit silently
            return ExitCode::SUCCESS;
        }
    };

    let cfg = config::load_config();
    let _ = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp(None)
        .try_init();

    log::info!("viewlba-tray {} starting", VERSION);

    // Run the tray event loop (blocks until quit)
    match tray::run_tray_loop(&cfg) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("tray loop error: {}", e);
            ExitCode::from(1)
        }
    }
}

fn print_help() {
    println!("viewlba-tray {} — ViewLBA native Windows tray", VERSION);
    println!();
    println!("USAGE:");
    println!("  viewlba-tray              Start the tray icon (autostarts with user session)");
    println!("  viewlba-tray --version    Print version");
    println!("  viewlba-tray --help       Print this help");
    println!();
    println!("The tray talks to viewlba-service via named pipe \\\\.\\pipe\\viewlba-service");
    println!("NO PowerShell. NO net.exe. NO sc.exe. NO cmd.exe.");
}
