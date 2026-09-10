/**
 * ViewLBA — Trial de 7 días (lógica pura, sin I/O).
 *
 * Reglas:
 *  · 1 sola prueba por instalación/hardware (las anclas viven en storage.ts).
 *  · Detección de retroceso de reloj: si now < lastSeenAt - TOLERANCIA →
 *    clockTampered = true (STICKY) y la evaluación se congela al high-water
 *    (lastSeenAt) — volver el reloj atrás NO alarga el trial ni revive una
 *    licencia vencida.
 *  · La meta es resistir manipulaciones casuales, no crear un DRM absurdo
 *    (límites documentados en docs/LICENSE-SECURITY.md).
 */
import { TRIAL_DAYS, type TrialResult, type MergedTrialState } from "./types"

/** Tolerancia de reloj hacia atrás (DST/NTP menor no dispara tamper). */
export const CLOCK_TAMPER_TOLERANCE_MS = 2 * 60 * 60 * 1000 // 2h

/** ¿El reloj retrocedió más allá de la tolerancia respecto al high-water? */
export function detectClockRollback(now: number, lastSeenAt: number | null, toleranceMs = CLOCK_TAMPER_TOLERANCE_MS): boolean {
  if (lastSeenAt == null) return false
  return now < lastSeenAt - toleranceMs
}

/**
 * Tiempo EFECTIVO de evaluación: el reloj nunca puede ganar tiempo hacia
 * atrás — si hay tamper, se congela al último instante visto.
 */
export function effectiveTime(now: number, lastSeenAt: number | null, clockTampered: boolean): number {
  if (clockTampered && lastSeenAt != null) return Math.max(now, lastSeenAt)
  return now
}

export interface TrialAnalysisInput {
  /** Estado fusionado de las anclas (storage.mergeTrialAnchors). */
  merged: MergedTrialState
  /** Reloj actual (ms epoch) — el real, no el efectivo. */
  now: number
  /** Tolerancia de rollback (tests). */
  toleranceMs?: number
}

/**
 * Analiza el trial con anti-rollback:
 *  · trialStartAt null → no iniciado (caller decide arrancarlo).
 *  · días restantes con techo en TRIAL_DAYS, suelo 0.
 *  · clockTampered es sticky (entra en merged y se persiste).
 */
export function analyzeTrial(input: TrialAnalysisInput): TrialResult {
  const { merged, now } = input
  const toleranceMs = input.toleranceMs ?? CLOCK_TAMPER_TOLERANCE_MS

  const rolledBack = detectClockRollback(now, merged.lastSeenAt, toleranceMs)
  const clockTampered = merged.clockTampered || rolledBack
  const effNow = effectiveTime(now, merged.lastSeenAt, clockTampered)

  if (merged.trialStartAt == null) {
    return { active: false, ended: false, daysLeft: TRIAL_DAYS, endsAt: 0, startedAt: null, clockTampered }
  }

  const endsAt = merged.trialStartAt + TRIAL_DAYS * 24 * 60 * 60 * 1000
  const msLeft = endsAt - effNow
  const daysLeft = Math.max(0, Math.ceil(msLeft / (24 * 60 * 60 * 1000)))
  const ended = msLeft <= 0

  return {
    active: !ended,
    ended,
    daysLeft,
    endsAt,
    startedAt: merged.trialStartAt,
    clockTampered,
  }
}

/**
 * Estado "fusionado" propuesto tras una lectura: alta el high-water al now
 * real (nunca hacia abajo) y arrastra flags sticky.
 */
export function nextHighWater(merged: MergedTrialState, now: number): number {
  return Math.max(now, merged.lastSeenAt ?? 0)
}
