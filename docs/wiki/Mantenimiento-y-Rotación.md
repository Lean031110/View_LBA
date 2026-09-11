# Mantenimiento y Rotación (v2)

## Rotación de claves de licencias (Ed25519 + X25519)

> Impacto: los tokens emitidos con las claves anteriores dejan de validar
> hasta actualizar el servidor. Hazla solo cuando sea necesaria.

1. **Backup previo**: app Android → Backup → Crear `.vlbak` (con las
   claves actuales) y guárdalo fuera del teléfono.
2. App Android → **Ajustes → «Generar claves nuevas»** (confirma el aviso).
3. **Copia las DOS públicas** nuevas (Ajustes las muestra).
4. **Servidor**: fija en `.env` `VIEWLBA_LICENSE_PUBLIC_KEY` y
   `VIEWLBA_REQUEST_PUBLIC_KEY` (o actualiza `public-key.ts` para un
   release firmado) y **reinicia** el servicio.
5. Verifica: un cliente nuevo genera código de solicitud → valida →
   genera token → activa.
6. **Re-emitir** (renovar) licencias a los clientes activos (el Historial
   de la app te dice quiénes son).
7. Crea un **backup nuevo** con las claves nuevas.

## Checklist de release (v2)

- [ ] `bun install --frozen-lockfile && bun run lint && bun run typecheck
      && bun test` — todo PASS.
- [ ] `bun run build` standalone PASS.
- [ ] CI verde en GitHub (quality · integration · e2e · security ·
      android-license-generator).
- [ ] APK del generador firmado (secrets `VIEWLBA_KEYSTORE_*`) + checksum.
- [ ] gitleaks limpio; artifact del APK sin material de claves.
- [ ] Versiones: `package.json` (servidor) y `app/build.gradle.kts`
      (generador) actualizadas + `CHANGELOG.md`.
- [ ] Tag `vX.Y.Z` + GitHub Release con instaladores, APK y `SHA256SUMS.txt`.
- [ ] Wiki y `docs/LICENSE-*.md` sincronizados.

## Troubleshooting

| Síntoma | Causa probable | Acción |
|---|---|---|
| Cliente activa → «NO corresponde a este equipo» | Token emitido para otra instalación (o cambió disco/equipo) | Re-emitir para SU instalación |
| Cliente activa → «no fue emitido por ViewLBA o fue modificado» | Token alterado/truncado o claves rotadas | Re-emitir token |
| App Android: «el código no se puede abrir» | Código de otro emisor o claves cambiadas | Verifica las claves X25519 |
| Código VLREQ2 «expiró» | Más de 15 días desde la solicitud | Que el cliente genere uno nuevo |
| APK sin firmar en CI | Faltan secrets `VIEWLBA_KEYSTORE_*` | Crear los 4 secrets (ver wiki) |

## Inventario operativo (v2.0.0)

- **Secrets de GitHub**: 4 de firma del APK (`VIEWLBA_KEYSTORE_BASE64`,
  `VIEWLBA_KEYSTORE_PASSWORD`, `VIEWLBA_KEY_ALIAS`,
  `VIEWLBA_KEY_PASSWORD`). `GITHUB_TOKEN` automático. Las claves PRIVADAS
  de licencias NO son secrets (viven en el teléfono del admin).
- **Workflows activos**: `ci.yml` (quality+integration+e2e+security),
  `android-license-generator.yml` (APK del generador),
  `release-installer.yml` (build+release en tag `v*`).
- **Documentación que debe permanecer sincronizada**:
  `docs/LICENSE-SYSTEM.md`, `LICENSE-GENERATOR.md`, `LICENSE-SECURITY.md`,
  `RELEASE.md`, `PRODUCTION_READINESS.md`, `CHANGELOG.md`, esta wiki y
  `android-license-generator/README.md`.
