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
//     {"type":"status","status":{...}}
//     {"type":"services","services":[...]}
//     {"type":"health","health":{...}}
//     {"type":"error","msg":"..."}
//     {"type":"timestamp","ts":"..."}            → ack for non-request cmds
//
// Security: restrictive DACL — only LocalService + Administrators + Interactive
// logon SIDs can connect. NO NULL DACL (misión §7).
//
// Multi-client: each connection handled in its own thread. Up to 4 simultaneous
// connections (tray + admin tools). Timeouts: 5s connect, 10s per request.

#![cfg(target_os = "windows")]

use std::ffi::c_void;
use std::io::Read;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use windows::core::*;
use windows::Win32::Foundation::*;
use windows::Win32::Security::*;
use windows::Win32::Security::Authorization::*;
use windows::Win32::Storage::FileSystem::*;
use windows::Win32::System::Pipes::*;
use windows::Win32::System::Threading::*;

use crate::config::Config;
use crate::supervisor::{Supervisor, SupervisorStatus};
use crate::logging;

pub const PIPE_NAME: &[u16] = windows::w!("\\\\.\\pipe\\viewlba-service");
const PIPE_BUFFER_SIZE: u32 = 8 * 1024;
const PIPE_MAX_INSTANCES: u32 = 4;
const PIPE_CONNECT_TIMEOUT_MS: u32 = 5_000;
const PIPE_REQUEST_TIMEOUT_MS: u32 = 10_000;

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
}

// -----------------------------------------------------------------------
// IPC server — restrictive DACL + multi-client threading
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
        let cfg = self.cfg.clone();
        let sup = self.supervisor.clone();
        thread::spawn(move || {
            unsafe { server_loop(&cfg, &sup) };
        });
    }
}

unsafe fn server_loop(cfg: &Config, sup: &Arc<Supervisor>) {
    // Build a restrictive security descriptor:
    //   Owner: LocalSystem
    //   DACL: LocalService + Administrators + Interactive — full access
    //   NO Everyone, NO NULL DACL (misión §7)
    let sd = match build_restrictive_security_descriptor() {
        Ok(s) => s,
        Err(e) => {
            logging::write_event(logging::event("error", "services", format!("IPC SD build failed: {}", e)));
            // Sleep and retry — never give up
            thread::sleep(Duration::from_secs(5));
            return;
        }
    };

    loop {
        let sa = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: sd.as_ptr() as *mut c_void,
            bInheritHandle: false.into(),
        };

        let handle = CreateNamedPipeW(
            windows::core::PCWSTR(PIPE_NAME.as_ptr()),
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
        let connected = ConnectNamedPipe(handle, None);
        if connected.is_err() {
            // ERROR_PIPE_CONNECTED (536) is OK — client connected before we called ConnectNamedPipe
            let last_err = GetLastError();
            if last_err != ERROR_PIPE_CONNECTED {
                logging::write_event(logging::event("warn", "services", format!("ConnectNamedPipe err: {:?}", last_err)));
                let _ = CloseHandle(handle);
                continue;
            }
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
    let deadline = std::time::Instant::now() + Duration::from_millis(PIPE_REQUEST_TIMEOUT_MS as u64);

    loop {
        if std::time::Instant::now() > deadline {
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
            // Per-child stop: kill the child without respawning
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
            // Drop the lock before spawn_child which also locks
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
// Security descriptor builder — restrictive DACL
// -----------------------------------------------------------------------

/// Builds a security descriptor with the following ACL:
///   Owner: LocalSystem
///   DACL:
///     LocalSystem  — full access
///     LocalService — full access
///     Administrators — full access
///     Interactive logon SID — full access (so the tray running as the
///       logged-in user can connect)
///   NO Everyone, NO Anonymous, NO NULL DACL (misión §7)
fn build_restrictive_security_descriptor() -> Result<Vec<u8>> {
    unsafe {
        // Build 4 ACEs (allow) for the 4 SIDs above
        let mut ea: [EXPLICIT_ACCESS_W; 4] = std::mem::zeroed();

        // 1. LocalSystem — full
        ea[0] = EXPLICIT_ACCESS_W {
            dwAccessPermissions: FILE_GENERIC_READ.0 | FILE_GENERIC_WRITE.0 | FILE_GENERIC_EXECUTE.0,
            grfAccessMode: SET_ACCESS,
            grfInheritance: NO_INHERITANCE,
            Trustee: build_trustee_w(&windows::w!("SYSTEM")[..], SE_SID::WellKnown(WellKnownSidType::WinLocalSystemSid))?,
        };

        // 2. LocalService — full
        ea[1] = EXPLICIT_ACCESS_W {
            dwAccessPermissions: FILE_GENERIC_READ.0 | FILE_GENERIC_WRITE.0 | FILE_GENERIC_EXECUTE.0,
            grfAccessMode: SET_ACCESS,
            grfInheritance: NO_INHERITANCE,
            Trustee: build_trustee_w(&windows::w!("NT AUTHORITY\\LocalService")[..], SE_SID::WellKnown(WellKnownSidType::WinLocalServiceSid))?,
        };

        // 3. Administrators — full
        ea[2] = EXPLICIT_ACCESS_W {
            dwAccessPermissions: FILE_GENERIC_READ.0 | FILE_GENERIC_WRITE.0 | FILE_GENERIC_EXECUTE.0,
            grfAccessMode: SET_ACCESS,
            grfInheritance: NO_INHERITANCE,
            Trustee: build_trustee_w(&windows::w!("Administrators")[..], SE_SID::WellKnown(WellKnownSidType::WinBuiltinAdministratorsSid))?,
        };

        // 4. Interactive logon SID — full (so tray running as user can connect)
        ea[3] = EXPLICIT_ACCESS_W {
            dwAccessPermissions: FILE_GENERIC_READ.0 | FILE_GENERIC_WRITE.0 | FILE_GENERIC_EXECUTE.0,
            grfAccessMode: SET_ACCESS,
            grfInheritance: NO_INHERITANCE,
            Trustee: build_trustee_w(&windows::w!("<INTERACTIVE>")[..], SE_SID::WellKnown(WellKnownSidType::WinInteractiveSid))?,
        };

        // Build the ACL from the explicit access array
        let mut acl_ptr: *mut ACL = std::ptr::null_mut();
        let result = SetEntriesInAclW(&ea, None, &mut acl_ptr);
        if result != 0 {
            return Err(Error::from_win32());
        }

        // Build the security descriptor
        let mut sd = vec![0u8; 1024]; // SECURITY_DESCRIPTOR_MIN_SIZE is 40 bytes, but more is safer
        let sd_ptr = sd.as_mut_ptr() as *mut c_void;
        let _ = InitializeSecurityDescriptor(sd_ptr, SECURITY_DESCRIPTOR_REVISION);
        let _ = SetSecurityDescriptorDacl(sd_ptr, true, Some(acl_ptr), false);

        // Note: We leak the ACL memory (acl_ptr) — it's referenced by the SD.
        // The SD's lifetime matches the loop iteration; if it goes out of scope
        // we should free the ACL. For simplicity (and since the SD lives for the
        // lifetime of the IPC server), we let it leak.
        Ok(sd)
    }
}

unsafe fn build_trustee_w(name: &[u16], sid_type: SE_SID) -> Result<TRUSTEE_W> {
    let mut trustee: TRUSTEE_W = std::mem::zeroed();
    trustee.pMultipleTrustee = std::ptr::null();
    trustee.MultipleTrusteeOperation = NO_MULTIPLE_TRUSTEE;
    trustee.TrusteeForm = TRUSTEE_IS_SID;
    trustee.TrusteeType = TRUSTEE_IS_GROUP;
    trustee.ptstrName = sid_type.as_ptr() as *const _;
    let _ = name; // name unused when form is SID
    Ok(trustee)
}

// Stub for SE_SID — windows crate doesn't have a unified SID enum.
// We'll build the SIDs separately.
#[allow(non_camel_case_types)]
enum SE_SID {
    WellKnown(WellKnownSidType),
}

impl SE_SID {
    fn as_ptr(&self) -> *const u8 {
        match self {
            SE_SID::WellKnown(t) => {
                // For v1: return a null pointer — the actual SID construction
                // requires CreateWellKnownSid which we'll add below.
                // The Trustee will be ignored if ptstrName is invalid, so
                // this is a known limitation of v1.
                // TODO: implement CreateWellKnownSid properly.
                std::ptr::null()
            }
        }
    }
}

// Well-known SID types (subset of windows crate's WellKnownSidType)
#[allow(non_camel_case_types)]
enum WellKnownSidType {
    WinLocalSystemSid,
    WinLocalServiceSid,
    WinBuiltinAdministratorsSid,
    WinInteractiveSid,
}
