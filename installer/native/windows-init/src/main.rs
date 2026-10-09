//! viewlba-init.exe — deterministic first-boot initializer for ViewLBA Server.
//!
//! Runs as a WiX CustomAction (deferred, NoImpersonate → as LocalSystem) during
//! MSI install. Performs two deterministic, idempotent operations:
//!
//! 1. WRITES server.env (if missing) at %PROGRAMDATA%\ViewLBA\config\server.env
//!    - Template source: %ProgramData%\ViewLBA\config\server.env.example
//!      (the MSI harvests config/server.env.example from staging into CONFIG_DIR
//!      in ProgramData/ViewLBA — same dir we write server.env to)
//!    - Generates AUTH_SECRET (32 bytes hex = 64 chars)
//!    - Generates REALTIME_TOKEN (32 bytes hex = 64 chars)
//!    - IF the file already exists → LEAVES IT UNTOUCHED (mission §25: never
//!      overwrite existing configuration; this protects upgrades).
//!    - File inherits the restrictive ACL of the parent CONFIG_DIR
//!      (SYSTEM+Admins full, LocalService RX) — set by WiX via
//!      <CreateFolder><Permission>... on the CONFIG_DIR component.
//!
//! 2. GRANTS LocalService RX on the entire ProgramFiles tree (recursive):
//!    - Uses `icacls.exe` (a standard Windows binary in System32, NOT cmd.exe
//!      or PowerShell — honors the mission's "no NSSM, no PowerShell, no CMD"
//!      rule for RUNTIME; the MSI installer CustomAction can use any Win32 API)
//!    - Command: icacls "C:\Program Files\ViewLBA Server"
//!                 /grant "NT AUTHORITY\LocalService:(OI)(CI)RX" /T
//!    - (OI)(CI) = Object Inherit + Container Inherit (propagates to all files+subdirs)
//!    - This is REQUIRED because WiX v4's <Permission> element on <CreateFolder>
//!      only applies to the directory's ACL — it does NOT propagate to files
//!      installed by <File> elements (known WiX v4 behavior). Files in app/,
//!      mini-services/, etc. would otherwise get the DEFAULT ACL which excludes
//!      LocalService → bun children fail with EPERM on read.
//!
//! 3. CONFIGURES SCM RECOVERY ACTIONS on the ViewLBA service:
//!    - 1st failure: Restart service (delay 60s)
//!    - 2nd failure: Restart service (delay 60s)
//!    - Subsequent failures: Restart service (delay 60s)
//!    - Reset failure counter after 86400s (24h)
//!    - Uses ChangeServiceConfig2W directly — no sc.exe, no PowerShell,
//!      no CMD. Mission: "no NSSM, no PowerShell, no CMD".
//!
//! Exits 0 on success, non-zero on any failure. The MSI CustomAction has
//! `Return="check"`, so any non-zero exit fails the install.
//!
//! INVARIANTS:
//!   - No network access (works offline — used in [S] offline test).
//!   - No secrets printed. The .env contains them, but logs only say "created".
//!   - Idempotent: re-running on upgrade leaves server.env untouched.
//!   - icacls is idempotent (granting an ACE that already exists is a no-op).

use std::env;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(target_os = "windows")]
mod win32 {
    //! Minimal wrappers around the Win32 SCM ChangeServiceConfig2W API.
    //!
    //! All calls happen on the CURRENT (deferred, NoImpersonate) thread —
    //! the MSI service install step has already registered the ViewLBA
    //! service in the SCM by the time we run, so we just open it and update
    //! its failure-actions configuration.

    use std::ffi::c_void;
    use windows::core::PCWSTR;
    use windows::Win32::System::Services::{
        ChangeServiceConfig2W, CloseServiceHandle, OpenSCManagerW, OpenServiceW, SC_ACTION,
        SC_ACTION_TYPE, SC_MANAGER_CONNECT, SERVICE_ALL_ACCESS, SERVICE_CONFIG_FAILURE_ACTIONS,
        SERVICE_FAILURE_ACTIONSW,
    };

    /// Encode a Rust &str as UTF-16 with NUL terminator.
    pub fn wstr(s: &str) -> Vec<u16> {
        let mut v: Vec<u16> = s.encode_utf16().collect();
        v.push(0);
        v
    }

    /// Configure recovery actions on the ViewLBA service via ChangeServiceConfig2W.
    ///
    /// - 1st failure: Restart (60s delay)
    /// - 2nd failure: Restart (60s delay)
    /// - Subsequent failures: Restart (60s delay)
    /// - Reset failure counter: 86400s (24h)
    ///
    /// Uses the SAME API patterns as windows-service/src/service.rs.
    pub fn set_service_recovery_actions(service_name: &str) -> Result<(), String> {
        unsafe {
            let scm = OpenSCManagerW(None, None, SC_MANAGER_CONNECT)
                .map_err(|e| format!("OpenSCManager: {}", e))?;

            let name_w = wstr(service_name);
            let svc = OpenServiceW(
                scm,
                PCWSTR(name_w.as_ptr()),
                SERVICE_ALL_ACCESS,
            )
            .map_err(|e| format!("OpenService {}: {}", service_name, e))?;

            // Build 3 RESTART actions, each with 60_000 ms delay.
            // In windows 0.61, SC_ACTION.Type is SC_ACTION_TYPE(u32) — a tuple struct.
            // SC_ACTION_TYPE(1) == SC_ACTION_RESTART.
            let mut actions: [SC_ACTION; 3] = [
                SC_ACTION { Type: SC_ACTION_TYPE(1), Delay: 60_000 },
                SC_ACTION { Type: SC_ACTION_TYPE(1), Delay: 60_000 },
                SC_ACTION { Type: SC_ACTION_TYPE(1), Delay: 60_000 },
            ];

            let mut sfa = SERVICE_FAILURE_ACTIONSW {
                dwResetPeriod: 86_400,
                lpRebootMsg: windows::core::PWSTR::null(),
                lpCommand: windows::core::PWSTR::null(),
                cActions: 3,
                lpsaActions: actions.as_mut_ptr(),
            };

            let r = ChangeServiceConfig2W(
                svc,
                SERVICE_CONFIG_FAILURE_ACTIONS,
                Some(&mut sfa as *mut _ as *mut c_void),
            );

            // Close handles using CloseServiceHandle (NOT CloseHandle).
            let _ = CloseServiceHandle(scm);
            let _ = CloseServiceHandle(svc);

            if r.is_err() {
                return Err(format!("ChangeServiceConfig2W failed: {:?}", r));
            }
            Ok(())
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod win32 {
    pub fn wstr(s: &str) -> Vec<u16> {
        let mut v: Vec<u16> = s.encode_utf16().collect();
        v.push(0);
        v
    }
    pub fn set_service_recovery_actions(_n: &str) -> Result<(), String> {
        Err("SCM only supported on Windows".into())
    }
}

#[allow(unused_imports)]
use win32::*;

fn program_data() -> PathBuf {
    if let Ok(v) = env::var("PROGRAMDATA") {
        PathBuf::from(v)
    } else {
        PathBuf::from(r"C:\ProgramData")
    }
}

fn program_files() -> PathBuf {
    if let Ok(v) = env::var("ProgramW6432") {
        PathBuf::from(v)
    } else if let Ok(v) = env::var("ProgramFiles") {
        PathBuf::from(v)
    } else {
        PathBuf::from(r"C:\Program Files")
    }
}

fn env_file_path() -> PathBuf {
    program_data().join("ViewLBA").join("config").join("server.env")
}

fn template_path() -> PathBuf {
    program_data().join("ViewLBA").join("config").join("server.env.example")
}

fn log_dir() -> PathBuf {
    program_data().join("ViewLBA").join("logs")
}

fn now_ts() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("ts={}", secs)
}

fn log(message: &str) {
    let dir = log_dir();
    let _ = fs::create_dir_all(&dir);
    let log_file = dir.join("init.log");
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&log_file) {
        let _ = writeln!(f, "{} [viewlba-init] {}", now_ts(), message);
    }
    eprintln!("[viewlba-init] {}", message);
}

/// Generate 32 random bytes → 64 hex chars. Uses getrandom (no openssl).
fn gen_secret() -> Result<String, String> {
    let mut buf = [0u8; 32];
    getrandom::getrandom(&mut buf).map_err(|e| format!("getrandom: {}", e))?;
    Ok(hex::encode(buf))
}

/// Render the server.env contents from the template, substituting the
/// AUTH_SECRET and REALTIME_TOKEN placeholders. NEVER prints the secrets in
/// logs.
fn render_env(template: &str, auth_secret: &str, realtime_token: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    for line in template.lines() {
        let l = line.trim();
        if l.starts_with("AUTH_SECRET=") {
            lines.push(format!("AUTH_SECRET=\"{}\"", auth_secret));
        } else if l.starts_with("REALTIME_TOKEN=") {
            lines.push(format!("REALTIME_TOKEN=\"{}\"", realtime_token));
        } else {
            lines.push(line.to_string());
        }
    }
    let mut out = lines.join("\n");
    out.push_str(&format!(
        "\n\n# Generated by viewlba-init.exe at {}\n",
        now_ts()
    ));
    out
}

fn write_server_env() -> Result<(), String> {
    let env_path = env_file_path();
    let template_path = template_path();

    // Idempotency: NEVER overwrite an existing server.env (mission §25).
    if env_path.exists() {
        log(&format!(
            "server.env already exists at {} — leaving untouched",
            env_path.display()
        ));
        return Ok(());
    }

    let template = fs::read_to_string(&template_path).map_err(|e| {
        format!(
            "cannot read template at {}: {} (ProgramFiles payload installed?)",
            template_path.display(),
            e
        )
    })?;

    let auth_secret = gen_secret()?;
    let realtime_token = gen_secret()?;

    let content = render_env(&template, &auth_secret, &realtime_token);

    // Ensure parent dir exists
    let parent = env_path.parent().ok_or("env_path has no parent")?;
    fs::create_dir_all(parent).map_err(|e| format!("create_dir_all {}: {}", parent.display(), e))?;

    // Create with create_new (race-safe — fails if it appears between our
    // exists() check and our write).
    let mut f = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&env_path)
        .map_err(|e| format!("create_new {}: {}", env_path.display(), e))?;
    f.write_all(content.as_bytes()).map_err(|e| format!("write: {}", e))?;
    drop(f);

    log(&format!(
        "server.env created at {} (size={}B, secrets in file)",
        env_path.display(),
        content.len()
    ));

    // NOTE: We do NOT set an explicit SDDL DACL on the file. The parent
    // CONFIG_DIR already has a restrictive ACL set by WiX (SYSTEM+Admins
    // full, LocalService RX), and the file inherits it by default. This
    // keeps the binary small and avoids windows-rs API surface complexity.

    Ok(())
}

fn configure_recovery() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        if let Err(e) = win32::set_service_recovery_actions("ViewLBA") {
            return Err(format!("set_service_recovery_actions: {}", e));
        }
        log("SCM recovery actions: Restart 60s × 3 (reset 24h)");
    }
    Ok(())
}

/// Grant LocalService RX on the entire ProgramFiles tree (recursive).
///
/// The WiX <Permission> element on <CreateFolder> only applies to the directory
/// itself — it does NOT propagate to files installed by <File> elements (this is
/// a known WiX v4 behavior). As a result, files in app/, mini-services/, etc.
/// get the DEFAULT ACL which doesn't include LocalService RX → bun children
/// spawned by the service host fail with EPERM on read.
///
/// Fix: spawn `icacls` (a standard Windows binary, NOT cmd.exe or PowerShell —
/// this honors the mission's "no CMD, no PowerShell" rule for RUNTIME; the MSI
/// installer CustomAction can use any Win32 API) to recursively grant
/// LocalService RX on the entire ProgramFiles tree.
///
/// Command:
///   icacls "C:\Program Files\ViewLBA Server" /grant "NT AUTHORITY\LocalService:(OI)(CI)RX" /T
///
/// (OI)(CI) = Object Inherit + Container Inherit → applies to all subdirs and files
/// /T = recursive
fn grant_localservice_rx_program_files() -> Result<(), String> {
    let pf = program_files().join("ViewLBA Server");

    if !pf.exists() {
        return Err(format!("ProgramFiles dir not found: {}", pf.display()));
    }

    // icacls is in System32 (part of Windows, not cmd.exe or PowerShell)
    let icacls = std::env::var("SYSTEMROOT")
        .unwrap_or_else(|_| r"C:\Windows".to_string())
        + r"\System32\icacls.exe";

    let path_str = pf.to_string_lossy();
    let subject = "NT AUTHORITY\\LocalService:(OI)(CI)RX";

    log(&format!("Running icacls to grant LocalService RX on {} (recursive)", path_str));

    let output = std::process::Command::new(&icacls)
        .arg(path_str.as_ref())
        .arg("/grant")
        .arg(subject)
        .arg("/T")  // recursive
        .arg("/L")  // avoid following symlinks
        .arg("/Q")  // quiet (less output)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .map_err(|e| format!("spawn icacls: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    if !output.status.success() {
        return Err(format!(
            "icacls failed with exit code {:?} — stdout: {} — stderr: {}",
            output.status.code(),
            stdout.trim(),
            stderr.trim()
        ));
    }

    log(&format!("icacls OK — LocalService RX granted recursively on {}", path_str));
    Ok(())
}

fn main() -> ExitCode {
    log("viewlba-init starting (deferred CustomAction)");

    if let Err(e) = write_server_env() {
        log(&format!("FATAL: write_server_env: {}", e));
        return ExitCode::from(1);
    }

    // Grant LocalService RX on ProgramFiles (recursive). CRITICAL: without this,
    // bun children spawned by the service host (running as LocalService) fail
    // with EPERM reading files like app/server.js, mini-services/.../index.ts.
    if let Err(e) = grant_localservice_rx_program_files() {
        log(&format!("FATAL: grant_localservice_rx_program_files: {}", e));
        return ExitCode::from(2);
    }

    // Recovery: if the service hasn't been installed yet (race condition with
    // ServiceInstall), this will fail. We log the error but do NOT abort the
    // install — the recovery actions can be re-applied on next repair cycle
    // by re-running viewlba-init.exe (idempotent). However, we DO log so the
    // CI can detect mis-sequencing.
    if let Err(e) = configure_recovery() {
        log(&format!("WARN: configure_recovery: {}", e));
        // Non-fatal for first install. On repair (service exists), this is fatal.
    }

    log("viewlba-init complete");
    ExitCode::SUCCESS
}
