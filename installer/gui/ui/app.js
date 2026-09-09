/**
 * ViewLBA Server Installer — lógica de la GUI (SOLO presentación/coordinación).
 * Toda la lógica real vive en el sidecar (installer/cli → installer/core).
 * Aquí: renderizar eventos NDJSON, recoger config, invocar comandos Tauri.
 */
const { invoke } = window.__TAURI__.core
const { listen } = window.__TAURI__.event

const $ = (sel) => document.querySelector(sel)
const $$ = (sel) => document.querySelectorAll(sel)

// ---------------------------------------------------------------- estado
const config = {
  mode: "new",
  restaurantName: "Mi Restaurante",
  timezone: "America/Havana",
  webPort: 3000,
  realtimePort: 3003,
  rtmpPort: 1935,
  httpFlvPort: 8000,
  lanMode: true,
  lanSubnet: undefined,
  withDemoData: false,
  offline: false,
  runBuild: true,
  adminEmail: undefined,
  adminPassword: undefined,
}

let installing = false

// ---------------------------------------------------------------- vistas
function show(view) {
  for (const v of $$(".view")) v.hidden = v.id !== `view-${view}`
  $("#nav").hidden = view === "welcome"
  for (const b of $$("#nav button")) b.classList.toggle("active", b.dataset.view === view)
}
function showPane(name) {
  for (const p of $$("#view-wizard .card")) p.hidden = p.id !== `pane-${name}`
  for (const li of $$("#steps li")) li.classList.toggle("active", li.dataset.step === name)
  for (const li of $$("#steps li")) {
    const done = stepIndex(li.dataset.step) < stepIndex(name)
    li.classList.toggle("done", done)
  }
}
const STEP_ORDER = ["preflight", "directory", "config", "network", "secrets", "admin", "run", "done"]
function stepIndex(s) {
  const i = STEP_ORDER.indexOf(s)
  return i === -1 ? 99 : i
}

// ---------------------------------------------------------------- checks
function renderChecks(table, checks) {
  table.hidden = false
  table.innerHTML = ""
  for (const c of checks) {
    const tr = document.createElement("tr")
    tr.innerHTML = `<td class="st st-${c.status}">${icon(c.status)}</td><td>${c.label}</td><td class="muted">${c.detail ?? ""}${c.hint ? `<br><span class="hint">↳ ${c.hint}</span>` : ""}</td>`
    table.appendChild(tr)
  }
}
const icon = (s) => (s === "pass" ? "✓" : s === "warn" ? "⚠" : "✗")

// ---------------------------------------------------------------- arranque
async function boot() {
  try {
    await invoke("ensure_elevated")
  } catch {
    /* el usuario verá el FAIL en preflight si falta elevación */
  }
  try {
    const d = await invoke("detect")
    const res = d.result ?? d
    if (res && res.found) {
      $("#btn-manage").hidden = false
      if (res.existing && res.existing.suggestedMode) {
        $("#in-mode").value = res.existing.suggestedMode
        $("#existing-info").textContent =
          `Instalación previa detectada — modo sugerido: ${res.existing.suggestedMode}` +
          (res.existing.hasDatabase ? " · la base de datos EXISTENTE no se tocará" : "")
      }
      if (res.layout) {
        $("#in-dir").placeholder = res.layout.appDir
        $("#in-datadir").placeholder = res.layout.dataDir
        $("#in-logdir").placeholder = res.layout.logDir
      }
    }
  } catch (e) {
    $("#elevate-note").textContent = `Sidecar no disponible: ${e}`
  }
}

$("#btn-start").onclick = () => {
  show("wizard")
  showPane("preflight")
}
$("#btn-manage").onclick = () => openManager()
for (const b of $$("#nav button")) b.onclick = () => (b.dataset.view === "manager" ? openManager() : show("wizard"))

// ---------------------------------------------------------------- preflight
$("#btn-preflight").onclick = async () => {
  $("#btn-preflight").disabled = true
  try {
    const r = await invoke("preflight")
    const res = r.result ?? r
    renderChecks($("#preflight-table"), res.checks ?? [])
    const blocking = res.blocking || (res.checks ?? []).some((c) => c.status === "fail")
    if (blocking) {
      $("#btn-preflight-next").hidden = true
      $("#btn-preflight").disabled = false
      $("#btn-prefflight").textContent = "Reintentar comprobación"
    } else {
      $("#btn-preflight-next").hidden = false
    }
  } catch (e) {
    $("#btn-preflight").disabled = false
    alert(`Preflight falló: ${e}`)
  }
}
$("#btn-preflight-next").onclick = () => showPane("directory")

// ---------------------------------------------------------------- directorio
$("#btn-dir-next").onclick = () => {
  config.mode = $("#in-mode").value
  config.installDir = $("#in-dir").value.trim() || undefined
  config.dataDir = $("#in-datadir").value.trim() || undefined
  config.logDir = $("#in-logdir").value.trim() || undefined
  showPane("config")
}

// ---------------------------------------------------------------- config
$("#btn-config-next").onclick = () => {
  config.restaurantName = $("#in-name").value.trim() || "Mi Restaurante"
  config.timezone = $("#in-tz").value.trim() || "America/Havana"
  config.webPort = Number($("#in-port").value) || 3000
  config.realtimePort = Number($("#in-rtport").value) || 3003
  config.rtmpPort = Number($("#in-rtmp").value) || 1935
  config.httpFlvPort = Number($("#in-flv").value) || 8000
  config.withDemoData = $("#in-demo").checked
  config.offline = $("#in-offline").checked
  showPane("network")
}
$("#btn-net-next").onclick = () => {
  config.lanMode = $("#in-lan").checked
  config.lanSubnet = $("#in-subnet").value.trim() || undefined
  showPane("secrets")
}
$("#btn-secrets-next").onclick = () => showPane("admin")
$("#btn-admin-next").onclick = () => {
  config.adminEmail = $("#in-email").value.trim() || undefined
  config.adminPassword = $("#in-passwd").value || undefined
  $("#run-summary").innerHTML = summaryHtml()
  showPane("run")
}

function summaryHtml() {
  const rows = [
    ["Modo", config.mode],
    ["Restaurante", config.restaurantName],
    ["Zona horaria", config.timezone],
    ["Puertos", `${config.webPort} · ${config.realtimePort} · ${config.rtmpPort} · ${config.httpFlvPort}`],
    ["Directorio app", config.installDir ?? "(por defecto del SO)"],
    ["Datos", config.dataDir ?? "(por defecto del SO)"],
    ["LAN", config.lanMode ? config.lanSubnet ?? "subred detectada" : "solo localhost"],
    ["Offline", config.offline ? "SÍ (sin red)" : "no"],
    ["Admin", config.adminEmail ?? "(crear luego)"],
    ["Demo", config.withDemoData ? "sí" : "no"],
  ]
  return rows.map(([k, v]) => `<div><b>${k}</b><span>${v}</span></div>`).join("")
}

// ---------------------------------------------------------------- instalación
$("#btn-install").onclick = async () => {
  if (installing) return
  installing = true
  $("#btn-install").disabled = true
  $("#btn-cancel").hidden = false
  $("#run-log").hidden = false
  $("#run-log").innerHTML = ""
  try {
    await invoke("start_install", { config })
  } catch (e) {
    appendLog(`✗ No se pudo iniciar: ${e}`, "err")
    installing = false
    $("#btn-install").disabled = false
    $("#btn-cancel").hidden = true
  }
}

$("#btn-cancel").onclick = async () => {
  try {
    await invoke("cancel_install")
  } catch {
    /* noop */
  }
}

let phaseNow = ""
listen("installer-event", (ev) => {
  let msg
  try {
    msg = JSON.parse(ev.payload)
  } catch {
    return
  }
  if (msg.type === "phase-start") {
    phaseNow = msg.phase
    appendLog(`▶ ${msg.title ?? msg.phase}`, "phase")
  } else if (msg.type === "phase-end") {
    appendLog(`  ${msg.status === "ok" ? "✓" : msg.status === "warn" ? "⚠" : "✗"} ${msg.phase}${msg.detail ? " — " + msg.detail : ""}`, msg.status)
  } else if (msg.type === "check") {
    appendLog(`  ${icon(msg.result.status)} ${msg.result.label}${msg.result.status !== "pass" && msg.result.detail ? " — " + msg.result.detail : ""}`, msg.result.status)
  } else if (msg.type === "info") {
    appendLog(`  · ${msg.message}`)
  } else if (msg.type === "warn") {
    appendLog(`  ⚠ ${msg.message}`, "warn")
  } else if (msg.type === "command") {
    appendLog(`  $ ${msg.command}`, "cmd")
  } else if (msg.type === "progress") {
    appendLog(`  … ${msg.current} ${msg.label ?? ""}`)
  } else if (msg.type === "done") {
    finish(true, msg.report)
  } else if (msg.type === "failed") {
    finish(false, null, msg.diagnostic)
  }
})

listen("installer-closed", () => {
  if (installing) {
    // el proceso murió sin done/failed (p. ej. cancelado)
    installing = false
    $("#btn-install").disabled = false
    $("#btn-cancel").hidden = true
    appendLog("— proceso del installer terminado —", "warn")
  }
})

function appendLog(line, cls) {
  const div = document.createElement("div")
  div.className = `logline ${cls ?? ""}`
  div.textContent = line
  $("#run-log").appendChild(div)
  $("#run-log").scrollTop = $("#run-log").scrollHeight
}

function finish(ok, report, diagnostic) {
  installing = false
  $("#btn-cancel").hidden = true
  $("#done-title").textContent = ok ? "✅ Instalación completada" : "❌ Instalación fallida"
  if (ok && report) {
    $("#done-body").innerHTML = `
      <div class="urls">
        <div><b>Panel de administración</b><code>${report.urls.admin}</code></div>
        <div><b>Pantalla TV</b><code>${report.urls.tv}</code></div>
        <div><b>Health</b><code>${report.urls.health}</code></div>
        <div><b>RTMP (OBS)</b><code>${report.urls.rtmp}</code></div>
      </div>
      ${report.warnings?.length ? `<div class="warnbox">${report.warnings.map((w) => `⚠ ${w}`).join("<br>")}</div>` : ""}
    `
    $("#btn-retry").hidden = true
  } else {
    const d = diagnostic ?? {}
    $("#done-body").innerHTML = `
      <pre class="diag">${d.error ?? ""}</pre>
      <p><b>Acción sugerida:</b> ${d.suggestion ?? "revisa el log de arriba"}</p>
      ${d.logPath ? `<p class="muted">Log: <code>${d.logPath}</code></p>` : ""}
      ${d.command ? `<p class="muted">Comando: <code>${d.command}</code></p>` : ""}
      <p class="muted">Se aplicó rollback NO destructivo: los datos están intactos. Corrige la causa y usa «Reintentar».</p>
    `
    $("#btn-retry").hidden = false
  }
  showPane("done")
}

$("#btn-retry").onclick = () => {
  config.mode = "repair"
  $("#run-summary").innerHTML = summaryHtml()
  showPane("run")
  $("#btn-install").disabled = false
}
$("#btn-open-manager").onclick = () => openManager()

// ---------------------------------------------------------------- manager
async function openManager() {
  show("manager")
  await refreshServices()
}

async function refreshServices() {
  try {
    const r = await invoke("manager", { args: ["services", "status"] })
    const res = r.result ?? r
    const table = $("#svc-table")
    table.innerHTML = ""
    for (const s of res.statuses ?? []) {
      const tr = document.createElement("tr")
      tr.innerHTML = `<td class="st st-${s.active ? "pass" : "fail"}">${s.active ? "✓ activo" : "✗ parado"}</td><td>${s.name}</td><td class="muted">${s.enabled ? "auto-arranque" : ""}</td>`
      table.appendChild(tr)
    }
  } catch (e) {
    alert(`No se pudo leer el estado: ${e}`)
  }
}
$("#svc-refresh").onclick = refreshServices
for (const b of $$("[data-svc]")) {
  b.onclick = async () => {
    b.disabled = true
    try {
      await invoke("manager", { args: ["services", b.dataset.svc] })
    } finally {
      b.disabled = false
    }
    setTimeout(refreshServices, 2500)
  }
}

$("#btn-health").onclick = async () => {
  const r = await invoke("manager", { args: ["health"] })
  const res = r.result ?? r
  const rows = [
    { status: res.status === "ok" ? "pass" : res.status === "degraded" ? "warn" : "fail", label: `Estado global: ${res.status}` },
    ...(res.areas ?? []).map((a) => ({ status: a.ok ? "pass" : res.status === "degraded" ? "warn" : "fail", label: a.key, detail: a.detail })),
  ]
  renderChecks($("#health-table"), rows)
}

$("#btn-logs").onclick = async () => {
  const r = await invoke("manager", { args: ["logs"] })
  const res = r.result ?? r
  $("#logs-body").hidden = false
  $("#logs-body").textContent = `${res.hint ?? ""}\n\n${(res.tail ?? []).join("\n")}`
}

$("#btn-diag").onclick = async () => {
  const r = await invoke("manager", { args: ["diagnostics"] })
  const res = r.result ?? r
  renderChecks($("#diag-table"), res.checks ?? [])
}

$("#btn-backup").onclick = async () => {
  $("#btn-backup").disabled = true
  try {
    const r = await invoke("manager", { args: ["backup"] })
    const res = r.result ?? r
    $("#backup-body").hidden = false
    $("#backup-body").textContent = res.output ?? res.error ?? "(sin salida)"
  } finally {
    $("#btn-backup").disabled = false
  }
}

$("#btn-repair").onclick = async () => {
  if (!confirm("¿Reparar la instalación? (los datos no se tocan)")) return
  const r = await invoke("manager", { args: ["repair"] })
  const res = r.result ?? r
  alert(res.ok ? "Reparación completada" : `Reparación con problemas: ${res.diagnostic?.error ?? "ver diagnóstico"}`)
}

$("#btn-uninstall").onclick = () => {
  $("#uninstall-card").hidden = !$("#uninstall-card").hidden
}

$("#btn-uninstall-confirm").onclick = async () => {
  const opts = {
    removeApplication: $("#un-app").checked,
    removeServices: $("#un-svc").checked,
    removeConfig: $("#un-cfg").checked,
    removeMedia: $("#un-media").checked,
    removeBackups: $("#un-backups").checked,
    removeDatabase: $("#un-db").checked,
  }
  if (opts.removeDatabase && !confirm("⚠ Se eliminará la BASE DE DATOS con TODO su contenido. ¿Seguro?")) return
  if (!confirm("Confirmar la desinstalación con las casillas seleccionadas")) return
  const r = await invoke("manager", { args: ["uninstall", "--confirm", `--uninstall-options=${JSON.stringify(opts)}`] })
  const res = r.result ?? r
  $("#uninstall-body").hidden = false
  $("#uninstall-body").textContent =
    `ELIMINADO:\n${(res.removed ?? []).map((x) => "  ✗ " + x).join("\n")}\n\nCONSERVADO:\n${(res.kept ?? []).map((x) => "  ✓ " + x).join("\n")}` +
    (res.warnings?.length ? `\n\nAVISOS:\n${res.warnings.map((x) => "  ⚠ " + x).join("\n")}` : "")
}

// ---------------------------------------------------------------- go
boot()
