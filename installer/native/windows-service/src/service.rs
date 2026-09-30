// SCM integration: install/uninstall/start/stop/run-as-service.
//
// Uses the Microsoft official `windows` crate (Win32::System::Services::*)
// for direct SCM API calls. NO NSSM. NO PowerShell. NO cmd.exe. NO sc.exe.
// NO find.exe.
//
// Service account: LocalService (NOT LocalSystem).
//   - LocalService has minimal privileges: no network creds, no impersonation
//   - Has SeChangeNotifyPrivilege (needed for child process spawning)
//   - Can write to ProgramData/ViewLBA when ACL grants LocalService write
//   - Can bind to non-privileged ports (3000, 3003, 1935, 8000)
//   - CANNOT authenticate as the machine on the network (we don't need this)

#![cfg(target_os = "windows")]

use std::ffi::c_void;
use std::ffi::OsString;
use std::os::windows::ffi::OsStrExt;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use windows::core::*;
use windows::Win32::Foundation::*;
use windows::Win32::Security::*;
use windows::Win32::System::Services::*;

use crate::config::Config;
use crate::ipc::{IpcServer, Protocol};
use crate::logging;
use crate::supervisor::Supervisor;

const SERVICE_NAME: PCWSTR = w!("ViewLBA");
const SERVICE_DISPLAY: PCWSTR = w!("ViewLBA Server");
const SERVICE_DESC: PCWSTR = w!("ViewLBA Server - native host for App + Realtime + Stream children");
const LOCALSERVICE_ACCOUNT: PCWSTR = w!("NT AUTHORITY\\LocalService");

const SERVICE_START_TIMEOUT_MS: u32 = 30_000;
const SERVICE_STOP_TIMEOUT_MS: u32 = 30_000;

static SHUTDOWN_REQUESTED: AtomicBool = AtomicBool::new(false);

/// --install: register the service with SCM.
pub fn install(cfg: &Config) -> ExitCode {
    unsafe {
        let exe_path = current_exe_path();
        let command_line = format!("\"{}\" --run", exe_path);

        match create_service(cfg, &command_line) {
            Ok(()) => {
                println!("Service 'ViewLBA' installed successfully.");
                set_recovery_actions();
                ExitCode::SUCCESS
            }
            Err(e) if is_error(&e, 1073) => {
                println!("Service 'ViewLBA' already exists — nothing to do.");
                ExitCode::SUCCESS
            }
            Err(e) => {
                eprintln!("Failed to install service 'ViewLBA': {}", e);
                logging::write_event(logging::event("error", "services", format!("install failed: {}", e)));
                ExitCode::from(1)
            }
        }
    }
}

/// --uninstall: delete the service from SCM.
pub fn uninstall(cfg: &Config) -> ExitCode {
    unsafe {
        match delete_service(cfg) {
            Ok(()) => {
                println!("Service 'ViewLBA' uninstalled successfully.");
                ExitCode::SUCCESS
            }
            Err(e) if is_error(&e, 1060) => {
                println!("Service 'ViewLBA' does not exist — nothing to do.");
                ExitCode::SUCCESS
            }
            Err(e) => {
                eprintln!("Failed to uninstall service 'ViewLBA': {}", e);
                logging::write_event(logging::event("error", "services", format!("uninstall failed: {}", e)));
                ExitCode::from(1)
            }
        }
    }
}

/// --start: start the registered service via SCM.
pub fn start(cfg: &Config) -> ExitCode {
    unsafe {
        match start_service(cfg) {
            Ok(()) => {
                println!("Service 'ViewLBA' started.");
                ExitCode::SUCCESS
            }
            Err(e) if is_error(&e, 1056) => {
                println!("Service 'ViewLBA' is already running.");
                ExitCode::SUCCESS
            }
            Err(e) => {
                eprintln!("Failed to start service 'ViewLBA': {}", e);
                logging::write_event(logging::event("error", "services", format!("start failed: {}", e)));
                ExitCode::from(1)
            }
        }
    }
}

/// --stop: stop the registered service via SCM.
pub fn stop(cfg: &Config) -> ExitCode {
    unsafe {
        match stop_service(cfg) {
            Ok(()) => {
                println!("Service 'ViewLBA' stopped.");
                ExitCode::SUCCESS
            }
            Err(e) if is_error(&e, 1062) => {
                println!("Service 'ViewLBA' is not running.");
                ExitCode::SUCCESS
            }
            Err(e) => {
                eprintln!("Failed to stop service 'ViewLBA': {}", e);
                logging::write_event(logging::event("error", "services", format!("stop failed: {}", e)));
                ExitCode::from(1)
            }
        }
    }
}

/// --run: called by SCM when starting the service.
/// Registers the SCM dispatcher and the control handler, then runs the
/// supervisor watch loop in the foreground.
pub fn run_as_service(cfg: &Config) -> ExitCode {
    let cfg = Arc::new(cfg.clone());

    // Spawn the worker thread that will do the actual work
    let supervisor = Arc::new(Supervisor::new(cfg.clone()));
    let sup_clone_for_thread = supervisor.clone();
    let worker_handle = thread::spawn(move || -> ExitCode {
        // Initialize IPC server
        let ipc = IpcServer::new(cfg.clone(), sup_clone_for_thread.clone());
        ipc.run_in_background();

        // Spawn children (stream → realtime → app)
        if let Err(e) = sup_clone_for_thread.start_all() {
            eprintln!("start_all failed: {}", e);
            logging::write_event(logging::event("error", "services", format!("start_all failed: {}", e)));
            return ExitCode::from(1);
        }

        // Run watch loop until shutdown requested
        sup_clone_for_thread.run_watch_loop();

        // Graceful shutdown of children
        sup_clone_for_thread.stop_all();

        ExitCode::SUCCESS
    });

    // Register the service control dispatcher on the main thread
    // (this blocks until the service is stopped)
    unsafe {
        let service_main: [SERVICE_TABLE_ENTRYW; 2] = [
            SERVICE_TABLE_ENTRYW {
                lpServiceName: SERVICE_NAME,
                lpServiceProc: Some(service_main_proc),
            },
            SERVICE_TABLE_ENTRYW {
                lpServiceName: PCWSTR::null(),
                lpServiceProc: None,
            },
        ];

        let result = StartServiceCtrlDispatcherW(&service_main);
        if result.is_err() {
            eprintln!("StartServiceCtrlDispatcherW failed — not running as a service?");
            // Signal worker to stop
            SHUTDOWN_REQUESTED.store(true, Ordering::SeqCst);
            supervisor.stop_flag.store(true, Ordering::SeqCst);
            let _ = worker_handle.join();
            return ExitCode::from(1);
        }
    }

    // After dispatcher returns (SCM stopped us), signal worker and join
    SHUTDOWN_REQUESTED.store(true, Ordering::SeqCst);
    supervisor.stop_flag.store(true, Ordering::SeqCst);
    worker_handle.join().unwrap_or(ExitCode::from(1))
}

// SCM dispatcher ServiceMain callback (extern "system" FFI).
extern "system" fn service_main_proc(_argc: u32, _argv: *const *const u16) {
    unsafe {
        // Register the control handler
        let status_handle = RegisterServiceCtrlHandlerExW(
            SERVICE_NAME,
            Some(service_control_handler),
            None,
        );

        if status_handle.is_invalid() {
            return;
        }

        // Report StartPending
        let _ = report_status(status_handle, SERVICE_START_PENDING, 0x00000001, 1, SERVICE_START_TIMEOUT_MS);

        // Report Running (the worker thread is already doing its thing)
        let _ = report_status(status_handle, SERVICE_RUNNING, 0x00000001, 0, 0);

        // Wait for shutdown signal
        while !SHUTDOWN_REQUESTED.load(Ordering::SeqCst) {
            thread::sleep(Duration::from_millis(500));
        }

        // Report StopPending
        let _ = report_status(status_handle, SERVICE_STOP_PENDING, 0, 0, SERVICE_STOP_TIMEOUT_MS);

        // Worker thread will have already called stop_all() before exiting.

        // Report Stopped
        let _ = report_status(status_handle, SERVICE_STOPPED, 0, 0, 0);
    }
}

// SCM control handler — receives Stop, Shutdown, Interrogate events.
extern "system" fn service_control_handler(
    control: u32,
    _event_type: u32,
    _event_data: *const c_void,
    _context: *const c_void,
) -> u32 {
    match control {
        // SERVICE_CONTROL_STOP = 1
        1 => {
            logging::write_event(logging::event("info", "services", "received SERVICE_CONTROL_STOP"));
            SHUTDOWN_REQUESTED.store(true, Ordering::SeqCst);
            0
        }
        // SERVICE_CONTROL_SHUTDOWN = 5
        5 => {
            logging::write_event(logging::event("info", "services", "received SERVICE_CONTROL_SHUTDOWN"));
            SHUTDOWN_REQUESTED.store(true, Ordering::SeqCst);
            0
        }
        // SERVICE_CONTROL_INTERROGATE = 4
        4 => 0,
        _ => 1, // ERROR_CALL_NOT_IMPLEMENTED
    }
}

unsafe fn report_status(
    handle: SERVICE_STATUS_HANDLE,
    state: u32, // SERVICE_START_PENDING=2, SERVICE_RUNNING=4, SERVICE_STOPPED=1, SERVICE_STOP_PENDING=3
    controls_accepted: u32,
    checkpoint: u32,
    wait_hint_ms: u32,
) -> Result<()> {
    let mut status: SERVICE_STATUS = std::mem::zeroed();
    status.dwServiceType = SERVICE_WIN32_OWN_PROCESS;
    status.dwCurrentState = state;
    status.dwControlsAccepted = controls_accepted;
    status.dwWin32ExitCode = 0;
    status.dwServiceSpecificExitCode = 0;
    status.dwCheckPoint = checkpoint;
    status.dwWaitHint = wait_hint_ms;

    if SetServiceStatus(handle, &status).is_err() {
        return Err(Error::from_win32());
    }
    Ok(())
}

// SCM status constants
const SERVICE_START_PENDING: u32 = 0x00000002;
const SERVICE_RUNNING: u32 = 0x00000004;
const SERVICE_STOP_PENDING: u32 = 0x00000003;
const SERVICE_STOPPED: u32 = 0x00000001;
const SERVICE_WIN32_OWN_PROCESS: u32 = 0x00000010;
const SERVICE_ACCEPT_STOP: u32 = 0x00000001;

// -----------------------------------------------------------------------
// SCM API helpers
// -----------------------------------------------------------------------

fn current_exe_path() -> PathBuf {
    std::env::current_exe().unwrap_or_else(|_| PathBuf::from("viewlba-service.exe"))
}

unsafe fn create_service(cfg: &Config, command_line: &str) -> Result<()> {
    let scm = OpenSCManagerW(None, None, SC_MANAGER_CONNECT | SC_MANAGER_CREATE_SERVICE)?;

    let exe_wide: Vec<u16> = OsString::from(command_line)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let service = CreateServiceW(
        &scm,
        SERVICE_NAME,
        SERVICE_DISPLAY,
        SERVICE_ALL_ACCESS,
        SERVICE_WIN32_OWN_PROCESS,
        SERVICE_AUTO_START,
        SERVICE_ERROR_NORMAL,
        windows::core::PCWSTR(exe_wide.as_ptr()),
        None,
        None,
        None,
        None,
        None,
    )?;

    // Set description
    let desc_text: PCWSTR = SERVICE_DESC;
    let mut desc: SERVICE_DESCRIPTIONW = std::mem::zeroed();
    desc.lpDescription = desc_text;
    let _ = ChangeServiceConfig2W(
        &service,
        SERVICE_CONFIG_DESCRIPTION,
        Some(&desc as *const _ as *const c_void),
    );

    // Set LocalService account (minimum privilege, NOT LocalSystem)
    let _ = ChangeServiceConfigW(
        &service,
        SERVICE_NO_CHANGE,
        SERVICE_NO_CHANGE,
        SERVICE_NO_CHANGE,
        None,
        None,
        None,
        None,
        Some(LOCALSERVICE_ACCOUNT),
        Some(PCWSTR::null()),
        None,
    );

    CloseServiceHandle(scm)?;
    CloseServiceHandle(service)?;
    Ok(())
}

unsafe fn delete_service(cfg: &Config) -> Result<()> {
    let scm = OpenSCManagerW(None, None, SC_MANAGER_CONNECT)?;
    let service = OpenServiceW(&scm, SERVICE_NAME, SERVICE_ALL_ACCESS)?;
    DeleteService(&service)?;
    CloseServiceHandle(scm)?;
    CloseServiceHandle(service)?;
    Ok(())
}

unsafe fn start_service(cfg: &Config) -> Result<()> {
    let scm = OpenSCManagerW(None, None, SC_MANAGER_CONNECT)?;
    let service = OpenServiceW(&scm, SERVICE_NAME, SERVICE_ALL_ACCESS)?;
    StartServiceW(&service, &[])?;
    CloseServiceHandle(scm)?;
    CloseServiceHandle(service)?;
    Ok(())
}

unsafe fn stop_service(cfg: &Config) -> Result<()> {
    let scm = OpenSCManagerW(None, None, SC_MANAGER_CONNECT)?;
    let service = OpenServiceW(&scm, SERVICE_NAME, SERVICE_ALL_ACCESS)?;

    let mut status: SERVICE_STATUS = std::mem::zeroed();
    ControlService(&service, SERVICE_CONTROL_STOP, &mut status)?;

    // Wait up to 30s for Stopped
    let deadline = Instant::now() + Duration::from_millis(SERVICE_STOP_TIMEOUT_MS as u64);
    while Instant::now() < deadline {
        let mut cur: SERVICE_STATUS = std::mem::zeroed();
        let _ = QueryServiceStatus(&service, &mut cur);
        if cur.dwCurrentState == SERVICE_STOPPED {
            CloseServiceHandle(scm)?;
            CloseServiceHandle(service)?;
            return Ok(());
        }
        thread::sleep(Duration::from_millis(500));
    }

    CloseServiceHandle(scm)?;
    CloseServiceHandle(service)?;
    Err(Error::from_win32())
}

unsafe fn set_recovery_actions() {
    // TODO: implement via ChangeServiceConfig2W with SERVICE_CONFIG_FAILURE_ACTIONS
    // For v1, default SCM recovery (no restart) is acceptable. v2 will add
    // restart-on-failure with 5s/10s/60s backoff.
    logging::write_event(logging::event("info", "services", "recovery actions (default SCM, v1)"));
}

fn is_error(e: &Error, code: i32) -> bool {
    let msg = format!("{}", e);
    // windows crate's Error formats include the HRESULT or win32 error code.
    // Check both decimal and hex.
    msg.contains(&code.to_string())
        || msg.contains(&format!("0x{:08X}", code as u32))
        || msg.contains(&format!("0x{:08x}", code as u32))
}
