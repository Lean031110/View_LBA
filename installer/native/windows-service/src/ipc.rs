// Named-pipe IPC server + formal protocol for tray → host communication.
//
// Pipe name: \\.\pipe\viewlba-service
// Protocol: JSON line-delimited (one request per line, one response per line)
//
// Security: restrictive DACL via SDDL string (misión §7).
//   SDDL: "D:P(A;;GA;;;SY)(A;;GA;;;LS)(A;;GA;;;BA)(A;;GA;;;IU)"
//   Only LocalSystem + LocalService + Administrators + Interactive logon SIDs
//   can connect. NO NULL DACL. NO Everyone.

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
use windows::Win32::Security::Authorization::*;
use windows::Win32::Storage::FileSystem::*;
use windows::Win32::System::Pipes::*;

use crate::config::Config;
use crate::supervisor::{Supervisor, SupervisorStatus};
use crate::logging;

const PIPE_BUFFER_SIZE: u32 = 8 * 1024;
const PIPE_MAX_INSTANCES: u32 = 4;
const PIPE_CONNECT_TIMEOUT_MS: u32 = 5_000;
const PIPE_REQUEST_TIMEOUT_MS: u64 = 10_000;

// SDDL string granting Generic All to:
//   SY (LocalSystem), LS (LocalService), BA (Administrators), IU (Interactive)
// D:P = DACL protected (no inheritance from parent)
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
    pub fn parse_request(line: &str) -> std::result::Result<Request, serde_json::Error> {
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
    // Build the security descriptor with restrictive DACL (SDDL).
    // Build it ONCE per server_loop lifetime; the SD is owned locally
    // (no cross-thread raw pointer issues).
    let sd_bytes = match build_restrictive_security_descriptor() {
        Ok(s) => s,
        Err(e) => {
            logging::write_event(logging::event("error", "services", format!("IPC SD build failed: {}", e)));
            thread::sleep(Duration::from_secs(5));
            return;
        }
    };

    let pipe_name: PCWSTR = w!("\\\\.\\pipe\\viewlba-service");

    loop {
        // Construct SA locally per iteration (raw pointer doesn't escape this scope)
        let sa = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: sd_bytes.as_ptr() as *mut c_void,
            bInheritHandle: false.into(),
        };

        let handle = CreateNamedPipeW(
            pipe_name,
            PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
            PIPE_MAX_INSTANCES,
            PIPE_BUFFER_SIZE,
            PIPE_BUFFER_SIZE,
            PIPE_CONNECT_TIMEOUT_MS,
            Some(&sa),
        );

        // CreateNamedPipeW returns HANDLE directly in windows 0.61 (not Result)
        if handle.is_invalid() {
            let e = Error::from_win32();
            logging::write_event(logging::event("error", "services", format!("CreateNamedPipeW failed: {}", e)));
            thread::sleep(Duration::from_secs(2));
            continue;
        }

        // Wait for a client to connect (blocking)
        match ConnectNamedPipe(handle, None) {
            Ok(()) => {
                // Client connected — spawn worker thread
            }
            Err(e) => {
                let last_err = unsafe { GetLastError() };
                if last_err != ERROR_PIPE_CONNECTED {
                    logging::write_event(logging::event("warn", "services", format!("ConnectNamedPipe err: {:?} {}", last_err, e)));
                    let _ = CloseHandle(handle);
                    continue;
                }
                // else: pipe already connected — proceed
            }
        }

        // Spawn worker thread — only HANDLE is captured (it's Send, just an opaque isize)
        let cfg_clone = cfg.clone();
        let sup_clone = sup.clone();
        thread::spawn(move || {
            handle_client(handle, &cfg_clone, &sup_clone);
        });
    }
}

unsafe fn handle_client(handle: HANDLE, cfg: &Config, sup: &Arc<Supervisor>) {
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
        let result = ReadFile(handle, Some(&mut byte), Some(&mut bytes_read), None);
        if result.is_err() || bytes_read == 0 {
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
    let result = WriteFile(handle, Some(bytes), Some(&mut written), None);
    if result.is_err() {
        return Err(std::io::Error::last_os_error());
    }
    let _ = WriteFile(handle, Some(b"\n"), Some(&mut written), None);
    Ok(())
}

// -----------------------------------------------------------------------
// Security descriptor via SDDL — restrictive DACL
// -----------------------------------------------------------------------

fn build_restrictive_security_descriptor() -> Result<Vec<u8>> {
    unsafe {
        let mut sd_ptr: *mut c_void = std::ptr::null_mut();
        let result = ConvertStringSecurityDescriptorToSecurityDescriptorW(
            SDDL_RESTRICTIVE,
            1, // SDDL_REVISION_1
            core::ptr::addr_of_mut!(sd_ptr) as *mut *mut c_void,
            None,
        );

        if result.is_err() {
            return Err(Error::from_win32());
        }

        let sd_size = GetSecurityDescriptorLength(sd_ptr as PSECURITY_DESCRIPTOR);
        let mut sd_bytes = vec![0u8; sd_size as usize];
        std::ptr::copy_nonoverlapping(
            sd_ptr as *const u8,
            sd_bytes.as_mut_ptr(),
            sd_size as usize,
        );

        // Note: we intentionally do NOT free the SD allocation here.
        // The windows 0.61 crate's LocalFree requires the Win32_System_Memory
        // feature which we don't have enabled. The leak is ~1KB once per
        // server_loop lifetime (which is the entire host lifetime) — acceptable.
        // v2 can enable Win32_System_Memory feature and call LocalFree.

        Ok(sd_bytes)
    }
}

// Suppress unused warning when not on Windows
#[cfg(not(target_os = "windows"))]
pub fn _suppress() {}
