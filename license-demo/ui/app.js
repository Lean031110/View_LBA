/* ViewLBA License Generator — lógica de la UI.
 * El navegador NUNCA ve la clave privada: toda firma ocurre en el backend. */
"use strict"

const $ = (sel) => document.querySelector(sel)

// ---------------------------------------------------------------- estado
let CONFIG = { mode: "?", protected: false, publicKey: "", contact: "52973387" }
const HISTORY_KEY = "viewlba.licenseDemo.history"

async function loadConfig() {
  try {
    const res = await fetch("/api/config")
    CONFIG = await res.json()
    const badge = $("#modeBadge")
    const text = $("#modeText")
    if (CONFIG.mode === "admin") {
      text.textContent = "ADMIN PRIVADO"
      badge.classList.add("admin")
      badge.title = "Emisión con la clave real del servidor"
    } else {
      text.textContent = "MODO DEMO"
      badge.title = "Clave efímera de demostración"
    }
    const notice = $("#modeNotice")
    if (CONFIG.mode === "demo") {
      notice.className = "notice warn"
      notice.textContent =
        "MODO DEMO: las licencias se firman con una clave de PRUEBA efímera de esta sesión — sirven para probar el flujo, NO son válidas en instalaciones reales de ViewLBA."
    } else {
      notice.className = "notice ok"
      notice.textContent = CONFIG.protected
        ? "MODO ADMIN PRIVADO: emisión con la clave de producción, protegida por token. La clave privada nunca llega a este navegador."
        : "MODO ADMIN PRIVADO (sin token): escucha solo en localhost del servidor emisor."
    }
  } catch {
    $("#modeText").textContent = "sin conexión"
  }
}
loadConfig()

// ---------------------------------------------------------------- tabs
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"))
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"))
    tab.classList.add("active")
    $(`#panel-${tab.dataset.tab}`).classList.add("active")
    if (tab.dataset.tab === "history") renderHistory()
  })
})

// ---------------------------------------------------------------- helpers
const todayIso = () => new Date().toISOString().slice(0, 10)

async function fileToBase64(file) {
  const buf = await file.arrayBuffer()
  let binary = ""
  const bytes = new Uint8Array(buf)
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

function showResult(el, { ok, title, checks, kv, reasons, download }) {
  el.className = `result ${ok ? "success" : "error"}`
  let html = `<h3>${ok ? "✓" : "✗"} ${title}</h3>`
  if (checks) {
    html += '<ul class="checks">'
    for (const c of checks) html += `<li><span class="${c.ok ? "tick" : "cross"}">${c.ok ? "✓" : "✗"}</span> ${c.label}</li>`
    html += "</ul>"
  }
  if (kv && kv.length) {
    html += "<dl class=\"kv\">"
    for (const [k, v, mono] of kv) html += `<dt>${k}</dt><dd class="${mono ? "mono" : ""}">${v}</dd>`
    html += "</dl>"
  }
  if (reasons && reasons.length) {
    html += '<ul class="reasons">'
    for (const r of reasons) html += `<li>${r}</li>`
    html += "</ul>"
  }
  if (download) {
    html += `<div class="download"><a class="btn primary" style="text-decoration:none" download="${download.fileName}" href="${download.href}">⬇ DESCARGAR ${download.fileName}</a></div>`
  }
  el.innerHTML = html
  el.classList.remove("hidden")
}

function planLabel(plan) {
  return plan === "annual" ? "Anual (365 días · USD 100)" : "Mensual (30 días · USD 10)"
}

function pushHistory(entry) {
  const list = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]")
  list.unshift(entry)
  localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 100)))
  renderHistory()
}

function renderHistory() {
  const el = $("#historyList")
  const list = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]")
  if (!list.length) {
    el.innerHTML = '<p style="color:var(--muted);font-size:13px;padding:12px 4px">Sin emisiones registradas todavía en este navegador.</p>'
    return
  }
  el.innerHTML = list
    .map(
      (h) => `
      <div class="history-item">
        <div>
          <span class="id">${h.licenseId}</span> <span class="name">${escapeHtml(h.customerName)}</span>
          <div class="dates">${h.startsAt?.slice(0, 10)} → ${h.expiresAt?.slice(0, 10)} · ${escapeHtml(h.deviceId)} · ${escapeHtml(h.diskId)}</div>
        </div>
        <div class="plan">${planLabel(h.plan)}</div>
      </div>`
    )
    .join("")
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
}

$("#btnClearHistory")?.addEventListener("click", () => {
  localStorage.removeItem(HISTORY_KEY)
  renderHistory()
})

// ---------------------------------------------------------------- nueva
$("#formNew input[name=startDate]").value = todayIso()
$("#btnFillDemo")?.addEventListener("click", () => {
  const f = $("#formNew")
  f.customerName.value = "Leandro Bueno"
  f.installationId.value = "VWLB-8F2A-91CD-2D31-77AA"
  f.diskId.value = "DSK-A5ED-432A-37DD"
  f.installPath.value = "C:\\PantallaRestaurante"
  f.plan.value = "annual"
  f.startDate.value = todayIso()
})

$("#formNew").addEventListener("submit", async (ev) => {
  ev.preventDefault()
  const btn = $("#btnGenerate")
  const el = $("#resultNew")
  btn.disabled = true
  btn.textContent = "GENERANDO…"
  el.classList.add("hidden")
  try {
    const f = ev.target
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customerName: f.customerName.value.trim(),
        installationId: f.installationId.value.trim(),
        diskId: f.diskId.value.trim(),
        installPath: f.installPath.value.trim(),
        plan: f.plan.value,
        startDate: f.startDate.value,
      }),
    })
    const data = await res.json()
    if (res.ok && data.ok) {
      const bytes = Uint8Array.from(atob(data.zipBase64), (c) => c.charCodeAt(0))
      const blob = new Blob([bytes], { type: "application/zip" })
      showResult(el, {
        ok: true,
        title: "Licencia creada",
        checks: [
          { ok: true, label: "Licencia creada y firmada (Ed25519)" },
          { ok: true, label: "Firma verificada de ida y vuelta" },
          { ok: true, label: "Binding correcto (equipo + disco)" },
          { ok: true, label: "ZIP listo para entregar al cliente" },
        ],
        kv: [
          ["Cliente", escapeHtml(data.summary.customerName)],
          ["Plan", planLabel(data.summary.plan)],
          ["Inicio", data.summary.startsAt.slice(0, 10)],
          ["Vencimiento", data.summary.expiresAt.slice(0, 10)],
          ["Installation ID", data.license.deviceId, true],
          ["Disk ID", data.license.diskId, true],
          ["Licencia", data.license.licenseId, true],
        ],
        download: { fileName: data.fileName, href: URL.createObjectURL(blob) },
      })
      pushHistory(data.license)
    } else {
      showResult(el, { ok: false, title: "No se generó nada — corrige los errores", reasons: data.reasons || [data.error || "Error desconocido"] })
    }
  } catch (e) {
    showResult(el, { ok: false, title: "Error de conexión", reasons: [String(e.message || e)] })
  } finally {
    btn.disabled = false
    btn.innerHTML = 'GENERAR LICENCIA'
  }
})

// ---------------------------------------------------------------- renovar
$("#formRenew input[name=startDate]").value = todayIso()
$("#formRenew").addEventListener("submit", async (ev) => {
  ev.preventDefault()
  const el = $("#resultRenew")
  el.classList.add("hidden")
  try {
    const f = ev.target
    const file = f.file.files[0]
    if (!file) throw new Error("Selecciona la licencia actual")
    const fileBase64 = await fileToBase64(file)
    const res = await fetch("/api/renew", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileBase64, plan: f.plan.value, startDate: f.startDate.value }),
    })
    const data = await res.json()
    if (res.ok && data.ok) {
      const bytes = Uint8Array.from(atob(data.zipBase64), (c) => c.charCodeAt(0))
      const blob = new Blob([bytes], { type: "application/zip" })
      showResult(el, {
        ok: true,
        title: "Renovación creada (licencia nueva, la anterior queda intacta)",
        checks: [
          { ok: true, label: "Licencia de origen verificada" },
          { ok: true, label: "Mismo binding (equipo + disco)" },
          { ok: true, label: "Nueva licencia firmada" },
        ],
        kv: [
          ["Cliente", escapeHtml(data.summary.customerName)],
          ["Plan", planLabel(data.summary.plan)],
          ["Nueva vigencia", `${data.summary.startsAt.slice(0, 10)} → ${data.summary.expiresAt.slice(0, 10)}`],
          ["Licencia nueva", data.license.licenseId, true],
        ],
        download: { fileName: data.fileName, href: URL.createObjectURL(blob) },
      })
      pushHistory(data.license)
    } else {
      showResult(el, { ok: false, title: "Renovación rechazada", reasons: data.reasons || [data.error || "Error desconocido"] })
    }
  } catch (e) {
    showResult(el, { ok: false, title: "Error", reasons: [String(e.message || e)] })
  }
})

// ---------------------------------------------------------------- verificar
$("#formVerify").addEventListener("submit", async (ev) => {
  ev.preventDefault()
  const el = $("#resultVerify")
  el.classList.add("hidden")
  try {
    const f = ev.target
    const file = f.file.files[0]
    if (!file) throw new Error("Selecciona una licencia")
    const fileBase64 = await fileToBase64(file)
    const res = await fetch("/api/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileBase64,
        installationId: f.installationId.value.trim() || undefined,
        diskId: f.diskId.value.trim() || undefined,
      }),
    })
    const data = await res.json()
    if (res.ok && data.ok) {
      const checks = [
        { ok: data.signatureOk, label: data.signatureOk ? "Firma digital VÁLIDA" : "Firma digital INVÁLIDA (modificada u otro emisor)" },
        { ok: !data.expired, label: data.expired ? "LICENCIA VENCIDA" : `Vigente — ${data.daysLeft} día(s) restantes` },
      ]
      if (data.binding.installationId) checks.push({ ok: data.binding.installationId === "match", label: `Installation ID ${data.binding.installationId === "match" ? "coincide" : "NO coincide"}` })
      if (data.binding.diskId) checks.push({ ok: data.binding.diskId === "match", label: `Disk ID ${data.binding.diskId === "match" ? "coincide" : "NO coincide"}` })
      showResult(el, {
        ok: data.signatureOk && !data.expired,
        title: data.signatureOk ? "Verificación de licencia" : "Licencia NO válida",
        checks,
        kv: [
          ["Cliente", escapeHtml(data.license.customerName)],
          ["Plan", planLabel(data.license.plan)],
          ["Vigencia", `${data.license.startsAt.slice(0, 10)} → ${data.license.expiresAt.slice(0, 10)}`],
          ["Equipo", data.license.deviceId, true],
          ["Disco", data.license.diskId, true],
          ["Ruta", escapeHtml(data.license.installPath), true],
        ],
      })
    } else {
      showResult(el, { ok: false, title: "No se pudo verificar", reasons: data.reasons || [data.error || "Error desconocido"] })
    }
  } catch (e) {
    showResult(el, { ok: false, title: "Error", reasons: [String(e.message || e)] })
  }
})
