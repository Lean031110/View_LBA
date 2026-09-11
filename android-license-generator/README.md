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
./gradlew :app:testReleaseUnitTest   # tests JVM
./gradlew :app:lintRelease           # Android lint
./gradlew :app:assembleRelease       # APK (firmado si hay env de keystore)
```

Firma de release con variables de entorno (CI usa GitHub Secrets):

```
VIEWLBA_KEYSTORE_FILE=/ruta/keystore.jks
VIEWLBA_KEYSTORE_PASSWORD=…
VIEWLBA_KEY_ALIAS=…
VIEWLBA_KEY_PASSWORD=…
```

## CI

`.github/workflows/android-license-generator.yml` — lint, tests JVM,
escaneo anti-claves en fuentes (grep) + gitleaks, build release, firma con
secrets, análisis del artifact, checksum `SHA256SUMS.txt` y subida del APK
`ViewLBA-License-Generator-vX.Y.Z.apk` (retención 30 días).
