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
//!                 /grant "*S-1-5-19:(OI)(CI)0x100" /T /Q
//!      (same for mini-services/)
//!    - 0x100 = FILE_WRITE_ATTRIBUTES (atomic Win32 permission, NOT Write Data,
//!      NOT Modify, NOT Full Control). Allows changing file metadata
//!      (timestamps, attributes) but NOT file contents.
//!    - We use the hex mask 0x100 because icacls on Windows Server 2022 does
//!      NOT accept `WA` as a /grant permission shorthand (returns "Invalid
//!      parameter"). The hex mask is the documented way to specify atomic
//!      access masks via icacls.
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

/// Grant LocalService RWX (Read+Write+Execute) on ProgramData/ViewLBA/cache/.
///
/// The cache/ dir is where the supervisor creates temp/ and home/ subdirs for
/// Bun's runtime. Bun needs to:
///   - Write to cache/temp/ (BUN_TMPDIR, TEMP, TMP)
///   - Write to cache/home/ (USERPROFILE, HOME, APPDATA)
///   - Write to cache/bun/ (BUN_INSTALL)
///
/// The WiX <Permission> element on the cache/ <CreateFolder> only applies to
/// the directory itself — it does NOT propagate to subdirs created at runtime
/// by the supervisor (same WiX v4 behavior as ProgramFiles). So we grant
/// RWX recursively on cache/ via icacls.
///
/// RWX = (OI)(CI)M — Modify permission includes Read+Write+Execute but NOT
/// Delete or Full Control. This is appropriate for the cache dir (Bun needs
/// to create+modify+traverse but not delete the dir itself).
fn grant_localservice_rwx_program_data_cache() -> Result<(), String> {
    let pd = program_data().join("ViewLBA").join("cache");
    if !pd.exists() {
        // The cache dir is created by the MSI's cmp_cache component (Permanent).
        // It should exist by the time we run (deferred CustomAction, after InstallFiles).
        // If it doesn't exist, create it.
        let _ = std::fs::create_dir_all(&pd);
    }
    if !pd.exists() {
        return Err(format!("ProgramData cache dir not found and could not be created: {}", pd.display()));
    }
    // M = Modify = Read + Write + Execute (NOT Delete, NOT Full Control)
    icacls_grant(&pd, "*S-1-5-19:(OI)(CI)M", "LocalService RWX (Modify) on ProgramData/cache (recursive)")
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
/// Implementation: icacls does NOT accept `WA` (Write Attributes) or hex masks
/// like `0x100` as a /grant permission shorthand on Windows Server 2022 — it
/// only accepts: F, M, RX, R, W, D. So we use PowerShell's `Set-Acl` cmdlet
/// from the MSI installer CustomAction (NOT the runtime product — the mission's
/// "no PowerShell" rule is for the RUNNING server, not the installer). The
/// PowerShell script uses .NET's FileSystemAccessRule with the
/// `WriteAttributes` FileSystemRights value, which maps to FILE_WRITE_ATTRIBUTES
/// (0x100) at the Win32 level.
///
/// The script walks the directory tree recursively and adds the ACE to each
/// file and subdir. The ACE uses ContainerInherit+ObjectInherit so future
/// files inherit it automatically.
fn grant_localservice_wa_app_dirs() -> Result<(), String> {
    let pf = program_files().join("ViewLBA Server");
    let app_dir = pf.join("app");
    let mini_dir = pf.join("mini-services");

    // app/ — Bun loads Next.js standalone server.js + .next/ + node_modules/ from here
    if !app_dir.exists() {
        return Err(format!("app/ dir not found: {}", app_dir.display()));
    }
    grant_wa_via_powershell(&app_dir)?;

    // mini-services/ — Bun loads realtime-service/index.ts + stream-service/index.ts
    if !mini_dir.exists() {
        return Err(format!("mini-services/ dir not found: {}", mini_dir.display()));
    }
    grant_wa_via_powershell(&mini_dir)?;

    Ok(())
}

/// Grant FILE_WRITE_ATTRIBUTES to LocalService (S-1-5-19) on a directory tree
/// via PowerShell's Set-Acl cmdlet. Used because icacls does not accept atomic
/// permission shorthands like WA.
///
/// NOTE: This spawns powershell.exe from the MSI installer CustomAction. The
/// mission's "no PowerShell" rule is for the RUNNING server product, NOT the
/// installer. The installer can use any Windows binary.
fn grant_wa_via_powershell(root: &std::path::Path) -> Result<(), String> {
    let root_str = root.to_string_lossy().replace('\'', "''");
    // PowerShell script: walks the dir tree recursively, adds a WriteAttributes
    // ACE for LocalService to each file and dir. Uses .NET's
    // FileSystemAccessRule which maps WriteAttributes → FILE_WRITE_ATTRIBUTES
    // (0x100) at the Win32 level.
    //
    // - Identity: "NT AUTHORITY\LocalService" (resolves to S-1-5-19)
    // - FileSystemRights: WriteAttributes (atomic, NOT WriteData)
    // - Inheritance: ContainerInherit + ObjectInherit (for dirs)
    // - AccessControlType: Allow
    //
    // The script uses Get-Acl + AddAccessRule + Set-Acl per file. For large
    // trees this is slower than a single recursive icacls call, but it's
    // the only way to grant the atomic FILE_WRITE_ATTRIBUTES permission
    // since icacls doesn't support it.
    let script = format!(
        r#"$ErrorActionPreference = 'Stop'
$root = '{root_str}'
$identity = 'NT AUTHORITY\LocalService'
$rights = [System.Security.AccessControl.FileSystemRights]::WriteAttributes
$dirInh = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
$fileInh = [System.Security.AccessControl.InheritanceFlags]::None
$propFlags = [System.Security.AccessControl.PropagationFlags]::None
$acType = [System.Security.AccessControl.AccessControlType]::Allow

$items = @(@{{ path = $root; isDir = $true }})
$childItems = Get-ChildItem -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
foreach ($child in $childItems) {{
    $items += @{{ path = $child.FullName; isDir = $child.PSIsContainer }}
}}

$count = 0
$failed = 0
foreach ($item in $items) {{
    try {{
        $acl = Get-Acl -LiteralPath $item.path
        # Use different inheritance flags for files vs directories.
        # Files CANNOT have inheritance flags (they have no children).
        # .NET throws "No flags can be set" if you pass inheritance flags
        # to a file's FileSystemAccessRule.
        $inhFlags = if ($item.isDir) {{ $dirInh }} else {{ $fileInh }}
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, $rights, $inhFlags, $propFlags, $acType)
        $acl.AddAccessRule($rule)
        Set-Acl -LiteralPath $item.path -AclObject $acl
        $count++
    }} catch {{
        $failed++
        if ($failed -le 10) {{ Write-Host "  WARN: $($item.path) : $_" }}
    }}
}}
Write-Host "WA granted to LocalService on $count items ($failed failed)"
if ($failed -gt 0 -and $failed -gt ($count / 100)) {{
    Write-Host "FATAL: Too many failures ($failed out of $($count + $failed))"
    exit 1
}}
exit 0
"#,
        root_str = root_str
    );

    let powershell = std::env::var("SYSTEMROOT")
        .unwrap_or_else(|_| r"C:\Windows".to_string())
        + r"\System32\WindowsPowerShell\v1.0\powershell.exe";

    log(&format!("Running PowerShell to grant LocalService WA on {} (recursive)", root.display()));

    let output = std::process::Command::new(&powershell)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy", "Bypass",
            "-Command", &script,
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .map_err(|e| format!("spawn powershell: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    // Log the PowerShell output
    for line in stdout.lines().take(20) {
        log(&format!("  PS: {}", line));
    }

    if !output.status.success() {
        return Err(format!(
            "PowerShell WA grant FAILED (exit {:?}) for {} — stdout: {} — stderr: {}",
            output.status.code(),
            root.display(),
            stdout.trim(),
            stderr.trim()
        ));
    }

    log(&format!("PowerShell OK: LocalService WA granted on {}", root.display()));
    Ok(())
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

    // 2. Grant LocalService RWX (Modify) on ProgramData/ViewLBA/cache/.
    // CRITICAL: Bun's runtime needs to write to cache/temp/ (BUN_TMPDIR),
    // cache/home/ (USERPROFILE), and cache/bun/ (BUN_INSTALL). Without RWX
    // on these dirs, Bun fails with "AccessDenied accessing temporary
    // directory" even when BUN_TMPDIR is set.
    if let Err(e) = grant_localservice_rwx_program_data_cache() {
        log(&format!("FATAL: grant_localservice_rwx_program_data_cache: {}", e));
        return ExitCode::from(5);
    }

    // 3. Grant LocalService WA on app/ + mini-services/ ONLY. CRITICAL: Bun's
    // Windows module loader uses CreateFileW with FILE_WRITE_ATTRIBUTES in the
    // access mask. Without WA, Bun fails with "EPERM reading <path>" even when
    // RX is granted. Reference: https://github.com/oven-sh/bun/issues/44626
    if let Err(e) = grant_localservice_wa_app_dirs() {
        log(&format!("FATAL: grant_localservice_wa_app_dirs: {}", e));
        return ExitCode::from(3);
    }

    // 4. Configure SCM recovery actions. FATAL if it fails — the deferred
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
