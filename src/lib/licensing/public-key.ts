/**
 * ViewLBA — Claves públicas de PRODUCCIÓN del sistema de licencias v2.
 *
 * ⚠ Estas son las ÚNICAS claves que viven en el producto (servidor):
 *   · PRODUCTION_LICENSE_PUBLIC_KEY  (Ed25519) — verifica tokens VLBA2.
 *   · PRODUCTION_REQUEST_PUBLIC_KEY  (X25519)  — sella códigos VLREQ2.
 *
 *   Las claves PRIVADAS correspondientes NO están (ni estarán) en este
 *   repositorio, bundle, instalador ni TV: viven SOLO en la app generadora
 *   Android del administrador (android-license-generator), protegidas por
 *   Android Keystore, y en su backup cifrado .vlbak (ver docs/LICENSE-SECURITY.md).
 *
 * Formato: base64url de los 32 bytes crudos.
 * Rotación: generar nuevo par en la app Android, configurar los env
 *   VIEWLBA_LICENSE_PUBLIC_KEY / VIEWLBA_REQUEST_PUBLIC_KEY (o actualizar
 *   estas constantes) y publicar release.
 */
export const PRODUCTION_LICENSE_PUBLIC_KEY = "Nq53Ljgl6w_8-GUnj0Qdlo8KlBbsYvPfn4u6h82puTE"

export const PRODUCTION_REQUEST_PUBLIC_KEY = "sESV8qtIhA-RIvjn8Pyqt-UsBm3P--LgQygcb3tsRjw"
