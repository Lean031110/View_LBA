/**
 * Tests: máquina de estados completa (getLicenseSystemState) + escenarios de
 * backup/restore y cambio de disco ("restore DB a otro disco → MISMATCH").
 *
 * Todo con MemoryStore + anclas en temp dirs: sin DB, sin red, determinista.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { getLicenseSystemState, activateLicenseToken } from "@/lib/licensing/index"
import { MemoryLicenseStore } from "@/lib/licensing/storage"
import { generateLicenseKeyPair } from "@/lib/licensing/crypto"
import { makeIdentity, makeLicenseToken, makeAnchorPaths, cleanupAnchorPaths, DAY_MS } from "./helpers"
import { TRACKED_TABLES } from "@/lib/backup"

let identity: ReturnType<typeof makeIdentity>
let key: ReturnType<typeof generateLicenseKeyPair>
let store: MemoryLicenseStore
let anchors: string[]

beforeEach(() => {
  identity = makeIdentity()
  key = generateLicenseKeyPair()
  store = new MemoryLicenseStore()
  anchors = makeAnchorPaths()
  process.env.AUTH_SECRET = "test-auth-secret-0123456789abcdef"
  process.env.VIEWLBA_LICENSE_PUBLIC_KEY = key.publicKey
})

afterEach(() => {
  delete process.env.VIEWLBA_LICENSE_PUBLIC_KEY
  cleanupAnchorPaths(anchors)
})

const stateOpts = () => ({ store, identity, anchorPaths: anchors, silent: true })

describe("getLicenseSystemState — ciclo de vida", () => {
  it("arranque fresco → trial con 7 días", async () => {
    const state = await getLicenseSystemState(stateOpts())
    expect(state.status).toBe("trial")
    expect(state.trial?.daysLeft).toBe(7)
    expect(state.daysLeft).toBe(7)
    expect(state.features.watermark).toBe(true)
    expect(state.features.flags["users.management"]).toBe(false)
  })

  it("día 8 (now avanzado) → unlicensed (modo limitado)", async () => {
    const now = Date.now()
    await getLicenseSystemState({ ...stateOpts(), now })
    const later = await getLicenseSystemState({ ...stateOpts(), now: now + 8 * DAY_MS })
    expect(later.status).toBe("unlicensed")
    expect(later.features.watermark).toBe(true)
    expect(later.features.watermarkLines?.[0]).toContain("PERÍODO DE PRUEBA FINALIZADO")
  })

  it("licencia activada por token → active: watermark OFF y premium ON", async () => {
    const token = makeLicenseToken(identity, key, { durationDays: 60, plan: "custom", customerName: "Leandro Bueno" })
    const activated = await activateLicenseToken(token, { store, identity, anchorPaths: anchors, silent: true })
    expect(activated.ok).toBe(true)

    const state = await getLicenseSystemState(stateOpts())
    expect(state.status).toBe("active")
    expect(state.license?.customerName).toBe("Leandro Bueno")
    expect(state.license?.plan).toBe("custom")
    expect(state.daysLeft).toBe(60)
    expect(state.features.watermark).toBe(false)
    expect(state.features.flags["users.management"]).toBe(true)
    expect(state.features.flags["screens.multiDisplay"]).toBe(true)
  })

  it("licencia vencida → expired (watermark de renovación)", async () => {
    // Se activa VIGENTE (en el pasado) y luego se evalúa AHORA (vencida)
    const token = makeLicenseToken(identity, key, { startsAt: new Date(Date.now() - 50 * DAY_MS), durationDays: 20, plan: "custom" })
    const activated = await activateLicenseToken(token, {
      store,
      identity,
      anchorPaths: anchors,
      silent: true,
      now: Date.now() - 40 * DAY_MS, // momento de la activación (vigente)
    })
    expect(activated.ok).toBe(true)

    const state = await getLicenseSystemState(stateOpts())
    expect(state.status).toBe("expired")
    expect(state.license?.customerName).toBe("Lo D'Leo") // visible para renovar
    expect(state.features.watermarkLines?.[0]).toContain("LICENCIA VENCIDA")
  })

  it("licencia manipulada tras el guardado → invalid en la siguiente evaluación", async () => {
    const token = makeLicenseToken(identity, key, { durationDays: 60, plan: "custom" })
    await activateLicenseToken(token, { store, identity, anchorPaths: anchors, silent: true })
    // manipulan la DB: el TOKEN guardado se edita (el token es la fuente de
    // verdad — el payloadJson es solo un cache de lectura)
    const record = await store.getLicenseRecord()
    const tamperedToken = record!.token.slice(0, -2) + (record!.token.endsWith("A") ? "B" : "A")
    await store.saveLicenseRecord({ ...record!, token: tamperedToken })

    const state = await getLicenseSystemState(stateOpts())
    expect(state.status).toBe("invalid")
    expect(state.reasons[0]).toMatch(/no fue emitido|modificado|esquema|alterado|truncado|corrupto/i)
  })

  it("mismatch → mensaje humano 'NO CORRESPONDE A ESTE EQUIPO'", async () => {
    const token = makeLicenseToken(identity, key, { durationDays: 365, plan: "annual" })
    await activateLicenseToken(token, { store, identity, anchorPaths: anchors, silent: true })

    // la identidad recalculada difiere (otro equipo)
    const movedIdentity = makeIdentity()
    const state = await getLicenseSystemState({ store, identity: movedIdentity, anchorPaths: anchors, silent: true })
    expect(state.status).toBe("mismatch")
    expect(state.features.watermarkLines?.[0]).toContain("LICENCIA NO CORRESPONDE A ESTE EQUIPO")
  })
})

describe("restore / cambio de disco (binding SIEMPRE se recalcula)", () => {
  it("L) restore de la DB a OTRO DISCO → MISMATCH (no se clona la licencia)", async () => {
    // Instalación original con licencia activa
    const token = makeLicenseToken(identity, key, { durationDays: 365, plan: "annual" })
    await activateLicenseToken(token, { store, identity, anchorPaths: anchors, silent: true })
    const before = await getLicenseSystemState(stateOpts())
    expect(before.status).toBe("active")

    // "Restore": la MISMA DB (mismo store) se restaura en otro equipo/disco:
    // la identidad recalculada difiere (otro diskId, mismo deviceId).
    const movedIdentity = makeIdentity({
      deviceIdHash: identity.deviceIdHash,
      installationId: identity.installationId,
      diskIdHash: "f".repeat(64),
      diskId: "DSK-FFFF-0000-0000",
    })
    const after = await getLicenseSystemState({ store, identity: movedIdentity, anchorPaths: anchors, silent: true })
    expect(after.status).toBe("mismatch")
    expect(after.reasons.join(" ")).toMatch(/otro disco/i)
    // y las features premium vuelven a bloquearse
    expect(after.features.flags["users.management"]).toBe(false)
    expect(after.features.watermark).toBe(true)
  })

  it("restore a OTRO EQUIPO (mismo disco no) → MISMATCH por instalación", async () => {
    const token = makeLicenseToken(identity, key, { durationDays: 365, plan: "annual" })
    await activateLicenseToken(token, { store, identity, anchorPaths: anchors, silent: true })

    const otherMachine = makeIdentity()
    const state = await getLicenseSystemState({ store, identity: otherMachine, anchorPaths: anchors, silent: true })
    expect(state.status).toBe("mismatch")
    expect(state.reasons.join(" ")).toMatch(/otro equipo|otro disco/i)
  })

  it("el trial NO se resetea tras restaurar la DB: las anclas viven fuera de la DB", async () => {
    const now = Date.now()
    await getLicenseSystemState({ ...stateOpts(), now })
    // "restauran" una DB vieja: el store se reemplaza por uno vacío
    const wipedStore = new MemoryLicenseStore()
    const after = await getLicenseSystemState({ store: wipedStore, identity, anchorPaths: anchors, silent: true, now: now + 3 * DAY_MS })
    // el trial continúa desde el día 3 (no vuelve a 7)
    expect(after.status).toBe("trial")
    expect(after.trial?.daysLeft).toBe(4)
  })

  it("las tablas de licencia participan del backup verificado (TRACKED_TABLES)", () => {
    expect(TRACKED_TABLES).toContain("LicenseState")
    expect(TRACKED_TABLES).toContain("LicenseHistory")
  })
})

describe("anti-rollback integrado en la máquina de estados", () => {
  it("licencia vencida + reloj hacia atrás → sigue EXPIRED (no revive)", async () => {
    const token = makeLicenseToken(identity, key, { startsAt: new Date(Date.now() - 50 * DAY_MS), durationDays: 20, plan: "custom" })
    const imported = await activateLicenseToken(token, {
      store,
      identity,
      anchorPaths: anchors,
      silent: true,
      now: Date.now() - 40 * DAY_MS,
    })
    expect(imported.ok).toBe(true)

    const now = Date.now()
    // primera evaluación (high-water = now)
    const s1 = await getLicenseSystemState({ ...stateOpts(), now })
    expect(s1.status).toBe("expired")

    // el usuario retrocede el reloj 20 días para "revivir" la licencia
    const s2 = await getLicenseSystemState({ ...stateOpts(), now: now - 20 * DAY_MS })
    expect(s2.clockTampered).toBe(true)
    expect(s2.status).toBe("expired") // congelado al high-water → sigue vencida
  })

  it("trial + rollback → clockTampered y días congelados", async () => {
    const now = Date.now()
    await getLicenseSystemState({ ...stateOpts(), now })
    // avanzan 5 días reales (high-water sube)
    await getLicenseSystemState({ ...stateOpts(), now: now + 5 * DAY_MS })
    // reloj retrocede 4 días
    const s = await getLicenseSystemState({ ...stateOpts(), now: now + DAY_MS })
    expect(s.clockTampered).toBe(true)
    expect(s.status).toBe("trial")
    // evaluado al high-water: quedan 2 días, no 6
    expect(s.trial?.daysLeft).toBe(2)
  })
})
