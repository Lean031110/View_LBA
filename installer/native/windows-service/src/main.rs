// viewlba-service — Native Windows service host for ViewLBA Server
//
// Single SCM-registered service that internally supervises 3 children:
//   - app      (bun scripts/start.ts, port 3000)
//   - realtime (bun mini-services/realtime-service/index.ts, port 3003)
//   - stream   (bun mini-services/stream-service/index.ts, ports 1935/8000/8100)
//
// NO NSSM. NO PowerShell. NO CMD. NO sc.exe. NO find.exe.
// All operations go through Win32 API (SCM, named pipes, CreateProcessW).
//
// Subcommands:
//   viewlba-service --install     → register service with SCM
//   viewlba-service --uninstall   → delete service from SCM
//   viewlba-service --start       → start the registered service
//   viewlba-service --stop        → stop the registered service
//   viewlba-service --run         → run as service (called by SCM, not user)
//   viewlba-service --foreground  → run as foreground process (for debug)
//   viewlba-service --version     → print version

#![windows_subsystem = "windows"]

use std::env;
use std::process::ExitCode;

mod config;
mod health;
mod ipc;
mod logging;
mod service;
mod supervisor;

const VERSION: &str = env!("CARGO_PKG_VERSION");

fn main() -> ExitCode {
    let args: Vec<String> = env::args().collect();
    let mut pico = pico_args::Arguments::from_vec(args[1..].to_vec());

    if pico.contains("--version") {
        println!("viewlba-service {}", VERSION);
        return ExitCode::SUCCESS;
    }

    if pico.contains("--help") {
        print_help();
        return ExitCode::SUCCESS;
    }

    let action = if pico.contains("--install") {
        Action::Install
    } else if pico.contains("--uninstall") {
        Action::Uninstall
    } else if pico.contains("--start") {
        Action::Start
    } else if pico.contains("--stop") {
        Action::Stop
    } else if pico.contains("--foreground") {
        Action::Foreground
    } else if pico.contains("--run") {
        Action::RunAsService
    } else {
        eprintln!("viewlba-service: no action specified. Use --help.");
        return ExitCode::from(2);
    };

    let cfg = config::load_config();
    logging::init(&cfg);

    log::info!(action = ?action, version = VERSION, "viewlba-service starting");

    match action {
        Action::Install => service::install(&cfg),
        Action::Uninstall => service::uninstall(&cfg),
        Action::Start => service::start(&cfg),
        Action::Stop => service::stop(&cfg),
        Action::Foreground => supervisor::run_foreground(&cfg),
        Action::RunAsService => {
            // On non-Windows, --run doesn't make sense. We still try.
            #[cfg(target_os = "windows")]
            return service::run_as_service(&cfg);
            #[cfg(not(target_os = "windows"))]
            {
                eprintln!("--run requires Windows");
                ExitCode::from(2)
            }
        }
    }
}

#[derive(Debug)]
enum Action {
    Install,
    Uninstall,
    Start,
    Stop,
    Foreground,
    RunAsService,
}

fn print_help() {
    println!("viewlba-service {} - ViewLBA native Windows service host", VERSION);
    println!();
    println!("USAGE:");
    println!("  viewlba-service --install       Register the service with Windows SCM");
    println!("  viewlba-service --uninstall     Remove the service from Windows SCM");
    println!("  viewlba-service --start         Start the registered service");
    println!("  viewlba-service --stop          Stop the registered service");
    println!("  viewlba-service --run            Run as service (called by SCM, not user)");
    println!("  viewlba-service --foreground     Run as foreground process (debugging)");
    println!("  viewlba-service --version       Print version");
    println!("  viewlba-service --help          Print this help");
    println!();
    println!("The service host supervises 3 children: app, realtime, stream.");
    println!("NO NSSM. NO PowerShell. NO CMD. NO sc.exe. NO find.exe.");
    println!("Service account: LocalService (NOT LocalSystem).");
}
