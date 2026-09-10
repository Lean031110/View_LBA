/**
 * E2E fixtures — par de claves Ed25519 DUMMY para el sistema de licencias.
 *
 * ⚠⚠ ESTA CLAVE PRIVADA ES UN FIXTURE DE TEST, NO UN SECRETO REAL ⚠⚠
 *  · Solo verifica contra VIEWLBA_LICENSE_PUBLIC_KEY de los entornos E2E/CI
 *    (que se fija a la clave pública DUMMY de este archivo).
 *  · La clave pública de PRODUCCIÓN (src/lib/licensing/public-key.ts) es
 *    DISTINTA → licencias firmadas aquí NUNCA pasarán validación en el
 *    producto real.
 *  · Ningún valor de producción (clientes, claves reales) aparece aquí.
 */
export const E2E_LICENSE_PUBLIC_KEY = "DEYlcmsRR7oWGjm7E72KhO2G5BzgirmO5w0mmsVtz6w"
export const E2E_LICENSE_PRIVATE_KEY = "h5qPUbRexSuabP26k5s0JU4LahOjFFmfU7VvrMDvXWw"

/** Override de fingerprint de hardware para E2E (64 hex). */
export const E2E_DEVICE_FINGERPRINT = "00946114a3a48905be6f60d95f945a1b29f3f2b261e32f30521afed84407f8e7"

/** Override de disk binding para E2E (64 hex). */
export const E2E_DISK_ID_HASH = "a5ed432a37dde11ef146fcc98049c07d06e0db193cc1cf69dc2214d7b2cc8b02"

/** Installation ID derivado del fingerprint E2E. */
export const E2E_INSTALLATION_ID = "VWLB-0094-6114-A3A4-8905"

/** Disk ID derivado del binding E2E. */
export const E2E_DISK_ID = "DSK-A5ED-432A-37DD"

/** Ruta de instalación E2E (override). */
export const E2E_INSTALL_PATH = "/srv/viewlba-e2e"
