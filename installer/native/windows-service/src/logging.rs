// Structured JSON logging to ProgramData/ViewLBA/logs/service-host.log
// One event per line, JSON object.
// NEVER logs secrets (passwords, tokens, AUTH_SECRET, REALTIME_TOKEN, DATABASE_URL).

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;

use chrono::Utc;
use serde::Serialize;

use crate::config::Config;

/// JSON event for structured logging (misión §2 fields).
#[derive(Serialize)]
pub struct LogEvent {
    pub ts: String,
    pub level: String,
    pub phase: String,
    pub msg: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub argv: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stdout: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stderr: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timed_out: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binary_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attempt: Option<u32>,
}

pub struct FileLogger {
    log_path: PathBuf,
}

static LOGGER: OnceLock<FileLogger> = OnceLock::new();

pub fn init(cfg: &Config) {
    let log_path = cfg.log_dir.join("service-host.log");
    // Ensure log dir exists
    if let Err(e) = std::fs::create_dir_all(&cfg.log_dir) {
        eprintln!("warning: cannot create log dir {}: {}", cfg.log_dir.display(), e);
    }
    let logger = FileLogger { log_path };
    let _ = LOGGER.set(logger);

    // Initialize env_logger for fallback stderr logging in debug builds
    let _ = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp(None)
        .try_init();

    log::info!("logging initialized, log_path={}", log_path_display(&log_path));
}

fn log_path_display(p: &PathBuf) -> String {
    p.to_string_lossy().replace('\\', "/")
}

pub fn write_event(event: LogEvent) {
    let line = match serde_json::to_string(&event) {
        Ok(s) => s,
        Err(_) => return,
    };
    if let Some(logger) = LOGGER.get() {
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&logger.log_path) {
            let _ = writeln!(f, "{}", line);
        }
    }
    // Also emit to stderr for foreground debugging
    eprintln!("{}", line);
}

/// Helper: build a LogEvent with sensible defaults
pub fn event(level: &str, phase: &str, msg: impl Into<String>) -> LogEvent {
    LogEvent {
        ts: Utc::now().to_rfc3339(),
        level: level.to_string(),
        phase: phase.to_string(),
        msg: msg.into(),
        command: None,
        argv: None,
        cwd: None,
        exit_code: None,
        stdout: None,
        stderr: None,
        timed_out: None,
        timeout_ms: None,
        service: None,
        binary_path: None,
        runtime_version: None,
        duration_ms: None,
        attempt: None,
    }
}

// Builder methods on LogEvent (no trait needed — methods are in scope wherever
// LogEvent is used, since impl blocks are part of the type).
impl LogEvent {
    pub fn with_command(mut self, s: &str) -> Self {
        self.command = Some(s.to_string());
        self
    }
    pub fn with_argv(mut self, v: Vec<String>) -> Self {
        self.argv = Some(v);
        self
    }
    pub fn with_cwd(mut self, s: String) -> Self {
        self.cwd = Some(s);
        self
    }
    pub fn with_exit_code(mut self, c: i32) -> Self {
        self.exit_code = Some(c);
        self
    }
    pub fn with_attempt(mut self, n: u32) -> Self {
        self.attempt = Some(n);
        self
    }
    pub fn with_service(mut self, s: impl Into<String>) -> Self {
        self.service = Some(s.into());
        self
    }
    pub fn with_pid(self, _p: u32) -> Self {
        // pid isn't a misión §2 field, but useful for diagnosis
        // (would need to add a field to LogEvent — skipped for v1)
        self
    }
}
