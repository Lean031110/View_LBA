# Seguridad — Dónde NO está la clave privada y matriz de ataques

Documento vivo de las garantías verificadas. Fuente de verdad adicional: `docs/LICENSE-SECURITY.md` (§ por §) y el job de gitleaks en CI.

## Dónde NO está la clave privada (verificado)

| Lugar | Estado |
|---|---|
| Repo git (historial completo escaneado por gitleaks en cada CI) | ✗ no está |
| Frontend / bundle del navegador | ✗ (solo constantes de features en cliente) |
| Pantalla TV | ✗ (la TV solo consume `/api/content` público) |
| Instaladores `.exe` / `.deb` / AppImage | ✗ (job de release ejecuta gitleaks + validaciones de empaquetado) |
| Logs / auditoría | ✗ (`redact()` + nunca se registran firmas ni claves completas) |
| Tests / fixtures | ✗ (claves DUMMY de test — nunca válidas en producción) |
| Artifacts de workflows | ✗ (el workflow aborta si el ZIP contiene fragmento de clave) |
| Wiki | ✗ (esta wiki documenta PROCEDIMIENTOS, nunca material de clave) |

La app no tiene ninguna ruta de código que lea una clave privada del entorno por defecto: `signLicense()` solo se invoca desde el generador y los tests, con la clave como **argumento explícito**.

## Matriz de ataques y mitigaciones

| Ataque | Mitigación | Resultado observado |
|---|---|---|
| Editar `license.json` del ZIP | Firma Ed25519 sobre payload canónico | `invalid` (test B: 1 byte → FAIL) |
| Re-firmar con clave propia | La pública incrustada no coincide | `invalid` (test G) |
| Copiar el ZIP a otro restaurante | Binding Installation/Disk ID recalculado en runtime | `mismatch` (tests E/F) |
| Restaurar DB de otro equipo | Binding recalculado en cada evaluación | `mismatch` |
| Regresar el reloj | High-water `lastSeenAt` + `clockTampered` sticky | Congelado (test específico) |
| Borrar anclas de trial | Doble ancla + fusión earliest-start | Trial NO renace (test) |
| Editar anclas a mano | Sello HMAC-SHA256 por `deviceIdHash` | `integrityWarnings`, sin trial nuevo |
| API: importar sin permiso | `POST /api/license/import` exige ADMIN | 401/403 |
| API: leer identidad sin permiso | `GET /api/license/identity` exige OPERATOR+ | 401/403 |
| Escuchar el endpoint público | Solo estado/watermark/features | Sin datos de cliente ni IDs |
| Zip bomb / ZIP gigante | Límites: 1 MB subida, ≤100 entradas, ≤10 MB/entrada, CRC | Rechazo temprano |
| Downgrade por importación | Anti-downgrade de vigencia | Rechazo (test) |
| Fuerza bruta de login admin | rate-limit existente del proyecto | Bloqueo |
| Fuga de secretos en git | gitleaks bloqueante en CI (push/PR/release) | Build rojo |

## Verificación de empaquetado (sección 28/29 — antes de cada release)

```bash
# 1) Ningún secreto en el historial (bloqueante en CI):
bunx gitleaks detect --source . -v

# 2) La clave privada NO aparece en el árbol de fuentes:
rg -l "VIEWLBA_LICENSE_PRIVATE_KEY" src/ public/ installer/ mini-services/ || echo "OK: solo docs/tools"

# 3) El bundle/instalador no contiene clave privada ni licencias reales:
strings <payload-del-instalador> | rg -i "private|BEGIN|seed|license.json" || echo "OK"
```

`.gitignore` cubre: `tools/license-generator/{out,history,keys,*.key}` y `data/licensing/` — jamás commiteados.

## Límites honestos del diseño (§ "Aviso de alcance")

El objetivo real es **impedir la copia casual y la manipulación trivial**, con verificación 100% offline — NO es un DRM "militar":

- Un atacante con control total de su equipo puede, en el peor caso, degradar la experiencia localmente.
- Falsificar el estado del trial exige localizar AMBAS anclas, entender el formato HMAC y conocer el `AUTH_SECRET` local — esfuerzo deliberado, respuesta comercial/legal.
- VMs clonadas de la misma imagen pueden colisionar en machine-id (caso raro; el Disk ID diferencia).
- La rotación de claves invalida las licencias anteriores (ver [[Mantenimiento-y-Rotación]]).

## Contacto

Cualquier incidente de seguridad, sospecha de licencia falsificada o fuga de material: **52973387**.

Siguiente: [[Mantenimiento-y-Rotación]].
