/**
 * Tests: trial de 7 días — anti-reinicio y anti-rollback (sección 27).
 *
 *  I) trial 7 días → PASS
 *  J) día 8 → EXPIRED (unlicensed)
 *  K) reloj retrocede → TAMPERED (congelado, no gana días)
 *  + borrar una ancla NO reinicia el trial; DB reset no reinicia; reinstall
 */
import { describe, expect, it, beforeEach } from "bun:test"
import { analyzeTrial, detectClockRollback, effectiveTime, CLOCK_TAMPER_TOLERANCE_MS } from "@/lib/licensing/trial"
import { refreshTrialState, readTrialAnchors, writeTrialAnchors, computeAnchorStamp } from "@/lib/licensing/storage"
import { makeIdentity, makeAnchorPaths, cleanupAnchorPaths, DAY_MS } from "./helpers"
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs"

describe("analyzeTrial (lógica pura)", () => {
  it("I) trial de 7 días: día 0 → 7 días; día 6 → 1 día", () => {
    const start = Date.now() - 6 * 60 * 60 * 1000 // hace 6h
    const r = analyzeTrial({ merged: { trialStartAt: start, lastSeenAt: start, clockTampered: false, lastLoggedStatus: null, integrityWarnings: 0, anchorsFound: 1 }, now: Date.now() })
    expect(r.active).toBe(true)
    expect(r.daysLeft).toBe(7)

    const r6 = analyzeTrial({ merged: { trialStartAt: Date.now() - 6 * DAY_MS, lastSeenAt: Date.now(), clockTampered: false, lastLoggedStatus: null, integrityWarnings: 0, anchorsFound: 1 }, now: Date.now() })
    expect(r6.daysLeft).toBe(1)
    expect(r6.active).toBe(true)
  })

  it("J) día 8 → ended, daysLeft 0", () => {
    const r = analyzeTrial({ merged: { trialStartAt: Date.now() - 8 * DAY_MS, lastSeenAt: Date.now(), clockTampered: false, lastLoggedStatus: null, integrityWarnings: 0, anchorsFound: 1 }, now: Date.now() })
    expect(r.active).toBe(false)
    expect(r.ended).toBe(true)
    expect(r.daysLeft).toBe(0)
  })

  it("nunca iniciado (null) → active false, sin días consumidos", () => {
    const r = analyzeTrial({ merged: { trialStartAt: null, lastSeenAt: null, clockTampered: false, lastLoggedStatus: null, integrityWarnings: 0, anchorsFound: 0 }, now: Date.now() })
    expect(r.active).toBe(false)
    expect(r.startedAt).toBeNull()
  })
})

describe("detectClockRollback / effectiveTime (K)", () => {
  it("K) reloj hacia atrás más allá de la tolerancia → detectado", () => {
    const lastSeen = Date.now()
    expect(detectClockRollback(lastSeen - CLOCK_TAMPER_TOLERANCE_MS - 1000, lastSeen)).toBe(true)
  })

  it("ajustes menores (DST/NTP) NO disparan tamper", () => {
    const lastSeen = Date.now()
    expect(detectClockRollback(lastSeen - 30 * 60 * 1000, lastSeen)).toBe(false) // 30 min atrás
    expect(detectClockRollback(lastSeen + 3600_000, lastSeen)).toBe(false) // hacia delante siempre ok
  })

  it("con tamper, el tiempo EFECTIVO se congela al high-water (no gana días)", () => {
    const lastSeen = Date.now() - 0 // "ahora real" del sistema
    const rolledBack = lastSeen - 5 * DAY_MS // reloj retrocedido 5 días
    const eff = effectiveTime(rolledBack, lastSeen, true)
    expect(eff).toBe(lastSeen) // evalúa como si siguiera en el high-water
  })

  it("K) trial + rollback: los días NO se recuperan (rollback tras consumir 6 días)", () => {
    const trialStart = Date.now() - 6 * DAY_MS
    const lastSeen = Date.now() // vio el día 6
    const rolledBackNow = Date.now() - 5 * DAY_MS // usuario retrocede 5 días
    const tampered = detectClockRollback(rolledBackNow, lastSeen)
    expect(tampered).toBe(true)
    const eff = effectiveTime(rolledBackNow, lastSeen, tampered)
    const r = analyzeTrial({ merged: { trialStartAt: trialStart, lastSeenAt: lastSeen, clockTampered: tampered, lastLoggedStatus: null, integrityWarnings: 0, anchorsFound: 1 }, now: rolledBackNow })
    // el análisis interno usa el reloj efectivo → quedan 1 día, NO 6
    expect(r.daysLeft).toBe(1)
    expect(r.clockTampered).toBe(true)
    void eff
  })

  it("rollback tras el fin del trial → sigue EXPIRADO (no revive)", () => {
    const trialStart = Date.now() - 9 * DAY_MS
    const lastSeen = Date.now() - 1 * DAY_MS // ya vio el trial vencido
    const rolledBackNow = Date.now() - 8 * DAY_MS
    const r = analyzeTrial({ merged: { trialStartAt: trialStart, lastSeenAt: lastSeen, clockTampered: true, lastLoggedStatus: null, integrityWarnings: 0, anchorsFound: 1 }, now: rolledBackNow })
    expect(r.ended).toBe(true)
    expect(r.active).toBe(false)
  })
})

describe("anclas de trial (persistencia anti-borrado casual)", () => {
  const identity = makeIdentity()

  it("primer arranque (sin licencia) → trial iniciado UNA vez y persistido en las 2 anclas", () => {
    const paths = makeAnchorPaths()
    try {
      const now = Date.now()
      const r1 = refreshTrialState(identity.deviceIdHash, { now, anchorPaths: paths, hasLicense: false })
      expect(r1.trialJustStarted).toBe(true)
      expect(r1.merged.trialStartAt).toBe(now)

      // ambas anclas existen y con el mismo trialStartAt
      expect(existsSync(paths[0])).toBe(true)
      expect(existsSync(paths[1])).toBe(true)

      // segundo arranque NO reinicia el trial
      const r2 = refreshTrialState(identity.deviceIdHash, { now: now + 3600_000, anchorPaths: paths, hasLicense: false })
      expect(r2.trialJustStarted).toBe(false)
      expect(r2.merged.trialStartAt).toBe(now)
    } finally {
      cleanupAnchorPaths(paths)
    }
  })

  it("borrar UNA ancla NO reinicia el trial (fusión earliest-start)", () => {
    const paths = makeAnchorPaths()
    try {
      const now = Date.now()
      refreshTrialState(identity.deviceIdHash, { now, anchorPaths: paths })
      rmSync(paths[0]) // "borran" la ancla del DATA_DIR
      const r2 = refreshTrialState(identity.deviceIdHash, { now: now + 2 * DAY_MS, anchorPaths: paths })
      expect(r2.trialJustStarted).toBe(false)
      expect(r2.merged.trialStartAt).toBe(now) // la ancla del home conserva el inicio
      expect(r2.analysis.daysLeft).toBe(5)
    } finally {
      cleanupAnchorPaths(paths)
    }
  })

  it("reset/reinstall superficial (regenerar la ancla del DATA_DIR) NO reinicia: gana la ancla del home", () => {
    const paths = makeAnchorPaths()
    try {
      const now = Date.now()
      refreshTrialState(identity.deviceIdHash, { now, anchorPaths: paths })
      // "reinstalan" la app: la ancla del data dir desaparece...
      rmSync(paths[0])
      // ...pero aparece una NUEVA sin trial iniciado (instalación fresca)
      const freshAnchorDir = paths[0].substring(0, paths[0].lastIndexOf("/"))
      mkdirSync(freshAnchorDir, { recursive: true })
      writeFileSync(
        paths[0],
        JSON.stringify({
          v: 1,
          deviceIdHash: identity.deviceIdHash,
          trialStartAt: null,
          lastSeenAt: null,
          clockTampered: false,
          stamp: "stamp-invalido-tras-reinstalacion",
        })
      )
      const r = refreshTrialState(identity.deviceIdHash, { now: now + DAY_MS, anchorPaths: paths })
      // la fusión toma el INICIO de la ancla legítima del home
      expect(r.merged.trialStartAt).toBe(now)
      expect(r.trialJustStarted).toBe(false)
    } finally {
      cleanupAnchorPaths(paths)
    }
  })

  it("ancla AJENA (otro deviceIdHash) se ignora — copiar ~/.viewlba a otra máquina no traslada el trial", () => {
    const paths = makeAnchorPaths()
    const foreign = makeIdentity()
    try {
      // máquina "A" inicia trial
      refreshTrialState(identity.deviceIdHash, { now: Date.now(), anchorPaths: paths })
      // máquina "B" recibe la home de A copiada (mismas anclas)
      const tB = Date.now() + 1000
      const rB = refreshTrialState(foreign.deviceIdHash, { now: tB, anchorPaths: paths })
      // B arranca su PROPIO trial (las anclas de A se ignoran)
      expect(rB.trialJustStarted).toBe(true)
      expect(rB.merged.trialStartAt).toBe(tB)
    } finally {
      cleanupAnchorPaths(paths)
    }
  })

  it("ancla editada a mano (sello HMAC inválido) → integrityWarning y NO reinicia el trial", () => {
    const paths = makeAnchorPaths()
    try {
      const now = Date.now()
      refreshTrialState(identity.deviceIdHash, { now, anchorPaths: paths })
      // el usuario edita ambas anclas para "borrar" el inicio del trial
      for (const p of paths) {
        const content = JSON.parse(readFileSync(p, "utf8"))
        content.trialStartAt = null
        writeFileSync(p, JSON.stringify(content))
      }
      const r = refreshTrialState(identity.deviceIdHash, { now: now + DAY_MS, anchorPaths: paths })
      expect(r.merged.integrityWarnings).toBe(2)
      // no confiamos en el trialStartAt editado → no hay trial válido
      expect(r.merged.trialStartAt).toBeNull()
    } finally {
      cleanupAnchorPaths(paths)
    }
  })

  it("writeTrialAnchors produce anclas con sello válido de ida y vuelta", () => {
    const paths = makeAnchorPaths()
    try {
      const state = { trialStartAt: Date.now(), lastSeenAt: Date.now(), clockTampered: false, lastLoggedStatus: null }
      writeTrialAnchors(identity.deviceIdHash, state, paths)
      const { merged } = readTrialAnchors(identity.deviceIdHash, paths)
      expect(merged.trialStartAt).toBe(state.trialStartAt)
      expect(merged.integrityWarnings).toBe(0)
      expect(merged.anchorsFound).toBe(2)
    } finally {
      cleanupAnchorPaths(paths)
    }
  })

  it("el sello mezcla el deviceIdHash: la misma ancla en otra máquina no valida", () => {
    const state = { trialStartAt: Date.now(), lastSeenAt: Date.now(), clockTampered: false, lastLoggedStatus: null }
    const body = { v: 1 as const, deviceIdHash: identity.deviceIdHash, ...state }
    const stamp = computeAnchorStamp(body)
    // misma estructura pero "firmada" para otro dispositivo → no coincide
    const otherBody = { v: 1 as const, deviceIdHash: "f".repeat(64), ...state }
    expect(computeAnchorStamp(otherBody)).not.toBe(stamp)
  })

  it("con licencia importada NO arranca trial (hasLicense=true)", () => {
    const paths = makeAnchorPaths()
    try {
      const r = refreshTrialState(identity.deviceIdHash, { now: Date.now(), anchorPaths: paths, hasLicense: true })
      expect(r.trialJustStarted).toBe(false)
      expect(r.merged.trialStartAt).toBeNull()
    } finally {
      cleanupAnchorPaths(paths)
    }
  })

  it("eventos: trial_started y clock_tampering_detected se emiten exactamente al ocurrir", () => {
    const paths = makeAnchorPaths()
    try {
      const events: string[] = []
      const now = Date.now()
      refreshTrialState(identity.deviceIdHash, {
        now,
        anchorPaths: paths,
        onEvent: (e) => events.push(e),
      })
      expect(events).toContain("trial_started")

      // rollback: now retrocede 3 días
      refreshTrialState(identity.deviceIdHash, {
        now: now - 3 * DAY_MS,
        anchorPaths: paths,
        onEvent: (e) => events.push(e),
      })
      expect(events).toContain("clock_tampering_detected")
      // y NO se repite en refreshes posteriores (sticky, una sola vez)
      const eventsBefore = events.length
      refreshTrialState(identity.deviceIdHash, { now: now - 3 * DAY_MS, anchorPaths: paths, onEvent: (e) => events.push(e) })
      expect(events.length).toBe(eventsBefore)
    } finally {
      cleanupAnchorPaths(paths)
    }
  })
})

beforeEach(() => {
  // aislar AUTH_SECRET de los sellos HMAC entre tests
  process.env.AUTH_SECRET = "test-auth-secret-0123456789abcdef"
})
