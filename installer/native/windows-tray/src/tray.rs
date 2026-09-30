// Tray icon + menu + event loop.
//
// Uses tray-icon + tao for the Win32 API surface. The tray icon shows
// status (green=running, red=stopped, yellow=transition). The menu offers
// Iniciar / Detener / Reiniciar / Configurar / Panel / Logs / Salir.

use std::time::Duration;
use std::thread;

use serde::{Deserialize, Serialize};

use crate::config::TrayConfig;
use crate::ipc::IpcClient;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ServiceResponse {
    Ok { msg: String },
    Error { msg: String },
    Status { status: String },
    Health { status: String },
}

pub fn run_tray_loop(cfg: &TrayConfig) -> Result<(), String> {
    // v1 implementation: poll the service every 5s via IPC and log status.
    // A full implementation would use tray-icon + tao for a real event loop,
    // but that requires extensive Win32 GUI wiring. For the FIRST iteration,
    // we provide a polling loop that demonstrates the IPC + lifecycle works.

    let ipc = IpcClient::new(cfg);
    let poll_interval = Duration::from_secs(5);

    log::info!("tray loop started — polling service every {:?}", poll_interval);

    loop {
        match poll_service(&ipc) {
            Ok(resp) => {
                log::info!("service status: {:?}", resp);
            }
            Err(e) => {
                log::warn!("service unreachable: {}", e);
            }
        }
        thread::sleep(poll_interval);
    }
}

fn poll_service(ipc: &IpcClient) -> Result<ServiceResponse, String> {
    let req = serde_json::json!({"cmd":"status"});
    ipc.request::<serde_json::Value, ServiceResponse>(&req, Duration::from_secs(5))
        .ok_or_else(|| "no response from service".to_string())
}
