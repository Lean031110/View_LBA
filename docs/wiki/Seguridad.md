# Seguridad — Dónde NO están las claves privadas y matriz de ataques

Documento vivo de las garantías verificadas. Fuente de verdad adicional:
`docs/LICENSE-SECURITY.md` y el job de gitleaks en CI.

## Dónde NO están las claves privadas (verificado)

| Lugar | Estado |
|---|---|
| Repo git (historial completo escaneado por gitleaks en cada CI) | ✗ no están |
| Servidor ViewLBA (bundle/standalone) — SOLO hay públicas | ✗ |
| Frontend / bundle del navegador | ✗ |
| Pantalla TV | ✗ (la TV solo consume `/api/content` público) |
| Instaladores `.exe` / `.deb` / AppImage | ✗ |
| APK del generador (análisis de strings en CI) | ✗ |
| Logs / auditoría | ✗ (`redact()`; jamás se registran claves ni firmas) |
| Tests / fixtures | ✗ (claves DUMMY de test — nunca válidas en producción) |
| Wiki / docs | ✗ (se documentan PROCEDIMIENTOS, nunca material de clave) |
| GitHub Secrets | ✗ (los secrets solo firman el APK, no son claves de licencias) |

Dónde SÍ están: la **DB cifrada (SQLCipher)** de la app Android del
administrador — con la master key envuelta por **Android Keystore**
(AES-256-GCM, biometría) y por el **PIN** (PBKDF2, 150k) — y su
**backup `.vlbak`** (AES-256-GCM con contraseña).

## Matriz de ataques y mitigaciones (v2)

| Ataque | Mitigación | Resultado observado |
|---|---|---|
| Editar el token VLBA2 (1 byte) | Firma Ed25519 sobre bytes exactos + CRC32 | Rechazo (test) |
| Re-firmar con clave propia | La pública del servidor no coincide | `invalid` (test) |
| Alterar el código de solicitud | Tag AES-GCM + CRC32 | "no se puede abrir" (test) |
| Abrir solicitud con otro emisor | ECDH → clave distinta → tag inválido | null (test) |
| Copiar el token a otro restaurante | Binding recalculado contra hardware | `mismatch` (tests) |
| Restaurar DB de otro equipo | Binding recalculado en cada evaluación | `mismatch` |
| Re-pegar un token ya activo | Idempotencia (`alreadyActive`) sin duplicar | 200 OK (test) |
| Re-usar una solicitud (replay) | Hash registrado en el emisor | Rechazo → «Renovar» (test) |
| Renovación que acorta | Anti-downgrade + acción administrativa | Rechazo (test) |
| Token truncado/excesivo/versión futura | Validación estructural estricta | `bad_*` (tests) |
| Regresar el reloj | High-water `lastSeenAt` + `clockTampered` sticky | Congelado (test) |
| Borrar anclas de trial | Doble ancla + fusión earliest-start | Trial NO renace (test) |
| Activar sin permiso | `POST /api/license/activate` exige ADMIN + rate limit | 401/403/429 |
| Leer identidad técnica | La ruta `/identity` **no existe**; `/api/license` no expone binding | 404 / sin datos |
| Fuerza bruta de login admin | rate-limit existente del proyecto | Bloqueo |
| Fuga de secretos en git | gitleaks bloqueante en CI (push/PR/release) | Build rojo |
| Claves en fuentes del generador | grep anti-material + análisis del APK en CI | Build rojo |

## Verificación de empaquetado (antes de cada release)

```bash
# 1) Ningún secreto en el historial (bloqueante en CI):
bunx gitleaks detect --source . -v

# 2) Sin material de clave en las fuentes del generador:
rg -iE "BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY" android-license-generator/app/src/ || echo "OK"

# 3) El APK no contiene material de clave (CI lo ejecuta):
unzip -p app-release.apk classes.dex | strings | rg "PRIVATE KEY" || echo "OK"
```

`.gitignore` cubre `android-license-generator/` (keystores, APKs, `.vlbak`,
`local.properties`) y `data/licensing/` — jamás commiteados.

## Límites honestos del diseño

El objetivo real es **impedir la copia casual y la manipulación trivial**,
con verificación 100% offline — NO es un DRM "militar":

- Un atacante con control total de su equipo puede, en el peor caso,
  degradar la experiencia localmente.
- Falsificar el estado del trial exige localizar AMBAS anclas, entender el
  formato HMAC y conocer el `AUTH_SECRET` local.
- Un teléfono del administrador con bootloader desbloqueado + ataque
  dirigido podría comprometer la bóveda (mitigado con StrongBox cuando
  existe + backups cifrados).
- La rotación de claves invalida los tokens anteriores (ver
  [Mantenimiento-y-Rotación](Mantenimiento-y-Rotación.md)).

## Contacto

Cualquier incidente de seguridad, sospecha de licencia falsificada o fuga
de material: **52973387**.

Siguiente: [Mantenimiento-y-Rotación](Mantenimiento-y-Rotación.md).
