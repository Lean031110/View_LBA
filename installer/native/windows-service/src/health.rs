// Health checks: HTTP GET to each child's /api/health or /health endpoint.
// Real, no shell, no curl — pure Rust ureq sync HTTP client.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::config::Config;
use crate::logging;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HealthStatus {
    Ok,
    Degraded,
    Down,
    Unknown,
}

impl HealthStatus {
    pub fn worst_of(a: HealthStatus, b: HealthStatus) -> HealthStatus {
        use HealthStatus::*;
        match (a, b) {
            (Ok, x) | (x, Ok) => x,
            (Down, _) | (_, Down) => Down,
            (Degraded, _) | (_, Degraded) => Degraded,
            (Unknown, Unknown) => Unknown,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthReport {
    pub app: HealthStatus,
    pub realtime: HealthStatus,
    pub stream: HealthStatus,
    pub database: HealthStatus,
    pub storage: HealthStatus,
    pub overall: HealthStatus,
}

pub fn check_all(cfg: &Config) -> HealthReport {
    let app = http_get_status("http://127.0.0.1:3000/api/health", 2_000);
    let realtime = http_get_status("http://127.0.0.1:3003/health", 2_000);
    let stream = http_get_status("http://127.0.0.1:8100/health", 2_000);
    let database = check_db_writable(&cfg.program_data.join("data").join("db"));
    let storage = check_dir_writable(&cfg.program_data.join("data").join("media"));

    let overall = HealthStatus::worst_of(
        app,
        HealthStatus::worst_of(
            realtime,
            HealthStatus::worst_of(
                stream,
                HealthStatus::worst_of(database, storage),
            ),
        ),
    );

    HealthReport {
        app,
        realtime,
        stream,
        database,
        storage,
        overall,
    }
}

fn http_get_status(url: &str, timeout_ms: u64) -> HealthStatus {
    match ureq::get(url)
        .timeout(Duration::from_millis(timeout_ms))
        .call()
    {
        Ok(resp) => {
            if resp.status() == 200 {
                HealthStatus::Ok
            } else {
                HealthStatus::Degraded
            }
        }
        Err(_) => HealthStatus::Down,
    }
}

fn check_db_writable(db_dir: &std::path::Path) -> HealthStatus {
    if !db_dir.exists() {
        return HealthStatus::Down;
    }
    let test_file = db_dir.join(".viewlba-health-write-test");
    match std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&test_file)
    {
        Ok(mut f) => {
            use std::io::Write;
            let _ = f.write_all(b"ok");
            drop(f);
            let _ = std::fs::remove_file(&test_file);
            HealthStatus::Ok
        }
        Err(_) => HealthStatus::Down,
    }
}

fn check_dir_writable(dir: &std::path::Path) -> HealthStatus {
    if !dir.exists() {
        return HealthStatus::Down;
    }
    let test_file = dir.join(".viewlba-health-write-test");
    match std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&test_file)
    {
        Ok(mut f) => {
            use std::io::Write;
            let _ = f.write_all(b"ok");
            drop(f);
            let _ = std::fs::remove_file(&test_file);
            HealthStatus::Ok
        }
        Err(_) => HealthStatus::Down,
    }
}

pub fn log_report(report: &HealthReport) {
    // Simple logging — don't use the with_service trait (would require importing it).
    logging::write_event(logging::event("info", "health", format!("health check result: {:?}", report)));
}

// Trait removed — methods directly on LogEvent in logging.rs would be cleaner
// but for v1 we just inline the values.
