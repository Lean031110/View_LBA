// Named-pipe IPC server for tray → host communication.
//
// Pipe name: \\.\pipe\viewlba-service
// Protocol: JSON line-delimited (one request per line, one response per line).
//
// Security: for v1 we use a NULL SD (default ACL — LocalSystem + creator own).
// TODO v2: tighten DACL to query the connecting user's SID on connect.
//
// The server accepts one connection at a time, processes a request, responds,
// and disconnects. Tray reconnects for each command (simple, robust).

use std::fs::OpenOptions;
use std::io::{Read, Write};
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
            let pipe_path = cfg.pipe_name.clone();
            #[cfg(target_os = "windows")]
            {
                use windows_sys::Win32::Storage::FileSystem::*;
                use windows_sys::Win32::Foundation::HANDLE;
                use windows_sys::Win32::Security::*;

                loop {
                    let pipe_name_wide: Vec<u16> = pipe_path
                        .encode_utf16()
                        .chain(std::iter::once(0))
                        .collect();
                    let mut sa: SECURITY_ATTRIBUTES = unsafe { std::mem::zeroed() };
                    sa.nLength = std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32;
                    sa.bInheritHandle = 0;
                    sa.lpSecurityDescriptor = std::ptr::null_mut();

                    let handle: HANDLE = unsafe {
                        CreateNamedPipeW(
                            pipe_name_wide.as_ptr(),
                            PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED,
                            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                            1,
                            8 * 1024,
                            8 * 1024,
                            5_000,
                            &sa as *const _,
                        )
                    };

                    if handle.is_null() || handle == std::ptr::null_mut() {
                        let event = logging::event("error", "services", "CreateNamedPipeW failed");
                        logging::write_event(event);
                        thread::sleep(Duration::from_secs(2));
                        continue;
                    }

                    let connected = unsafe { ConnectNamedPipe(handle, std::ptr::null_mut()) };
                    if connected == 0 {
                        let event = logging::event("warn", "services", "ConnectNamedPipe returned 0");
                        logging::write_event(event);
                        unsafe { CloseHandle(handle) };
                        continue;
                    }

                    // Read one line (request) — byte by byte until newline
                    let mut reader = PipeReader { handle };
                    let mut line_buf = Vec::with_capacity(1024);
                    let mut byte = [0u8; 1];
                    loop {
                        match reader.read(&mut byte) {
                            Ok(0) => break, // EOF
                            Ok(_) => {
                                if byte[0] == b'\n' {
                                    break;
                                }
                                line_buf.push(byte[0]);
                                if line_buf.len() > 8192 {
                                    // Defense against abusers
                                    break;
                                }
                            }
                            Err(_) => break,
                        }
                    }

                    let line_str = String::from_utf8_lossy(&line_buf).to_string();
                    let response = process_request(&line_str, &sup);
                    let resp_json = serde_json::to_string(&response)
                        .unwrap_or_else(|_| r#"{"type":"error","msg":"json error"}"#.to_string());

                    let mut writer = PipeWriter { handle };
                    let _ = writer.write_all(resp_json.as_bytes());
                    let _ = writer.write_all(b"\n");

                    unsafe { FlushFileBuffers(handle) };
                    unsafe { DisconnectNamedPipe(handle) };
                    unsafe { CloseHandle(handle) };
                }
            }

            #[cfg(not(target_os = "windows"))]
            {
                let _ = pipe_path;
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
            // Per-child stop not yet implemented; for v1 we error out cleanly
            let _ = svc;
            Response::Error { msg: "per-child stop not yet implemented; use restart or full stop".to_string() }
        }
        Request::Restart { svc } => {
            let keys = keys_for(svc);
            for key in keys {
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
            // Host can't open browser as LocalSystem — return URL to the tray
            Response::Ok { msg: "http://localhost:3000".to_string() }
        }
        Request::OpenLogs { which } => {
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

// Minimal pipe reader/wrapper using the raw handle.
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
fn _suppress() { let _ = OpenOptions::new(); }
