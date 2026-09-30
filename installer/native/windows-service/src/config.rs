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

        let bin_dir = program_files.join("bin");
        let runtime_dir = program_files.join("runtime");
        let app_dir = program_files.join("app");
        let mini_services = program_files.join("mini-services");

        Self {
            service_name: "ViewLBA".to_string(),
            service_display: "ViewLBA Server".to_string(),
            service_description: "ViewLBA Server — native host for App + Realtime + Stream".to_string(),
            program_files,
            program_data,
            bun_path: runtime_dir.join("bun.exe"),
            app_dir: app_dir.clone(),
            app_entry: app_dir.join("scripts").join("start.ts"),
            realtime_dir: mini_services.join("realtime-service"),
            realtime_entry: mini_services.join("realtime-service").join("index.ts"),
            stream_dir: program_data.join("data"), // stream cwd is ProgramData
            stream_entry: app_dir.join("mini-services").join("stream-service").join("index.ts"),
            log_dir: program_data.join("logs"),
            pid_dir: program_data.join("run"),
            pipe_name: r"\\.\pipe\viewlba-service".to_string(),
            health_check_interval_secs: 5,
            backoff_initial_ms: 5_000,
            backoff_max_ms: 5 * 60_000, // 5 minutes
            backoff_max_attempts: 10,
            stop_timeout_ms: 30_000,
        }
    }
}

pub fn load_config() -> Config {
    let mut cfg = Config::default();

    // Env overrides (for debugging and CI)
    if let Ok(v) = env::var("VIEWLBA_PROGRAM_FILES") {
        cfg.program_files = PathBuf::from(v);
    }
    if let Ok(v) = env::var("VIEWLBA_PROGRAM_DATA") {
        cfg.program_data = PathBuf::from(v);
    }

    // Re-derive dependent paths
    let bin_dir = cfg.program_files.join("bin");
    let runtime_dir = cfg.program_files.join("runtime");
    let app_dir = cfg.program_files.join("app");
    let mini_services = cfg.program_files.join("mini-services");

    cfg.bun_path = runtime_dir.join("bun.exe");
    cfg.app_dir = app_dir.clone();
    cfg.app_entry = app_dir.join("scripts").join("start.ts");
    cfg.realtime_dir = mini_services.join("realtime-service");
    cfg.realtime_entry = cfg.realtime_dir.join("index.ts");
    cfg.stream_dir = cfg.program_data.join("data");
    cfg.stream_entry = app_dir.join("mini-services").join("stream-service").join("index.ts");
    cfg.log_dir = cfg.program_data.join("logs");
    cfg.pid_dir = cfg.program_data.join("run");

    cfg
}
