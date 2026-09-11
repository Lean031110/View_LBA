# Binding de Hardware y Disco

Cada licencia se vincula a **una instalación concreta**: un equipo (Installation ID) y un disco (Disk ID). El binding se **recalcula contra el hardware actual en cada evaluación** — nunca se confía en un valor cacheado, así que restaurar una DB de otro equipo o clonar el disco produce `mismatch`.

## Installation ID (`VWLB-XXXX-XXXX-XXXX-XXXX`)

- **Qué es**: identificador público de la instalación — 16 hex (64 bits) derivado como prefijo del `deviceIdHash` (SHA-256 completo del fingerprint de hardware).
- **Fuentes** (en orden de preferencia, `fingerprint.ts`):
  1. **machine-id del sistema** (Linux: `/etc/machine-id`; Windows: MachineGuid del registro) → método `machine-id`. Es el primario: estable ante cambios de hostname, IP, RAM/CPU.
  2. **composite** (fallback): normalización de múltiples señales (modelo CPU, cores, RAM total, hostname, arquitectura) cuando no hay machine-id.
- **Qué NO afecta**: cambio de hostname, IP o tarjetas de red; upgrades de RAM/CPU (siendo machine-id estable); mover la carpeta de instalación dentro del mismo disco.
- **Qué SÍ lo cambia**: reinstalación del SO (nuevo machine-id → MISMATCH → requiere licencia nueva).

## Disk ID (`DSK-XXXX-XXXX-XXXX`)

- **Qué es**: identificador público del **volumen/disco** de instalación — 12 hex (48 bits), prefijo del `diskIdHash` (SHA-256 del UUID/serial del disco).
- **Fuentes por SO** (`disk-binding.ts`):

| SO | Fuente del UUID/serial | Métodos |
|---|---|---|
| Linux | UUID del filesystem | `findmnt-uuid` → `lsblk-uuid` → symlink `/dev/disk/by-uuid` → `mountinfo` |
| Windows | Número de serie del **volumen** (`vol C:`) | `vol-serial` — estable del volumen, sobrevive a formateos de otras particiones |
| macOS | `diskutil` | `diskutil-uuid` |
| Contenedores/CI | sin disco real | `weak-fallback` (binding débil — solo entornos de test) |

- **Por qué disco y no ruta**: la ruta (`C:\PantallaRestaurante` vs `D:\apps\viewlba`) es solo informativa — mover la carpeta dentro del **mismo** disco produce a lo sumo una advertencia informativa (`installPathWarning`), no un mismatch. Cambiar de **disco/volumen** sí produce MISMATCH (diseño intencional: una licencia por instalación física).

## Matriz de comportamiento (verificada en tests)

| Escenario | Resultado |
|---|---|
| Mismo equipo + mismo disco | ✅ `active` |
| Mismo equipo, disco distinto (o disco clonado a otro volumen) | ❌ `mismatch` (motivo: diskId esperado vs encontrado) |
| Otro equipo (aunque sea mismo modelo) | ❌ `mismatch` (motivo: installationId) |
| Ambos distintos | ❌ `mismatch` con 2 motivos |
| Restaurar DB de otro equipo | ❌ `mismatch` (binding recalculado en runtime) |
| Mismo equipo/disco, distinta ruta | ✅ válido + advertencia informativa |
| Reinstalación del SO | ❌ MISMATCH → emitir licencia nueva |

## Cómo el cliente envía sus IDs

**Administración → Licencia** muestra el bloque de solicitud con Installation ID, Disk ID y ruta (`GET /api/license/identity`, requiere sesión OPERATOR+ — la API nunca expone los hashes completos, solo los IDs públicos). Ese bloque es lo que se envía al emisor para generar la licencia.

## Detección de cambio de disco/equipo en cliente ya licenciado

Si un cliente cambia de disco o de equipo, su licencia deja de validar con estado `mismatch` y el detalle (solo visible para el admin) muestra expected vs found. El procedimiento comercial es **emitir una licencia nueva** con los nuevos IDs (sección 19 del diseño: el sistema NO re-vincula licencias — evita que una misma licencia "migre" de instalación en instalación sin control del emisor).

## Longitudes y modelo de amenaza

- Installation ID público: 64 bits de binding. Disk ID público: 48 bits. Fabricar una segunda instalación con los mismos IDs exigiría ~2⁶⁴ intentos — suficiente para el modelo "anti-copia casual" (ver [Seguridad](Seguridad.md)). El objetivo NO es un DRM "militar": un atacante con control total de su máquina puede, en el peor caso, degradar la experiencia. La respuesta para ese perfil es comercial/legal.

Siguiente: [Trial-de-7-días](Trial-de-7-días.md).
