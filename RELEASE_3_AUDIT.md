# RELEASE_3_AUDIT — Auditoría previa a ViewLBA 3.0.0

> FASE 0 de la misión «ViewLBA 3.0.0 Production Release».
> **Inspección sin modificaciones.** Todo lo aquí documentado se verificó
> contra el repositorio real (`main` = `b2647aa5`), la API de GitHub y el
> artifact publicado de la release v2.0.0.
>
> Fecha: 2026-09-12 · Auditor: agente de release · Estado: **BLOQUEADO para
> producción** (ver veredicto).

---

## 1. Veredicto ejecutivo

| Área | Estado | Detalle |
|---|---|---|
| APK publicado v2.0.0 | ❌ **NO INSTALA** | APK sin firmar (`apksigner verify` → `DOES NOT VERIFY — Missing META-INF/MANIFEST.MF`) |
| Firma en CI | ❌ **Roto por diseño** | Fallback «sin secrets → publica unsigned» + warning |
| Secrets de firma | ❌ **AUSENTES** | 0 de 4 (`VIEWLBA_KEYSTORE_*`) configurados |
| Versionado | ❌ **Caos** | 1.0.0 (Gradle+nombre APK) / 2.0.0 (package.json+CHANGELOG) / «v2.0+» (README) |
| CI servidor | ✅ SUCCESS | 4 jobs bloqueantes en `main` (quality/integration/e2e/security) |
| CI Android | ⚠️ SUCCESS «falso» | Verde aunque el artifact sea no-instalable; sin zipalign/apksigner/badging |
| Instaladores Linux/Windows | ✅ SUCCESS | `release-installer.yml` (v2.0.0) construyó .deb + AppImage + Setup.exe con guards |
| Licencias v2 (server) | ✅ Sólido | 588 bloques `test()` aprox. (licensing/integration/e2e) — cobertura adversarial amplia |
| Licencias v2 (Android) | ✅ Sólido | 57 tests JVM + vectores dorados TS↔Kotlin |
| Branding | ⚠️ Parcial | Icono Android = vector ViewLBA propio (OK); falta verificación sistemática de todos los recursos y PNGs de respaldo |

**Conclusión FASE 0:** el sistema de licencias v2 está sano y probado, pero el
**pipeline de publicación Android es defectuoso por construcción** (publica
APKs sin firmar con nombre de versión incorrecto) y faltan los 4 secrets de
firma. La release 3.0.0 NO puede salir hasta corregir FASES 1–7, 22.

---

## 2. Problemas (ordenados por severidad)

### P0 — Bloquean la instalación del APK

1. **APK sin firmar publicado en la release v2.0.0.**
   `ViewLBA-License-Generator-v1.0.0.apk` (22.7 MB, SHA-256
   `59e58f8d5f3a4cc442a96f75ded35a8cfd71fa98970aa559036264275859b031`):
   `apksigner verify` responde `DOES NOT VERIFY — Missing
   META-INF/MANIFEST.MF`. Un APK de release sin certificados es rechazado por
   Android 8+ con `INSTALL_PARSE_FAILED_NO_CERTIFICATES` → **causa raíz
   confirmada de «el APK no instala»**.
2. **Fallback a unsigned en el workflow** (`.github/workflows/
   android-license-generator.yml`, paso «Firmar APK», líneas 122–125):
   si `VIEWLBA_KEYSTORE_BASE64` falta, hace `cp app-release-unsigned.apk …`
   y **continúa con un warning**. Antipatrón de producción: publica
   deliberadamente un artifact inválido.
3. **Secrets de firma inexistentes.** La API de secrets del repo solo lista
   `VIEWLBA_LICENSE_PRIVATE_KEY` (huérfano, ver §7). **No existe** ninguno de:
   `VIEWLBA_KEYSTORE_BASE64`, `VIEWLBA_KEYSTORE_PASSWORD`,
   `VIEWLBA_KEY_ALIAS`, `VIEWLBA_KEY_PASSWORD`.

### P1 — Cadena de release incompleta

4. **Sin verificación criptográfica del APK en CI.** El workflow no ejecuta
   `apksigner verify` (v1/v2/v3), ni `zipalign -c`, ni `aapt2 dump badging`
   (package/versionName/versionCode/minSdk/targetSdk), ni `unzip -t`. Solo
   escanea strings de `classes.dex`.
5. **Sin zipalign.** La alineación de recursos no se aplica ni se comprueba.
6. **Firma por doble ensamblado Gradle.** El paso de firma re-ejecuta
   `assembleRelease` con env vars (ruta frágil) en lugar del flujo canónico
   unsigned → zipalign → `apksigner sign` → verify.
7. **El workflow Android no se dispara en tags `v*`.** En v2.0.0 el APK se
   subió a la GitHub Release **a mano** (sin validación del pipeline de
   release). `release-installer.yml` tampoco incluye el APK.
8. **Sin test de instalación real** (emulador/dispositivo físico). «Gradle
   terminó» no es «Android verificado».

### P2 — Versionado

9. **Tres versiones simultáneas**: Gradle `versionName = "1.0.0"` +
   `versionCode = 1`; `APK_NAME = ViewLBA-License-Generator-v1.0.0.apk`;
   `package.json` = 2.0.0; CHANGELOG = 2.0.0; README «v2.0+». El APK de la
   release v2.0.0 se llama **v1.0.0**. No existe fuente única de verdad ni
   gate que las sincronice.
10. **`versionCode` no es monótono gestionado** (sigue en 1 desde la primera
    publicación).

### P3 — Menores

11. El resumen del workflow imprime `Firmado: false` sin fallar (confuso).
12. `roundIcon` apunta al mismo adaptive icon (aceptable), pero no hay PNGs
    de respaldo para launchers legacy < API 26 (minSdk 26 → no aplica;
    documentar).

---

## 3. Errores confirmados (evidencia)

| # | Error | Evidencia |
|---|---|---|
| E1 | APK no instala | `apksigner verify` local contra el asset descargado de la release v2.0.0 (id 557572011): `DOES NOT VERIFY`, `Missing META-INF/MANIFEST.MF` |
| E2 | APK mal nombrado | Asset `ViewLBA-License-Generator-v1.0.0.apk` dentro de la release **v2.0.0** |
| E3 | CI «verde» con artifact inválido | Última run de «Android License Generator» en `main` (34616195595): `success` con warning de firma |
| E4 | CI «verde» sin firma configurada | El job terminó `success` precisamente porque el fallback evita fallar |
| E5 | Local `main` desfasado respecto a `origin/main` | `origin/main` = `b2647aa5` (merge #3); corregido en el clon de trabajo (no afecta al repo) |

---

## 4. Riesgos

| Riesgo | Impacto | Mitigación prevista |
|---|---|---|
| Crear keystore nuevo por build / rotación accidental | Se pierde la continuidad de actualización Android (la app no se actualizaría sobre la instalada) | Keystore creado **UNA sola vez, fuera del repo**, custodiado; CI solo consume secrets |
| Secrets de firma filtrados (logs/artifacts) | Suplantación de firma de la app | Nunca `echo`; borrar keystore temporal tras firmar; escanear artifacts |
| Publicar 3.0.0 con gates incompletos | Release no instalable (repetir v2.0.0) | FASE 21 checklist codificada como verificación de workflow + RC previo |
| `VIEWLBA_LICENSE_PRIVATE_KEY` huérfano | Clave privada v1 (ya rotada en 1.2.1, sin uso en workflows) permanece en Secrets | Eliminar tras confirmar cero referencias (FASE 12) |
| Emulador inestable en CI | «Android verified» declarado sin evidencia | Job separado opt-in (dispatch); la validación binaria (apksigner/zipalign/badging) es bloqueante; el smoke en emulador queda como evidencia extra, no sustituto |
| Sin gate de coherencia de versiones | Deriva 1.0.0/2.x/3.0.0 otra vez | Archivo `VERSION` + script de verificación en CI (FASE 5) |
| Firmar PRs con la clave de producción | Ninguno directo (firma ≠ secreto revelado), peroartifact de PR firmado podría redistribuirse | Aceptable: el APK público firmado es el producto; la clave nunca sale de Secrets |

---

## 5. Tests faltantes (gap analysis vs FASES 9/10/11/16)

**Cubiertos hoy (server):** token truncado/alterado/otra clave/futuro/
expirado/otro equipo/otro disco/plan-duration inválido/charset/prefijo/
versión futura/CRC, request sellado manipulado, replay idempotente,
downgrade, renovación, gating server-side, rutas viejas 404, watermark,
rate-limit básico, integración HTTP real, E2E de flujo completo.
**Cubiertos hoy (Android JVM):** códec/cripto/políticas/backup básico +
cross-compat TS↔Kotlin con vectores dorados.

**FALTAN:**

1. **Fuzz/property (FASE 10)** — parsers de request y token, Base32,
   canonical JSON, expiry: entradas vacías, enormes, truncadas, bytes
   aleatorios, unicode, NUL, claves duplicadas, campos extra/faltantes,
   números extremos (NaN/±Infinity/epoch desorbitado). Esperado: rechazo
   seguro, jamás crash/throw sin captura.
2. **Concurrencia (FASE 11)** — N POST paralelos de `/api/license/activate`
   con el MISMO token (idempotencia real) y con tokens distintos.
3. **Payloads adversos HTTP** — cuerpo >1 MB, multipart malformado,
   content-type incorrecto en activate/request-code.
4. **Ataque al almacenamiento (FASE 11)** — manipular el registro de licencia
   guardado (token sustituido/registro editado) → el estado debe revalidar la
   firma al leer, no confiar en la DB.
5. **Backup (FASE 16, Android)** — ampliar: truncado, alterado, contraseña
   incorrecta, versión futura, restauración parcial, registros falsos
   inyectados.
6. **Branding (FASE 8)** — test de recursos: iconos presentes, label =
   ViewLBA, package = `com.viewlba.licensegen`.
7. **Metadata (FASE 4)** — aserciones automáticas de badging en CI
   (versionName/versionCode/minSdk/targetSdk/package).
8. **Revocación (FASE 9.27)** — la arquitectura v2 no contempla revocación
   en línea (offline). Documentar como **limitación conocida** (no inventar).

---

## 6. Secrets requeridos (estado actual: NO CONFIGURADOS)

| Secret | Estado | Uso |
|---|---|---|
| `VIEWLBA_KEYSTORE_BASE64` | ❌ ausente | Keystore PKCS#12/JKS codificado base64 (creado UNA vez, fuera del repo) |
| `VIEWLBA_KEYSTORE_PASSWORD` | ❌ ausente | Password del keystore |
| `VIEWLBA_KEY_ALIAS` | ❌ ausente | Alias de la clave de firma |
| `VIEWLBA_KEY_PASSWORD` | ❌ ausente | Password de la clave |
| `VIEWLBA_LICENSE_PRIVATE_KEY` | ⚠️ huérfano | Clave Ed25519 v1 (rotada 1.2.1): **ningún workflow actual la referencia** → candidata a eliminación |
| `VIEWLBA_REQUEST_PUBLIC_KEY` | ℹ️ dummy inline en ci.yml | Clave pública DUMMY de E2E (allowlisted, no es secreto real) |

> Nota: el PAT de GitHub del repo NO es la clave de firma Android (son cosas
> distintas, FASE 22). Los 4 secrets deben crearse como tales.

---

## 7. Archivos sospechosos (revisión de secretos)

| Ruta | Veredicto |
|---|---|
| `e2e/fixtures/licensing/keys.ts` | ✅ OK — claves DUMMY etiquetadas para E2E, allowlist gitleaks, incapaces de firmar producción |
| `src/lib/licensing/public-key.ts` | ✅ OK — SOLO públicas (verificación) |
| `/home/z/my-project/keys/PRODUCTION-KEYS.txt` (fuera del repo) | ✅ OK — custodia admin; no está en Git ni en artifacts |
| `android-license-generator/**` fuentes | ✅ OK — grep anti-material-de-claves en CI + análisis de `classes.dex` |
| `data/`, `tmp/`, `upload/`, `logs/`, `backups/`, `.next/`, `db/*.db`, `local.properties` | ✅ OK — gitignored; `git ls-files` confirma 0 archivos tracked de desarrollo |
| CHANGELOG/docs mencionando el secret v1 | ✅ OK — texto histórico enmascarado |
| Historial Git | ✅ OK — gitleaks en CI con `fetch-depth: 0` (runs verdes) |

---

## 8. Estado del CI (API, 2026-09-12)

| Workflow | Ref | Resultado | Nota |
|---|---|---|---|
| CI | main | ✅ success | quality + integration + e2e (26 tests) + security |
| Android License Generator | main | ✅ success | ⚠️ con APK unsigned (fallback) |
| Release Installers | tag v2.0.0 | ✅ success | .deb/.AppImage/Setup.exe + manifestifiestos + SHA256SUMS |

## 9. Estado del APK

- **Artifact actual:** `ViewLBA-License-Generator-v1.0.0.apk` — 22.7 MB —
  unsigned — **NO VERIFICA** — nombre erróneo.
- Config: `com.viewlba.licensegen`, minSdk 26, targetSdk 35, compileSdk 35,
  AGP 8.7.3, Kotlin 2.0.21, Gradle 8.10.2, R8+shrink.

## 10. Estado de la versión

- Tags: `v1.0.0`, `v1.0.1-rc.1`, `v1.2.0`, `v1.2.1`, `v2.0.0`.
- Server: `package.json` 2.0.0 · Android: 1.0.0/1 · **Objetivo: 3.0.0
  (versionCode ≥ 3, monótono)**.
- Fuentes de versión divergentes: Gradle, workflow, package.json, CHANGELOG,
  README, docs — sin gate de sincronía.

---

## 11. Plan de acción (mapa FASES 1–25)

1. **F1–F4**: eliminar fallback unsigned (FAIL si faltan secrets), flujo
   canónico unsigned→zipalign→`apksigner sign`→`verify`→`badging`→`unzip -t`.
2. **F5**: `VERSION` raíz como fuente única + gate de coherencia en CI.
3. **F6**: workflow Android de 15 pasos sin `continue-on-error`.
4. **F7**: validación binaria bloqueante + job de emulador separado
   (opt-in); evidencia de instalación real donde haya emulador estable.
5. **F8–F16**: branding, fuzzing, ataques autorizados, escaneo de clave
   privada, análisis APK, seguridad del manifest, funcional del generador,
   ataques a backup.
6. **F17–F18**: servidor completo + instaladores obligatorios en el release.
7. **F19–F20**: logos y documentación 3.0.0.
8. **F21–F23**: checklist → crear secrets → RC `v3.0.0-rc.1` → verificar
   artifacts descargándolos de GitHub.
9. **F24–F25**: prueba de instalación del APK exacto publicado → solo si
   todo PASS → `v3.0.0` + GitHub Release + `FINAL_RELEASE_AUDIT.md`.
