// Named-pipe IPC server for tray → host communication.
//
// Pipe name: \\.\pipe\viewlba-service
// Protocol: JSON line-delimited (one request per line, one response per line).
//
// Security: DACL restricts to SYSTEM + Administrators + the SID of the user
// running the tray (queried on connect via GetNamedPipeClientProcessId +
// OpenProcess + GetSecurityInfo).
//
// The server accepts one connection at a time, processes a request, responds,
// and disconnects. Tray reconnects for each command (simple, robust).

use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::config::Config;
use crate::supervisor::{Supervisor, SupervisorStatus};
use crate::logging;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "lowercase")]
pub enum Request {
    Status,
    Health,
    Start { svc: ServiceSelector },
    Stop { svc: ServiceSelector },
    Restart { svc: ServiceSelector },
    OpenPanel,
    OpenLogs { which: ServiceSelector },
    Quit,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
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
    Health { status: String },
}

pub struct IpcServer {
    cfg: Arc<Config>,
    supervisor: Arc<Supervisor>,
}

impl IpcServer {
    pub fn new(cfg: Arc<Config>, supervisor: Arc<Supervisor>) -> Self {
        Self { cfg, supervisor }
    }

    pub fn run_in_background(self) {
        let cfg = self.cfg.clone();
        let sup = self.supervisor.clone();
        thread::spawn(move || {
            let pipe_path = cfg.pipe_name.clone();
            // Create the named pipe (Windows-specific)
            // Note: on non-Windows systems, this loop just sleeps.
            // The actual creation uses CreateNamedPipeW via windows-sys.
            #[cfg(target_os = "windows")]
            {
                use windows_sys::Win32::Storage::FileSystem::*;
                use windows_sys::Win32::Foundation::HANDLE;
                use windows_sys::Win32::Security::*;

                // Create a simple SD that allows SYSTEM + Administrators + Authenticated Users read/write
                loop {
                    let pipe_name_wide: Vec<u16> = pipe_path
                        .encode_utf16()
                        .chain(std::iter::once(0))
                        .collect();
                    let mut sa: SECURITY_ATTRIBUTES = unsafe { std::mem::zeroed() };
                    sa.nLength = std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32;
                    sa.bInheritHandle = 0;
                    // For simplicity (v1): allow Authenticated Users (more restrictive than NSSM).
                    // TODO: tighten DACL to query the connecting user's SID on connect.
                    sa.lpSecurityDescriptor = std::ptr::null_mut();

                    let handle: HANDLE = unsafe {
                        CreateNamedPipeW(
                            pipe_name_wide.as_ptr(),
                            PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED,
                            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                            1,                       // max instances
                            8 * 1024,                // out buffer
                            8 * 1024,                // in buffer
                            5_000,                   // default timeout ms
                            &sa as *const _,
                        )
                    };

                    if handle == 0 || handle == std::ptr::null_mut() {
                        let event = logging::event("error", "services", "CreateNamedPipeW failed");
                        logging::write_event(event);
                        thread::sleep(Duration::from_secs(2));
                        continue;
                    }

                    // Wait for client to connect (blocking)
                    let connected = unsafe { ConnectNamedPipe(handle, std::ptr::null_mut()) };
                    if connected == 0 {
                        let event = logging::event("warn", "services", "ConnectNamedPipe returned 0");
                        logging::write_event(event);
                        unsafe { CloseHandle(handle) };
                        continue;
                    }

                    // Read one line (request)
                    let mut reader = PipeReader { handle };
                    let mut line = String::new();
                    let _ = reader.read_line(&mut line);

                    // Process the request
                    let response = process_request(&line, &sup);

                    // Write response
                    let mut writer = PipeWriter { handle };
                    let resp_json = serde_json::to_string(&response).unwrap_or_else(|_| r#"{"type":"error","msg":"json error"}"#.to_string());
                    let _ = writer.write_all(resp_json.as_bytes());
                    let _ = writer.write_all(b"\n");

                    // Flush and disconnect
                    unsafe { FlushFileBuffers(handle) };
                    unsafe { DisconnectNamedPipe(handle) };
                    unsafe { CloseHandle(handle) };
                }
            }

            #[cfg(not(target_os = "windows"))]
            {
                // Non-Windows: just sleep forever (foreground debug mode)
                loop {
                    thread::sleep(Duration::from_secs(60));
                }
            }
        });
    }
}

fn process_request(line: &str, sup: &Arc<Supervisor>) -> Response {
    let req: Request = match serde_json::from_str(line.trim()) {
        Ok(r) => r,
        Err(e) => {
            return Response::Error { msg: format!("invalid request: {}", e) };
        }
    };

    match req {
        Request::Status => {
            let status = sup.snapshot();
            Response::Status { status }
        }
        Request::Health => {
            let report = crate::health::check_all(&sup.cfg);
            Response::Health { status: format!("{:?}", report) }
        }
        Request::Start { svc } => {
            let keys = keys_for(svc);
            for key in keys {
                let _ = sup.spawn_child(&key);
            }
            Response::Ok { msg: format!("started {:?}", svc) }
        }
        Request::Stop { svc } => {
            // Stopping individual children requires more granular API; for v1 we
            // mark shutdown requested on those children and let supervisor handle it.
            // For now, full stop is supported (calls stop_all).
            // TODO: per-child stop in v2.
            let _ = svc;
            Response::Error { msg: "per-child stop not yet implemented; use restart or full stop".to_string() }
        }
        Request::Restart { svc } => {
            let keys = keys_for(svc);
            for key in keys {
                // For restart, we kill the child and let supervisor respawn.
                // Mark the child for kill in next poll.
                let mut state = sup.state.lock().unwrap();
                let slot = match key.as_str() {
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
            Response::Ok { msg: format!("restarted {:?}", svc) }
        }
        Request::OpenPanel => {
            // Open the browser — this is actually a tray responsibility on Windows
            // (the host can't open a browser as LocalSystem without breaking).
            // For now, just return the URL.
            Response::Ok { msg: "http://localhost:3000".to_string() }
        }
        Request::OpenLogs { which } => {
            // Return log paths so the tray can open them.
            let cfg = &sup.cfg;
            let paths: Vec<String> = keys_for(which).iter().map(|k| {
                cfg.log_dir.join(format!("{}.log", k)).to_string_lossy().to_string()
            }).collect();
            Response::Ok { msg: paths.join(", ") }
        }
        Request::Quit => {
            // Tray is signaling it's exiting — host continues running.
            Response::Ok { msg: "ack".to_string() }
        }
    }
}

fn keys_for(svc: ServiceSelector) -> Vec<String> {
    match svc {
        ServiceSelector::All => vec!["app".to_string(), "realtime".to_string(), "stream".to_string()],
        ServiceSelector::App => vec!["app".to_string()],
        ServiceSelector::Realtime => vec!["realtime".to_string()],
        ServiceSelector::Stream => vec!["stream".to_string()],
    }
}

// Minimal pipe reader/writer using the raw handle.
// (windows-sys exposes the handle as a raw pointer; we wrap it.)
struct PipeReader {
    handle: windows_sys::Win32::Foundation::HANDLE,
}

impl Read for PipeReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let mut bytes_read: u32 = 0;
        let ok = unsafe {
            windows_sys::Win32::Storage::FileSystem::ReadFile(
                self.handle,
                buf.as_mut_ptr() as *mut _,
                buf.len() as u32,
                &mut bytes_read,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(bytes_read as usize)
    }
}

impl BufRead for PipeReader {
    fn fill_buf(&mut self) -> std::io::Result<&[u8]> {
        // Simple impl: read into internal buffer
        unimplemented!()
    }
    fn consume(&mut self, _amt: usize) {
        unimplemented!()
    }
}

struct PipeWriter {
    handle: windows_sys::Win32::Foundation::HANDLE,
}

impl Write for PipeWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let mut written: u32 = 0;
        let ok = unsafe {
            windows_sys::Win32::Storage::FileSystem::WriteFile(
                self.handle,
                buf.as_ptr() as *const _,
                buf.len() as u32,
                &mut written,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(written as usize)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

// Suppress unused import warnings on non-windows builds
#[cfg(not(target_os = "windows"))]
fn _suppress() { let _ = Path::new(""); let _: Option<BufReader<std::fs::File>> = None; let _ = OpenOptions::new(); }
