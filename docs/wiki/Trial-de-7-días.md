# Trial de 7 días

El trial es **automático** (no se emite, no se factura): al primer arranque de una instalación sin licencia, empiezan 7 días de prueba con funciones limitadas y marca de agua. El objetivo de su diseño es resistir la manipulación **casual** (borrar archivos, restaurar backups, volver el reloj) sin ocultar que un atacante con privilegios de administrador y conocimiento del formato puede, en última instancia, falsear las anclas — ese escenario queda cubierto por el soporte y el contrato (52973387), no por más capas de DRM.

## Anclas duales (resistentes al borrado casual)

El estado del trial vive en DOS archivos, no en la DB:

1. **`<dataDir>/licensing/state.json`** — junto a los datos de la app.
2. **`~/.viewlba-license.json`** — en el home del usuario (sobrevive a reinstalaciones superficiales de la app).

Cada ancla es un JSON firmado con **HMAC-SHA256** (`stamp`) cuya clave deriva del `deviceIdHash` — por eso:

- **Anclas ajenas se ignoran** (copiar el home de otra máquina no transfiere el trial — el `deviceIdHash` no coincide).
- **Editar un ancla a mano** rompe el `stamp` → `integrityWarnings` + **no hay trial nuevo**.
- **Borrar UNA ancla** → la otra conserva `trialStartAt` (la fusión usa el **inicio más temprano**: `trialStartAt` mínimo, `lastSeenAt` máximo, flags sticky OR).
- **Borrar la DB** → el trial NO está en la DB: sobrevive.
- **Reinstalar la app superficialmente** → el ancla del home sobrevive.

## Anti-rollback de reloj

Cada evaluación registra `lastSeenAt` (marca de agua temporal). Si el reloj del sistema retrocede respecto a `lastSeenAt` (tolerancia 2 h para DST/NTP):

- `clockTampered = true` (flag **sticky**: persiste aunque el reloj vuelva a ser correcto).
- La evaluación del trial se **congela** (no se recuperan días, no se revive una licencia vencida).
- Evento de auditoría `clock_tampering_detected`.
- Instalar/reinstalar no lo limpia (anclas persisten).

## Ciclo del trial

| Momento | Estado | Qué pasa |
|---|---|---|
| Primer arranque | `trial` | Se escribe `trialStartAt` en ambas anclas + evento `trial_started` |
| Día 1–6 | `trial` | App funcional, marca de agua "VERSIÓN DE PRUEBA · Quedan X días" |
| Día 7 | `trial` | "Último día de prueba" |
| Día 8+ | `unlicensed` | `trial_expired` — marca de agua final, features premium bloqueados |
| Importa licencia válida | `active` | El trial deja de evaluarse; marca de agua desaparece |
| Licencia vence | `expired` | Se puede renovar ([[Emisión-de-Licencias]]) |

## No-repetición del trial

"Una sola vez por instalación" se garantiza por el binding de las anclas al `deviceIdHash` (equipo) + su persistencia fuera de la DB. Reintentos típicos:

| Intento del usuario | Resultado |
|---|---|
| Borrar la DB (o restaurar backup viejo) | El trial vive en las anclas → sigue contando/no renace |
| Borrar UNA ancla | La otra conserva el inicio → mismo resultado |
| Borrar AMBAS anclas (usuario técnico) | **Vulnerabilidad conocida y documentada** (§4 de `docs/LICENSE-SECURITY.md`) — requeriría encontrar ambos archivos, entender el formato y falsificar el HMAC; para ese perfil la respuesta es comercial |
| Copiar el home de otra máquina | Anclas ligadas a otro `deviceIdHash` → se ignoran |
| Volver el reloj | High-water + `clockTampered` sticky → congelado |

## Relación con la ventana de gracia

Paralelo al trial, las licencias **comerciales vencidas** tienen una ventana de gracia opcional (`LICENSE_GRACE_HOURS`, ver [[Importación-de-Licencia]]): dentro de ella el estado es `grace` (todo funciona, con aviso de renovación). El trial NO tiene ventana de gracia: el día 8 es `unlicensed`.

Siguiente: [[Importación-de-Licencia]].
