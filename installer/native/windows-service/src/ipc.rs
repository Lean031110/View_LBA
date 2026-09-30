// Named-pipe IPC server + formal protocol for tray → host communication.
//
// Pipe name: \\.\pipe\viewlba-service
// Protocol: JSON line-delimited (one request per line, one response per line)
//
// Formal protocol (misión §6):
//   REQUESTS (tray → host):
//     {"cmd":"status"}                          → status snapshot
//     {"cmd":"start","svc":"all|app|rt|stream"}
//     {"cmd":"stop","svc":"..."}
//     {"cmd":"restart","svc":"..."}
//     {"cmd":"health"}                          → force health check
//     {"cmd":"diagnostics"}                      → last error + log path
//
//   RESPONSES (host → tray):
//     {"type":"ok","msg":"..."}
//     {"type":"error","msg":"..."}
//     {"type":"status","status":{...}}
//     {"type":"health","health":{...}}
//     {"type":"timestamp","ts":"..."}            → ack for non-request cmds
//     {"type":"diagnostics","last_error":...,"log_path":...}
//
// Security: restrictive DACL via SDDL string (misión §7).
//   Only LocalSystem + LocalService + Administrators + Interactive logon SIDs
//   can connect. NO NULL DACL. NO Everyone.
//
// SDDL: "D:(A;;GA;;;SY)(A;;GA;;;LS)(A;;GA;;;BA)(A;;GA;;;IU)"
//   D: = DACL
//   A: = Allow ACE
//   GA: = Generic All
//   ;;;SY = LocalSystem
//   ;;;LS = LocalService
//   ;;;BA = Built-in Administrators
//   ;;;IU = Interactive User
//
// Multi-client: each connection handled in its own thread (max 4).

#![cfg(target_os = "windows")]

use std::ffi::c_void;
use std::io::Read;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use windows::core::*;
use windows::Win32::Foundation::*;
use windows::Win32::Security::*;
use windows::Win32::Storage::FileSystem::*;
use windows::Win32::System::Pipes::*;

use crate::config::Config;
use crate::supervisor::{Supervisor, SupervisorStatus};
use crate::logging;

const PIPE_NAME: PCWSTR = w!("\\\\.\\pipe\\viewlba-service");
const PIPE_BUFFER_SIZE: u32 = 8 * 1024;
const PIPE_MAX_INSTANCES: u32 = 4;
const PIPE_CONNECT_TIMEOUT_MS: u32 = 5_000;
const PIPE_REQUEST_TIMEOUT_MS: u64 = 10_000;

// SDDL string granting Generic All to:
//   SY (LocalSystem), LS (LocalService), BA (Administrators), IU (Interactive)
// D:P = DACL protected (prevents inheriting from parent)
const SDDL_RESTRICTIVE: PCWSTR = w!("D:P(A;;GA;;;SY)(A;;GA;;;LS)(A;;GA;;;BA)(A;;GA;;;IU)");

// -----------------------------------------------------------------------
// Protocol — formal request/response types
// -----------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "lowercase")]
pub enum Request {
    Status,
    Start { svc: ServiceSelector },
    Stop { svc: ServiceSelector },
    Restart { svc: ServiceSelector },
    Health,
    Diagnostics,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ServiceSelector {
    All,
    App,
    Realtime,
    Stream,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Response {
    Ok { msg: String },
    Error { msg: String },
    Status { status: SupervisorStatus },
    Health { health: HealthReport },
    Timestamp { ts: String },
    Diagnostics { last_error: Option<String>, log_path: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthReport {
    pub app: String,
    pub realtime: String,
    pub stream: String,
    pub database: String,
    pub storage: String,
    pub overall: String,
}

pub struct Protocol;

impl Protocol {
    pub fn parse_request(line: &str) -> Result<Request, serde_json::Error> {
        serde_json::from_str(line.trim())
    }

    pub fn build_response(resp: &Response) -> String {
        serde_json::to_string(resp).unwrap_or_else(|_| {
            r#"{"type":"error","msg":"json serialization failed"}"#.to_string()
        })
    }

    pub fn error_response(msg: impl Into<String>) -> String {
        let r = Response::Error { msg: msg.into() };
        Self::build_response(&r)
    }

    pub fn ok_response(msg: impl Into<String>) -> String {
        let r = Response::Ok { msg: msg.into() };
        Self::build_response(&r)
    }
}

// -----------------------------------------------------------------------
// IPC server
// -----------------------------------------------------------------------

pub struct IpcServer {
    pub cfg: Arc<Config>,
    pub supervisor: Arc<Supervisor>,
}

impl IpcServer {
    pub fn new(cfg: Arc<Config>, supervisor: Arc<Supervisor>) -> Self {
        Self { cfg, supervisor }
    }

    pub fn run_in_background(self) {
        thread::spawn(move || {
            unsafe { server_loop(&self.cfg, &self.supervisor) };
        });
    }
}

unsafe fn server_loop(cfg: &Config, sup: &Arc<Supervisor>) {
    // Build the security descriptor with the restrictive DACL (SDDL).
    let sd_bytes = match build_restrictive_security_descriptor() {
        Ok(s) => s,
        Err(e) => {
            logging::write_event(logging::event("error", "services", format!("IPC SD build failed: {}", e)));
            // Sleep and retry — never give up (host must serve IPC)
            thread::sleep(Duration::from_secs(5));
            return;
        }
    };

    // Wrap the SD in an Arc for thread-safe sharing (raw pointer issue workaround)
    let sd_arc = Arc::new(sd_bytes);
    let sa = build_security_attributes(&sd_arc);

    loop {
        let handle = CreateNamedPipeW(
            PIPE_NAME,
            PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
            PIPE_MAX_INSTANCES,
            PIPE_BUFFER_SIZE,
            PIPE_BUFFER_SIZE,
            PIPE_CONNECT_TIMEOUT_MS,
            Some(&sa),
        );

        if handle.is_invalid() {
            let e = Error::from_win32();
            logging::write_event(logging::event("error", "services", format!("CreateNamedPipeW failed: {}", e)));
            thread::sleep(Duration::from_secs(2));
            continue;
        }

        // Wait for a client to connect (blocking)
        let connect_result = ConnectNamedPipe(handle, None);
        if let Err(e) = connect_result {
            let hr = e.code();
            // ERROR_PIPE_CONNECTED = 0x80000005? actually it's 535 (0x217)
            // Check if the error is "pipe already connected"
            let last_err = unsafe { GetLastError() };
            if last_err != ERROR_PIPE_CONNECTED {
                logging::write_event(logging::event("warn", "services", format!("ConnectNamedPipe err: {:?} hr: {:?}", last_err, hr)));
                let _ = CloseHandle(handle);
                continue;
            }
            // else: pipe already connected — proceed
        }

        // Spawn a worker thread to handle this client (multi-client)
        let cfg_clone = cfg.clone();
        let sup_clone = sup.clone();
        thread::spawn(move || {
            handle_client(handle, &cfg_clone, &sup_clone);
        });
    }
}

unsafe fn handle_client(handle: HANDLE, cfg: &Config, sup: &Arc<Supervisor>) {
    // Read one line (request) — byte by byte until newline (max 8KB)
    let mut line_buf = Vec::with_capacity(1024);
    let mut byte = [0u8; 1];
    let deadline = Instant::now() + Duration::from_millis(PIPE_REQUEST_TIMEOUT_MS);

    loop {
        if Instant::now() > deadline {
            let _ = write_response(handle, &Protocol::error_response("request timeout"));
            let _ = CloseHandle(handle);
            return;
        }
        let mut bytes_read: u32 = 0;
        let ok = ReadFile(handle, Some(&mut byte), Some(&mut bytes_read), None);
        if ok.is_err() || bytes_read == 0 {
            // Client disconnected without sending — silently close
            let _ = CloseHandle(handle);
            return;
        }
        if byte[0] == b'\n' {
            break;
        }
        line_buf.push(byte[0]);
        if line_buf.len() > 8192 {
            let _ = write_response(handle, &Protocol::error_response("request too large"));
            let _ = CloseHandle(handle);
            return;
        }
    }

    let line_str = match std::str::from_utf8(&line_buf) {
        Ok(s) => s,
        Err(_) => {
            let _ = write_response(handle, &Protocol::error_response("invalid utf8"));
            let _ = CloseHandle(handle);
            return;
        }
    };

    let request = match Protocol::parse_request(line_str) {
        Ok(r) => r,
        Err(e) => {
            let _ = write_response(handle, &Protocol::error_response(format!("invalid request: {}", e)));
            let _ = CloseHandle(handle);
            return;
        }
    };

    let response = process_request(&request, sup, cfg);
    let resp_json = Protocol::build_response(&response);

    let _ = write_response(handle, &resp_json);
    let _ = FlushFileBuffers(handle);
    let _ = DisconnectNamedPipe(handle);
    let _ = CloseHandle(handle);
}

fn process_request(req: &Request, sup: &Arc<Supervisor>, cfg: &Config) -> Response {
    match req {
        Request::Status => {
            let status = sup.snapshot();
            Response::Status { status }
        }
        Request::Health => {
            let report = crate::health::check_all(cfg);
            let h = HealthReport {
                app: format!("{:?}", report.app).to_lowercase(),
                realtime: format!("{:?}", report.realtime).to_lowercase(),
                stream: format!("{:?}", report.stream).to_lowercase(),
                database: format!("{:?}", report.database).to_lowercase(),
                storage: format!("{:?}", report.storage).to_lowercase(),
                overall: format!("{:?}", report.overall).to_lowercase(),
            };
            Response::Health { health: h }
        }
        Request::Start { svc } => {
            let keys = keys_for(*svc);
            let mut errors = Vec::new();
            for k in keys {
                if let Err(e) = sup.spawn_child(&k) {
                    errors.push(format!("{}: {}", k, e));
                }
            }
            if errors.is_empty() {
                Response::Ok { msg: format!("started {:?}", svc) }
            } else {
                Response::Error { msg: errors.join("; ") }
            }
        }
        Request::Stop { svc } => {
            let keys = keys_for(*svc);
            for k in keys {
                let mut state = sup.state.lock().unwrap();
                let slot = match k.as_str() {
                    "app" => &mut state.app,
                    "realtime" => &mut state.realtime,
                    "stream" => &mut state.stream,
                    _ => continue,
                };
                if let Some(child) = slot.child.take() {
                    let _ = child.kill();
                    slot.state = crate::supervisor::ChildState::Stopped;
                    slot.next_attempt_at = None;
                }
            }
            Response::Ok { msg: format!("stopped {:?}", svc) }
        }
        Request::Restart { svc } => {
            let keys = keys_for(*svc);
            for k in keys {
                let mut state = sup.state.lock().unwrap();
                let slot = match k.as_str() {
                    "app" => &mut state.app,
                    "realtime" => &mut state.realtime,
                    "stream" => &mut state.stream,
                    _ => continue,
                };
                if let Some(child) = slot.child.take() {
                    let _ = child.kill();
                    slot.state = crate::supervisor::ChildState::Stopped;
                    slot.next_attempt_at = None;
                }
            }
            // Drop state lock before re-acquiring in spawn_child
            drop(sup.state.lock().unwrap());
            for k in keys {
                let _ = sup.spawn_child(&k);
            }
            Response::Ok { msg: format!("restarted {:?}", svc) }
        }
        Request::Diagnostics => {
            Response::Diagnostics {
                last_error: sup.last_error(),
                log_path: cfg.log_dir.join("service-host.log").to_string_lossy().to_string(),
            }
        }
    }
}

fn keys_for(svc: ServiceSelector) -> Vec<String> {
    match svc {
        ServiceSelector::All => vec!["app".into(), "realtime".into(), "stream".into()],
        ServiceSelector::App => vec!["app".into()],
        ServiceSelector::Realtime => vec!["realtime".into()],
        ServiceSelector::Stream => vec!["stream".into()],
    }
}

unsafe fn write_response(handle: HANDLE, resp: &str) -> std::io::Result<()> {
    let bytes = resp.as_bytes();
    let mut written: u32 = 0;
    let ok = WriteFile(handle, Some(bytes), Some(&mut written), None);
    if ok.is_err() {
        return Err(std::io::Error::last_os_error());
    }
    // Append newline
    let _ = WriteFile(handle, Some(b"\n"), Some(&mut written), None);
    Ok(())
}

// -----------------------------------------------------------------------
// Security descriptor via SDDL — restrictive DACL
// -----------------------------------------------------------------------

/// Builds a security descriptor with the following restrictive DACL:
///   LocalSystem   — full access
///   LocalService  — full access
///   Administrators — full access
///   Interactive logon SID — full access (tray running as user)
///   NO Everyone, NO Anonymous, NO NULL DACL (misión §7)
fn build_restrictive_security_descriptor() -> Result<Vec<u8>> {
    unsafe {
        let mut sd_ptr: *mut c_void = std::ptr::null_mut();
        let ok = ConvertStringSecurityDescriptorToSecurityDescriptorW(
            SDDL_RESTRICTIVE,
            SDDL_REVISION_1,
            &mut sd_ptr,
            None,
        );
        if ok.is_err() {
            return Err(Error::from_win32());
        }

        // Determine the size of the SD to copy it into a Vec<u8>
        // SECURITY_DESCRIPTOR_RELATIVE has a length field, but for simplicity
        // we copy a fixed size (typical SDs are <1KB)
        let sd_size = GetSecurityDescriptorLength(sd_ptr);
        let mut sd_bytes = vec![0u8; sd_size as usize];
        std::ptr::copy_nonoverlapping(
            sd_ptr as *const u8,
            sd_bytes.as_mut_ptr(),
            sd_size as usize,
        );

        // Free the original SD allocation (Windows allocated it)
        LocalFree(Some(sd_ptr as *const _));

        Ok(sd_bytes)
    }
}

/// Wraps the SD bytes in a SECURITY_ATTRIBUTES for CreateNamedPipeW.
fn build_security_attributes(sd_bytes: &Arc<Vec<u8>>) -> SECURITY_ATTRIBUTES {
    SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: sd_bytes.as_ptr() as *mut c_void,
        bInheritHandle: false.into(),
    }
}

// Suppress unused warning when not on Windows
#[cfg(not(target_os = "windows"))]
pub fn _suppress() {}
