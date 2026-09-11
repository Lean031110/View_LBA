/**
 * FASE 11 (release 3.0.0) — ATAQUE AUTORIZADO: manipulación del
 * almacenamiento de licencias (DB / license store).
 *
 * Escenario: un atacante con acceso al servidor edita el registro guardado
 * (cambia el token, inyecta uno firmado por él, o cambia el payload guardado).
 * El sistema DEBE revalidar firma + binding en cada evaluación — nunca confiar
 * en la DB. PASS = el ataque NO desbloquea funciones (status invalid, features
 * de trial/unlicensed).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { getLicenseSystemState, activateLicenseToken, buildLicenseToken, generateLicenseKeyPair } from "@/lib/licensing/index"
import { MemoryLicenseStore } from "@/lib/licensing/storage"
import { makeIdentity, makeLicenseToken, makeTokenPayload, makeAnchorPaths, cleanupAnchorPaths } from "./helpers"

let identity: ReturnType<typeof makeIdentity>
let key: ReturnType<typeof generateLicenseKeyPair>
let attackerKey: ReturnType<typeof generateLicenseKeyPair>
let store: MemoryLicenseStore
let anchors: string[]

beforeEach(() => {
  identity = makeIdentity()
  key = generateLicenseKeyPair()
  attackerKey = generateLicenseKeyPair()
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
const activateOpts = () => ({ store, identity, anchorPaths: anchors, silent: true })

describe("ATAQUE — manipular la DB de licencias (storage tampering)", () => {
  it("baseline: activación válida → active con features desbloqueadas", async () => {
    const token = makeLicenseToken(identity, key, { durationDays: 365, customerName: "Restaurante Objetivo" })
    const res = await activateLicenseToken(token, activateOpts())
    expect(res.ok).toBe(true)
    const state = await getLicenseSystemState(stateOpts())
    expect(state.status).toBe("active")
    expect(state.features.flags["users.management"]).toBe(true)
    expect(state.features.watermark).toBe(false)
  })

  it("ataque 1: mutar 2 caracteres del token guardado → invalid, features bloqueadas", async () => {
    const token = makeLicenseToken(identity, key, { durationDays: 365, customerName: "Restaurante Objetivo" })
    await activateLicenseToken(token, activateOpts())

    // el atacante edita el token EN la DB (2 caracteres del final)
    const mutated = token.slice(0, -2) + (token.endsWith("AA") ? "ZZ" : "AA")
    store.record = { ...store.record!, token: mutated }

    const state = await getLicenseSystemState(stateOpts())
    expect(state.status).toBe("invalid")
    expect(state.features.flags["users.management"]).toBe(false)
    expect(state.license).toBeNull()
  })

  it("ataque 2: reemplazar el token por uno firmado por el ATACANTE → invalid", async () => {
    const token = makeLicenseToken(identity, key, { durationDays: 365, customerName: "Restaurante Objetivo" })
    await activateLicenseToken(token, activateOpts())

    // el atacante inyecta SU token (firmado con SU clave) que 'concede' todos
    // los features y 10 años de vigencia
    const attackPayload = makeTokenPayload(identity, {
      durationDays: 3650,
      plan: "custom",
      customerName: "Restaurante Objetivo",
      features: { "users.management": true, "screens.multiDisplay": true, "themes.custom": true, "branding.customLogo": true },
    })
    const attackToken = buildLicenseToken(attackPayload, attackerKey.privateKey)
    store.record = { ...store.record!, token: attackToken, payload: attackPayload }

    const state = await getLicenseSystemState(stateOpts())
    expect(state.status).toBe("invalid")
    expect(state.features.flags["users.management"]).toBe(false)
    expect(state.features.flags["themes.custom"]).toBe(false)
    expect(state.features.flags["branding.customLogo"]).toBe(false)
  })

  it("ataque 3: editar el PAYLOAD guardado (expiración+10 años, otro cliente) → el estado se deriva del TOKEN revalidado", async () => {
    const token = makeLicenseToken(identity, key, { durationDays: 365, customerName: "Restaurante Objetivo" })
    await activateLicenseToken(token, activateOpts())

    // el atacante edita SOLO el payload parseado de la DB: extiende la
    // expiración 10 años y cambia el cliente. El estado REAL se deriva del
    // TOKEN (firma + fechas) — el payload falsificado NO aplica.
    const realExpires = store.record!.payload.expiresAt
    const forged = makeTokenPayload(identity, {
      durationDays: 365,
      customerName: "Atacante Supremo",
      startsAt: new Date(store.record!.payload.startsAt),
    })
    forged.expiresAt = realExpires + 3650 * 86400000 // +10 años falsos
    store.record = { ...store.record!, payload: forged }

    const state = await getLicenseSystemState(stateOpts())
    expect(state.status).toBe("active") // el token original sigue siendo válido
    // PERO los datos vienen del TOKEN, no del payload falsificado de la DB:
    expect(state.license?.customerName).toBe("Restaurante Objetivo")
    expect(state.license?.expiresAt).toBe(realExpires)
    expect(state.daysLeft).toBeLessThanOrEqual(365)
  })

  it("ataque 4: clonar la DB a OTRO equipo (restore) → mismatch (no active)", async () => {
    const token = makeLicenseToken(identity, key, { durationDays: 365, customerName: "Restaurante Objetivo" })
    await activateLicenseToken(token, activateOpts())

    // la misma DB evaluada contra hardware DISTINTO → binding no cuadra
    const otherIdentity = makeIdentity()
    const state = await getLicenseSystemState({ store, identity: otherIdentity, anchorPaths: anchors, silent: true })
    expect(state.status).toBe("mismatch")
    expect(state.features.flags["users.management"]).toBe(false)
  })

  it("ataque 5: registro con token corrupto (no decodable) → invalid sin lanzar", async () => {
    const token = makeLicenseToken(identity, key, { durationDays: 365, customerName: "Restaurante Objetivo" })
    await activateLicenseToken(token, activateOpts())
    store.record = { ...store.record!, token: "VLBA2-" + "A".repeat(300) }

    const state = await getLicenseSystemState(stateOpts())
    expect(state.status).toBe("invalid")
  })

  it("ataque 6: intentar downgrade (licencia anual → mensual) → rechazado, la anual sigue activa", async () => {
    const annual = makeLicenseToken(identity, key, { durationDays: 365, customerName: "Restaurante Objetivo" })
    const res1 = await activateLicenseToken(annual, activateOpts())
    expect(res1.ok).toBe(true)

    const monthly = makeLicenseToken(identity, key, { durationDays: 30, customerName: "Restaurante Objetivo" })
    const res2 = await activateLicenseToken(monthly, activateOpts())
    expect(res2.ok).toBe(false)
    expect(res2.code).toBe("downgrade")

    const state = await getLicenseSystemState(stateOpts())
    expect(state.status).toBe("active")
    expect(state.license?.durationDays).toBe(365)
  })
})
