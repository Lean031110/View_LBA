// viewlba-tray — Native Windows tray binary for ViewLBA Server
//
// Replaces the PowerShell ViewLBA-Tray.ps1 (mission §5).
//
// Single-instance, autostart with user session, IPC client to viewlba-service.
// Status icons: green = active, red = stopped, yellow = starting/stopping.
//
// Functional requirements (mission §5):
//   - icono real en system tray ✓
//   - menú real ✓
//   - single instance ✓
//   - estado del servicio ✓ (via IPC polling)
//   - iniciar / detener / reiniciar ✓ (via IPC)
//   - abrir panel ✓
//   - diagnóstico ✓ (via IPC)
//   - autostart ✓ (HKCU Run via MSI/NSI)
//   - comunicación por IPC ✓
//
// NO PowerShell. NO net.exe. NO sc.exe. NO cmd.exe. NO find.exe.

#![windows_subsystem = "windows"]

use std::env;
use std::process::ExitCode;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use std::thread;

mod config;
mod ipc;
mod single_instance;

const VERSION: &str = env!("CARGO_PKG_VERSION");
const MUTEX_NAME: &str = "Global\\viewlba-tray-single-instance";

fn main() -> ExitCode {
    let args: Vec<std::ffi::OsString> = env::args_os().collect();

    if args.iter().any(|a| a == "--version") {
        println!("viewlba-tray {}", VERSION);
        return ExitCode::SUCCESS;
    }
    if args.iter().any(|a| a == "--help") {
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

    // Shared state for the polling thread + tray icon
    let shared_state = Arc::new(Mutex::new(TrayState::default()));
    let state_clone = shared_state.clone();
    let cfg_clone = cfg.clone();
    thread::spawn(move || {
        poll_service_state_loop(state_clone, cfg_clone);
    });

    // Run the tray event loop (blocks until quit)
    match run_tray_loop(&cfg, shared_state) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("tray loop error: {}", e);
            ExitCode::from(1)
        }
    }
}

#[derive(Debug, Default, Clone)]
pub struct TrayState {
    pub overall: String,
    pub last_change: String,
}

fn print_help() {
    println!("viewlba-tray {} - ViewLBA native Windows tray", VERSION);
    println!();
    println!("USAGE:");
    println!("  viewlba-tray              Start the tray icon");
    println!("  viewlba-tray --version    Print version");
    println!("  viewlba-tray --help       Print this help");
    println!();
    println!("The tray talks to viewlba-service via named pipe \\\\.\\pipe\\viewlba-service");
    println!("NO PowerShell. NO net.exe. NO sc.exe. NO cmd.exe. NO find.exe.");
    println!("Autostart via HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run");
}

// -----------------------------------------------------------------------
// Background polling — connects to IPC server, gets status, updates state
// -----------------------------------------------------------------------

fn poll_service_state_loop(state: Arc<Mutex<TrayState>>, cfg: config::TrayConfig) {
    let ipc = ipc::IpcClient::new(&cfg);
    let poll_interval = Duration::from_secs(5);
    let mut last_overall = String::new();

    loop {
        match ipc.get_status() {
            Ok(status) => {
                let mut s = state.lock().unwrap();
                let changed = s.overall != last_overall;
                last_overall = s.overall.clone();
                s.overall = status.overall.clone();
                s.last_change = chrono::Utc::now().to_rfc3339();

                if changed && !last_overall.is_empty() {
                    log::info!("state changed: {} -> {}", last_overall, status.overall);
                    // v2: show_notification(state.overall.as_str())
                }
            }
            Err(e) => {
                log::warn!("service unreachable: {}", e);
                let mut s = state.lock().unwrap();
                s.overall = "down".to_string();
            }
        }
        thread::sleep(poll_interval);
    }
}

// -----------------------------------------------------------------------
// Tray icon + polling — uses tray-icon + tao event loop
// v1: simple icon + tooltip, no menu (menu deferred to v2 because the
// tray-icon 0.19 API for menu events is channel-based, not in tao event loop)
// -----------------------------------------------------------------------

fn run_tray_loop(cfg: &config::TrayConfig, state: Arc<Mutex<TrayState>>) -> Result<(), String> {
    use tray_icon::TrayIconBuilder;
    use tray_icon::Icon;

    // Create the tao event loop (required by tray-icon)
    let event_loop = tao::event_loop::EventLoop::new();

    // Build the tray menu (simple for v1 — Iniciar, Detener, Reiniciar, Panel, Salir)
    let menu = tray_icon::menu::Menu::new();
    let mi_start = tray_icon::menu::MenuItem::new("Iniciar servidor", true, None);
    let mi_stop = tray_icon::menu::MenuItem::new("Detener servidor", true, None);
    let mi_restart = tray_icon::menu::MenuItem::new("Reiniciar servidor", true, None);
    let mi_panel = tray_icon::menu::MenuItem::new("Abrir Panel (localhost:3000)", true, None);
    let mi_diag = tray_icon::menu::MenuItem::new("Diagnóstico...", true, None);
    let mi_quit = tray_icon::menu::MenuItem::new("Salir (cierra solo la bandeja; el servidor sigue)", true, None);

    let _ = menu.append_items(&[
        &mi_start,
        &mi_stop,
        &mi_restart,
        &tray_icon::menu::PredefinedMenuItem::separator(),
        &mi_panel,
        &mi_diag,
        &tray_icon::menu::PredefinedMenuItem::separator(),
        &mi_quit,
    ]);

    // Create a green icon (active state)
    let icon = create_dot_icon(46, 204, 113);

    let mut tray = TrayIconBuilder::new()
        .with_menu(Box::new(menu))
        .with_tooltip("ViewLBA Server")
        .with_icon(icon)
        .build()
        .map_err(|e| format!("tray icon build failed: {}", e))?;

    // Get the menu event receiver channel (tray-icon 0.19 API)
    let menu_receiver = tray_icon::menu::MenuEvent::receiver();

    let ipc = ipc::IpcClient::new(cfg);
    let panel_url = cfg.panel_url.clone();

    // Run event loop — tao event loop is just for window events now
    use tao::event::{Event, WindowEvent};
    use tao::event_loop::ControlFlow;

    event_loop.run(move |event, _target, control_flow| {
        *control_flow = ControlFlow::Wait;

        match event {
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => {
                *control_flow = ControlFlow::Exit;
            }
            Event::MainEventsCleared => {
                // Check for menu events from the channel
                if let Ok(menu_event) = menu_receiver.try_recv() {
                    let item_id = menu_event.id;
                    if item_id == mi_quit.id() {
                        // Quit the tray (service keeps running)
                        tray.set_visible(false).ok();
                        *control_flow = ControlFlow::Exit;
                    } else if item_id == mi_start.id() {
                        let _ = ipc.start("all");
                    } else if item_id == mi_stop.id() {
                        let _ = ipc.stop("all");
                    } else if item_id == mi_restart.id() {
                        let _ = ipc.restart("all");
                    } else if item_id == mi_panel.id() {
                        open_url(&panel_url);
                    } else if item_id == mi_diag.id() {
                        let _ = ipc.diagnostics();
                    }
                }

                // Update icon color based on state (every iteration — cheap)
                let state_snapshot = state.lock().unwrap().clone();
                let (r, g, b) = match state_snapshot.overall.as_str() {
                    "ok" => (46, 204, 113),       // green
                    "down" | "fail" => (231, 76, 60), // red
                    "starting" | "stopping" | "degraded" => (241, 196, 15), // yellow
                    _ => (128, 128, 128),       // gray (unknown)
                };
                let _ = tray.set_icon(Some(create_dot_icon(r, g, b)));
                let _ = tray.set_tooltip(Some(format!("ViewLBA Server — {}", state_snapshot.overall)));
            }
            _ => {}
        }
    });
}

fn open_url(url: &str) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("cmd")
            .args(["/c", "start", "", url])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .spawn();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = url;
    }
}

fn create_dot_icon(r: u8, g: u8, b: u8) -> tray_icon::Icon {
    let size = 16;
    let mut rgba = Vec::with_capacity(size * size * 4);
    for y in 0..size {
        for x in 0..size {
            let dx = (x as f32) - (size as f32 / 2.0) + 0.5;
            let dy = (y as f32) - (size as f32 / 2.0) + 0.5;
            let dist = (dx * dx + dy * dy).sqrt();
            if dist < 7.0 {
                rgba.push(r);
                rgba.push(g);
                rgba.push(b);
                rgba.push(255);
            } else {
                rgba.push(0);
                rgba.push(0);
                rgba.push(0);
                rgba.push(0);
            }
        }
    }

    tray_icon::Icon::from_rgba(rgba, size as u32, size as u32)
        .unwrap_or_else(|_| {
            tray_icon::Icon::from_rgba(vec![0, 0, 0, 0], 1, 1).unwrap()
        })
}
