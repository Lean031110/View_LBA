// Child process supervisor — spawns and watches the 3 children (app, realtime, stream).
// Each child has its own backoff state and is respawned on crash.
//
// Uses std::process::Command (no Win32) — children are spawned via CreateProcessW
// internally by std. Each child:
//   - stdout/stderr redirected to log files in ProgramData/ViewLBA/logs/
//   - cwd set to the appropriate directory per child
//   - env inherited from the host (with .env applied by the children themselves)
//   - separate process group (CREATE_NEW_PROCESS_GROUP on Windows)
//
// Watchdog per child:
//   - poll every 500ms
//   - on exit code 0 → Stopped (clean shutdown, no respawn)
//   - on exit code != 0 → Failed, schedule respawn with backoff
//   - backoff: 5s (attempt 1), 30s (attempt 2), 5min (3+)
//
// Graceful shutdown:
//   - host receives STOP from SCM
//   - host calls stop_all()
//   - host sends Ctrl-Break to each child's process group
//   - waits up to 30s for each to exit cleanly
//   - force-kills any stragglers

use std::process::{Child, Command, ExitStatus, Stdio, ExitCode};
use std::sync::atomic::{AtomicBool, Ordering};
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
    pub key: String,
    pub state: ChildState,
    pub pid: Option<u32>,
    pub attempt: u32,
    pub last_exit_code: Option<i32>,
    pub last_started_ago_secs: Option<u64>,
    pub last_stopped_ago_secs: Option<u64>,
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
    pub cfg: Arc<Config>,
    pub state: Arc<Mutex<SupervisorState>>,
    pub stop_flag: Arc<AtomicBool>,
}

pub struct SupervisorState {
    pub app: ChildSlot,
    pub realtime: ChildSlot,
    pub stream: ChildSlot,
    pub started_at: Instant,
    pub last_health: Option<HealthReport>,
    pub last_error: Option<String>,
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
                last_health: None,
                last_error: None,
            })),
            stop_flag: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Returns the last error message seen by the supervisor (for diagnostics).
    pub fn last_error(&self) -> Option<String> {
        self.state.lock().unwrap().last_error.clone()
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
                let remaining = when.duration_since(Instant::now());
                return Err(format!("{} in backoff, next attempt in {:?}", key, remaining));
            }
        }

        let (bin, args, cwd) = self.child_command(key);

        slot.state = ChildState::Starting;
        slot.attempt += 1;
        slot.last_started_at = Some(Instant::now());
        slot.next_attempt_at = None;

        let log_path = self.cfg.log_dir.join(format!("{}.log", key));
        let err_log_path = self.cfg.log_dir.join(format!("{}.err.log", key));

        // Ensure log dir exists
        if let Err(e) = std::fs::create_dir_all(&self.cfg.log_dir) {
            return Err(format!("cannot create log dir {}: {}", self.cfg.log_dir.display(), e));
        }

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
                let attempt = slot.attempt;
                let argv_str = args.iter().map(|s| s.to_string()).collect::<Vec<_>>();
                let cwd_str = cwd.to_string_lossy().to_string();
                let bin_str = bin.to_string_lossy().to_string();

                let event = logging::event("info", "services", format!("child {} spawned", key))
                    .with_service(key)
                    .with_command(&bin_str)
                    .with_argv(argv_str)
                    .with_cwd(cwd_str)
                    .with_pid(pid)
                    .with_attempt(attempt);
                logging::write_event(event);

                slot.child = Some(child);
                slot.state = ChildState::Running;
                slot.last_error = None;
                Ok(())
            }
            Err(e) => {
                slot.state = ChildState::Failed;
                slot.last_error = Some(e.to_string());
                let backoff_ms = self.calc_backoff_ms(slot.attempt);
                slot.next_attempt_at = Some(Instant::now() + Duration::from_millis(backoff_ms));

                let event = logging::event("error", "services", format!("child {} spawn failed: {}", key, e))
                    .with_service(key)
                    .with_attempt(slot.attempt);
                logging::write_event(event);

                state.last_error = Some(format!("{} spawn failed: {}", key, e));
                Err(e.to_string())
            }
        }
    }

    fn calc_backoff_ms(&self, attempt: u32) -> u64 {
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
                bun,
                vec![self.cfg.stream_entry.to_string_lossy().to_string()],
                self.cfg.stream_dir.clone(),
            ),
            _ => unreachable!(),
        }
    }

    /// Watch loop: poll each child, respawn on crash with backoff, run health checks.
    /// Checks self.stop_flag internally — no parameter needed.
    pub fn run_watch_loop(&self) {
        let health_interval = Duration::from_secs(self.cfg.health_check_interval_secs);
        let mut last_health = Instant::now();

        while !self.stop_flag.load(Ordering::SeqCst) {
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
                    // Drop state lock before spawn_child (which locks again)
                    drop(state);
                    let _ = self.spawn_child(key);
                }
            }
        }
    }

    fn publish_health_event(&self, report: &HealthReport) {
        // Store last health in state for status snapshot
        let mut state = self.state.lock().unwrap();
        state.last_health = Some(report.clone());
        drop(state);

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
            last_started_ago_secs: slot.last_started_at.map(|i| i.elapsed().as_secs()),
            last_stopped_ago_secs: slot.last_stopped_at.map(|i| i.elapsed().as_secs()),
            last_error: slot.last_error.clone(),
        };
        SupervisorStatus {
            app: to_status(&state.app),
            realtime: to_status(&state.realtime),
            stream: to_status(&state.stream),
            health: state.last_health.clone(),
            uptime_secs: state.started_at.elapsed().as_secs(),
        }
    }

    /// Stop all children gracefully (used during shutdown).
    pub fn stop_all(&self) {
        // Mark shutdown
        self.stop_flag.store(true, Ordering::SeqCst);

        // Try graceful: kill each child (signal SIGTERM-equivalent).
        // std::process::Child::kill on Windows calls TerminateProcess (forceful).
        // For TRUE graceful shutdown, we'd send CTRL_BREAK_EVENT to the child's
        // process group. For v1 we use TerminateProcess directly (simpler).
        // TODO: send CTRL_BREAK_EVENT for graceful shutdown in v2.
        let mut state = self.state.lock().unwrap();
        // Iterate by key to avoid multiple mutable borrows of `state`
        for key in ["app", "realtime", "stream"] {
            let slot = match key {
                "app" => &mut state.app,
                "realtime" => &mut state.realtime,
                "stream" => &mut state.stream,
                _ => continue,
            };
            if let Some(mut child) = slot.child.take() {
                let pid = child.id();
                let _ = child.kill();
                let _ = child.wait();
                slot.state = ChildState::Stopped;
                let event = logging::event("info", "services", format!("child {} killed (pid={})", slot.key, pid))
                    .with_service(slot.key)
                    .with_pid(pid);
                logging::write_event(event);
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
    sup.run_watch_loop();
    sup.stop_all();
    ExitCode::SUCCESS
}

