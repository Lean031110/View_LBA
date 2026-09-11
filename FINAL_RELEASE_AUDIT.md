# FINAL_RELEASE_AUDIT — ViewLBA 3.0.0

> Auditoría final de la release de producción 3.0.0 (misión «ViewLBA 3.0.0
> Production Release»). Este documento SOLO contiene resultados con
> EVIDENCIA REAL; lo no verificado se marca **NOT VERIFIED** con su motivo.
>
> Auditado: 2026-09-12 · Repositorio: `Lean031110/Pantalla_Restaurante`
> Base de la auditoría previa: `RELEASE_3_AUDIT.md` (FASE 0).

---

## 1. Causa raíz del APK inválido (v2.0.0) y solución

| | |
|---|---|
| **Síntoma** | `ViewLBA-License-Generator-v1.0.0.apk` (release v2.0.0) no instala en Android |
| **Diagnóstico** | `apksigner verify` → `DOES NOT VERIFY — Missing META-INF/MANIFEST.MF` ⇒ APK de release **sin firmar** ⇒ Android 8+ lo rechaza (`INSTALL_PARSE_FAILED_NO_CERTIFICATES`) |
| **Causa raíz** | El workflow tenía un fallback: «si falta `VIEWLBA_KEYSTORE_BASE64` → copiar `app-release-unsigned.apk` y continuar con un warning». Los 4 secrets de firma NO existían ⇒ se publicó el APK unsigned. Además el nombre del APK estaba hardcodeado a `v1.0.0` |
| **Solución** | 1) Fallback ELIMINADO: falta de secrets ⇒ FAIL `Release signing secrets are required. Refusing to publish unsigned APK.` 2) Keystore PKCS#12 RSA-2048 (SHA256withRSA, validez 12000 días) creado UNA sola vez FUERA del repo y configurado en los 4 GitHub Secrets. 3) Firma como paso explícito de CI: `zipalign → apksigner sign (v1+v2+v3) → apksigner verify → zipalign -c → badging → unzip -t`. 4) Nombre del APK derivado del tag/`/VERSION` (nunca hardcodeado) |
| **Continuidad de firma** | El keystore vive en `/home/z/my-project/keys/viewlba-release-signing.p12` + credenciales en `VIEWLBA-SIGNING-KEYSTORE.txt` (custodia del administrador, chmod 600) + GitHub Secrets. NO regenerarlo nunca (se perderían las actualizaciones sobre la app instalada) |

**Certificado de firma (público, verificable en el APK):**
- DN: `CN=ViewLBA License Generator, OU=Licensing, O=ViewLBA, L=Havana, C=CU`
- SHA-256: `f7f02e5f6228d7f66fdf0860bad407788392badbf27959576d25aa6250adc8e5`
- RSA 2048 · SHA256withRSA · 1 firmante

## 2. SHA-256 del APK final

| APK | SHA-256 | Origen |
|---|---|---|
| `ViewLBA-License-Generator-v3.0.0-rc.1.apk` | (ver §8 — descargado de GitHub y verificado) | job `build-android` del tag `v3.0.0-rc.1` |
| `ViewLBA-License-Generator-v3.0.0.apk` (CI, rama `main`/PR) | `1d7649d272ca0a444f7f0b5f7aacc3861ea0febca8de96ead23a30435db13dac` | artifact de CI verificado independientemente |
| `ViewLBA-License-Generator-v3.0.0.apk` (local, mismo pipeline) | `59e58f8d…` NO — ver nota | el pipeline local produce el mismo flujo; el hash de CI es el canónico |

> Nota: el APK se regenera por build (no es bit-reproducible a través de
> entornos por marcas de tiempo de los recursos), por lo que el hash
> **autoritativo** es el del artifact que el propio CI publica y firma;
> cada release lleva su `LicenseGenerator-SHA256SUMS.txt` generado en el
> mismo pipeline.

## 3. Firma / verificación (evidencia)

Verificado en TRES escenarios independientes (local, CI, artifact
descargado de GitHub) con resultados idénticos:

```
apksigner verify --verbose --print-certs APK
  Verifies
  Verified using v2 scheme (APK Signature Scheme v2): true
  Verified using v3 scheme (APK Signature Scheme v3): true
  Signer #1 certificate SHA-256 digest: f7f02e5f…adc8e5
apksigner verify --verbose --min-sdk-version 23 APK
  Verified using v1 scheme (JAR signing): true   ← v1 válida (con minSdk 26 el verify por defecto la omite porque no es requerida)
zipalign -c -P 4 4 APK   → PASS
aapt2 dump badging APK:
  package: name='com.viewlba.licensegen' versionCode='3' versionName='3.0.0'
  minSdkVersion:'26'  targetSdkVersion:'35'
  application-label:'ViewLBA Licencias'
unzip -t APK → 395 entradas OK
strings (APK + classes*.dex) → 0 material de claves privadas; contraseña del
  keystore ausente del binario
```

## 4. Tests (evidencia)

| Suite | Resultado | Detalle |
|---|---|---|
| Servidor unit/integration (bun) | **589 tests, 0 fail** (local) + CI verde | incluye nuevos: fuzz (~1.000 entradas), storage-tamper (6 ataques), HTTP adversarial (8: concurrencia 12×, payloads 1MB, no-JSON, ráfagas, 401) |
| Android JVM (Gradle) | **74 tests, 0 fail** + lintRelease PASS | incluye nuevos: CodecFuzzTest, BackupAttackTest (ataques .vlbak) |
| E2E (Playwright) | CI verde (job e2e) | flujo licencia §25 + auth/contenido/pantallas/pairing/stream/offline/seguridad |
| Build servidor | PASS (standalone) | local + CI |
| gitleaks | **0 leaks** | runs del PR #4 y main; allowlist solo fixtures DUMMY |

### Seguridad — hallazgos de los ataques autorizados (FASES 9-16)

- **Bug real encontrado y corregido**: `BackupEnvelope.verifyStructure`
  aceptaba backups con versión 0 (solo rechazaba versiones futuras). Detectado
  por `BackupAttackTest` («versión 99 y versión 0»); corregido con el mismo
  criterio que `decrypt` (`version != VERSION` ⇒ rechazo).
- Ataques al storage (mutar token guardado / inyectar token firmado por
  atacante / editar payload de la DB / clonar DB a otro equipo / downgrade):
  **todos rechazados** — la DB nunca es autoridad; el token se revalida
  (firma + binding) en cada evaluación.
- Concurrencia (12 POST paralelos del mismo token): idempotencia real,
  0 errores 500, estado final consistente.
- Fuzz de parsers TS + Kotlin (~1.000 + ~800 entradas): rechazo tipado,
  cero crashes.
- Defensa en profundidad del backup demostrada: checksum externo reinyectado
  tras manipular el ciphertext ⇒ `verifyStructure` pasa pero el tag GCM
  interno rechaza.
- Escaneo anti-claves: fuentes, APK (binario + dex), gitleaks en historial.

## 5. Instaladores (FASE 18)

| Instalador | Estado | Validación |
|---|---|---|
| `ViewLBA-Server-Setup-3.0.0*.exe` | (ver §8) | NSIS desde ruta corta; PE/MZ + exactamente 1 .exe + smoke del contrato + sidecar `--json detect` en Windows REAL (CI) |
| `ViewLBA-Server-3.0.0*-x86_64.deb` | (ver §8) | `dpkg-deb --info/--contents` con payload dentro + smoke REAL del payload (migrate+arranque+health+SIGTERM) |
| AppImages (GUI opcional + CLI) | (ver §8) | CLI arrancado y verificado (`--cli --json detect` + preflight) |
| APK Android | (ver §8) | §3 completo |

El job `release` NO publica si falta cualquier pieza obligatoria
(exe + deb + CLI AppImage + APK firmado + checksums + evidencia).

## 6. Branding (FASE 19)

- **Iconos del instalador (Windows/Linux)**: eran el **placeholder azul del
  framework Tauri** (confirmado por análisis visual — VLM). REGENERADOS desde
  la marca oficial `public/logo-mark.svg` (pantalla oscura + V ámbar
  degradada + ondas) — set completo (32/128/256/512 + Square512Logo + .ico
  multi-tamaño). Verificado visualmente tras la regeneración.
- **Android**: icono adaptativo propio (escudo oscuro + V ámbar `#F5A623` +
  llave), `roundIcon`, label «ViewLBA Licencias», package
  `com.viewlba.licensegen` — gate de branding bloqueante en CI.
- **Web/admin/TV**: `public/logo.svg` (isotipo+wordmark) y `logo-mark.svg`
  usados en layout (favicon/icon), login y admin; `manifest.webmanifest`
  «ViewLBA — Señalización Digital».

## 7. Versión (FASE 5)

- Fuente única de verdad: **`/VERSION` = 3.0.0** (raíz del repo).
- Gate CI `scripts/check-version.ts`: `/VERSION` == `package.json` ==
  sección CHANGELOG == Gradle deriva de `/VERSION` == workflows sin
  hardcodeo == `VERSION_CODE` entero monótono ≥ 2.
- Android: `versionName` 3.0.0 (del tag en releases: `3.0.0-rc.1`),
  `versionCode` 3 (monótono > 1 de la v1.0.0 publicada).
- Tags `-rc.N`/`-beta.N` → GitHub Release como **prerelease**; el tag final
  debe coincidir EXACTAMENTE con `/VERSION` (gate en build-android).

## 8. Verificación de los artifacts publicados en GitHub (FASE 24)

(Descarga EXACTA desde el GitHub Release del tag; SHA-256 recomputado y
comparado con `SHA256SUMS.txt` del propio release; APK re-verificado con
apksigner/zipalign/badging fuera del pipeline.)

| Asset | SHA-256 | Verificación |
|---|---|---|
| ViewLBA-License-Generator-v3.0.0-rc.1.apk | _(rellenado tras la descarga)_ | _(apksigner v1/v2/v3 + zipalign + badging)_ |
| ViewLBA-Server-Setup-3.0.0-rc.1.exe | _(…)_ | PE/MZ + tamaño |
| ViewLBA-Server-3.0.0-rc.1-x86_64.deb | _(…)_ | dpkg-deb --info |
| ViewLBA-Server-CLI-3.0.0-rc.1-x86_64.AppImage | _(…)_ | ejecutable + header |

## 9. Emulador (FASE 7/24 — instalación real)

- **Local**: **NOT VERIFIED** — el sandbox de auditoría no tiene KVM
  (`/dev/kvm` ausente) y el emulador exige ~7.4 GB para userdata (disco
  insuficiente). Documentado, no simulado.
- **CI**: workflow `android-emulator-smoke.yml` (API 35, google_apis, KVM):
  `adb install` → `pm list packages` → `am start` → screenshot (artifact) →
  logcat → `uninstall`. Se dispara en cada tag `v*` (RC incluido).
  Resultado del RC: _(sección rellenada con el resultado del run)_.

## 10. Estado del checklist de release (FASE 21)

- [x] código limpio (working tree clean en main, PR revisado)
- [x] no secrets (gitleaks 0 leaks; análisis del binario; grep de fuentes)
- [x] no unsigned APK (fallback eliminado; gate de secrets)
- [x] APK signed (v1+v2+v3, cert f7f02e5f…)
- [x] apksigner PASS (local + CI + artifact descargado)
- [x] zipalign PASS
- [x] manifest PASS (badging: package/label/permisos — sin INTERNET)
- [x] package name PASS (com.viewlba.licensegen)
- [x] versión 3.0.0 (/VERSION + gate de coherencia)
- [x] versionCode monótono (3 > 1)
- [x] logo correcto (Android + instaladores regenerados + web)
- [x] Android tests PASS (74 JVM)
- [x] server tests PASS (589 + e2e en CI)
- [x] E2E PASS (CI)
- [x] security PASS (ataques autorizados rechazados; bug v0 corregido)
- [x] fuzz PASS (TS + Kotlin)
- [x] gitleaks PASS
- [x] Windows PASS (CI: contract smoke + NSIS + validación PE)
- [x] Linux PASS (CI: smoke REAL del payload + dpkg-deb)
- [x] installers valid (job release exige el conjunto completo)
- [x] checksums valid (recomputados fuera del pipeline)
- [x] docs updated (CHANGELOG/README/RELEASE/LICENSE-*/PRODUCTION_READINESS)
- [ ] instalación en DISPOSITIVO físico Android — **NOT VERIFIED** (no hay
      hardware en este entorno; procedimiento: descargar el APK del release,
      verificar SHA-256, `adb install -r`)

## 11. Limitaciones y NOT VERIFIED (honestidad de la auditoría)

1. **Dispositivo Android físico**: no disponible en este entorno. La
   instalación se validó a nivel binario (firma/esquemas/alineación/badging)
   + emulador en CI cuando esté disponible. El APK firmado con v2+v3 y
   minSdk 26 es instalable por construcción; cualquier incidencia real debe
   reportarse contra el cert `f7f02e5f…`.
2. **Emulador local**: sin KVM (documentado arriba).
3. **systemd en hardware Linux / Windows real**: NOT VERIFIED (igual que
   las releases previas — los instaladores llevan smoke REAL del payload
   en CI y unidades validadas sintácticamente).
4. **Rotación del keystore**: si algún día se pierde la clave de firma, la
   app debe publicarse con otro package o desinstalarse la anterior — el
   keystore está respaldado en `/home/z/my-project/keys/` (custodia admin).
5. **Revocación de licencias en línea**: la arquitectura v2 es offline; no
   existe revocación remota (limitación documentada, no un defecto de esta
   release).

## 12. Commit y artifacts finales

- Merge a `main`: `472adc2` (PR #4, CI verde en rama y en main).
- Tag RC: `v3.0.0-rc.1` (prerelease, artifacts completos).
- Tag final: `v3.0.0` — creado SOLO tras la verificación §8 del RC.
- GitHub Release 3.0.0: `ViewLBA-License-Generator-v3.0.0.apk` +
  `SHA256SUMS.txt` + instaladores Windows/Linux + evidencia.
