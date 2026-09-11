/**
 * E2E fixtures — pares de claves DUMMY para el sistema de licencias v2.
 *
 * ⚠⚠ ESTAS CLAVES PRIVADAS SON FIXTURES DE TEST, NO SON SECRETOS REALES ⚠⚠
 *  · Solo firman/abren contra VIEWLBA_LICENSE_PUBLIC_KEY y
 *    VIEWLBA_REQUEST_PUBLIC_KEY de los entornos E2E/CI (que se fijan a las
 *    claves públicas DUMMY de este archivo).
 *  · Las claves públicas de PRODUCCIÓN (src/lib/licensing/public-key.ts) son
 *    DISTINTAS → tokens firmados aquí NUNCA pasarán validación en el
 *    producto real.
 *  · Ningún valor de producción (clientes, claves reales) aparece aquí.
 */
export const E2E_LICENSE_PUBLIC_KEY = "GDEuTLCbpriQyXbECGbffdgTa52f-YHPjp-lVhvjxd0"
export const E2E_LICENSE_PRIVATE_KEY = "JBFSwaQlHUUSK2TaynCVSfzMUD7qENFOXCPSjlKGgsQ"

/** Par X25519 DUMMY: el "emisor Android" de E2E abre los códigos VLREQ2. */
export const E2E_REQUEST_PUBLIC_KEY = "qWlCO6xJt2e_AZjNxDZ2olv_DiJBNuLHNBGSLm87pjE"
export const E2E_REQUEST_PRIVATE_KEY = "l8JtCDu6UfduLjXZHJh2ax6v8ulxR5g2qt42osgecIk"

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
