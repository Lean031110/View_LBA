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
2. Crea tu **PIN** (4–16 caracteres, simple) — la bóveda se inicializa
   (DB cifrada con master key envuelta por el PIN: PBKDF2 150k +
   AES-256-GCM). Sin biometría, sin Keystore, sin requisitos del
   dispositivo: funciona en cualquier teléfono (v3.2).
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

- DB **SQLCipher** cifrada; master key envuelta por el **PIN**
  (PBKDF2-HMAC-SHA256 150k + AES-256-GCM) — simple y portable
  (v3.2: sin Keystore/biometría; los vaults ≤3.1 se desbloquean igual
  con el PIN y migran al cambiarlo).
- Bloqueo automático a los 60 s en background; PIN para desbloquear;
  cambio de PIN.
- `allowBackup=false` — nada sale al cloud.
- Claves privadas jamás en claro (ni logs, ni screenshots de la app: los
  ajustes solo muestran las PÚBLICAS).

### Códigos de solicitud demo (SOLO builds de CI)

Con `-PdemoRequests=true` (build del smoke del emulador, nunca en
producción) la app acepta códigos `VLDEMO-…` como solicitudes válidas
con datos inventados — permite verificar en CI el flujo completo de
emitir una licencia sin claves reales de clientes. El APK de producción
se compila SIN la flag: `VLDEMO-` se rechaza como código inválido.

## Compilación y CI

```bash
./gradlew :app:testReleaseUnitTest   # 74 tests JVM (vectores dorados + fuzz + ataques backup)
./gradlew :app:lintRelease
./gradlew :app:assembleRelease       # APK SIN firmar (la firma es paso de CI)
```

### Firma (pipeline canónico — release 3.0.0)

Gradle **nunca** firma: `assembleRelease` produce `app-release-unsigned.apk`
y la firma es un paso explícito, auditable y bloqueante de CI
(`.github/actions/android-apk/action.yml`, idéntico en local con
`scripts/sign-and-verify-apk.sh` del entorno de build):

```
zipalign -f -P 4 4 unsigned.apk aligned.apk
apksigner sign --ks <keystore de Secrets> --v1 --v2 --v3 --out APK aligned.apk
apksigner verify --verbose --print-certs APK          # v2+v3 true (bloqueante)
apksigner verify --verbose --min-sdk-version 23 APK   # v1/JAR true
zipalign -c -P 4 4 APK
aapt2 dump badging APK               # package/version/minSdk/targetSdk/label
unzip -t APK
```

Si falta cualquiera de los 4 secrets (`VIEWLBA_KEYSTORE_BASE64`,
`VIEWLBA_KEYSTORE_PASSWORD`, `VIEWLBA_KEY_ALIAS`, `VIEWLBA_KEY_PASSWORD`)
el CI **falla inmediatamente**: nunca se publica un APK sin firmar. El
keystore se creó UNA sola vez fuera del repositorio (PKCS#12, RSA-2048,
~33 años de validez); NO regenerarlo nunca (se perdería la continuidad de
actualización de la app).

## Vectores dorados (compatibilidad TS↔Kotlin)

`scripts/gen-golden-vectors.ts` (raíz del repo) genera con el MISMO código
del servidor: JSON canónico, Base32, CRC32, un token VLBA2 y un código
VLREQ2 con semillas fijas. `CrossCompatTest` (JVM) los reproduce byte a
byte → el emisor Android y el verificador del servidor no pueden divergir
sin romper CI.
