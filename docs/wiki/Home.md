# Wiki de ViewLBA — Sistema de Licencias

Bienvenido a la wiki interna de **ViewLBA Server** (repo `Lean031110/Pantalla_Restaurante`). Esta wiki documenta **cómo funciona el sistema de licenciamiento 100% offline**, cómo se generan las claves y las licencias, y todo lo que hay que hacer para operar el repositorio (secrets, workflows, releases).

> **Estado actual (v1.2.1 · 2026-09-11):** sistema de licencias operativo · clave de producción rotada · secret `VIEWLBA_LICENSE_PRIVATE_KEY` creado y verificado · CI verde · release v1.2.1 publicada.

## Índice

| # | Página | Qué contiene |
|---|---|---|
| 1 | [Sistema-de-Licencias](Sistema-de-Licencias.md) | Arquitectura general, estados, flujo end-to-end |
| 2 | [Claves-Ed25519](Claves-Ed25519.md) | **Cómo se generan las claves** (par Ed25519), formatos, dónde vive cada clave |
| 3 | [Secret-de-GitHub-Actions](Secret-de-GitHub-Actions.md) | `VIEWLBA_LICENSE_PRIVATE_KEY`: qué es, cómo se creó, cómo verificarlo y rotarlo |
| 4 | [Emisión-de-Licencias](Emisión-de-Licencias.md) | Las 3 vías de emisión: CLI, GitHub Actions y demo web — paso a paso |
| 5 | [Planes-y-Precios](Planes-y-Precios.md) | Trial 7 días · Mensual 30 días/USD 10 · Anual 365 días/USD 100 |
| 6 | [Binding-Hardware-y-Disco](Binding-Hardware-y-Disco.md) | Installation ID (`VWLB-…`), Disk ID (`DSK-…`), fingerprint |
| 7 | [Trial-de-7-días](Trial-de-7-días.md) | Mecánica, anclas duales, anti-manipulación de reloj |
| 8 | [Importación-de-Licencia](Importación-de-Licencia.md) | Flujo del cliente (ZIP), validaciones y errores |
| 9 | [Seguridad](Seguridad.md) | Dónde NO está la clave privada, matriz de ataques y mitigaciones |
| 10 | [Mantenimiento-y-Rotación](Mantenimiento-y-Rotación.md) | Rotación de claves, checklist de release, troubleshooting |

## Datos de operación rápida

- **Contacto comercial / soporte:** **52973387** (aparece en la marca de agua de la TV y en la UI de licencias).
- **Workflow de emisión:** GitHub → pestaña **Actions** → **License Generator** → *Run workflow* (ver [Emisión-de-Licencias](Emisión-de-Licencias.md)).
- **Instaladores oficiales:** GitHub → **Releases** → `ViewLBA-Server-v1.2.1` (`.exe` Windows, `.deb`/AppImage Linux, `SHA256SUMS.txt`).
- **Manual del generador CLI:** [`docs/LICENSE-GENERATOR.md`](https://github.com/Lean031110/Pantalla_Restaurante/blob/main/docs/LICENSE-GENERATOR.md) · Modelo de seguridad: [`docs/LICENSE-SECURITY.md`](https://github.com/Lean031110/Pantalla_Restaurante/blob/main/docs/LICENSE-SECURITY.md) · Sistema completo: [`docs/LICENSE-SYSTEM.md`](https://github.com/Lean031110/Pantalla_Restaurante/blob/main/docs/LICENSE-SYSTEM.md)

## Reglas de oro (resumen)

1. La **clave privada** de firma NUNCA se commitea, no se imprime en logs, no viaja al cliente y no se sube a la wiki. Vive en: el secret de GitHub Actions + la copia custodiada por el dueño (fuera de banda).
2. Cada licencia se emite para **una** instalación concreta (equipo + disco).
3. Renovar = **licencia nueva** (nunca se "extiende" la anterior).
4. Ante cambio de disco/equipo del cliente: emitir licencia nueva.
5. **"Código implementado" ≠ "producción verificada"**: todo cambio pasa CI (tests + gitleaks) antes de merge.
