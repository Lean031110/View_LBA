# ViewLBA — Modelo de seguridad del licenciamiento

> Objetivo real del diseño: **impedir la copia casual y la manipulación
> trivial**, con verificación 100% offline. NO es un DRM "militar": un atacante
> con control total del equipo siempre puede, en el peor caso, degradar la
> experiencia. Este documento es honesto sobre qué protege y qué no.

## 1. Criptografía

- **Ed25519** (node:crypto, cero dependencias nuevas).
- La firma cubre la **forma canónica** del payload completo excepto `signature`
  (claves ordenadas recursivamente — ver `canonical.ts`). Cambiar 1 byte de
  cualquier campo (cliente, fechas, IDs, plan, features) invalida la firma.
- La clave **privada existe solo en el emisor** (generador CLI / demo web
  protegida / GitHub Actions via secret). El producto (frontend, TV, bundle,
  instaladores, repo público del código) contiene **únicamente la clave
  pública** (`src/lib/licensing/public-key.ts`).
- Longitudes: hash de fingerprint 256 bits; Installation ID público 64 bits
  (prefijo del hash); Disk ID público 48 bits. Suficiente para el modelo
  "anti-copia casual": fabricar una segunda instalación con el mismo ID
  exigiría ~2^64 intentos.

## 2. Dónde NO está la clave privada (verificado)

| Lugar | Estado |
|---|---|
| Repo git (historial escaneado por gitleaks en CI) | ✗ no está |
| Frontend / bundle del navegador | ✗ (solo constants de features en cliente) |
| Pantalla TV | ✗ (la TV solo consume `/api/content` público) |
| Instaladores `.exe` / `.deb` / AppImage | ✗ (ver §8) |
| Logs / auditoría | ✗ (`redact()` + nunca se registran firmas/claves) |
| Tests / fixtures | ✗ (claves DUMMY de test, nunca válidas en producción) |

La app **no contiene ninguna ruta de código** que lea una clave privada del
entorno por defecto: `signLicense()` solo se invoca desde el generador y tests
con la clave como **argumento explícito**.

## 3. Verificación offline (sección 17 del requisito)

`validateLicense()` NO hace ninguna llamada de red. La única operación externa
del ciclo de vida es la **entrega manual del ZIP**. No existe
`fetch("licensing-server")` en el producto.

## 4. Trial: qué resiste y qué no

**Resiste** (manipulación casual):
- Borrar la DB / restaurar un backup viejo → el trial vive en anclas FUERA de la DB.
- Borrar UNA ancla → la otra conserva `trialStartAt` (fusión earliest-start).
- Reinstalar la app superficialmente → el ancla del home (`~/.viewlba-license.json`) sobrevive.
- Editar las anclas a mano → sello HMAC inválido → `integrityWarnings` y **no hay trial nuevo**.
- Retroceder el reloj → `lastSeenAt` (high-water) congela la evaluación; no se recuperan días ni se revive una licencia vencida (tolerancia 2 h para DST/NTP).
- Copiar el home a otra máquina → las anclas están ligadas al `deviceIdHash` (se ignoran).

**NO resiste** (y no pretende): un atacante que localiza AMBAS anclas, entiende
el formato y además conoce el `AUTH_SECRET` local puede falsificar el estado del
trial. Requiere esfuerzo deliberado y acceso de administrador; para ese perfil
de atacante la respuesta es comercial/legal, no técnica.

## 5. Binding de hardware: límites conocidos

| Escenario | Resultado |
|---|---|
| Cambio de hostname / IP / tarjeta de red | ✓ mismo Installation ID (machineId primario) |
| Upgrade de RAM/CPU (con machineId) | ✓ mismo ID |
| Reinstalación del SO | ✗ nuevo machineId → MISMATCH → nueva licencia |
| Cambio de disco / clonación a otro volumen | ✗ MISMATCH (deseado: sección 19) |
| Contenedores/CI (sin disco real) | Binding débil de fallback (método `weak-fallback`) — solo entornos de test |
| VMs con machineId compartido (clon de imagen) | Posible colisión de Installation ID — caso raro; el Disk ID diferencia |

El `installPath` **no** es binding estricto (mover la carpeta dentro del mismo
disco produce solo una advertencia informativa).

## 6. Superficies de ataque y mitigaciones

| Ataque | Mitigación |
|---|---|
| Editar `license.json` del ZIP | Firma Ed25519 → `invalid` |
| Re-firmar con clave propia | La pública incrustada no coincide → `invalid` |
| Copiar el ZIP a otro restaurante | Binding Installation/Disk ID → `mismatch` |
| Restaurar DB de otro equipo | El binding se recalcula en cada evaluación → `mismatch` |
| Regresar el reloj | High-water + `clockTampered` (sticky) |
| Borrar anclas de trial | Doble ancla + fusión earliest-start |
| API: importar sin permiso | `POST /api/license/import` exige ADMIN (sesión) |
| API: leer identidad sin permiso | `GET /api/license/identity` exige OPERATOR+ |
| Escuchar el endpoint público | Solo estado/watermark/features — sin datos de cliente ni IDs |
| Zip bomb / ZIP gigante | Límites: 1 MB de subida, ≤100 entradas, ≤10 MB/entrada, CRC obligatorio |
| Downgrade por importación | Rechazo de licencias que acorten la vigencia activa |
| Fuerza bruta de login de admin | rate-limit existente del proyecto |

## 7. Auditoría y no-repudio ligero

`license_imported / license_rejected / license_expired / license_mismatch /
trial_started / trial_expired / clock_tampering_detected` en la tabla `Log` +
logger JSON (stdout/archivo rotativo), con `redact()`. Las respuestas de la API
nunca incluyen firmas completas ni hashes de binding completos.

## 8. Verificación de empaquetado (sección 28/29 del requisito)

Comprobaciones antes de cada release (además de CI):

```bash
# 1) Ningún secreto en el historial (bloqueante en CI — gitleaks)
bunx gitleaks detect --source . -v

# 2) La clave privada NO aparece en el árbol de fuentes
rg -l "VIEWLBA_LICENSE_PRIVATE_KEY" src/ public/ installer/ mini-services/ || echo "OK: solo docs/tools"

# 3) El bundle/instalador no contiene la clave privada ni licencias reales
#    (tras el build, sobre el payload del instalador)
strings <payload-del-instalador> | rg -i "private|BEGIN|seed|license.json" || echo "OK"
```

Reglas del `.gitignore`: `tools/license-generator/{out,history,keys,*.key}` y
`data/licensing/` nunca se commitean.

## 9. Rotación de claves

1. Generar nuevo par (`cli.ts keys`).
2. Actualizar `PRODUCTION_LICENSE_PUBLIC_KEY` en `src/lib/licensing/public-key.ts`.
3. Publicar release; las licencias viejas dejan de validar → re-emitir a clientes activos
   (o emitir el nuevo par con `schemaVersion` nuevo en una migración futura si se
   quiere convivencia de claves — la arquitectura lo soporta añadiendo un
   `kid` al payload y un mapa clave→`kid` en el verificador).

## 10. Aviso de alcance

El sistema protege el **uso comercial legítimo** contra copias triviales y
errores humanos. Un usuario técnico con privilegios de administrador SOBRE SU
PROPIA máquina puede, en última instancia, alterar binarios/entorno local. La
respuesta para ese escenario es el soporte (52973387) y el contrato de licencia,
no más capas de DRM.
