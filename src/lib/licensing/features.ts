/**
 * ViewLBA — Feature flags de licenciamiento (mapeados a funciones REALES).
 *
 * Nada inventado: cada flag corresponde a una sección/función existente:
 *  · screens.multiDisplay → sección "Pantallas" (gestión multi-pantalla)
 *  · branding.customLogo  → sección "Logotipo"
 *  · themes.custom        → sección "Apariencia" (colores/temas)
 *  · users.management     → sección "Usuarios"
 *  · backup.selfService   → botón de backup del Dashboard
 *  · analytics.advanced   → métricas avanzadas del Dashboard
 *
 * Durante trial/limitado se permite: configuración básica, contenido,
 * transmisión, pantalla TV, health (ver docs/LICENSE-SYSTEM.md).
 * La lista de features es extensible vía license.features (futuro).
 */
import { CONTACT_PHONE, type FeatureAvailability, type FeatureKey, type LicensePlan, type LicenseStatus } from "./types"

export const FEATURE_KEYS: FeatureKey[] = [
  "display.watermark",
  "screens.multiDisplay",
  "branding.customLogo",
  "themes.custom",
  "users.management",
  "backup.selfService",
  "analytics.advanced",
]

/** Flags para planes comerciales (mensual y anual: producto completo). */
export const COMMERCIAL_FEATURES: Record<FeatureKey, boolean> = {
  "display.watermark": false,
  "screens.multiDisplay": true,
  "branding.customLogo": true,
  "themes.custom": true,
  "users.management": true,
  "backup.selfService": true,
  "analytics.advanced": true,
}

/** Flags durante trial / estados limitados (premium bloqueado). */
export const LIMITED_FEATURES: Record<FeatureKey, boolean> = {
  "display.watermark": true,
  "screens.multiDisplay": false,
  "branding.customLogo": false,
  "themes.custom": false,
  "users.management": false,
  "backup.selfService": false,
  "analytics.advanced": false,
}

/** Nombres legibles de cada flag (para la UI de licencia). */
export const FEATURE_LABELS: Record<FeatureKey, string> = {
  "display.watermark": "Marca de agua en TV",
  "screens.multiDisplay": "Gestión multi-pantalla",
  "branding.customLogo": "Logotipo y branding personalizado",
  "themes.custom": "Temas y apariencia personalizada",
  "users.management": "Gestión de usuarios y roles",
  "backup.selfService": "Copias de seguridad manuales",
  "analytics.advanced": "Métricas avanzadas del panel",
}

export interface ResolveFeaturesInput {
  /** Estado global resuelto (trial/active/expired/...). */
  status: LicenseStatus
  /** Features explícitas de la licencia (solo se usan si status=active/grace). */
  licenseFeatures?: Record<string, boolean> | null
  /** Días restantes (para el texto del watermark de trial). */
  trialDaysLeft?: number
}

/**
 * Resuelve la disponibilidad de features + watermark para el estado actual.
 * Las features de la licencia SOBRESCRIBEN el default del plan (arquitectura
 * preparada para futuros planes con features selectivas — sección 33).
 */
export function resolveFeatures(input: ResolveFeaturesInput): FeatureAvailability {
  const commercial = input.status === "active" || input.status === "grace"

  if (commercial) {
    const flags: Record<FeatureKey, boolean> = { ...COMMERCIAL_FEATURES }
    // La licencia puede afinar flags (excepto watermark, que depende del estado)
    for (const key of FEATURE_KEYS) {
      if (key === "display.watermark") continue
      if (input.licenseFeatures && key in input.licenseFeatures) {
        flags[key] = input.licenseFeatures[key] === true
      }
    }
    if (input.status === "grace") {
      // En gracia el producto sigue completo pero la licencia está por vencer
      return { flags, watermark: false, watermarkLines: null, lockReason: null }
    }
    return { flags, watermark: false, watermarkLines: null, lockReason: null }
  }

  // Estados limitados: trial | unlicensed | expired | invalid | mismatch
  const days = input.trialDaysLeft ?? 0
  let lines: string[]
  switch (input.status) {
    case "trial":
      lines = [
        "VERSIÓN DE PRUEBA · ViewLBA",
        days > 1 ? `Quedan ${days} días` : days === 1 ? "Queda 1 día" : "Último día de prueba",
        `Activar licencia: ${CONTACT_PHONE}`,
      ]
      break
    case "unlicensed":
      lines = ["PERÍODO DE PRUEBA FINALIZADO · ViewLBA", `Para continuar, activa tu licencia: ${CONTACT_PHONE}`]
      break
    case "expired":
      lines = ["LICENCIA VENCIDA · ViewLBA", `Renueva tu licencia: ${CONTACT_PHONE}`]
      break
    case "mismatch":
      lines = ["LICENCIA VINCULADA A OTRA INSTALACIÓN · ViewLBA", `Contacto: ${CONTACT_PHONE}`]
      break
    default: // invalid
      lines = ["LICENCIA NO VÁLIDA · ViewLBA", `Contacto: ${CONTACT_PHONE}`]
      break
  }

  const lockReason =
    input.status === "trial"
      ? `Versión de prueba — las funciones premium se activan con la licencia (${CONTACT_PHONE}).`
      : `Este estado no permite funciones premium. Importa o renueva tu licencia (${CONTACT_PHONE}).`

  return { flags: { ...LIMITED_FEATURES }, watermark: true, watermarkLines: lines, lockReason }
}
