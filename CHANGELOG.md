# Changelog

Todos los cambios notables de este proyecto se documentan en este archivo.

El formato está basado en [Keep a Changelog](https://keepachangelog.com/es/1.1.0/),
y este proyecto adhiere a [SemVer](https://semver.org/lang/es/).

## [3.2.2] — 2026-09-16 — Bandeja Linux 100 % offline (cero dependencias del sistema)

### Auditoría offline de los instaladores (lo pedido: «verifica si los
instaladores funcionan completamente offline y traen todas las dependencias»)

- **Windows (Setup.exe): VERIFICADO 100 % offline** — bun.exe + nssm.exe +
  node_modules (vendored) + engines de Prisma viajan DENTRO del paquete; la
  bandeja es PowerShell (integrado en Windows) y la generación de
  credenciales usa PowerShell del propio SO. La CI ya lo prueba con reglas
  de firewall outbound BLOCK (loopback exento) — instalación + health sin red.
- **Linux (.deb, servidor): VERIFICADO 100 % offline** — runtime bun +
  node_modules podado + engines empaquetados; `Depends: systemd` (presente
  en cualquier Linux moderno). La CI ya lo prueba con iptables REJECT (solo
  loopback) — instalación + health + iniciar/detener sin red.
- **Linux (.deb, bandeja): HABÍA UN GAP REAL** — la bandeja era
  Python3 + PyGObject (python3-gi) + GTK + gir1.2-ayatanaappindicator,
  paquetes del SISTEMA declarados solo como `Recommends` → `dpkg -i` NO los
  instala y una máquina offline NO puede conseguirlos → **la bandeja no
  arrancaba** (degradación silenciosa: icono ausente, servidor intacto).

### Arreglado

- **La bandeja de Linux ya NO depende de NADA del sistema**: reescrita en
  TypeScript PURO que corre con el MISMO runtime bun que el .deb ya trae
  (`/opt/viewlba-server/runtime/bun`) hablando los protocolos de escritorio
  directamente por el socket de sesión D-Bus:
  - **StatusNotifierItem** (org.kde.StatusNotifierItem) — el icono de la
    bandeja en KDE/XFCE/MATE/Cinnamon (nativo) y Ubuntu GNOME (vía
    gnome-shell-extension-appindicator, preinstalado).
  - **DBusMenu** (com.canonical.dbusmenu) — el menú
    Iniciar servidor · Detener servidor · Reiniciar · Configurar… ·
    Abrir Panel · Ver credenciales · Salir, con ítems que se
    habilitan/deshabilitan según el estado real del servicio.
  - **Notificaciones** (org.freedesktop.Notifications) — globos al cambiar
    de estado.
  - Implementación D-Bus propia (`installer/linux/tray/dbus.ts`): wire
    format completo con las alineaciones del spec oficial (STRUCT a 8,
    padding de array incluso vacío, VARIANT a 1), SASL EXTERNAL, llamadas
    con correlación serial↔respuesta, lado servidor (métodos + propiedades
    + introspección XML autogenerada). Firmas verificadas contra DOS
    fuentes independientes (ksni —lado servidor— y
    gnome-shell-extension-appindicator —lado consumidor—) y contra
    **busctl** (referencia de systemd) como consumidor real.
  - Clic izquierdo en el icono → abre el Panel (toda la configuración del
    restaurante vive en el panel web; la ventana GTK anterior duplicaba
    eso y exigía GTK para existir).
  - Se conserva TODO el comportamiento clave: icono VERDE/ROJO/AMARILLO
    por estado, refresco 5 s (1 s tras una acción), instancia única por
    pid-file, re-registro si el watcher SNI (re)aparece, degradación
    elegante headless (mensaje claro + exit 0), modo `--check` para CI.
- **control del .deb**: `Depends: systemd` — ÚNICAMENTE. Eliminado el
  `Recommends: python3, python3-gi, gir1.2-…` (que además `dpkg -i` no
  instalaba): la bandeja ahora no exige ningún paquete del sistema.
- `/usr/bin/viewlba-tray` es ahora un wrapper que ejecuta
  `/opt/viewlba-server/tray/tray.ts` con el bun del paquete (el código
  vive FUERA de `resources/server` → sobrevive a la poda del postinst).

### Añadido

- **`tests/installer/tray-dbus.test.ts`** (29 tests): golden vectors de
  marshalling (bytes exactos de cada tipo D-Bus), round-trips de mensajes,
  integración REAL con un dbus-daemon privado (SASL + Hello + RequestName +
  errores + exportación), y **E2E completo**: watcher SNI simulado +
  demonio de notificaciones simulado + systemctl/pkexec/xdg-open falsos →
  la bandeja REAL (proceso aparte) se registra, muestra el menú completo,
  cambia el icono al estado del servicio, ejecuta las acciones privilegiadas
  y envía notificaciones.
- CI: `installer-flow.yml` (FLUJO 2) y `release-installer.yml` validan la
  bandeja nueva — código TS instalado + runtime bun del paquete + `--check`
  + **regresión offline**: el build ROMPE si el control vuelve a depender
  de python/gir/appindicator.

### Añadido (mismo día — verificación de TODO + README pro)

- **`tsconfig.installer.json` — el instalador y la bandeja ahora son
  TypeScript ESTRICTO**: `installer/**` (CLI, adaptadores, build-deb,
  bandeja D-Bus) y `scripts/**` antes no los tipaba NADIE (el tsconfig
  principal solo incluye `src/**`); solo corrían con bun. Gate nuevo en
  el job quality de la CI (`bun run typecheck:installer`) + fixes de los
  errores que el gate destapó:
  - `scripts/restore.ts` importaba `purgeInvalidThemes` del barril
    `src/lib/themes` — que NO lo re-exportaba → **`bun run db:restore`
    crasheaba al importar** (el CLI de restauración estaba roto).
    Re-exportado. El typecheck lo habría cazado a tiempo.
  - `installer/linux/tray/dbus.ts`: `require()` de node:fs → import
    estático (lint) y `process.getuid` defensivo.
  - `installer/linux/tray/tray.ts`: opción `captureOutput` redundante
    eliminada (node:child_process ya captura siempre en modo sync;
    verificado en runtime con bun) y `getuid` defensivo.
  - `installer/core/install.ts` + `scripts/manual-screenshots.ts` +
    `scripts/check-version.ts`: null-safety y tipado de respuestas fetch.
- **`scripts/check-docs.ts` — gate de coherencia de documentación** (nuevo
  paso del job quality): badges de Actions al repo REAL y a workflows que
  existen, instrucciones `git clone` correctas en README/CONTRIBUTING/
  INSTALLATION, todos los enlaces relativos del README resuelven, índice
  de docs completo (cada `docs/*.md` enlazado desde el README), screenshots
  presentes y **conteos publicados fieles al código** (specs/tests/
  escenarios E2E exactos; tests unitarios en banda estático↔runtime).
- **README.md reescrito** (pro, completo y sin errores): badges + clone +
  `package.json` apuntaban a `Pantalla_Restaurante` cuando el repo real es
  `View_LBA` (corregido en los 4 sitios); conteos actualizados (776 tests ·
  E2E 9 specs/52 tests/22 escenarios · 15 secciones del panel); nueva
  sección **Bandeja del sistema** (tabla Windows/Linux); sección de
  instaladores con la prueba offline real de la CI; índice de docs ampliado
  (+EMISOR DE LICENCIAS, +SEGURIDAD DE LICENCIAS); badge nuevo del
  workflow Installer Flow CI.
- CI: nombre del job E2E actualizado (52 tests / 22 escenarios) y
  comentario del paso de tests con las cifras reales.

## [3.2.1] — 2026-09-16 — Bandeja permanente + fix del Setup.exe colgado + CI de flujo completo por SO

### Arreglado

- **El Setup.exe de Windows ya NO se queda colgado tras una instalación
  PERFECTA** (regresión de v3.2.0: instalación completa en 35 s, servicio
  Running, health 200… y el instalador esperaba para siempre hasta que el
  runner lo mataba a los 22 min). Causa raíz: el NSIS lanzaba la bandeja
  con `nsExec::Exec`, que **ESPERA a que el proceso termine** — y la bandeja
  es un bucle de mensajes infinito. Ahora se lanza con `Exec` (no espera) y
  el test de regresión `tests/installer/tray.test.ts` ROMPE el build si
  alguien vuelve a escribir nsExec para la bandeja.

- **La bandeja de Windows ya NO muere en silencio al arranque** (causa raíz
  encontrada con instrumentación CI: `tray-launch.txt` = «exec: OK» pero
  `tray-boot.txt` ausente y error de parse 5.1 «Unexpected token @line
  174»). El `.ps1` estaba en UTF-8 sin BOM y Windows PowerShell 5.1 (en-US,
  CP1252) lee los bytes crudos: el guion largo `—` (0x94 en CP1252) es una
  **comilla curva = TERMINADOR de cadena** → el parse moría → powershell
  jamás ejecutaba el script. Fix: `ViewLBA-Tray.ps1` en **ASCII 100 % puro**
  (inmune a cualquier codepage) + test de regresión de ASCII puro.

### Añadido

- **Bandeja del sistema PERMANENTE (lo pedido: «icono permanente en la
  barra de tareas como indicador de que está activo y cuando le den clic
  salgan opciones de iniciar, detener y configurar»)**:
  - Windows: icono de color según estado (VERDE activo / ROJO detenido /
    AMARILLO transición), menú Iniciar · Detener · Reiniciar ·
    Configurar… · Abrir Panel · Salir, ventana «Configurar» (estado en
    vivo, credenciales, carpetas app/datos/logs, control del servicio),
    globos de notificación al cambiar de estado, refresco 5 s, instancia
    única por pid-file, autostart con la sesión (HKCU Run).
  - Linux: `viewlba-tray` (Python3 + GTK/AppIndicator con fallback
    StatusIcon y degradación elegante sin escritorio), menú y ventana
    equivalentes vía pkexec+systemd; el .deb instala el script + iconos de
    estado hicolor (running/stopped/waiting × 22/32/48) + .desktop +
    autostart XDG + limpieza en postrm; `viewlba-server tray|configure`.
- **CI nuevo `installer-flow.yml` (en cada push/PR, no solo en tags)**:
  flujo completo por SO en runners reales — instalar → bandeja →
  iniciar/detener → configurar → **100 % OFFLINE real** (Linux: iptables
  REJECT con solo loopback; Windows: firewall outbound BLOCK de
  sidecar+bun+nssm) → desinstalar. 28 tests nuevos de bandeja (141 del
  installer en total).

## [3.2.0] — 2026-09-13 — Instaladores nativos + PIN simple + smoke del flujo completo

### Arreglado

- **La APK ya NO se atasca en la primera pantalla en dispositivos reales**
  (evidencia: Samsung S22 Ultra). Causa raíz: `MasterKeyVault` creaba una
  clave de Android Keystore con `setUserAuthenticationRequired(true)` y
  luego la usaba INMEDIATAMENTE para cifrar la master key — en un equipo
  con biometría inscrita eso lanza `UserNotAuthenticatedException` (no hay
  BiometricPrompt visible durante el primer uso) y la bóveda nunca se
  crea. Los emuladores sin biometría caían al fallback y por eso el CI
  pasaba. **Decisión de producto (pedido explícito):** se ELIMINA toda la
  envoltura Keystore/biométrica — la bóveda queda protegida solo por el
  PIN (PBKDF2-HMAC-SHA256 150k + AES-256-GCM), como un «programa simple».
  Los vaults creados por versiones ≤3.1 siguen desbloqueándose con su PIN
  (la envoltura B se conserva); al cambiar el PIN quedan migrados al
  formato nuevo.

- **Los instaladores de Windows y Linux ya NO fallan**. Causa raíz
  encontrada: el payload NUNCA incluyó las plantillas systemd
  (`deploy/linux/*.service|target|timer`) que `LinuxServiceAdapter
  .installServices` renderiza — el instalador moría con «No se encuentran
  las plantillas systemd en /opt/pantalla-restaurante/deploy/linux (payload
  incompleto)». Ahora `createProductionPayload` las incluye (guard de 8
  unidades) y los tests lo exigen.

### Cambiado

- **PIN simple**: política relajada a **4–16 caracteres** (antes 6–16),
  configurable desde dentro de la propia app (primer uso) y cambiable en
  Ajustes. Sin biometría, sin Keystore, sin requisitos del dispositivo.
- **PBKDF2 fuera del hilo de UI**: crear bóveda y desbloquear corren en
  el ejecutor de fondo (antes en el hilo de UI — riesgo de ANR en
  dispositivos lentos; el botón se deshabilita mientras trabaja).

### Añadido

- **Instalador Windows NATIVO** (`installer/windows/viewlba-setup.nsi`,
  NSIS puro — sin Tauri/Rust): una sola pantalla, instala TODO (el runtime
  **bun va dentro del paquete**: la máquina no necesita node ni bun),
  registra y ARRANCA el servicio (NSSM incluido), genera credenciales
  (`CREDENCIALES.txt` + acceso directo) y crea accesos en el escritorio:
  **Panel · Iniciar servidor · Detener servidor · Credenciales · Bandeja**.
- **Bandeja del sistema Windows** (`installer/windows/tray/ViewLBA-Tray.ps1`):
  notificación persistente junto al reloj — **clic derecho: Iniciar ·
  Detener · Abrir Panel · Salir**; icono verde/rojo según estado; refresco
  cada 10 s; arranque automático con Windows. Cero dependencias
  (PowerShell 5.1 preinstalado).
- **.deb NATIVO de Linux** (`installer/linux/build-deb.ts`, dpkg-deb puro
  — sin Tauri/Rust/linuxdeploy): `dpkg -i` y listo — el postinst instala
  el usuario de sistema, las unidades systemd, la DB, el admin, ARRANCA el
  servicio (se reinicia con el equipo), genera credenciales y copia los
  accesos al escritorio. Comando simple `viewlba-server {start|stop|
  restart|status|health|logs|panel|credentials}`. Purge conserva los
  datos del restaurante.
- **VALIDACIÓN REAL de los instaladores en CI** (nada de «estructura
  correcta»): el job de Linux hace `dpkg -i` del .deb en el runner
  (systemd activo + `/api/health` 200 + ciclo stop/start + purge) y el
  job de Windows instala el `Setup.exe /S` en silencio (servicio
  Running + health + credenciales + accesos + net stop/start +
  desinstalación). Un instalador que no pasa eso NO se publica.
- **Smoke del FLUJO COMPLETO de licencias** (`scripts/
  apk-license-flow-check.sh`, pedido explícito): abrir la APK → PIN
  (2025 — valida la política nueva de 4) → «Nueva licencia» → pegar
  código de solicitud **demo** (`VLDEMO-…`, datos inventados solo para
  pruebas, habilitado únicamente en builds de CI con
  `-PdemoRequests=true`; en producción el prefijo se rechaza como código
  inválido) → validar → GENERAR → token **VLBA2-** visible → **copiar al
  portapapeles** (toast verificado) → aparece en el Historial. Corre en
  el emulador de CI junto al smoke de primera pantalla.
- Entrada `demo-requests` en la action compuesta `android-apk` (default
  `false` — el APK de producción NUNCA lleva demo habilitado).

## [3.1.0] — 2026-09-12 — Temas de pantalla + Manual de usuario + release comercial

### Añadido

- **Smoke funcional del primer arranque de la APK** (`scripts/
  apk-first-screen-check.sh`): el emulador de CI ya no comprueba solo
  «el proceso está vivo» — ahora verifica que la APK **pasa la primera
  pantalla** con un PIN de ejemplo (131313): configuración del PIN →
  «Crear bóveda» → HOME (botón «Nueva licencia»), relanzamiento →
  desbloqueo con el mismo PIN → HOME, y control negativo (un PIN
  incorrecto NO desbloquea). Corre sobre `uiautomator` (coordenadas por
  resource-id, estables ante idioma/resolución) y sube screenshots de
  cada paso como evidencia. El smoke corre también en cada push a
  `main` (regresión funcional visible de inmediato).

- **Sistema de Temas TV** (misión «Release Final de Producción», §6–§24):
  nueva sección **🎨 Temas de Pantalla** en Administración con
  importación de paquetes `.vtheme`, activación, vista previa, eliminación
  (el tema predeterminado no se puede borrar) y restauración. Solo
  disponible con licencia completa (`themes.custom`); durante la prueba
  muestra «Los temas de pantalla están disponibles con una licencia
  completa».
- **Formato `.vtheme`** (ZIP estructurado y DECLARATIVO):
  `manifest.json` + `theme.json` + `assets/`. Un tema NO puede contener
  código (JS/shell/ejecutables rechazados); solo JSON, imágenes raster
  validadas por magic bytes y límites estrictos. Validación de importación
  de 21 pasos: extensión, ZIP, tamaño, nº de archivos, path traversal,
  rutas absolutas, symlinks, manifest, schema, tipos, tamaños, assets,
  formatos, duplicados, compatibilidad, etc. (ver `docs/THEME_SECURITY.md`).
- **Tres temas oficiales**: `ViewLBA Default` (integrado, siempre
  funciona, sin archivos externos), `ViewLBA Classic` (elegante oscuro
  profesional) y `ViewLBA Neon` (moderno tecnológico con brillos y
  animaciones suaves). Classic y Neon se distribuyen como
  `themes/ViewLBA-Classic.vtheme` y `themes/ViewLBA-Neon.vtheme`.
- **Motor de temas en la TV**: paleta, tipografías (lista blanca),
  estilo de reloj, estilo de ticker, transiciones del carrusel y fondos
  decorativos declarativos — todo renderizado internamente por ViewLBA
  (cero JavaScript de terceros en el paquete). Propagación realtime:
  aplicar un tema en Administración → las TVs conectadas lo reciben al
  instante vía `content:update`. Si un tema activo falla → la TV vuelve
  automáticamente a Default.
- **Seguridad de temas probada**: suite de tests adversariales
  (traversal `../../`, ZIP bomb, symlinks, MIME falso, duplicados,
  imágenes gigantes, manifest inválido, JSON malformado, unicode,
  extensión falsa, archivos ejecutables…) — todo termina en REJECT
  SAFE sin crash (`tests/themes/`).
- **Gestión de trial/licencia**: trial no puede importar/aplicar temas;
  si una licencia completa vence, los temas instalados NO se borran (modo
  restringido de gestión, el tema activo se mantiene de forma segura).
- **`features` de licencia** preparadas para el futuro: `themes.standard`,
  `themes.premium`, `multiDisplay`, `advancedAnimations` (arquitectura
  extensible, sin marketplace todavía).
- **Manual de Usuario ViewLBA** (PDF profesional en español, para
  CLIENTES): 16 capítulos — qué es, instalación (Windows/Linux/Docker),
  primer arranque, prueba de 7 días, activación por WhatsApp, precios
  (10 USD mensual / 100 USD anual, contacto 52973387), administración,
  pantalla TV, temas con capturas reales, backup, solución de problemas.
  Generado por `scripts/build_customer_manual.py` con capturas reales del
  sistema y validado en CI (`.github/workflows/customer-manual.yml`):
  número de páginas > 0, textos obligatorios y branding verificados.

### Cambiado

- `versionCode` Android: 4 → **5** (monótono; el 4 fue publicado en el
  prerelease v3.1.0-rc.1 y no se reutiliza). APK:
  `ViewLBA-License-Generator-v3.1.0.apk`.
- Los backups incluyen las filas de temas (`Theme` en
  `TRACKED_TABLES`); restaurar revalida los paquetes antes de usarlos.

### Arreglado (BLOQUEANTE — detectado por el smoke funcional del emulador)

- **CRASH al desbloquear con un PIN incorrecto** (`FATAL EXCEPTION` en el
  listener de «Desbloquear»): `MasterKeyVault.verifyPin` llamaba
  `pbkdf2Sha256` sin proteger la criptografía — cualquier excepción del
  JCE (en el emulador API 35: `InvalidKeySpecException: Could not
  generate secret key` desde `SecretKeyFactory`) tiraba TODA la app al
  suelo (pantalla negra → launcher). Ahora `verifyPin`/`pinDecrypt`
  tratan cualquier fallo criptográfico como «PIN incorrecto» (fallo
  seguro, la app sigue bloqueada) y registran la causa completa en
  logcat (`ViewLBA-Vault`) para auditoría. Un PIN equivocado JAMÁS debe
  cerrar la app.
- **La APK no pasaba de la primera pantalla en dispositivos sin
  biometría** (emuladores limpios, tablets/TVs sin lector): al crear la
  bóveda, `MasterKeyVault.ensureKeystoreKey()` pedía una clave
  AndroidKeyStore con `setUserAuthenticationRequired(true)` y el
  Keystore la rechaza con `IllegalStateException: «At least one
  biometric must be enrolled to create keys requiring user
  authentication»` → el usuario se quedaba atascado en «Configura tu
  PIN» para siempre. Ahora: se intenta la clave con binding de
  autenticación (biometría/credencial) y, si el dispositivo no tiene
  ninguna, se degrada ELEGANTEMENTE a una clave sin binding (sigue
  UID-scoped y TEE-backed en hardware real): la bóveda se crea, el
  desbloqueo queda 100 % protegido por el PIN (PBKDF2 150k +
  AES-256-GCM) y la UI nunca ofrece biometría donde no existe.

## [3.0.0] — 2026-09-12 — Release de producción: APK firmado + pipeline de release verificable

### Arreglado (BLOQUEANTE de producción)

- **El APK publicado NO INSTALABA**: era un APK de release SIN FIRMAR
  (`apksigner verify` → `Missing META-INF/MANIFEST.MF` → Android lo rechaza
  con `INSTALL_PARSE_FAILED_NO_CERTIFICATES`). Causa raíz: el workflow tenía
  un fallback «si faltan los secrets → publica el APK unsigned con un
  warning». **Fallback ELIMINADO**: ahora el CI falla inmediatamente con
  `Release signing secrets are required. Refusing to publish unsigned APK.`
  si falta cualquiera de los 4 secrets de firma.
- **Caos de versiones**: el APK de la release v2.0.0 se llamaba `v1.0.0`
  (Gradle decía 1.0.0/1, el workflow hardcodeaba el nombre, package.json
  decía 2.0.0). Nueva fuente única de verdad: **archivo `/VERSION`** en la
  raíz + gate de coherencia en CI (`scripts/check-version.ts`): /VERSION ==
  package.json == CHANGELOG == Gradle derivado == workflows sin hardcodeo.

### Añadido

- **Firma Android REAL de producción**: keystore PKCS#12 RSA-2048 creado UNA
  sola vez fuera del repositorio y configurado como GitHub Secrets
  (`VIEWLBA_KEYSTORE_BASE64/PASSWORD/KEY_ALIAS/KEY_PASSWORD`). El secret
  huérfano v1 (`VIEWLBA_LICENSE_PRIVATE_KEY`, clave ya rotada) fue eliminado.
- **Pipeline de firma canónico** (`.github/actions/android-apk/action.yml`,
  compartido por CI y release):
  `assembleRelease (unsigned) → zipalign -P 4 4 → apksigner sign v1+v2+v3 →
  apksigner verify → zipalign -c → aapt2 badging (package/versionName/
  versionCode/minSdk/targetSdk/label/iconos) → unzip -t → análisis
  anti-secretos del binario → branding → SHA256SUMS → artifact`.
  El APK solo se publica si TODA la verificación criptográfica pasa.
- **El APK del generador entra al pipeline de release**: `release-installer.yml`
  tiene job `build-android` (mismos 15 pasos) y el GitHub Release incluye
  `ViewLBA-License-Generator-v{versión}.apk` + `LicenseGenerator-SHA256SUMS.txt`
  + `LicenseGenerator-VERIFY.txt` (evidencia: apksigner + badging + checksum).
  Los tags `-rc.N`/`-beta.N` se publican como **prerelease**.
- **versionCode monótono** gestionado (`VERSION_CODE=3` en
  `android-license-generator/gradle.properties`, gate CI ≥ 2).
- **FUZZ/property tests del lado servidor** (`tests/licensing/fuzz.test.ts`):
  ~1.000 entradas adversariales (vacías, enormes, truncadas, bytes aleatorios,
  unicode, NULs, duplicados, campos extra, números extremos) contra los
  parsers de token/solicitud/tramas/Base32/JSON canónico. Expectativa:
  rechazo tipado, NUNCA crash. PRNG con semilla fija (reproducible).
- **Ataques autorizados al almacenamiento** (`tests/licensing/storage-tamper.test.ts`):
  mutar el token guardado, inyectar un token firmado por un atacante, editar
  el payload de la DB (features «gratis»), clonar la DB a otro equipo
  (mismatch), token corrupto, downgrade. Todo rechazado: la DB JAMÁS es
  autoridad — el token se revalida (firma + binding) en cada evaluación.
- **Ataques HTTP contra /api/license/activate**
  (`tests/integration/license-api-adversarial.test.ts`): 12 POST concurrentes
  del mismo token (idempotencia real, 0 errores 500), payloads de 1 MB,
  cuerpos no-JSON, tipos inesperados, ráfaga de repetición 20x, 15 variantes
  de token corrupto, bypass de sesión (401). `LICENSE_RATE_LIMIT_MAX`
  configurable para test (default de producción sin cambios: 10/min).
- **Fuzz Android** (`CodecFuzzTest.kt`): tramas aleatorias, mutaciones,
  truncados, Base32 caótico → solo `CodecException` tipada.
- **Ataques al backup `.vlbak`** (`BackupAttackTest.kt`): versión futura/0/99,
  magic alterado, checksum reinyectado tras manipular ciphertext (el tag GCM
  interno sigue rechazando — defensa en profundidad), salt manipulado,
  truncado en cada posición, 800 archivos aleatorios.
- **Smoke de instalación REAL en emulador** (`.github/workflows/
  android-emulator-smoke.yml`, job separado opt-in + tags): emulator API 35
  → `adb install` → `am start` → `pm list packages` → screenshot → logcat →
  `uninstall`. Evidencia subida como artifact.
- **Gate de coherencia de versión en CI** (job quality de ci.yml).

### Cambiado

- `app/build.gradle.kts` ya NO firma desde Gradle (ni acepta env vars de
  firma): el APK sale siempre unsigned de `assembleRelease` y la firma es un
  paso explícito y auditable de CI. `versionName` se lee de `/VERSION`
  (override `-PandroidVersionName` para RC); `versionCode` de
  `gradle.properties`.
- `android-license-generator.yml`: se dispara en CADA push a main (sin filtro
  de paths — la firma se verifica siempre), usa el action compuesto y
  ejecuta gitleaks como paso propio.
- `RELEASE_3_AUDIT.md` (nuevo): auditoría FASE 0 de la release 3.0.0 con la
  causa raíz del APK inválido, riesgos, secrets y plan.

### Verificado

- Apksigner: v1 + v2 + v3 = true · zipalign -c PASS · badging: package
  `com.viewlba.licensegen`, versionName 3.0.0, versionCode 3, minSdk 26,
  targetSdk 35 · unzip -t PASS · sin material de claves en el binario.

## [2.0.0] — 2026-09-11 — Sistema de licencias v2: token copiar/pegar + generador Android

### Cambiado (ROMPE el flujo v1 — migración limpia)

- **Reemplazo COMPLETO del sistema de activación de licencias**: el flujo
  ZIP + `license.json` + Installation ID/Disk ID a mano **desaparece**. El
  cliente ahora solo ve, en Administración → Licencia:
  1. «Copiar código de solicitud» (`VLREQ2-…`, la identidad del equipo viaja
     CIFRADA dentro del código — nunca visible);
  2. campo «Token de licencia» + «Activar licencia» (`VLBA2-…`);
  3. estado humano (PRUEBA ACTIVA / LICENCIA ACTIVA / LICENCIA VENCIDA /
     LICENCIA NO VÁLIDA / LICENCIA NO CORRESPONDE A ESTE EQUIPO), cliente,
     inicio, «Vence el DD/MM/YYYY» y «Restan X días».
- **Nuevas rutas API**: `POST /api/license/request-code` (genera el código
  sellado con la identidad OCULTA), `POST /api/license/activate` (pipeline
  de 12 pasos: formato → trama → firma Ed25519 → esquema → producto →
  fechas exactas → binding → anti-replay idempotente → anti-downgrade →
  guardado → auditoría → resumen seguro). ELIMINADAS `/api/license/identity`
  e `/api/license/import` (404).
- **Formatos v2** (Base32 RFC 4648 sin padding — guiones separadores
  inequívocos, tolerante a WhatsApp, case-insensitive):
  - `VLREQ2-…`: sealed box X25519 efímero → HKDF-SHA256 → AES-256-GCM con
    nonce, timestamp y CRC32; expira a los 15 días; solo la app del
    administrador puede abrirlo (nombre y Disk ID viajan cifrados).
  - `VLBA2-…`: payload JSON canónico firmado Ed25519 (licenseId, cliente,
    plan monthly/annual/custom + durationDays exacto, fechas epoch ms,
    binding, features, nonce) + CRC32.
- **Prisma**: migración `20260912000000_license_v2_token` (recreación de
  `LicenseState`/`LicenseHistory` — cero licencias v1 emitidas, sin impacto).

### Añadido

- **`android-license-generator/`** — app Android PRIVADA del administrador
  (Kotlin, minSdk 26): Nueva licencia (pegar VLREQ2 → validar → duración →
  generar → copiar token), Historial (búsqueda por cliente/licenseId,
  filtros, renovación, detalle), Backup `.vlbak` (crear/restaurar/verificar
  integridad), Ajustes (importar/rotar claves, cambiar PIN).
  - **DB local cifrada** con SQLCipher 4.6.1; master key con doble envoltura:
    Android Keystore AES-256-GCM (biometría, `setUserAuthenticationRequired`)
    y PIN (PBKDF2-SHA256 150k). PIN + biometría + auto-bloqueo 60 s.
  - **Anti-replay** (hash de solicitud registrado), **anti-downgrade**
    (recorte solo con acción administrativa explícita), licenseId único,
    auto-verificación de firma tras emitir.
  - `allowBackup=false` + data extraction rules: nada sale al cloud.
- **CI Android** (`.github/workflows/android-license-generator.yml`): JDK 17
  + SDK 35 fijos, lint, tests JVM, gitleaks + grep anti-claves en fuentes,
  build release firmado con secrets, análisis del artifact, checksum
  SHA-256 y APK `ViewLBA-License-Generator-v1.0.0.apk`.
- **Compatibilidad TS↔Kotlin garantizada** por vectores dorados generados
  por el mismo código del servidor (`scripts/gen-golden-vectors.ts`) y
  verificados en `CrossCompatTest` (JVM).

### Eliminado (flujo v1 — cero dead code)

- `tools/license-generator/` (CLI), `license-demo/` (servidor web demo),
  `.github/workflows/license-generator.yml`.
- `src/lib/licensing/zip.ts` y todo el flujo ZIP; rutas identity/import.
- Tests v1 (zip/import-flow/demo-server) — sustituidos por las suites v2.

### Verificado

- Servidor: 553 tests unit/integración PASS (licensing 178 + integración 20
  + E2E spec del flujo §25: copiar código → pegar token → LICENCIA ACTIVA).
- Android: 57 tests JVM PASS + lint PASS + APK release compilado y escaneado
  (0 rastros de material de claves) + vectores dorados byte a byte.
- gitleaks limpio (allowlist solo de fixtures DUMMY).

### Rotación de claves (corte limpio)

- Se generó un par NUEVO de claves Ed25519 (firma) y X25519 (solicitudes)
  para producción: las públicas van en `public-key.ts`; las privadas se
  entregan SOLO al administrador (fuera de banda) para importarlas en la app
  Android. Impacto: **cero** (no existían licencias activas).

## [1.2.1] — 2026-09-11 — Rotación de clave de firma Ed25519 (producción)

### Cambiado

- **Rotación del par de claves de PRODUCCIÓN del sistema de licencias**:
  `PRODUCTION_LICENSE_PUBLIC_KEY` en `src/lib/licensing/public-key.ts`
  ahora es `ZT_i…GhEg` (antes `hP5E…dKRY`).
  - **Motivo**: el par anterior fue emitido en v1.2.0 pero su clave privada
    nunca llegó a ningún canal operativo (ni secret, ni entrega fuera de
    banda registrada) → era imposible emitir licencias válidas para esa
    clave. Se rota ANTES de emitir la primera licencia a un cliente real:
    **cero impacto** (sin licencias activas en el campo, sin historial de
    emisiones).
  - La nueva clave privada queda SOLO en el secret de GitHub Actions
    `VIEWLBA_LICENSE_PRIVATE_KEY` (cifrado sealed-box) + copia custodiada
    por el dueño fuera de banda. **No está (ni estará) en el repo** —
    verificado con gitleaks + búsqueda de patrón.
  - Procedimiento conforme a `docs/LICENSE-SECURITY.md` §9 (Rotación de
    claves): nuevo par → pública en el verificador → release.
- **Instaladores re-compilados** con la clave pública nueva (v1.2.1):
  los instaladores de v1.2.0 verifican licencias firmadas con la clave
  retirada y NO deben usarse para despliegues con licencias reales.

### Verificado

- 136/136 tests de licensing (matriz de seguridad A–H: firma rota por
  1 byte, re-firmado con otra clave, vencida, mismatch de equipo/disco,
  planes 30/365 días exactos) tras la rotación.
- Emisión E2E local con la clave nueva: firma verificada de ida y vuelta;
  la misma licencia **falla** contra la clave retirada (comportamiento
  esperado).
- Workflow "License Generator" de GitHub Actions ejecutado con
  `workflow_dispatch` usando el secret: ZIP firmado + artifact publicado.

## [1.2.0] — 2026-09-11 — Licenciamiento offline + generador + GitHub Actions

### Añadido

- **Sistema de licencias 100% offline** (Ed25519, cero dependencias nuevas):
  vinculación a instalación (`INSTALLATION_ID VWLB-…`) + disco (`DISK-…`),
  firma sobre payload canónico, importación ZIP validada en su totalidad
  (firma → esquema → producto → fechas → equipo → disco → anti-downgrade),
  renovaciones con historial (`LicenseState`/`LicenseHistory`), y estados
  `trial · active · expired · invalid · mismatch · grace · unlicensed`.
- **Trial de 7 días** por instalación con anclas dobles fuera de la DB
  (resistente a borrado casual y reinstalación superficial), marca de agua
  discreta en la pantalla TV y banner en el panel.
- **Detección de retroceso de reloj** (high-water `lastSeenAt` + congelado
  del estado): volver el reloj atrás no alarga el trial ni revive licencias.
- **Feature gating premium real**: Pantallas (2ª en adelante), Logotipo,
  Apariencia, Usuarios, backup del Dashboard — bloqueado en UI (candado +
  panel) y en backend (403 en las rutas admin correspondientes).
- **API de licencias**: `GET /api/license` (público sin secretos, enriquecido
  para admin), `GET /api/license/identity`, `POST /api/license/import`;
  watermark de la TV integrado en `/api/content` (ETag invalidado al importar).
- **Auditoría de licencias** (sección "license"): `license_imported`,
  `license_rejected`, `license_expired`, `license_mismatch`, `trial_started`,
  `trial_expired`, `clock_tampering_detected`.
- **Generador de licencias separado** (`tools/license-generator/`):
  `generate · renew · verify · keys · history`, ZIP con `license.json` +
  `README.txt`, validaciones previas y auto-verificación de firma. La clave
  PRIVADA vive fuera del repo (docs/LICENSE-SECURITY.md).
- **Backup/restore consciente de licencias**: tablas incluidas en el backup
  verificado; binding SIEMPRE recalculado contra el hardware actual.
- **Tests**: 122 unitarios de licensing + 14 de integración (servidor real
  aislado) + 6 E2E del flujo completo del administrador.
- **Documentación**: `docs/LICENSE-SYSTEM.md`, `docs/LICENSE-GENERATOR.md`,
  `docs/LICENSE-SECURITY.md`.
- **Web demo del generador** (`license-demo/`, rama demo fusionada): backend
  Bun con MODO DEMO (clave efímera por sesión, jamás válida contra producción)
  y MODO ADMIN (clave real vía env + token de administración, sin token solo
  escucha localhost); la UI jamás recibe la clave privada (invariante testeada).
- **GitHub Actions para emitir licencias**
  (`.github/workflows/license-generator.yml`, `workflow_dispatch`): firma con
  el secret `VIEWLBA_LICENSE_PRIVATE_KEY` (enmascarado, nunca impreso), valida
  inputs, genera el ZIP, verifica la firma antes de publicar el artifact y
  falla de forma segura si falta el secret.
- **CI endurecido**: permisos `pull-requests:read` para gitleaks en PRs, suite
  de integración de licencias en el job de integración, y runtime sin archivos
  de DB/backups en el índice git (solo quedan como datos demo en el historial).
- **Repo**: versión 1.2.0 coherente en `package.json`, `Cargo.toml` y
  `tauri.conf.json`.

## [1.1.0] — 2026-09-09

### Añadido

- **Banner rotativo de Sugerencias del Día**: con varias sugerencias activas,
  el banner compacto rota automáticamente en bucle (7 s, ajustable con la
  velocidad de animación) con indicadores clicables y transición de
  deslizamiento suave.
- **Destellos en redes sociales**: barrido de luz sobre cada tarjeta, estrella
  titilante sobre la insignia de marca y respiración de glow — todo sutil,
  GPU-friendly (transform/opacity) y sincronizado con la velocidad global.
- Migración `scripts/update-ui-v1.1.ts`: limpia redes retiradas, ajusta
  `streamRatio` y añade sugerencias demo.

### Cambiado

- **Ofertas y Promociones ahora ocupa media pantalla** (`streamRatio`
  0.62 → 0.5): la columna de contenido pasa del 38 % al 50 % del ancho, con
  imagen de promoción más grande (42 % → 46 % de la tarjeta) y descripción en
  dos líneas.
- **Sugerencias del Día más estrecha**: de tarjeta flexible (~70 % de la
  columna) a banner horizontal fijo (~10.5 vh) con imagen cuadrada compacta,
  nombre y precio en una línea.
- **Arreglo importante**: el área de contenido del carrusel de promociones
  quedaba a altura 0 (la sección no crecía dentro de la columna) — ahora la
  sección es `flex-1` y las imágenes se ven a tamaño real.
- **Redes sociales**: solo Facebook · Instagram · WhatsApp (YouTube y TikTok
  fuera por ahora), franja más estrecha y compacta, insignias circulares con
  degradados oficiales de marca e iconos blancos.
- Panel: sección renombrada "Plato del Día" → "Sugerencias del Día"
  (sidebar y encabezado); slider de proporción de transmisión ampliado
  (45 %–80 %).

## [1.0.0] — 2026-09-09

### Añadido

- **Pantalla TV** (`/?view=tv`) — interfaz de señalización para televisores:
  transmisión de video en vivo como elemento dominante, reloj/fecha, horario del
  día con turno activo destacado, carrusel de promociones con ventanas de
  fecha/hora, plato del día, redes sociales, ticker (izquierda → derecha),
  identificación de pantalla (TV-001…), modo kiosco (wake lock, cursor oculto,
  tecla `S`), pantalla completa y watchdog de auto-recuperación.
- **Panel de administración** (`/?view=admin`) con 13 secciones: Dashboard,
  Transmisión, Promociones, Plato del Día, Horarios, Redes Sociales, Ticker,
  Logotipo, Audio (remoto), Pantallas, Apariencia, Usuarios y Registros.
- **Servidor de streaming RTMP integrado** (`mini-services/stream-service`,
  node-media-server): ingest RTMP :1935 con validación de clave, HTTP-FLV :8000,
  control interno :8100, rotación de clave sin reinicio y notificación en vivo
  a pantallas/admins.
- **Servicio realtime** (`mini-services/realtime-service`, Socket.io): registro
  y heartbeat de pantallas, snapshot de estado, comandos remotos (reload/audio),
  difusión de cambios de contenido y estado del stream.
- **Autenticación con roles** (ADMIN / OPERATOR / VIEWER) — sesiones firmadas
  HMAC + scrypt, cookies httpOnly.
- **Proxy server-side del FLV** (`/api/stream/live.flv`): la clave de
  transmisión nunca llega al navegador de la TV.
- **Multisección de contenido con actualización instantánea** (editar en admin
  → la TV se refresca sin recargar).
- **Fallback elegante** cuando no hay transmisión: mensaje configurable,
  imagen o video, con reconexión automática (5/10/15 s → fallback).
- **Branding ViewLBA**: logo, isotipo, favicon y presencia en administración;
  en la TV solo se muestra fuera de pantalla completa.
- **CI** (GitHub Actions): lint, typecheck, tests y build de producción.
- **Tests unitarios** (bun test) para validación de campos, red LAN y branding.
- Documentación: README, guía de despliegue LAN, seguridad, contribución.

### Seguridad

- Clave de transmisión enmascarada y revelable solo por ADMIN.
- Secretos fuera del repositorio (`.env` ignorado, `.env.example` documentado).
- Guard anti path-traversal en el servicio de archivos.
