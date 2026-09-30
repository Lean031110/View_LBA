// Tray config — same defaults as the service host.

use std::env;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct TrayConfig {
    pub program_files: PathBuf,
    pub program_data: PathBuf,
    pub log_dir: PathBuf,
    pub pipe_name: String,
    pub panel_url: String,
    pub credentials_path: PathBuf,
}

impl Default for TrayConfig {
    fn default() -> Self {
        let program_files = PathBuf::from(r"C:\Program Files\ViewLBA Server");
        let program_data = PathBuf::from(r"C:\ProgramData\ViewLBA");
        // Clone program_data before moving into Self so we can use it for derived paths
        let program_data_for_self = program_data.clone();
        Self {
            program_files,
            program_data: program_data_for_self,
            log_dir: program_data.join("logs"),
            pipe_name: r"\\.\pipe\viewlba-service".to_string(),
            panel_url: "http://localhost:3000".to_string(),
            credentials_path: program_data.join("credentials").join("CREDENCIALES.txt"),
        }
    }
}

pub fn load_config() -> TrayConfig {
    let mut cfg = TrayConfig::default();
    if let Ok(v) = env::var("VIEWLBA_PROGRAM_FILES") {
        cfg.program_files = PathBuf::from(v);
    }
    if let Ok(v) = env::var("VIEWLBA_PROGRAM_DATA") {
        cfg.program_data = PathBuf::from(v);
    }
    cfg.log_dir = cfg.program_data.join("logs");
    cfg.credentials_path = cfg.program_data.join("credentials").join("CREDENCIALES.txt");
    cfg
}
