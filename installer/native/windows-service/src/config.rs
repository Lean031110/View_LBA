// Config loading: reads from ProgramData/ViewLBA/config/service-host.toml
// with env overrides. Falls back to sensible defaults if missing.

use std::env;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct Config {
    pub service_name: String,
    pub service_display: String,
    pub service_description: String,
    pub program_files: PathBuf,
    pub program_data: PathBuf,
    pub bun_path: PathBuf,
    pub app_dir: PathBuf,
    pub app_entry: PathBuf,
    pub realtime_dir: PathBuf,
    pub realtime_entry: PathBuf,
    pub stream_dir: PathBuf,
    pub stream_entry: PathBuf,
    pub log_dir: PathBuf,
    pub pid_dir: PathBuf,
    pub pipe_name: String,
    pub health_check_interval_secs: u64,
    pub backoff_initial_ms: u64,
    pub backoff_max_ms: u64,
    pub backoff_max_attempts: u32,
    pub stop_timeout_ms: u64,
}

impl Default for Config {
    fn default() -> Self {
        let program_files = PathBuf::from(r"C:\Program Files\ViewLBA Server");
        let program_data = PathBuf::from(r"C:\ProgramData\ViewLBA");

        let runtime_dir = program_files.join("runtime");
        let app_dir = program_files.join("app");
        let mini_services = program_files.join("mini-services");

        // Clone before moving into Self to use in derived paths
        let program_data_for_self = program_data.clone();
        let app_dir_for_self = app_dir.clone();
        let mini_services_for_self = mini_services.clone();

        Self {
            service_name: "ViewLBA".to_string(),
            service_display: "ViewLBA Server".to_string(),
            service_description: "ViewLBA Server — native host for App + Realtime + Stream".to_string(),
            program_files,
            program_data: program_data_for_self,
            bun_path: runtime_dir.join("bun.exe"),
            app_dir: app_dir_for_self.clone(),
            // Next.js standalone produces server.js at the ROOT of the standalone
            // output. The stage-windows.ts copies .next/standalone/* → app/*
            // (so app/server.js exists). The standalone server.js uses cwd to
            // find .next/ and node_modules/ — cwd must be app_dir.
            app_entry: app_dir_for_self.join("server.js"),
            realtime_dir: mini_services_for_self.clone().join("realtime-service"),
            realtime_entry: mini_services_for_self.join("realtime-service").join("index.ts"),
            // stream-service is in mini-services/, NOT app/mini-services/
            stream_dir: mini_services.clone().join("stream-service"),
            stream_entry: mini_services.join("stream-service").join("index.ts"),
            log_dir: program_data.join("logs"),
            pid_dir: program_data.join("run"),
            pipe_name: r"\\.\pipe\viewlba-service".to_string(),
            health_check_interval_secs: 5,
            backoff_initial_ms: 5_000,
            backoff_max_ms: 5 * 60_000,
            backoff_max_attempts: 10,
            stop_timeout_ms: 30_000,
        }
    }
}

pub fn load_config() -> Config {
    let mut cfg = Config::default();

    // AUTO-DETECT install path from binary location
    // The service binary is at: <Program Files>\ViewLBA Server\bin\viewlba-service.exe
    // So the install root is 3 levels up from the binary
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(bin_dir) = exe_path.parent() {
            if let Some(install_root) = bin_dir.parent() {
                // Check if this looks like our install dir (has "bin" subfolder)
                if bin_dir.ends_with("bin") {
                    cfg.program_files = install_root.to_path_buf();
                    cfg.bun_path = install_root.join("runtime").join("bun.exe");
                    cfg.app_dir = install_root.join("app");
                    // Next.js standalone produces server.js at the ROOT of the
                    // standalone output (not under scripts/). The stage-windows.ts
                    // copies .next/standalone/* → app/* (so app/server.js exists).
                    cfg.app_entry = cfg.app_dir.join("server.js");
                    cfg.realtime_dir = install_root.join("mini-services").join("realtime-service");
                    cfg.realtime_entry = cfg.realtime_dir.join("index.ts");
                    // stream-service is in mini-services/, NOT app/mini-services/
                    cfg.stream_dir = install_root.join("mini-services").join("stream-service");
                    cfg.stream_entry = cfg.stream_dir.join("index.ts");
                    cfg.log_dir = cfg.program_data.join("logs");
                    cfg.pid_dir = cfg.program_data.join("run");
                }
            }
        }
    }

    // Env overrides (for debugging and CI)
    if let Ok(v) = env::var("VIEWLBA_PROGRAM_FILES") {
        cfg.program_files = PathBuf::from(v);
    }
    if let Ok(v) = env::var("VIEWLBA_PROGRAM_DATA") {
        cfg.program_data = PathBuf::from(v);
        cfg.log_dir = cfg.program_data.join("logs");
        cfg.pid_dir = cfg.program_data.join("run");
    }

    cfg
}
