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

| APK | SHA-256 | Origen | Verificación externa |
|---|---|---|---|
| **`ViewLBA-License-Generator-v3.0.0.apk` (RELEASE FINAL)** | **`1d7649d272ca0a444f7f0b5f7aacc3861ea0febca8de96ead23a30435db13dac`** | GitHub Release v3.0.0 (job build-android del tag) | descargado de GitHub y re-verificado: hash ✓ + apksigner v1/v2/v3 + zipalign + badging |
| `ViewLBA-License-Generator-v3.0.0-rc.1.apk` | `8df32875fee19b7702506f6a6e5e1e8735864db0fd1c72e9100a2759aa27289f` | GitHub Release rc.1 | idéntica verificación externa |

**Reproducibilidad observada**: el hash del APK del release final es
IDÉNTICO al artifact de CI construido sobre commits distintos (solo diffs
de docs/workflows) — el pipeline produce el mismo binario (no bit-flaky).
El hash AUTORITATIVO es el publicado por el propio release con su
`LicenseGenerator-SHA256SUMS.txt`.

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

Descarga EXACTA desde el GitHub Release `v3.0.0-rc.1` (todos los assets) y
verificación FUERA del pipeline (`scripts/verify-release-assets.sh`):

| Asset | SHA-256 (recomputado == release) | Verificación binaria |
|---|---|---|
| ViewLBA-License-Generator-v3.0.0-rc.1.apk | `8df32875…7289f` ✓ | apksigner v1+v2+v3 true, cert f7f02e5f…, zipalign PASS, badging `com.viewlba.licensegen`/3/`3.0.0-rc.1`/26/35 |
| ViewLBA-Server-3.0.0-rc.1-x86_64.deb | `c76335bd…2fc532` ✓ | dpkg-deb --info/--contents: paquete Debian 2.0 con el payload del servidor (9.657 entradas resources/server) |
| ViewLBA-Server-Setup-3.0.0-rc.1.exe | `6c453213492…` ✓ | cabecera PE (MZ) válida, 296 MB |
| ViewLBA-Server-CLI-3.0.0-rc.1-x86_64.AppImage | `d946d96d…35c92f` ✓ | ELF válido + ejecutable |
| ViewLBA-Server-3.0.0-rc.1-x86_64.AppImage | `bfb921a1…4369a` ✓ | (GUI opcional) |

**Hallazgo corregido durante el RC (FASE 24 funcionando)**: el
`SHA256SUMS.txt` consolidado del rc.1 quedó con rutas internas de artifacts
(sed que nunca matcheaba) → imposible `sha256sum -c` tras descargar.
CORREGIDO en el job release (nombres base con awk, PR #5): rc.2+ lleva
sums verificables directamente. Los hashes del rc.1 se verificaron por
mapeo de nombre (todos coinciden).

## 9. Emulador (FASE 7/24 — instalación real)

- **Local (sandbox de auditoría)**: **NOT VERIFIED** — sin KVM (`/dev/kvm`
  ausente) y con chequeo fijo de ~7.4 GB para userdata del emulador
  (disco insuficiente). Documentado, no simulado.
- **CI — INSTALACIÓN REAL VERIFICADA** (workflow `android-emulator-smoke.yml`,
  API 35, google_apis, x86_64, KVM, run 34639244657 sobre el commit final
  `4f0898c`):
  - `adb install -r ViewLBA-License-Generator-v3.0.0.apk` → **Success**
  - `pm list packages` → `package:com.viewlba.licensegen` ✓
  - `am start -n com.viewlba.licensegen/.ui.MainActivity` → **Starting: Intent{…}** ✓
  - `dumpsys activity` → **`topResumedActivity=ActivityRecord{… com.viewlba.licensegen/.ui.MainActivity}`** (la app está ARRIBA y viva) ✓
  - Screenshot capturado y subido como artifact `viewlba-emulator-evidence`
    (verificado visualmente: pantalla «Configura tu PIN de acceso» — primer
    uso de la app, UI en español, sin crash)
  - logcat: **sin FATAL EXCEPTION** ✓
  - `adb uninstall` → Success ✓

  Nota: en los LOGS de CI el nombre del package aparece como
  `com.***.licensegen` — GitHub enmascara la subcadena «viewlba» (el alias
  de firma es `viewlba`); es cosmético, la verificación es real.

  Iteraciones necesarias (evidencia honesta): rc.1 falló por disco del
  runner (userdata 7.4 GB) → fix de liberación de disco; rc.2 booteó (67 s)
  pero el script murió en `set -o pipefail` (dash) → POSIX; rc.3 evidenció
  que la action ejecuta el script LÍNEA A LÍNEA (variables no persisten) →
  script autocontenido; run final: SUCCESS completo.

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
- [x] checksums valid (recomputados fuera del pipeline; rc.1 por mapeo
      de nombre — bug de rutas corregido, rc.2+ verificable con -c)
- [x] docs updated (CHANGELOG/README/RELEASE/LICENSE-*/PRODUCTION_READINESS)
- [x] instalación REAL en emulador (CI, API 35): install → launch →
      topResumedActivity → screenshot → sin FATAL → uninstall (§9)
- [ ] instalación en DISPOSITIVO físico Android — **NOT VERIFIED** (no hay
      hardware en este entorno; procedimiento: descargar el APK del release,
      verificar SHA-256, `adb install -r`)

## 11. Limitaciones y NOT VERIFIED (honestidad de la auditoría)

1. **Dispositivo Android físico**: no disponible en este entorno. La
   instalación se validó a nivel binario (firma/esquemas/alineación/badging)
   **y en emulador REAL API 35 en CI** (§9: install/launch/top-activity/
   screenshot/uninstall). El APK firmado con v2+v3 y minSdk 26 es instalable
   por construcción; cualquier incidencia real debe reportarse contra el
   cert `f7f02e5f…`.
2. **Emulador local del sandbox**: sin KVM (documentado en §9).
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

- Merge a `main` del sistema 3.0.0: `472adc2` (PR #4, CI verde en rama y main).
- Fixes de pipeline durante el RC (PR #5 `f6b01f7`, PR #6 `c6cda27` +
  `4f0898c`): disco del runner para el emulador, SHA256SUMS con nombres
  base, script del emulador POSIX/autocontenido — todos con CI verde.
- Tags RC: `v3.0.0-rc.1` y `v3.0.0-rc.2` (prereleases con 11 assets cada uno,
  incluido APK firmado + checksums + evidencia).
- **Tag final: `v3.0.0`** sobre `0347566` (= `/VERSION`, gate verificado;
  CI verde en el commit del tag).
- **GitHub Release 3.0.0 PUBLICADO y verificado externamente**:
  https://github.com/Lean031110/Pantalla_Restaurante/releases/tag/v3.0.0
  - `ViewLBA-License-Generator-v3.0.0.apk` — SHA-256
    `1d7649d272ca0a444f7f0b5f7aacc3861ea0febca8de96ead23a30435db13dac`,
    firmado v1+v2+v3, cert `f7f02e5f…`
  - `ViewLBA-Server-Setup-v3.0.0.exe` —
    `de3218549f05e838c24e2dc140eefe0c52fd47e6b03219b1bcb36ecd0cef8d6f`
  - `ViewLBA-Server-v3.0.0-x86_64.deb` —
    `8d55e6b20804bc2924d6478959afa102eae79b6e560e1448d9c1b5784a49118f`
  - `ViewLBA-Server-3.0.0-x86_64.AppImage` —
    `a957717ce406d08c5845bfcaac8226d9da23c26414a843bc9f52977db8be2c25`
  - `ViewLBA-Server-CLI-v3.0.0-x86_64.AppImage` —
    `c7ffa3f26177e2456b6d6c068342390a82d772e16eccb69069b66a3ce3a71029`
  - `SHA256SUMS.txt` (nombres base — `sha256sum -c` funciona tras descargar,
    verificado) + `LicenseGenerator-SHA256SUMS.txt` +
    `LicenseGenerator-VERIFY.txt` (evidencia apksigner/badging/unzip) +
    manifiestos linux/windows.
- Emulator smoke sobre el tag final: **SUCCESS** (run 34640562770 —
  install → launch → topResumedActivity → screenshot → sin FATAL →
  uninstall del APK v3.0.0).
- Todos los jobs del tag v3.0.0: build-android ✓ · build-linux ✓ ·
  build-windows ✓ · release ✓ · emulator-smoke ✓.

---

## 13. Conclusión

**ViewLBA 3.0.0 está PUBLICADA como release de producción con evidencia
verificable de extremo a extremo**: build → sign (apksigner v1+v2+v3,
cert de producción) → verify (verify/zipalign/badging/unzip) → release
(conjunto completo de instaladores + APK + checksums + evidencia) →
verificación externa (descarga desde GitHub, hashes re-computados) →
instalación REAL en emulador API 35 (install → launch → top activity →
screenshot → sin FATAL → uninstall).

Quedan **NOT VERIFIED** (sin hardware en el entorno de auditoría, documentado
en §11): dispositivo Android físico, systemd sobre hardware Linux y Windows
real — cada uno con su procedimiento de verificación listo para ejecutar
in situ. Nada de lo anterior impide la distribución: el binario publicado
está íntegro, firmado y verificado.
