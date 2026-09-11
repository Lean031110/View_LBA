# Wiki de ViewLBA — Sistema de Licencias

Bienvenido a la wiki interna de **ViewLBA Server** (repo `Lean031110/Pantalla_Restaurante`). Esta wiki documenta el **sistema de licencias v2 por token copiar/pegar** (100% offline): cómo el cliente solicita y activa, cómo el administrador emite desde la app Android, y cómo se operan claves, backups y releases.

> **Estado actual (v2.0.0 · 2026-09-11):** flujo copiar/pegar operativo (VLREQ2/VLBA2) · app Android del emisor (android-license-generator) · CI Android con APK firmado como artifact · claves de producción nuevas (públicas en el repo, privadas SOLO en el teléfono del administrador) · CI verde.

## Índice

| # | Página | Qué contiene |
|---|---|---|
| 1 | [Sistema-de-Licencias](Sistema-de-Licencias.md) | Arquitectura general, estados, flujo end-to-end |
| 2 | [Claves-Ed25519](Claves-Ed25519.md) | **Cómo se generan las claves** (Ed25519 firma + X25519 solicitudes), formatos, dónde vive cada clave |
| 3 | [Secret-de-GitHub-Actions](Secret-de-GitHub-Actions.md) | Secrets de firma del APK Android: qué son, cómo crearlos y rotarlos |
| 4 | [Emisión-de-Licencias](Emisión-de-Licencias.md) | Emisión desde la **app Android** (única vía) — paso a paso |
| 5 | [Planes-y-Precios](Planes-y-Precios.md) | Trial 7 días · Mensual 30 días/USD 10 · Anual 365 días/USD 100 |
| 6 | [Binding-Hardware-y-Disco](Binding-Hardware-y-Disco.md) | Installation ID (`VWLB-…`), Disk ID (`DSK-…`), fingerprint |
| 7 | [Trial-de-7-días](Trial-de-7-días.md) | Mecánica, anclas duales, anti-manipulación de reloj |
| 8 | [Importación-de-Licencia](Importación-de-Licencia.md) | Flujo del cliente (copiar código → pegar token → activar), validaciones y errores |
| 9 | [Seguridad](Seguridad.md) | Dónde NO está la clave privada, matriz de ataques y mitigaciones |
| 10 | [Mantenimiento-y-Rotación](Mantenimiento-y-Rotación.md) | Rotación de claves, checklist de release, troubleshooting |

## Datos de operación rápida

- **Contacto comercial / soporte:** **52973387** (aparece en la marca de agua de la TV y en la UI de licencias).
- **Emisión:** app Android **ViewLBA Licencias** (APK del artifact de Actions "Android License Generator"; ver [Emisión-de-Licencias](Emisión-de-Licencias.md)).
- **Instaladores oficiales:** GitHub → **Releases** → `ViewLBA-Server-v1.2.1` (`.exe` Windows, `.deb`/AppImage Linux, `SHA256SUMS.txt`).
- **Manual del generador CLI:** [`docs/LICENSE-GENERATOR.md`](https://github.com/Lean031110/Pantalla_Restaurante/blob/main/docs/LICENSE-GENERATOR.md) · Modelo de seguridad: [`docs/LICENSE-SECURITY.md`](https://github.com/Lean031110/Pantalla_Restaurante/blob/main/docs/LICENSE-SECURITY.md) · Sistema completo: [`docs/LICENSE-SYSTEM.md`](https://github.com/Lean031110/Pantalla_Restaurante/blob/main/docs/LICENSE-SYSTEM.md)

## Reglas de oro (resumen)

1. Las **claves privadas** (Ed25519 firma + X25519 solicitudes) NUNCA se commitean, no se imprimen en logs, no viajan al cliente y no se suben a la wiki. Viven SOLO en la app Android del administrador (DB cifrada) + su backup `.vlbak` con contraseña.
2. Cada licencia se emite para **una** instalación concreta (equipo + disco).
3. Renovar = **licencia nueva** (nunca se "extiende" la anterior).
4. Ante cambio de disco/equipo del cliente: emitir licencia nueva.
5. **"Código implementado" ≠ "producción verificada"**: todo cambio pasa CI (tests + gitleaks) antes de merge.
