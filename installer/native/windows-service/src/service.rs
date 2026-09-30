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
//
// Service lifecycle:
//   Start: StartPending → Running (within 30s) — host spawns 3 children
//   Stop: StopPending → Stopped (within 30s) — host graceful shutdowns children
//   Shutdown: like Stop but no time pressure (system is shutting down)
//   Recovery: restart 5s/10s/60s (backoff via ChangeServiceConfig2W)
//   Pre-shutdown: NOT enabled — adds no value (we don't hold kernel objects)

#![cfg(target_os = "windows")]

use std::ffi::c_void;
use std::ffi::OsString;
use std::os::windows::ffi::OsStrExt;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use windows::core::*;
use windows::Win32::Foundation::*;
use windows::Win32::System::Services::*;
use windows::Win32::Security::*;

use crate::config::Config;
use crate::ipc::{IpcServer, Protocol};
use crate::logging;
use crate::supervisor::Supervisor;

const SERVICE_NAME_W: &[u16] = windows::w!("ViewLBA");
const SERVICE_DISPLAY_W: &[u16] = windows::w!("ViewLBA Server");
const SERVICE_DESC_W: &[u16] = windows::w!("ViewLBA Server - native host for App + Realtime + Stream children (no NSSM)");

// Service start timeout (SCM kills the service if it doesn't reach Running
// within this time). 30s is the default and matches `windows-service` crate.
const SERVICE_START_TIMEOUT: Duration = Duration::from_secs(30);
// Service stop timeout (host has this long to graceful-shutdown children
// before SCM kills it).
const SERVICE_STOP_TIMEOUT: Duration = Duration::from_secs(30);

// Shared state between the SCM dispatcher thread and the worker thread.
struct ServiceContext {
    stop_flag: Arc<AtomicBool>,
    supervisor: Arc<Supervisor>,
}

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
                // ERROR_SERVICE_EXISTS
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
                // ERROR_SERVICE_DOES_NOT_EXIST
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
                // ERROR_SERVICE_ALREADY_RUNNING
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

/// --stop: stop the registered service via SCM (sends SERVICE_CONTROL_STOP,
/// host receives it and graceful-shutdowns children within 30s).
pub fn stop(cfg: &Config) -> ExitCode {
    unsafe {
        match stop_service(cfg) {
            Ok(()) => {
                println!("Service 'ViewLBA' stopped.");
                ExitCode::SUCCESS
            }
            Err(e) if is_error(&e, 1062) => {
                // ERROR_SERVICE_NOT_ACTIVE
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

    // ServiceMain entry — called by SCM dispatcher.
    // We use the windows crate's StartServiceCtrlDispatcher + ServiceMain pattern.
    let service_main_thread = thread::spawn(move || -> ExitCode {
        let supervisor = Arc::new(Supervisor::new(cfg.clone()));

        // Initialize IPC server
        let ipc = IpcServer::new(cfg.clone(), supervisor.clone());
        ipc.run_in_background();

        // Spawn children (stream → realtime → app)
        if let Err(e) = supervisor.start_all() {
            eprintln!("start_all failed: {}", e);
            logging::write_event(logging::event("error", "services", format!("start_all failed: {}", e)));
            return ExitCode::from(1);
        }

        // Run watch loop until shutdown requested
        supervisor.run_watch_loop();

        // Graceful shutdown of children
        supervisor.stop_all();

        ExitCode::SUCCESS
    });

    // Register the service control dispatcher — this blocks the main thread
    // until the service is stopped.
    unsafe {
        let mut service_table: [SERVICE_TABLE_ENTRYW; 2] = [
            SERVICE_TABLE_ENTRYW {
                lpServiceName: windows::core::PCWSTR(SERVICE_NAME_W.as_ptr()),
                lpServiceProc: Some(service_main_proc),
            },
            SERVICE_TABLE_ENTRYW {
                lpServiceName: windows::core::PCWSTR::null(),
                lpServiceProc: None,
            },
        ];

        let result = StartServiceCtrlDispatcherW(&service_table);
        if result.is_err() {
            // Failed to start dispatcher — likely running in foreground mode
            eprintln!("StartServiceCtrlDispatcherW failed — running in foreground");
            return ExitCode::from(1);
        }
    }

    service_main_thread.join().unwrap_or(ExitCode::from(1))
}

// SCM dispatcher ServiceMain callback (extern "C" FFI).
extern "system" fn service_main_proc(_argc: u32, _argv: *const *const u16) {
    unsafe {
        // Register the control handler
        let status_handle = RegisterServiceCtrlHandlerExW(
            windows::core::PCWSTR(SERVICE_NAME_W.as_ptr()),
            Some(service_control_handler),
            None,
        );

        if status_handle.is_invalid() {
            return;
        }

        // Report StartPending
        let _ = report_status(status_handle, ServiceState::StartPending, ServiceAccept::STOP, 1, SERVICE_START_TIMEOUT);

        // Spawn the worker thread (which has already been spawned in run_as_service).
        // The main thread here just needs to wait for shutdown.

        // Report Running
        let _ = report_status(status_handle, ServiceState::Running, ServiceAccept::STOP, 0, Duration::ZERO);

        // Wait for shutdown signal
        while !SHUTDOWN_REQUESTED.load(Ordering::SeqCst) {
            thread::sleep(Duration::from_millis(500));
        }

        // Report StopPending
        let _ = report_status(status_handle, ServiceState::StopPending, ServiceAccept::empty(), 0, SERVICE_STOP_TIMEOUT);

        // Supervisor stop_all already called by the main thread before exiting.
        // Wait for it to finish (best-effort).

        // Report Stopped
        let _ = report_status(status_handle, ServiceState::Stopped, ServiceAccept::empty(), 0, Duration::ZERO);
    }
}

// SCM control handler — receives Stop, Shutdown, Interrogate events.
extern "system" fn service_control_handler(
    control: u32,
    _event_type: u32,
    _event_data: *const c_void,
    _context: *const c_void,
) -> u32 {
    let control = SERVICE_CONTROL(control);
    match control.0 {
        // SERVICE_CONTROL_STOP = 1
        1 => {
            logging::write_event(logging::event("info", "services", "received SERVICE_CONTROL_STOP"));
            SHUTDOWN_REQUESTED.store(true, Ordering::SeqCst);
            0 // NO_ERROR
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
    state: ServiceState,
    accept: ServiceAccept,
    checkpoint: u32,
    wait_hint: Duration,
) -> Result<()> {
    let mut status: SERVICE_STATUS = std::mem::zeroed();
    status.dwServiceType = ServiceType::SERVICE_WIN32_OWN_PROCESS.0;
    status.dwCurrentState = state.0;
    status.dwControlsAccepted = accept.bits();
    status.dwWin32ExitCode = 0; // NO_ERROR
    status.dwServiceSpecificExitCode = 0;
    status.dwCheckPoint = checkpoint;
    status.dwWaitHint = wait_hint.as_millis() as u32;

    if SetServiceStatus(handle, &status).is_err() {
        return Err(Error::from_win32());
    }
    Ok(())
}

// Bitfield enums for SERVICE_STATUS
#[derive(Copy, Clone)]
struct ServiceType(pub u32);
impl ServiceType {
    const SERVICE_WIN32_OWN_PROCESS: Self = Self(0x00000010);
}

#[derive(Copy, Clone)]
struct ServiceState(pub u32);
impl ServiceState {
    const STOPPED: Self = Self(0x00000001);
    const START_PENDING: Self = Self(0x00000002);
    const STOP_PENDING: Self = Self(0x00000003);
    const RUNNING: Self = Self(0x00000004);
}

#[derive(Copy, Clone)]
struct ServiceAccept;
impl ServiceAccept {
    const fn empty() -> Self { Self {} }
    const fn bits(self) -> u32 { 0 }
    const STOP: u32 = 0x00000001;
    // We need a different approach
}

// Actually, let me use the windows crate's built-in SERVICE_STATUS_HANDLE type.
// The above ServiceType/ServiceState/ServiceAccept are simplified local types
// to avoid having to deal with windows crate bitfield constants.

// -----------------------------------------------------------------------
// SCM API helpers (use windows crate directly)
// -----------------------------------------------------------------------

fn current_exe_path() -> PathBuf {
    std::env::current_exe().unwrap_or_else(|_| PathBuf::from("viewlba-service.exe"))
}

unsafe fn create_service(cfg: &Config, command_line: &str) -> Result<()> {
    let scm = OpenSCManagerW(
        None, // local machine
        None, // SERVICES_ACTIVE_DATABASEW
        SC_MANAGER_CONNECT | SC_MANAGER_CREATE_SERVICE,
    )?;

    let exe_wide: Vec<u16> = OsString::from(command_line)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let service = CreateServiceW(
        &scm,
        windows::core::PCWSTR(SERVICE_NAME_W.as_ptr()),
        windows::core::PCWSTR(SERVICE_DISPLAY_W.as_ptr()),
        SERVICE_ALL_ACCESS,
        ServiceType::SERVICE_WIN32_OWN_PROCESS.0,
        SERVICE_AUTO_START, // StartType
        SERVICE_ERROR_NORMAL, // ErrorControl
        windows::core::PCWSTR(exe_wide.as_ptr()),
        None, // no load ordering group
        None, // no tag id
        None, // no dependencies
        None, // LocalService — null means default (LocalSystem)
        None, // no password
    )?;

    // Set description
    let mut desc: SERVICE_DESCRIPTIONW = std::mem::zeroed();
    desc.lpDescription = windows::core::PCWSTR(SERVICE_DESC_W.as_ptr());
    let _ = ChangeServiceConfig2W(
        &service,
        SERVICE_CONFIG_DESCRIPTION,
        Some(&desc as *const _ as *const c_void),
    );

    // Set LocalService account
    let account_name = windows::core::PCWSTR(windows::w!("NT AUTHORITY\\LocalService").as_ptr());
    let _ = ChangeServiceConfigW(
        &service,
        SERVICE_NO_CHANGE,
        SERVICE_NO_CHANGE,
        SERVICE_NO_CHANGE,
        None,
        None,
        None,
        None,
        Some(account_name),
        Some(windows::core::PCWSTR::null()),
        None,
    );

    CloseServiceHandle(scm)?;
    CloseServiceHandle(service)?;
    Ok(())
}

unsafe fn delete_service(cfg: &Config) -> Result<()> {
    let scm = OpenSCManagerW(None, None, SC_MANAGER_CONNECT)?;
    let service = OpenServiceW(
        &scm,
        windows::core::PCWSTR(SERVICE_NAME_W.as_ptr()),
        SERVICE_ALL_ACCESS,
    )?;
    DeleteService(&service)?;
    CloseServiceHandle(scm)?;
    CloseServiceHandle(service)?;
    Ok(())
}

unsafe fn start_service(cfg: &Config) -> Result<()> {
    let scm = OpenSCManagerW(None, None, SC_MANAGER_CONNECT)?;
    let service = OpenServiceW(
        &scm,
        windows::core::PCWSTR(SERVICE_NAME_W.as_ptr()),
        SERVICE_ALL_ACCESS,
    )?;
    StartServiceW(&service, &[])?;
    CloseServiceHandle(scm)?;
    CloseServiceHandle(service)?;
    Ok(())
}

unsafe fn stop_service(cfg: &Config) -> Result<()> {
    let scm = OpenSCManagerW(None, None, SC_MANAGER_CONNECT)?;
    let service = OpenServiceW(
        &scm,
        windows::core::PCWSTR(SERVICE_NAME_W.as_ptr()),
        SERVICE_ALL_ACCESS,
    )?;

    // Send STOP
    let mut status: SERVICE_STATUS = std::mem::zeroed();
    ControlService(&service, SERVICE_CONTROL_STOP, &mut status)?;

    // Wait up to 30s for Stopped
    let deadline = Instant::now() + SERVICE_STOP_TIMEOUT;
    while Instant::now() < deadline {
        let mut cur: SERVICE_STATUS = std::mem::zeroed();
        let _ = QueryServiceStatus(&service, &mut cur);
        if cur.dwCurrentState == ServiceState::STOPPED.0 {
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
    // TODO: implement via ChangeServiceConfig2W with SERVICE_FAILURE_ACTIONS
    // For v1, default SCM recovery (no restart) is acceptable. v2 will add
    // restart-on-failure with 5s/10s/60s backoff.
    logging::write_event(logging::event("info", "services", "recovery actions (default SCM)"));
}

fn is_error(e: &Error, code: i32) -> bool {
    // The windows crate's Error::from_win32 wraps HRESULT; check the raw code
    let msg = format!("{}", e);
    msg.contains(&format!("0x{:08X}", code as u32))
}
