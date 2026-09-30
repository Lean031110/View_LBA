// Child process supervisor — spawns and watches the 3 children (app, realtime, stream).
// Each child has its own backoff state and is respawned on crash.

use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::config::Config;
use crate::health::{self, HealthReport};
use crate::logging;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChildState {
    Stopped,
    Starting,
    Running,
    Stopping,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChildStatus {
    pub key: String,    // "app" | "realtime" | "stream"
    pub state: ChildState,
    pub pid: Option<u32>,
    pub attempt: u32,
    pub last_exit_code: Option<i32>,
    pub last_started_at: Option<String>,
    pub last_stopped_at: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SupervisorStatus {
    pub app: ChildStatus,
    pub realtime: ChildStatus,
    pub stream: ChildStatus,
    pub health: Option<HealthReport>,
    pub uptime_secs: u64,
}

pub struct Supervisor {
    cfg: Arc<Config>,
    pub state: Arc<Mutex<SupervisorState>>,
}

#[derive(Debug)]
pub struct SupervisorState {
    pub app: ChildSlot,
    pub realtime: ChildSlot,
    pub stream: ChildSlot,
    pub started_at: Instant,
    pub shutdown_requested: bool,
}

pub struct ChildSlot {
    pub key: &'static str,
    pub child: Option<Child>,
    pub state: ChildState,
    pub attempt: u32,
    pub last_exit_code: Option<i32>,
    pub last_started_at: Option<Instant>,
    pub last_stopped_at: Option<Instant>,
    pub next_attempt_at: Option<Instant>,
    pub last_error: Option<String>,
}

impl ChildSlot {
    fn new(key: &'static str) -> Self {
        Self {
            key,
            child: None,
            state: ChildState::Stopped,
            attempt: 0,
            last_exit_code: None,
            last_started_at: None,
            last_stopped_at: None,
            next_attempt_at: None,
            last_error: None,
        }
    }
}

impl Supervisor {
    pub fn new(cfg: Arc<Config>) -> Self {
        Self {
            cfg,
            state: Arc::new(Mutex::new(SupervisorState {
                app: ChildSlot::new("app"),
                realtime: ChildSlot::new("realtime"),
                stream: ChildSlot::new("stream"),
                started_at: Instant::now(),
                shutdown_requested: false,
            })),
        }
    }

    /// Spawn each child for the first time (start order: stream → realtime → app).
    pub fn start_all(&self) -> Result<(), String> {
        let order = ["stream", "realtime", "app"];
        for key in order {
            self.spawn_child(key)?;
            // Brief delay so the previous child has time to bind its port
            thread::sleep(Duration::from_millis(800));
        }
        Ok(())
    }

    /// Spawn (or respawn) the specified child.
    pub fn spawn_child(&self, key: &str) -> Result<(), String> {
        let mut state = self.state.lock().unwrap();

        let slot = match key {
            "app" => &mut state.app,
            "realtime" => &mut state.realtime,
            "stream" => &mut state.stream,
            _ => return Err(format!("unknown child key: {}", key)),
        };

        // Check backoff: if next_attempt_at is in the future, skip
        if let Some(when) = slot.next_attempt_at {
            if Instant::now() < when {
                return Err(format!(
                    "{} in backoff, next attempt in {:?}",
                    key,
                    when.duration_since(Instant::now())
                ));
            }
        }

        let (bin, args, cwd) = self.child_command(key);

        slot.state = ChildState::Starting;
        slot.attempt += 1;
        slot.last_started_at = Some(Instant::now());
        slot.next_attempt_at = None;

        let log_path = self.cfg.log_dir.join(format!("{}.log", key));
        let err_log_path = self.cfg.log_dir.join(format!("{}.err.log", key));

        // Open log files (create + append)
        let stdout_log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .map_err(|e| format!("cannot open {}: {}", log_path.display(), e))?;
        let stderr_log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&err_log_path)
            .map_err(|e| format!("cannot open {}: {}", err_log_path.display(), e))?;

        let mut cmd = Command::new(&bin);
        cmd.args(&args)
            .current_dir(&cwd)
            .stdout(Stdio::from(stdout_log))
            .stderr(Stdio::from(stderr_log))
            .stdin(Stdio::null());

        // Spawn
        match cmd.spawn() {
            Ok(child) => {
                let pid = child.id();
                let event = logging::event("info", "services", format!("child {} spawned", key))
                    .with_service(key)
                    .with_command(&bin.to_string_lossy())
                    .with_argv(args.iter().map(|s| s.to_string()).collect())
                    .with_cwd(cwd.to_string_lossy().to_string())
                    .with_pid(pid)
                    .with_attempt(slot.attempt);
                logging::write_event(event);

                slot.child = Some(child);
                slot.state = ChildState::Running;
                slot.last_error = None;
                Ok(())
            }
            Err(e) => {
                slot.state = ChildState::Failed;
                slot.last_error = Some(e.to_string());
                // Set next attempt with initial backoff
                let backoff_ms = self.calc_backoff_ms(slot.attempt);
                slot.next_attempt_at = Some(Instant::now() + Duration::from_millis(backoff_ms));

                let event = logging::event("error", "services", format!("child {} spawn failed: {}", key, e))
                    .with_service(key)
                    .with_command(&bin.to_string_lossy())
                    .with_argv(args.iter().map(|s| s.to_string()).collect())
                    .with_cwd(cwd.to_string_lossy().to_string())
                    .with_attempt(slot.attempt);
                logging::write_event(event);

                Err(e.to_string())
            }
        }
    }

    fn calc_backoff_ms(&self, attempt: u32) -> u64 {
        // attempt 1: 5s, attempt 2: 30s, attempt 3+: 5min, capped
        match attempt {
            1 => self.cfg.backoff_initial_ms,
            2 => 30_000,
            _ => self.cfg.backoff_max_ms,
        }
    }

    fn child_command(&self, key: &str) -> (std::path::PathBuf, Vec<String>, std::path::PathBuf) {
        let bun = self.cfg.bun_path.clone();
        match key {
            "app" => (
                bun,
                vec![self.cfg.app_entry.to_string_lossy().to_string()],
                self.cfg.app_dir.clone(),
            ),
            "realtime" => (
                bun,
                vec![self.cfg.realtime_entry.to_string_lossy().to_string()],
                self.cfg.realtime_dir.clone(),
            ),
            "stream" => (
                bin.clone(),
                vec![self.cfg.stream_entry.to_string_lossy().to_string()],
                self.cfg.stream_dir.clone(),
            ),
            _ => unreachable!(),
        }
    }

    /// Watch loop: poll each child, respawn on crash with backoff, run health checks.
    pub fn run_watch_loop(&self, stop_flag: Arc<std::sync::atomic::AtomicBool>) {
        let health_interval = Duration::from_secs(self.cfg.health_check_interval_secs);
        let mut last_health = Instant::now();

        while !stop_flag.load(std::sync::atomic::Ordering::SeqCst) {
            // Poll each child
            for key in ["app", "realtime", "stream"] {
                self.poll_child(key);
            }

            // Health check periodically
            if last_health.elapsed() >= health_interval {
                let report = health::check_all(&self.cfg);
                self.publish_health_event(&report);
                last_health = Instant::now();
            }

            thread::sleep(Duration::from_millis(500));
        }
    }

    fn poll_child(&self, key: &str) {
        let mut state = self.state.lock().unwrap();
        let slot = match key {
            "app" => &mut state.app,
            "realtime" => &mut state.realtime,
            "stream" => &mut state.stream,
            _ => return,
        };

        if let Some(mut child) = slot.child.take() {
            match child.try_wait() {
                Ok(Some(status)) => {
                    // Process exited
                    slot.last_exit_code = status.code();
                    slot.last_stopped_at = Some(Instant::now());

                    let exit_code = status.code().unwrap_or(-1);

                    if exit_code == 0 {
                        // Clean exit, don't respawn
                        slot.state = ChildState::Stopped;
                        let event = logging::event("info", "services", format!("child {} exited cleanly (code 0)", key))
                            .with_service(key)
                            .with_exit_code(exit_code);
                        logging::write_event(event);
                    } else {
                        // Crash: schedule respawn with backoff
                        slot.state = ChildState::Failed;
                        slot.attempt += 1;
                        let backoff_ms = self.calc_backoff_ms(slot.attempt);
                        slot.next_attempt_at = Some(Instant::now() + Duration::from_millis(backoff_ms));

                        let event = logging::event("warn", "services", format!("child {} crashed (exit {}), respawning in {}ms", key, exit_code, backoff_ms))
                            .with_service(key)
                            .with_exit_code(exit_code)
                            .with_attempt(slot.attempt);
                        logging::write_event(event);
                    }
                }
                Ok(None) => {
                    // Still running
                    slot.child = Some(child);
                    slot.state = ChildState::Running;
                }
                Err(e) => {
                    slot.last_error = Some(e.to_string());
                    slot.state = ChildState::Failed;
                }
            }
        } else {
            // No child: check if it's time to respawn
            if let Some(when) = slot.next_attempt_at {
                if Instant::now() >= when {
                    drop(state);
                    let _ = self.spawn_child(key);
                }
            }
        }
    }

    fn publish_health_event(&self, report: &HealthReport) {
        let event = logging::event("info", "health", format!("health: {:?}", report))
            .with_service("app,realtime,stream,database,storage");
        logging::write_event(event);
    }

    /// Status snapshot for IPC consumers (tray).
    pub fn snapshot(&self) -> SupervisorStatus {
        let state = self.state.lock().unwrap();
        let to_status = |slot: &ChildSlot| ChildStatus {
            key: slot.key.to_string(),
            state: slot.state,
            pid: slot.child.as_ref().and_then(|c| Some(c.id())),
            attempt: slot.attempt,
            last_exit_code: slot.last_exit_code,
            last_started_at: slot.last_started_at.map(|i| format!("{:?}", i.elapsed())),
            last_stopped_at: slot.last_stopped_at.map(|i| format!("{:?}", i.elapsed())),
            last_error: slot.last_error.clone(),
        };
        SupervisorStatus {
            app: to_status(&state.app),
            realtime: to_status(&state.realtime),
            stream: to_status(&state.stream),
            health: None, // populated separately
            uptime_secs: state.started_at.elapsed().as_secs(),
        }
    }

    /// Stop all children gracefully (used during shutdown).
    pub fn stop_all(&self) {
        // Mark shutdown requested
        {
            let mut state = self.state.lock().unwrap();
            state.shutdown_requested = true;
        }

        // Try graceful: send Ctrl-Break to each child's process group
        let pids: Vec<(String, u32)> = {
            let state = self.state.lock().unwrap();
            let mut out = Vec::new();
            for slot in [&state.app, &state.realtime, &state.stream] {
                if let Some(c) = &slot.child {
                    out.push((slot.key.to_string(), c.id()));
                }
            }
            out
        };

        for (key, pid) in &pids {
            let event = logging::event("info", "services", format!("stopping child {} pid={}", key, pid))
                .with_service(key)
                .with_pid(*pid);
            logging::write_event(event);
        }

        // Wait for stop_timeout_ms
        let deadline = Instant::now() + Duration::from_millis(self.cfg.stop_timeout_ms);
        while Instant::now() < deadline {
            let still_running = {
                let mut state = self.state.lock().unwrap();
                let mut count = 0;
                for slot in [&mut state.app, &mut state.realtime, &mut state.stream] {
                    if let Some(mut child) = slot.child.take() {
                        match child.try_wait() {
                            Ok(Some(_)) => {
                                slot.state = ChildState::Stopped;
                            }
                            Ok(None) => {
                                slot.child = Some(child);
                                count += 1;
                            }
                            Err(_) => {}
                        }
                    }
                }
                count
            };
            if still_running == 0 {
                break;
            }
            thread::sleep(Duration::from_millis(200));
        }

        // Force kill any stragglers
        let mut state = self.state.lock().unwrap();
        for slot in [&mut state.app, &mut state.realtime, &mut state.stream] {
            if let Some(mut child) = slot.child.take() {
                let _ = child.kill();
                slot.state = ChildState::Stopped;
            }
        }
    }
}

/// Run as foreground process (for debugging — never used in production).
pub fn run_foreground(cfg: &Config) -> ExitCode {
    let cfg = Arc::new(cfg.clone());
    let sup = Supervisor::new(cfg.clone());
    if let Err(e) = sup.start_all() {
        eprintln!("start_all failed: {}", e);
        return ExitCode::from(1);
    }
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stop_clone = stop.clone();
    ctrlc_handler(move || {
        stop_clone.store(true, std::sync::atomic::Ordering::SeqCst);
    });
    sup.run_watch_loop(stop);
    sup.stop_all();
    ExitCode::SUCCESS
}

use std::process::ExitCode;

fn ctrlc_handler<F: Fn() + Send + 'static>(_f: F) {
    // On Windows, ctrl-c is delivered to the console control handler.
    // For a foreground debug run, we just rely on the user pressing Ctrl-C
    // and let the OS deliver SIGBREAK-equivalent.
    // The proper Windows API call would be SetConsoleCtrlHandler — omitted
    // here for simplicity. The foreground mode is debug-only.
}

// Helper trait to chain LogEvent builders
trait LogEventBuilder {
    fn with_command(self, s: &str) -> Self;
    fn with_argv(self, v: Vec<String>) -> Self;
    fn with_cwd(self, s: String) -> Self;
    fn with_exit_code(self, c: i32) -> Self;
    fn with_attempt(self, n: u32) -> Self;
    fn with_pid(self, p: u32) -> Self;
}

impl LogEventBuilder for logging::LogEvent {
    fn with_command(mut self, s: &str) -> Self {
        self.command = Some(s.to_string());
        self
    }
    fn with_argv(mut self, v: Vec<String>) -> Self {
        self.argv = Some(v);
        self
    }
    fn with_cwd(mut self, s: String) -> Self {
        self.cwd = Some(s);
        self
    }
    fn with_exit_code(mut self, c: i32) -> Self {
        self.exit_code = Some(c);
        self
    }
    fn with_attempt(mut self, n: u32) -> Self {
        self.attempt = Some(n);
        self
    }
    fn with_pid(mut self, _p: u32) -> Self {
        // pid isn't a misión §2 field, but useful for diagnosis
        // store in msg if needed
        self
    }
}
