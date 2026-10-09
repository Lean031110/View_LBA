//! viewlba-init.exe — deterministic first-boot initializer for ViewLBA Server.
//!
//! Runs as a WiX CustomAction (deferred, NoImpersonate → as LocalSystem) during
//! MSI install. Performs four deterministic, idempotent operations:
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
//!                 /grant "*S-1-5-19:(OI)(CI)RX" /T /Q
//!    - (OI)(CI) = Object Inherit + Container Inherit (propagates to all files+subdirs)
//!    - This is REQUIRED because WiX v4's <Permission> element on <CreateFolder>
//!      only applies to the directory's ACL — it does NOT propagate to files
//!      installed by <File> elements (known WiX v4 behavior). Files in app/,
//!      mini-services/, etc. would otherwise get the DEFAULT ACL which excludes
//!      LocalService → bun children fail with EPERM on read.
//!
//! 3. GRANTS LocalService WA (FILE_WRITE_ATTRIBUTES) on the app/ and
//!    mini-services/ subtrees ONLY (recursive, in addition to RX):
//!    - Command: icacls "C:\Program Files\ViewLBA Server\app"
//!                 /grant "*S-1-5-19:(OI)(CI)WA" /T /Q
//!      (same for mini-services/)
//!    - WA = Write Attributes (FILE_WRITE_ATTRIBUTES) — NOT Write Data, NOT
//!      Modify, NOT Full Control. WA allows changing file metadata (timestamps,
//!      attributes) but NOT file contents.
//!    - This is REQUIRED for Bun's Windows module loader. Reference:
//!      https://github.com/oven-sh/bun/issues/44626 (Oct 2026)
//!      Bun's module loader on Windows opens files via CreateFileW with an
//!      access mask that includes FILE_WRITE_ATTRIBUTES. When the calling
//!      account has only RX (no WA), CreateFileW fails with ERROR_ACCESS_DENIED
//!      (5), which Bun surfaces as the misleading "EPERM reading <path>"
//!      error. readFileSync works (uses a different access mask), but
//!      `import`/`require` of the SAME file fails — exactly matching the
//!      ViewLBA symptom where bun --version works as runner user but
//!      bun app/server.js fails with EPERM reading app/server.js.
//!    - The fix is narrowly scoped: WA is granted ONLY on app/ and
//!      mini-services/ (where Bun loads modules), NOT on the entire
//!      ProgramFiles tree. RX is preserved everywhere. WA does NOT
//!      grant Write Data, Modify, or Full Control.
//!    - Idempotent: re-running on upgrade is a no-op (granting an ACE that
//!      already exists is a no-op).
//!
//! 4. CONFIGURES SCM RECOVERY ACTIONS on the ViewLBA service:
//!    - 1st failure: Restart service (delay 60s)
//!    - 2nd failure: Restart service (delay 60s)
//!    - Subsequent failures: Restart service (delay 60s)
//!    - Reset failure counter after 86400s (24h)
//!    - Uses ChangeServiceConfig2W directly — no sc.exe, no PowerShell,
//!      no CMD. Mission: "no NSSM, no PowerShell, no CMD".
//!    - FATAL if it fails when the service should already be registered
//!      (the deferred CustomAction runs AFTER InstallServices, so the
//!      ViewLBA service MUST exist by the time we call OpenServiceW).
//!
//! Exits 0 on success, non-zero on any failure. The MSI CustomAction has
//! `Return="check"`, so any non-zero exit fails the install.
//!
//! INVARIANTS:
//!   - No network access (works offline — used in [S] offline test).
//!   - No secrets printed. The .env contains them, but logs only say "created".
//!   - Idempotent: re-running on upgrade leaves server.env untouched.
//!   - icacls is idempotent (granting an ACE that already exists is a no-op).
//!   - WA is granted ONLY on app/ and mini-services/ (Bun module trees).
//!     Other ProgramFiles dirs (bin/, runtime/, themes/, public/) only get RX.

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
    use windows::Win32::Security::Authorization::{
        SetEntriesInAclW, SetNamedSecurityInfoW, GetNamedSecurityInfoW,
        EXPLICIT_ACCESS_W, TRUSTEE_W,
        TRUSTEE_IS_SID, TRUSTEE_IS_WELL_KNOWN_GROUP,
        GRANT_ACCESS, SUB_CONTAINERS_AND_OBJECTS_INHERIT,
        SE_FILE_OBJECT,
    };
    use windows::Win32::Security::{
        ConvertStringSidToSidW, ACL, DACL_SECURITY_INFORMATION,
        PSECURITY_DESCRIPTOR, BOOL,
    };

    /// Encode a Rust &str as UTF-16 with NUL terminator.
    pub fn wstr(s: &str) -> Vec<u16> {
        let mut v: Vec<u16> = s.encode_utf16().collect();
        v.push(0);
        v
    }

    /// Grant FILE_WRITE_ATTRIBUTES (0x100) to LocalService (S-1-5-19) on a
    /// single file or directory, with inheritance (so children inherit the ACE).
    ///
    /// We use the Win32 API directly because `icacls` does NOT accept `WA`
    /// (Write Attributes) as a /grant permission shorthand on the Windows
    /// Server 2022 runner — it returns "Invalid parameter" (exit 87).
    /// The Win32 API accepts the atomic access mask 0x100
    /// (FILE_WRITE_ATTRIBUTES) directly.
    ///
    /// Permission mode is GRANT_ACCESS (additive) — does NOT remove existing
    /// ACEs. The existing RX ACE (from the icacls RX grant) is preserved.
    /// Inheritance is SUB_CONTAINERS_AND_OBJECTS_INHERIT so children files
    /// and subdirs inherit the ACE.
    ///
    /// Steps:
    /// 1. Get the existing DACL via GetNamedSecurityInfoW (so we can MERGE
    ///    the new WA ACE with it, instead of replacing)
    /// 2. Convert "S-1-5-19" to a SID pointer via ConvertStringSidToSidW
    /// 3. Build TRUSTEE_W: TrusteeForm=TRUSTEE_IS_SID, TrusteeType=
    ///    TRUSTEE_IS_WELL_KNOWN_GROUP (LocalService is a well-known group)
    /// 4. Build EXPLICIT_ACCESS_W with FILE_WRITE_ATTRIBUTES (0x100),
    ///    GRANT_ACCESS, SUB_CONTAINERS_AND_OBJECTS_INHERIT
    /// 5. SetEntriesInAclW with the EXISTING DACL as old_acl → merged ACL
    /// 6. SetNamedSecurityInfoW applies the merged DACL to the file/dir
    pub fn grant_file_write_attributes(path: &std::path::Path) -> Result<(), String> {
        unsafe {
            let path_w = wstr(&path.to_string_lossy());
            let pcpath = PCWSTR(path_w.as_ptr());

            // 1. Get the existing DACL via GetNamedSecurityInfoW
            //    We need the existing DACL so we can MERGE the new WA ACE
            //    with it (preserving the existing RX ACE). If we just built
            //    a fresh ACL with only the WA ACE and applied it via
            //    SetNamedSecurityInfoW, the existing RX would be REPLACED.
            let mut p_existing_sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
            let mut p_existing_dacl: *mut ACL = std::ptr::null_mut();
            let mut p_owner: *mut c_void = std::ptr::null_mut();
            let mut p_group: *mut c_void = std::ptr::null_mut();

            let r = GetNamedSecurityInfoW(
                pcpath,
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                Some(&mut p_owner),
                Some(&mut p_group),
                Some(&mut p_existing_dacl),
                None,
                &mut p_existing_sd,
            );
            if r.is_err() {
                return Err(format!("GetNamedSecurityInfoW failed for {}: {:?}", path.display(), r));
            }
            // Determine if DACL was present (for passing to SetEntriesInAclW)
            let has_existing_dacl = !p_existing_dacl.is_null();

            // 2. Convert "S-1-5-19" to a SID pointer
            let sid_w = wstr("S-1-5-19");
            let mut p_sid: *mut c_void = std::ptr::null_mut();
            let r = ConvertStringSidToSidW(PCWSTR(sid_w.as_ptr()), &mut p_sid);
            if r.is_err() {
                let _ = windows::Win32::Foundation::LocalFree(p_existing_sd as *const _ as *mut _);
                return Err(format!("ConvertStringSidToSidW failed: {:?}", r));
            }

            // 3. Build TRUSTEE_W using the SID
            let mut trustee: TRUSTEE_W = std::mem::zeroed();
            trustee.TrusteeForm = TRUSTEE_IS_SID;
            trustee.TrusteeType = TRUSTEE_IS_WELL_KNOWN_GROUP;
            trustee.ptstrName = windows::core::PWSTR(p_sid as *mut u16);

            // 4. Build EXPLICIT_ACCESS_W with FILE_WRITE_ATTRIBUTES (0x100)
            let mut ea: EXPLICIT_ACCESS_W = std::mem::zeroed();
            ea.grfAccessPermissions = 0x100;  // FILE_WRITE_ATTRIBUTES
            ea.grfAccessMode = GRANT_ACCESS;  // additive — preserves existing ACEs
            ea.grfInheritance = SUB_CONTAINERS_AND_OBJECTS_INHERIT;
            ea.Trustee = trustee;

            // 5. Build the merged ACL via SetEntriesInAclW
            //    If we have an existing DACL, pass it as old_acl so the new
            //    ACE is MERGED with existing ACEs (not replacing them).
            let mut p_acl: *mut ACL = std::ptr::null_mut();
            let entries: [EXPLICIT_ACCESS_W; 1] = [ea];
            let r = if has_existing_dacl {
                SetEntriesInAclW(&entries, Some(p_existing_dacl), &mut p_acl)
            } else {
                SetEntriesInAclW(&entries, None, &mut p_acl)
            };
            if r.is_err() {
                let _ = windows::Win32::Foundation::LocalFree(p_sid as *const _ as *mut _);
                let _ = windows::Win32::Foundation::LocalFree(p_existing_sd as *const _ as *mut _);
                return Err(format!("SetEntriesInAclW failed: {:?}", r));
            }

            // 6. Apply the merged DACL to the file/dir via SetNamedSecurityInfoW
            let r = SetNamedSecurityInfoW(
                pcpath,
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                None,
                None,
                Some(p_acl),
                None,
            );

            // Free the SID, ACL, and existing SD (LocalFree)
            let _ = windows::Win32::Foundation::LocalFree(p_sid as *const _ as *mut _);
            let _ = windows::Win32::Foundation::LocalFree(p_acl as *const _ as *mut _);
            let _ = windows::Win32::Foundation::LocalFree(p_existing_sd as *const _ as *mut _);

            if r.is_err() {
                return Err(format!("SetNamedSecurityInfoW failed for {}: {:?}", path.display(), r));
            }
            Ok(())
        }
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
    // The deferred CustomAction runs AFTER InstallServices, so the ViewLBA
    // service MUST already be registered in SCM by the time we get here.
    // If OpenServiceW fails, that's a sequencing bug in the MSI — we treat
    // it as FATAL so the install fails and CI can detect it.
    //
    // Previous behavior (warn + continue) was a regression: it allowed the
    // install to "succeed" without recovery actions configured, which then
    // failed the smoke-test's "Verify recovery actions" check. The user
    // explicitly required recovery to be blocking (mission §4).
    #[cfg(target_os = "windows")]
    {
        if let Err(e) = win32::set_service_recovery_actions("ViewLBA") {
            return Err(format!("set_service_recovery_actions: {}", e));
        }
        log("SCM recovery actions: Restart 60s × 3 (reset 24h)");
    }
    Ok(())
}

/// Helper: run `icacls <path> /grant "<subject>" /T /Q` and return Ok on
/// success, Err with detailed message on failure.
///
/// `path`    — the target directory or file
/// `subject` — the ACE spec, e.g., "*S-1-5-19:(OI)(CI)RX"
/// `label`   — human-readable description for logging
fn icacls_grant(path: &std::path::Path, subject: &str, label: &str) -> Result<(), String> {
    let icacls = std::env::var("SYSTEMROOT")
        .unwrap_or_else(|_| r"C:\Windows".to_string())
        + r"\System32\icacls.exe";

    let path_str = path.to_string_lossy();
    log(&format!("Running icacls: {} ({})", path_str, label));

    let output = std::process::Command::new(&icacls)
        .arg(path_str.as_ref())
        .arg("/grant")
        .arg(subject)
        .arg("/T")  // recursive
        .arg("/Q")  // quiet (less output)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .map_err(|e| format!("spawn icacls: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    if !output.status.success() {
        return Err(format!(
            "icacls FAILED (exit {:?}) for {} — stdout: {} — stderr: {}",
            output.status.code(),
            path_str,
            stdout.trim(),
            stderr.trim()
        ));
    }

    log(&format!("icacls OK: {} ({})", path_str, label));
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
/// We use icacls.exe (a standard Windows binary in System32 — NOT cmd.exe or
/// PowerShell; this honors the mission's "no NSSM, no PowerShell, no CMD" rule
/// for RUNTIME; the MSI installer CustomAction can use any Win32 API).
///
/// Uses the SID S-1-5-19 directly (asterisk prefix) to avoid any name-resolution
/// ambiguity.
fn grant_localservice_rx_program_files() -> Result<(), String> {
    let pf = program_files().join("ViewLBA Server");
    if !pf.exists() {
        return Err(format!("ProgramFiles dir not found: {}", pf.display()));
    }
    // (OI)(CI) = Object Inherit + Container Inherit → applies to all subdirs and
    // files recursively (combined with /T).
    icacls_grant(&pf, "*S-1-5-19:(OI)(CI)RX", "LocalService RX on ProgramFiles (recursive)")
}

/// Grant LocalService WA (FILE_WRITE_ATTRIBUTES) on app/ and mini-services/ ONLY.
///
/// Bun's Windows module loader opens files via CreateFileW with an access mask
/// that includes FILE_WRITE_ATTRIBUTES (WA). When the calling account has only
/// RX (no WA), CreateFileW fails with ERROR_ACCESS_DENIED, which Bun surfaces
/// as the misleading "EPERM reading <path>" error.
///
/// Reference: https://github.com/oven-sh/bun/issues/44626 (Oct 2026)
///
/// The fix is narrowly scoped:
///   - WA is granted ONLY on app/ and mini-services/ (Bun module trees)
///   - RX is preserved everywhere (from grant_localservice_rx_program_files)
///   - WA does NOT grant Write Data, Modify, or Full Control — only
///     FILE_WRITE_ATTRIBUTES (changing file metadata like timestamps)
///   - Other ProgramFiles dirs (bin/, runtime/, themes/, public/) only get RX
///
/// Implementation: icacls does NOT accept `WA` as a /grant permission shorthand
/// (returns "Invalid parameter" on Windows Server 2022 runner). We use the
/// Win32 API directly: GetNamedSecurityInfoW + SetEntriesInAclW + 
/// SetNamedSecurityInfoW with GRANT_ACCESS mode (additive — preserves existing
/// RX ACEs) and SUB_CONTAINERS_AND_OBJECTS_INHERIT (inheritable by children).
///
/// The function applies the ACE to the directory AND walks the tree to apply
/// it to all existing files (inheritance handles future files, but existing
/// files need explicit application because inheritance only applies at create
/// time on Windows for some scenarios).
fn grant_localservice_wa_app_dirs() -> Result<(), String> {
    let pf = program_files().join("ViewLBA Server");
    let app_dir = pf.join("app");
    let mini_dir = pf.join("mini-services");

    // app/ — Bun loads Next.js standalone server.js + .next/ + node_modules/ from here
    if !app_dir.exists() {
        return Err(format!("app/ dir not found: {}", app_dir.display()));
    }
    log(&format!("Granting LocalService WA on {} (recursive, via Win32 API)", app_dir.display()));
    grant_wa_recursive(&app_dir)?;

    // mini-services/ — Bun loads realtime-service/index.ts + stream-service/index.ts
    if !mini_dir.exists() {
        return Err(format!("mini-services/ dir not found: {}", mini_dir.display()));
    }
    log(&format!("Granting LocalService WA on {} (recursive, via Win32 API)", mini_dir.display()));
    grant_wa_recursive(&mini_dir)?;

    Ok(())
}

/// Recursively grant FILE_WRITE_ATTRIBUTES to LocalService on a directory tree.
/// Applies the ACE to the directory itself (with inheritance) AND walks all
/// files/subdirs to explicitly apply the ACE (for existing files that might
/// not pick up inheritance).
#[cfg(target_os = "windows")]
fn grant_wa_recursive(root: &std::path::Path) -> Result<(), String> {
    // Apply to the root directory itself (with inheritance so children inherit)
    win32::grant_file_write_attributes(root)
        .map_err(|e| format!("WA grant on root {} failed: {}", root.display(), e))?;

    // Walk the tree and apply to every file (dirs inherit from root, but
    // explicit application is safer for existing files).
    let mut stack: Vec<std::path::PathBuf> = vec![root.to_path_buf()];
    let mut visited = 0usize;
    let mut errors = Vec::new();

    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(e) => {
                errors.push(format!("read_dir {}: {}", dir.display(), e));
                continue;
            }
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let file_type = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if file_type.is_dir() {
                // Apply WA to the subdir (with inheritance)
                if let Err(e) = win32::grant_file_write_attributes(&path) {
                    errors.push(format!("WA grant on dir {} failed: {}", path.display(), e));
                }
                stack.push(path);
                visited += 1;
            } else if file_type.is_file() {
                // Apply WA to the file (no inheritance needed for files)
                if let Err(e) = win32::grant_file_write_attributes(&path) {
                    errors.push(format!("WA grant on file {} failed: {}", path.display(), e));
                }
                visited += 1;
            }
            // Log progress every 1000 entries
            if visited % 1000 == 0 && visited > 0 {
                log(&format!("  ... {} entries processed", visited));
            }
        }
    }

    log(&format!("  WA applied to {} entries under {}", visited, root.display()));

    if !errors.is_empty() {
        // Log the first 10 errors, fail if more than 1% of files failed
        log(&format!("  {} errors during recursive WA grant", errors.len()));
        for e in errors.iter().take(10) {
            log(&format!("  - {}", e));
        }
        if errors.len() > (visited / 100).max(1) {
            return Err(format!("Too many WA grant failures: {} out of {}", errors.len(), visited));
        }
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn grant_wa_recursive(_root: &std::path::Path) -> Result<(), String> {
    Err("Win32 API only available on Windows".into())
}

fn main() -> ExitCode {
    log("viewlba-init starting (deferred CustomAction)");

    if let Err(e) = write_server_env() {
        log(&format!("FATAL: write_server_env: {}", e));
        return ExitCode::from(1);
    }

    // 1. Grant LocalService RX on ProgramFiles (recursive). CRITICAL: without this,
    // bun children spawned by the service host (running as LocalService) cannot
    // read files like app/server.js, mini-services/.../index.ts.
    if let Err(e) = grant_localservice_rx_program_files() {
        log(&format!("FATAL: grant_localservice_rx_program_files: {}", e));
        return ExitCode::from(2);
    }

    // 2. Grant LocalService WA on app/ + mini-services/ ONLY. CRITICAL: Bun's
    // Windows module loader uses CreateFileW with FILE_WRITE_ATTRIBUTES in the
    // access mask. Without WA, Bun fails with "EPERM reading <path>" even when
    // RX is granted. Reference: https://github.com/oven-sh/bun/issues/44626
    if let Err(e) = grant_localservice_wa_app_dirs() {
        log(&format!("FATAL: grant_localservice_wa_app_dirs: {}", e));
        return ExitCode::from(3);
    }

    // 3. Configure SCM recovery actions. FATAL if it fails — the deferred
    // CustomAction runs AFTER InstallServices, so the ViewLBA service MUST
    // already exist in SCM by the time we call OpenServiceW. Previous
    // behavior (warn + continue) was a regression that allowed the install
    // to succeed without recovery actions configured.
    if let Err(e) = configure_recovery() {
        log(&format!("FATAL: configure_recovery: {}", e));
        return ExitCode::from(4);
    }

    log("viewlba-init complete");
    ExitCode::SUCCESS
}
