// Named-pipe IPC client: connects to \\.\\pipe\\viewlba-service and sends
// a single JSON request, reads a single JSON response, then disconnects.

use std::io::{Read, Write};
use std::time::Duration;

use serde::{de::DeserializeOwned, Serialize};

use crate::config::TrayConfig;

pub struct IpcClient {
    pipe_name: String,
}

impl IpcClient {
    pub fn new(cfg: &TrayConfig) -> Self {
        Self { pipe_name: cfg.pipe_name.clone() }
    }

    /// Send a request and read a response. Returns None on connection failure
    /// (e.g., service not running).
    pub fn request<Req: Serialize, Resp: DeserializeOwned>(
        &self,
        req: &Req,
        timeout: Duration,
    ) -> Option<Resp> {
        // On Windows, use CreateFileW to open the named pipe.
        // On non-Windows, return None (stub for cross-compile).
        #[cfg(target_os = "windows")]
        {
            use windows_sys::Win32::Storage::FileSystem::*;
            use windows_sys::Win32::Foundation::{GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE};

            let pipe_wide: Vec<u16> = self.pipe_name
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect();

            let handle = unsafe {
                CreateFileW(
                    pipe_wide.as_ptr(),
                    GENERIC_READ | GENERIC_WRITE,
                    0,
                    std::ptr::null(),
                    OPEN_EXISTING,
                    0,
                    std::ptr::null(),
                )
            };

            if handle == 0 || handle == INVALID_HANDLE_VALUE {
                return None;
            }

            // Set read timeout
            let _ = timeout;

            // Write request
            let req_json = serde_json::to_string(req).ok()?;
            let req_bytes = format!("{}\n", req_json).into_bytes();

            let mut written: u32 = 0;
            let ok = unsafe {
                WriteFile(handle, req_bytes.as_ptr() as *const _, req_bytes.len() as u32, &mut written, std::ptr::null_mut())
            };
            if ok == 0 {
                unsafe { CloseHandle(handle) };
                return None;
            }

            // Read response (line-delimited JSON)
            let mut buf = Vec::new();
            let mut chunk = [0u8; 1024];
            let mut bytes_read: u32 = 0;
            loop {
                let ok = unsafe {
                    ReadFile(handle, chunk.as_mut_ptr() as *mut _, chunk.len() as u32, &mut bytes_read, std::ptr::null_mut())
                };
                if ok == 0 || bytes_read == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..bytes_read as usize]);
                if buf.contains(&b'\n') {
                    break;
                }
            }

            unsafe { CloseHandle(handle) };

            let line = buf.iter().take_while(|&&b| b != b'\n').copied().collect::<Vec<u8>>();
            let line_str = String::from_utf8_lossy(&line);
            serde_json::from_str(&line_str).ok()
        }

        #[cfg(not(target_os = "windows"))]
        {
            let _ = (req, timeout);
            None::<Resp>
        }
    }
}
