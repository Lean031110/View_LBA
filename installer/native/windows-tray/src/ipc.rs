// Named-pipe IPC client for tray → host communication.
//
// Connects to \\.\\pipe\viewlba-service (host side server).
// Protocol: JSON line-delimited (one request per line, one response per line).
//
// Handles:
//   - service host not running → return Err, tray shows "down" state
//   - service host restarted → client reconnects on next call
//   - timeout → return Err after 5s
//   - invalid response → return Err

#![cfg(target_os = "windows")]

use std::time::Duration;

use serde::{Deserialize, Serialize};

use windows::core::*;
use windows::Win32::Foundation::*;
use windows::Win32::Storage::FileSystem::*;

use crate::config::TrayConfig;

const PIPE_NAME: PCWSTR = w!("\\\\.\\pipe\\viewlba-service");
const PIPE_TIMEOUT: u32 = 5_000; // 5s

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceStatus {
    pub app: ServiceChildStatus,
    pub realtime: ServiceChildStatus,
    pub stream: ServiceChildStatus,
    pub overall: String,
    pub uptime_secs: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceChildStatus {
    pub key: String,
    pub state: String,
    pub pid: Option<u32>,
    pub attempt: u32,
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

pub struct IpcClient {
    _cfg: TrayConfig, // for future use (e.g. custom pipe path)
}

impl IpcClient {
    pub fn new(cfg: &TrayConfig) -> Self {
        Self { _cfg: cfg.clone() }
    }

    /// Send a request to the service host and get the response.
    /// Returns Err if the host is unreachable or the response is invalid.
    pub fn request<Req: Serialize, Resp: for<'de> Deserialize<'de>>(
        &self,
        req: &Req,
    ) -> Result<Resp, String> {
        unsafe {
            // Open the named pipe (client side)
            let handle_result = CreateFileW(
                PIPE_NAME,
                FILE_GENERIC_READ.0 | FILE_GENERIC_WRITE.0,
                0,
                None,
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                None,
            );

            let handle = match handle_result {
                Ok(h) if !h.is_invalid() => h,
                Ok(_) => return Err("invalid pipe handle".to_string()),
                Err(e) => return Err(format!("pipe open failed: {}", e)),
            };

            // Set read mode to byte + timeout
            let mut mode: u32 = PIPE_READMODE_BYTE;
            let _ = SetNamedPipeHandleState(handle, Some(&mode), None, None);

            // Serialize request + append newline
            let req_json = serde_json::to_string(req).map_err(|e| format!("json serialize: {}", e))?;
            let req_bytes = format!("{}\n", req_json).into_bytes();

            // Write request
            let mut written: u32 = 0;
            let write_result = WriteFile(handle, Some(req_bytes.as_slice()), Some(&mut written), None);
            if write_result.is_err() || written == 0 {
                let _ = CloseHandle(handle);
                return Err("write failed".to_string());
            }

            // Flush
            let _ = FlushFileBuffers(handle);

            // Read response (up to 8KB or newline)
            let mut buf = Vec::with_capacity(8192);
            let mut chunk = [0u8; 1024];
            let deadline = std::time::Instant::now() + Duration::from_millis(PIPE_TIMEOUT as u64);
            loop {
                if std::time::Instant::now() > deadline {
                    let _ = CloseHandle(handle);
                    return Err("timeout reading response".to_string());
                }
                let mut bytes_read: u32 = 0;
                let read_result = ReadFile(handle, Some(&mut chunk), Some(&mut bytes_read), None);
                if read_result.is_err() {
                    let _ = CloseHandle(handle);
                    return Err("read failed".to_string());
                }
                if bytes_read == 0 {
                    break; // EOF
                }
                buf.extend_from_slice(&chunk[..bytes_read as usize]);
                if buf.contains(&b'\n') {
                    break;
                }
                if buf.len() > 8192 {
                    let _ = CloseHandle(handle);
                    return Err("response too large".to_string());
                }
            }

            let _ = CloseHandle(handle);

            // Parse response (take bytes before newline)
            let line_end = buf.iter().position(|&b| b == b'\n').unwrap_or(buf.len());
            let line_bytes = &buf[..line_end];
            let line_str = std::str::from_utf8(line_bytes)
                .map_err(|e| format!("utf8 error: {}", e))?;
            let resp: Resp = serde_json::from_str(line_str)
                .map_err(|e| format!("json parse: {}", e))?;
            Ok(resp)
        }
    }

    /// Convenience: get_status sends {"cmd":"status"} and parses the response.
    pub fn get_status(&self) -> Result<ServiceStatus, String> {
        let req = serde_json::json!({"cmd":"status"});
        let resp: ServiceStatusResponse = self.request(&req)?;
        match resp {
            ServiceStatusResponse::Status { status } => Ok(status),
            ServiceStatusResponse::Error { msg } => Err(msg),
            _ => Err("unexpected response type".to_string()),
        }
    }

    /// Convenience: send a start request to the service host.
    pub fn start(&self, svc: &str) -> Result<String, String> {
        let req = serde_json::json!({"cmd":"start","svc":svc});
        let resp: ServiceStatusResponse = self.request(&req)?;
        match resp {
            ServiceStatusResponse::Ok { msg } => Ok(msg),
            ServiceStatusResponse::Error { msg } => Err(msg),
            _ => Err("unexpected response type".to_string()),
        }
    }

    /// Convenience: send a stop request.
    pub fn stop(&self, svc: &str) -> Result<String, String> {
        let req = serde_json::json!({"cmd":"stop","svc":svc});
        let resp: ServiceStatusResponse = self.request(&req)?;
        match resp {
            ServiceStatusResponse::Ok { msg } => Ok(msg),
            ServiceStatusResponse::Error { msg } => Err(msg),
            _ => Err("unexpected response type".to_string()),
        }
    }

    /// Convenience: send a restart request.
    pub fn restart(&self, svc: &str) -> Result<String, String> {
        let req = serde_json::json!({"cmd":"restart","svc":svc});
        let resp: ServiceStatusResponse = self.request(&req)?;
        match resp {
            ServiceStatusResponse::Ok { msg } => Ok(msg),
            ServiceStatusResponse::Error { msg } => Err(msg),
            _ => Err("unexpected response type".to_string()),
        }
    }

    /// Convenience: get a health report.
    pub fn get_health(&self) -> Result<HealthReport, String> {
        let req = serde_json::json!({"cmd":"health"});
        let resp: ServiceStatusResponse = self.request(&req)?;
        match resp {
            ServiceStatusResponse::Health { health } => Ok(health),
            ServiceStatusResponse::Error { msg } => Err(msg),
            _ => Err("unexpected response type".to_string()),
        }
    }

    /// Convenience: get diagnostics (last error + log path).
    pub fn diagnostics(&self) -> Result<String, String> {
        let req = serde_json::json!({"cmd":"diagnostics"});
        let resp: ServiceStatusResponse = self.request(&req)?;
        match resp {
            ServiceStatusResponse::Diagnostics { last_error, log_path } => {
                Ok(format!("last_error={:?} log_path={}", last_error, log_path))
            }
            ServiceStatusResponse::Error { msg } => Err(msg),
            _ => Err("unexpected response type".to_string()),
        }
    }
}

// Response variants from the host
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum ServiceStatusResponse {
    Ok { msg: String },
    Error { msg: String },
    Status { status: ServiceStatus },
    Health { health: HealthReport },
    Timestamp { ts: String },
    Diagnostics { last_error: Option<String>, log_path: String },
}
