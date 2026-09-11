/**
 * ViewLBA — Clave pública Ed25519 de PRODUCCIÓN del sistema de licencias.
 *
 * ⚠ Esta es la ÚNICA clave que vive en el producto. La clave PRIVADA
 *   correspondiente NO está (ni estará) en este repositorio, bundle,
 *   instalador ni TV: solo la posee el emisor de licencias (ver
 *   docs/LICENSE-GENERATOR.md).
 *
 * Formato: base64url de los 32 bytes crudos de la clave pública Ed25519.
 * Rotación: generar nuevo par, actualizar esta constante, publicar release.
 * La clave privada se entrega al dueño fuera de banda (nunca por git).
 */
export const PRODUCTION_LICENSE_PUBLIC_KEY = "ZT_iNNFWeV0ambnm03NjqCuABG5IRMK-Ez37QtbGhEg"
