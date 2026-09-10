import { NextResponse } from "next/server"
import { getFeatureAvailability, CONTACT_PHONE } from "./index"
import type { FeatureKey } from "./types"

/**
 * ViewLBA — Guard de features de licencia para rutas API (defensa en
 * profundidad: la UI bloquea secciones premium, el backend rechaza las
 * mutaciones correspondientes cuando el plan no las incluye).
 *
 * Uso en rutas admin:
 *   const denied = await requireLicenseFeature("users.management")
 *   if (denied) return denied   // 403 { error, feature, contact }
 */

/** Features que exigen plan comercial (trial/limitado → 403). */
export async function requireLicenseFeature(feature: FeatureKey): Promise<NextResponse | null> {
  const features = await getFeatureAvailability()
  if (features.flags[feature] === true) return null
  return NextResponse.json(
    {
      error: `Función no disponible en el plan actual (${feature}). ${features.lockReason ?? ""}`.trim(),
      feature,
      contact: CONTACT_PHONE,
    },
    { status: 403 }
  )
}

/** Igual que requireLicenseFeature pero con condición extra (p.ej. límite de pantallas del trial). */
export async function requireLicenseFeatureIf(condition: boolean, feature: FeatureKey): Promise<NextResponse | null> {
  if (!condition) return null
  return requireLicenseFeature(feature)
}
