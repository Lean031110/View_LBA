# ViewLBA License Generator (Android)

Aplicación Android **privada del administrador** para emitir licencias del
sistema ViewLBA v2 (flujo copiar/pegar).

**No se publica en Play Store**: el APK se distribuye como artifact de
GitHub Actions (firmado con secrets del repositorio).

## Flujo completo (3 pasos)

```
CLIENTE (ViewLBA)                      ADMINISTRADOR (esta app)
─────────────────                      ────────────────────────
Administración → Licencia
1. Escribe el nombre del negocio
2. «Copiar código de solicitud»  ───►  (WhatsApp) ───►  Nueva licencia
                                             3. Pega el código VLREQ2-…
                                             4. Valida (muestra el nombre)
                                             5. Elige duración (30/365/custom)
                                             6. «Generar y copiar token»
                        ◄─── (WhatsApp) ───┘
7. Pega el token VLBA2-…
8. «Activar licencia»  →  LICENCIA ACTIVA · Restan X días
```

## Qué hace la app

| Pantalla | Función |
|---|---|
| Inicio | Nueva licencia · Historial · Backup · Ajustes |
| Nueva licencia | Pegar código VLREQ2 → validar → duración → generar → copiar token |
| Historial | Búsqueda por cliente/licenseId, filtros (activa/vencida/futura), renovar, copiar token, ver fechas |
| Detalle | Cliente, licenseId, plan, inicio, vencimiento, días restantes, estado, copiar token, renovar |
| Backup | Crear/restaurar/verificar `.vlbak` (cifrado AES-256-GCM con contraseña) |
| Ajustes | Claves públicas (copiar), importar claves privadas, generar (rotar), cambiar PIN |

## Seguridad

- **DB local cifrada en reposo** (SQLCipher Community 4.6.1): licencias,
  tokens, hashes anti-replay y **las claves privadas del emisor**.
- **Clave maestra** envuelta doblemente:
  - Android Keystore AES-256-GCM (`setUserAuthenticationRequired(true)`,
    hardware-backed TEE/StrongBox cuando está disponible) → desbloqueo con
    **biometría**;
  - PBKDF2-HMAC-SHA256 del **PIN** (150 000 iter) → desbloqueo por PIN.
- **PIN + biometría + bloqueo automático** (60 s en segundo plano) y bloqueo
  manual.
- **Las claves privadas NUNCA**:
  - están hardcodeadas / en assets / strings / BuildConfig;
  - aparecen en logs;
  - salen en claro — solo dentro de la DB cifrada o del backup `.vlbak`
    (cifrado con contraseña del administrador).
- `allowBackup=false` + data extraction rules: nada sale al cloud de Google.
- Backup `.vlbak`: magic+versión+salt+IV+ciphertext(AES-256-GCM)+SHA-256.
  Rechaza backups manipulados/truncados/de versión futura. Restaura en un
  teléfono nuevo tras verificar integridad.

## Emisión (garantías)

- **Anti-replay**: cada código de solicitud solo emite UNA licencia (hash
  SHA-256 registrado); re-usar un código invita a usar «Renovar».
- **Anti-downgrade**: una renovación nunca acorta una licencia activa, salvo
  marcado explícito «Acortar licencia (acción administrativa)».
- **licenseId único** (VLBA- + 12 hex) con reintento anti-colisión.
- **Auto-verificación** de firma tras emitir (ida y vuelta con la pública).
- Duración **decidida solo por el administrador** (mensual 30 / anual 365 /
  personalizada 1–3650) — el cliente nunca la elige.

## Formatos (compatibles byte a byte con el servidor)

- Código de solicitud: `VLREQ2-XXXX-…` (sealed box X25519→HKDF→AES-256-GCM,
  Base32 sin padding, CRC32, v2).
- Token de licencia: `VLBA2-XXXX-…` (payload JSON canónico firmado Ed25519,
  Base32, CRC32, v2).

La compatibilidad se garantiza con **vectores dorados** generados por el
mismo código del servidor (`scripts/gen-golden-vectors.ts` en la raíz del
repo) y verificados en `CrossCompatTest` (JVM).

## Compilar

```bash
# Requisitos: JDK 17, Android SDK (platform 35, build-tools 35.0.0)
echo "sdk.dir=/ruta/al/sdk" > local.properties
./gradlew :app:testReleaseUnitTest   # 74 tests JVM (fuzz + ataques backup incluidos)
./gradlew :app:lintRelease           # Android lint
./gradlew :app:assembleRelease       # APK SIN firmar (la firma es paso de CI)
```

### Firma de release (canónica — 3.0.0)

Gradle NUNCA firma (no acepta env vars de keystore). El APK sale unsigned
de `assembleRelease` y CI lo firma con `apksigner` tras `zipalign`, con el
keystore de producción guardado en GitHub Secrets (creado UNA sola vez
fuera del repo — NO regenerar):

```
VIEWLBA_KEYSTORE_BASE64    # keystore PKCS#12 codificado en base64
VIEWLBA_KEYSTORE_PASSWORD  # password del keystore
VIEWLBA_KEY_ALIAS          # viewlba
VIEWLBA_KEY_PASSWORD       # password de la clave (PKCS#12: = store)
```

Verificación bloqueante tras firmar: `apksigner verify` (v2+v3, y v1 vía
`--min-sdk-version 23`), `zipalign -c`, `aapt2 dump badging` (package
`com.viewlba.licensegen`, versionName de `/VERSION`, versionCode de
`gradle.properties`, minSdk 26, targetSdk 35), `unzip -t` y escaneo
anti-secretos del binario. Si falta un secret, el CI FALLA («Refusing to
publish unsigned APK») — jamás se publica un APK sin firmar.

## CI

`.github/workflows/android-license-generator.yml` — en cada push a main y
PR: gitleaks + pipeline compuesto (`.github/actions/android-apk`): lint,
tests JVM, escaneo anti-claves en fuentes, build, zipalign, firma con
secrets, verificación apksigner, badging, `unzip -t`, análisis del
artifact, branding, checksum `SHA256SUMS.txt` y subida del APK
`ViewLBA-License-Generator-vX.Y.Z.apk` (retención 30 días).

En tags `v*` el MISMO pipeline corre dentro de `release-installer.yml`
(job `build-android`) y el APK firmado + checksums + evidencia
(`LicenseGenerator-VERIFY.txt`) se publican en el GitHub Release. Además,
`android-emulator-smoke.yml` instala y lanza el APK en un emulador API 35
real (evidencia de instalación).
