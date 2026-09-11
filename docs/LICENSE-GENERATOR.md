# Generador de Licencias (App Android privada)

> El generador v1 (CLI `tools/license-generator/` + servidor demo
> `license-demo/` + workflow de GitHub que emitía ZIPs) fue **ELIMINADO** en
> la v2.0.0. El único emisor ahora es la app Android.

## Qué es

`android-license-generator/` — aplicación Android (Kotlin) que el
administrador instala en su teléfono personal. Emite tokens VLBA2 firmados
con la clave Ed25519 del emisor y abre códigos VLREQ2 con la clave X25519.

- **NO se publica en Play Store**: el APK firmado sale como artifact de
  GitHub Actions (workflow `android-license-generator.yml`) con checksum
  SHA-256.
- **100% offline**: cero permisos, cero red.

## Primer uso

1. Instala `ViewLBA-License-Generator-vX.Y.Z.apk` (verifica el SHA-256 del
   artifact contra `SHA256SUMS.txt`).
2. Crea tu **PIN** (6–16 caracteres) — la bóveda se inicializa (DB cifrada
   con master key envuelta por Keystore+PIN).
3. **Ajustes → Importar claves privadas**: pega las DOS claves base64url
   que recibiste al configurar el sistema (Ed25519 firma + X25519
   solicitudes). O **Generar claves nuevas** (rotación) y copia las
   públicas para el servidor.
4. Crea un **backup .vlbak** pronto (Backup → Crear, elige contraseña
   fuerte).

## Emitir una licencia (flujo diario)

1. **Nueva licencia** → pega el `VLREQ2-…` que el cliente envió por
   WhatsApp (tolerante a saltos de línea).
2. **Validar** → muestra el nombre del negocio y el equipo (enmascarado).
3. Elige duración: **Mensual 30 · Anual 365 · Personalizada (1–3650)**.
4. **Generar y copiar token** → el token `VLBA2-…` queda en el
   portapapeles (y visible para re-copiar).
5. Envíalo por WhatsApp al cliente → él lo pega en
   Administración → Licencia → **Activar licencia**.

## Renovar

Historial → registro del cliente → **Renovar** → elegir duración. El inicio
por defecto = vencimiento actual (extiende, nunca acorta). Un recorte
explícito exige marcar «Acortar licencia (acción administrativa)».

## Historial y búsqueda

- Buscar por **cliente** o **licenseId** (parcial).
- Filtros: todas / activas / vencidas / futuras.
- Detalle: cliente, licenseId, plan, inicio, vencimiento, días restantes,
  estado; copiar token; renovar.

## Backup / restauración (.vlbak)

- **Crear**: contraseña elegida → PBKDF2 (120k) + AES-256-GCM + SHA-256.
  Incluye licencias, solicitudes procesadas, ajustes y **claves** (cifradas).
- **Verificar integridad**: valida magic/versión/checksum y descifra SIN
  importar (resumen: versión, nº licencias, nº claves, fecha).
- **Restaurar**: reemplaza el contenido de la DB (transacción). Rechaza
  backups manipulados/truncados/versión futura/contraseña incorrecta.
- Probar el ciclo completo en un teléfono nuevo: crear → borrar app →
  instalar → restaurar → verificar historial y emitir una renovación.

## Seguridad de la app

Ver `docs/LICENSE-SECURITY.md`. Resumen:

- DB **SQLCipher** cifrada; master key con doble envoltura (Keystore
  AES-GCM con biometría + PBKDF2 del PIN).
- Bloqueo automático a los 60 s en background; PIN y biometría para
  desbloquear; cambio de PIN.
- `allowBackup=false` — nada sale al cloud.
- Claves privadas jamás en claro (ni logs, ni screenshots de la app: los
  ajustes solo muestran las PÚBLICAS).

## Compilación y CI

```bash
./gradlew :app:testReleaseUnitTest   # 57 tests JVM (incluye vectores dorados)
./gradlew :app:lintRelease
./gradlew :app:assembleRelease       # firma por env VIEWLBA_KEYSTORE_*
```

CI (`.github/workflows/android-license-generator.yml`): JDK 17 + SDK 35
fijos, lint, tests, gitleaks + grep anti-claves, build, firma con secrets
(`VIEWLBA_KEYSTORE_BASE64`, `VIEWLBA_KEYSTORE_PASSWORD`,
`VIEWLBA_KEY_ALIAS`, `VIEWLBA_KEY_PASSWORD`), análisis del APK, checksum y
artifact.

## Vectores dorados (compatibilidad TS↔Kotlin)

`scripts/gen-golden-vectors.ts` (raíz del repo) genera con el MISMO código
del servidor: JSON canónico, Base32, CRC32, un token VLBA2 y un código
VLREQ2 con semillas fijas. `CrossCompatTest` (JVM) los reproduce byte a
byte → el emisor Android y el verificador del servidor no pueden divergir
sin romper CI.
