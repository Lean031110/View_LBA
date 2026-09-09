/**
 * ViewLBA Server Installer — GUI (Tauri v2).
 *
 * REGLA DE ARQUITECTURA (misión): la GUI SOLO coordina. CERO lógica de DB,
 * secrets, migraciones, systemd o NSSM aquí: todo se delega al sidecar
 * (binario `viewlba-installer` = installer/cli/main.ts compilado con
 * `bun build --compile`), que habla NDJSON por stdout.
 *
 *   GUI (esta capa)  ──spawn──▶  sidecar --json  ──▶  installer/core  ──▶  SO
 *
 * Comandos expuestos a la webview:
 *  · sidecar_ok()                 — sanity check del sidecar
 *  · detect()                     — instalación previa (JSON del sidecar)
 *  · preflight()                  — checks del sistema (JSON del sidecar)
 *  · start_install(config)        — instalación con eventos en streaming
 *  · cancel_install()             — aborto cooperativo (kill del sidecar)
 *  · manager(args)                — gestión: services/health/logs/backup/…
 *  · ensure_elevated()            — Windows: relanza con UAC si falta
 *
 * El evento "installer-event" lleva cada línea NDJSON del sidecar.
 */
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Mutex, OnceLock};

use tauri::{AppHandle, Emitter, Manager, State};

/// Estado del sidecar de instalación (hijo vivo + su stdin).
struct SidecarState {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
}

/// Directorio de recursos de Tauri (donde vive el payload del servidor).
/// Se rellena en setup() y se pasa al sidecar como VIEWLBA_PAYLOAD_DIR:
/// en los bundles Linux (deb/AppImage) los recursos NO están junto al bin
/// (usr/bin vs usr/lib/<producto>), así el sidecar no tiene que adivinar.
static RESOURCE_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Fallback de localización del payload para el modo --cli (antes de que
/// exista el AppHandle): junto al exe, o ../lib/* y ../share/* (Tauri).
fn fallback_payload_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?.to_path_buf();
    let has_payload = |root: &PathBuf| {
        root.join("resources").join("server").join("package.json").exists()
            || root.join("runtime").join("bun").exists()
            || root.join("resources").join("runtime").join("bun").exists()
    };
    if has_payload(&exe_dir) {
        return Some(exe_dir);
    }
    for base in ["lib", "share"] {
        let dir = exe_dir.join("..").join(base);
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for e in entries.flatten() {
                let cand = e.path();
                if cand.is_dir() && has_payload(&cand) {
                    return Some(cand);
                }
            }
        }
    }
    None
}

/// VIEWLBA_PAYLOAD_DIR efectivo para los procesos hijos (sidecar).
fn payload_dir() -> Option<PathBuf> {
    if let Some(rd) = RESOURCE_DIR.get() {
        return Some(rd.clone());
    }
    if let Ok(env) = std::env::var("VIEWLBA_PAYLOAD_DIR") {
        if !env.is_empty() {
            return Some(PathBuf::from(env));
        }
    }
    fallback_payload_dir()
}

/// Ruta del sidecar: junto al ejecutable (bundle) o variable de entorno
/// (desarrollo: VIEWLBA_INSTALLER_BIN=/ruta/al/binario compilado).
/// En desarrollo también se acepta VIEWLBA_DEV_CLI con `bun` + script.
fn sidecar_command() -> Result<(String, Vec<String>), String> {
    if let Ok(bin) = std::env::var("VIEWLBA_INSTALLER_BIN") {
        return Ok((bin, vec![]));
    }
    if let Ok(cli) = std::env::var("VIEWLBA_DEV_CLI") {
        // Modo desarrollo: ejecutar el CLI con bun directamente.
        return Ok(("bun".into(), vec![cli]));
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or("sin directorio del exe")?.to_path_buf();
    let plain = dir.join(format!("viewlba-installer{}", std::env::consts::EXE_SUFFIX));
    if plain.exists() {
        return Ok((plain.to_string_lossy().to_string(), vec![]));
    }
    // Nombre con triple (como lo deja tauri-build en algunos layouts):
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let name = entry.map_err(|e| e.to_string())?.file_name().to_string_lossy().to_string();
        if name.starts_with("viewlba-installer-") && name.ends_with(std::env::consts::EXE_SUFFIX) {
            return Ok((dir.join(name).to_string_lossy().to_string(), vec![]));
        }
    }
    Err(format!(
        "sidecar no encontrado junto a {} (binarios/viewlba-installer)",
        dir.to_string_lossy()
    ))
}

fn spawn_sidecar(args: &[&str]) -> Result<Child, String> {
    let (bin, prefix) = sidecar_command()?;
    let mut cmd = Command::new(&bin);
    cmd.args(&prefix);
    cmd.args(args);
    if let Some(dir) = payload_dir() {
        cmd.env("VIEWLBA_PAYLOAD_DIR", &dir);
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cmd.spawn().map_err(|e| format!("no se pudo lanzar {}: {}", bin, e))
}

/// Sanity check: el sidecar responde --version (o arranca en modo json).
#[tauri::command]
fn sidecar_ok() -> Result<String, String> {
    let (bin, prefix) = sidecar_command()?;
    let mut cmd = Command::new(&bin);
    cmd.args(&prefix);
    cmd.arg("--version");
    if let Some(dir) = payload_dir() {
        cmd.env("VIEWLBA_PAYLOAD_DIR", &dir);
    }
    let out = cmd.output().map_err(|e| e.to_string())?;
    Ok(format!("{} {:?}", bin, out.status.code()))
}

/// Detección de instalación previa (JSON del manager del sidecar).
#[tauri::command]
async fn detect() -> Result<serde_json::Value, String> {
    run_json(&["--json", "detect"]).await
}

/// Preflight del sistema (JSON del manager del sidecar).
#[tauri::command]
async fn preflight() -> Result<serde_json::Value, String> {
    run_json(&["--json", "preflight"]).await
}

/// Ejecuta un comando del manager y devuelve su JSON.
async fn run_json(args: &[&str]) -> Result<serde_json::Value, String> {
    let owned: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    tauri::async_runtime::spawn_blocking(move || {
        let mut child = spawn_sidecar(&owned.iter().map(|s| s.as_str()).collect::<Vec<_>>())?;
        let output = child.wait_with_output().map_err(|e| e.to_string())?;
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let first = stdout.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
        let parsed: serde_json::Value =
            serde_json::from_str(first).unwrap_or(serde_json::json!({ "ok": false, "raw": first }));
        Ok(parsed)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Instalación: lanza el sidecar --json, escribe la config por stdin y
/// reenvía cada línea NDJSON como evento "installer-event" a la webview.
#[tauri::command]
async fn start_install(
    app: AppHandle,
    state: State<'_, Mutex<SidecarState>>,
    config: serde_json::Value,
) -> Result<(), String> {
    // Un solo intento: si ya hay una instalación corriendo → error claro.
    {
        let mut st = state.lock().map_err(|e| e.to_string())?;
        if st.child.is_some() {
            return Err("ya hay una instalación en curso".into());
        }
    }

    let mut child = spawn_sidecar(&["--json"])?;
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // Config por stdin (protocolo del sidecar).
    if let Some(mut si) = stdin {
        let line = serde_json::json!({ "type": "config", "config": config }).to_string();
        let _ = writeln!(si, "{}", line);
        let _ = si.flush();
        {
            let mut st = state.lock().map_err(|e| e.to_string())?;
            st.stdin = Some(si);
        }
    }

    {
        let mut st = state.lock().map_err(|e| e.to_string())?;
        st.child = Some(child);
    }

    // Streaming de eventos (stdout NDJSON).
    if let Some(out) = stdout {
        let app2 = app.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(out);
            for line in reader.lines().map_while(Result::ok) {
                if line.trim().is_empty() {
                    continue;
                }
                let _ = app2.emit("installer-event", line);
            }
            let _ = app2.emit("installer-closed", ());
        });
    }
    // Logs humanos del sidecar (stderr) → evento separado.
    if let Some(err) = stderr {
        let app3 = app.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(err);
            for line in reader.lines().map_while(Result::ok) {
                let _ = app3.emit("installer-log", line);
            }
        });
    }
    Ok(())
}

/// Aborto: mata el sidecar (los datos nunca se tocan; el core hace rollback
/// no destructivo al fallar — el kill deja la instalación parcial marcable
/// como "reparable").
#[tauri::command]
async fn cancel_install(state: State<'_, Mutex<SidecarState>>) -> Result<(), String> {
    let mut st = state.lock().map_err(|e| e.to_string())?;
    if let Some(mut child) = st.child.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    st.stdin = None;
    Ok(())
}

/// Gestión: services/health/logs/backup/diagnostics/uninstall/update/repair.
#[tauri::command]
async fn manager(args: Vec<String>) -> Result<serde_json::Value, String> {
    let mut all = vec!["--json".to_string()];
    all.extend(args);
    run_json(&all.iter().map(|s| s.as_str()).collect::<Vec<_>>()).await
}

/// Windows: pedir elevación (UAC) si falta. Linux/macOS: no-op informativo.
#[tauri::command]
fn ensure_elevated(app: AppHandle) -> Result<bool, String> {
    if cfg!(windows) {
        let admin = Command::new("net").arg("session").output().map(|o| o.status.success()).unwrap_or(false);
        if admin {
            return Ok(true);
        }
        // Relanzar elevado y cerrar esta instancia.
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let script = format!("Start-Process -FilePath '{}' -Verb RunAs", exe.to_string_lossy());
        let ok = Command::new("powershell")
            .args(["-NoProfile", "-Command", &script])
            .spawn()
            .map(|_| true)
            .unwrap_or(false);
        if ok {
            let _ = app.exit(0);
        }
        return Ok(ok);
    }
    let uid = nix_uid();
    Ok(uid == Some(0))
}

#[cfg(unix)]
fn nix_uid() -> Option<u32> {
    Some(unsafe { libc_uid() })
}

#[cfg(unix)]
unsafe fn libc_uid() -> u32 {
    // sin crate extra: leer /proc/self/status es poco portable; usamos el
    // trampo estándar de getuid vía libc enlazado del sistema.
    extern "C" {
        fn getuid() -> u32;
    }
    getuid()
}

#[cfg(not(unix))]
fn nix_uid() -> Option<u32> {
    None
}

pub fn run() {
    // Modo --cli: el MISMO binario actúa como installer de terminal (el
    // sidecar hereda stdio y el código de salida). Útil en headless y para
    // automatización con el AppImage/GUI.
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--cli") {
        let rest: Vec<String> = args.into_iter().filter(|a| a != "--cli").collect();
        match cli_passthrough(&rest) {
            Ok(code) => std::process::exit(code),
            Err(e) => {
                eprintln!("✗ {}", e);
                std::process::exit(1);
            }
        }
    }

    tauri::Builder::default()
        .manage(Mutex::new(SidecarState { child: None, stdin: None }))
        .setup(|app| {
            // Directorio de recursos autoritativo de Tauri → sidecar.
            if let Ok(rd) = app.path().resource_dir() {
                let _ = RESOURCE_DIR.set(rd);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sidecar_ok,
            detect,
            preflight,
            start_install,
            cancel_install,
            manager,
            ensure_elevated
        ])
        .run(tauri::generate_context!())
        .expect("error al ejecutar la GUI de ViewLBA Installer");
}

/// Ejecuta el sidecar CLI con los argumentos dados, heredando stdio.
fn cli_passthrough(args: &[String]) -> Result<i32, String> {
    use std::io::Write;
    let (bin, prefix) = sidecar_command()?;
    let mut cmd = Command::new(&bin);
    cmd.args(&prefix);
    cmd.args(args);
    if let Some(dir) = payload_dir() {
        cmd.env("VIEWLBA_PAYLOAD_DIR", &dir);
    }
    cmd.stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    let mut child = cmd.spawn().map_err(|e| format!("no se pudo lanzar {}: {}", bin, e))?;
    let _ = child.stdin.as_mut().map(|s| s.flush());
    let status = child.wait().map_err(|e| e.to_string())?;
    Ok(status.code().unwrap_or(0))
}
