# SCREEN_PAIRING — vinculación de pantallas por código temporal (FASE 32, VERIFIED)

> Flujo verificado E2E (3 specs) + tests del servicio (16/16): vinculación
> completa, re-vinculación con invalidación del token anterior y código sin
> TV esperando.

## El flujo

```
TV nueva (navegador limpio)
  → abre /?view=tv → muestra CÓDIGO DE 6 DÍGITOS (renovable, TTL 10 min)
  → espera en el room pair:<código> del realtime (con re-join periódico)

ADMIN (panel → Pantallas)
  A) "Nueva pantalla": código de la TV + nombre + ubicación
     → crea la pantalla (code TV-### automático si no se indica)
     → genera token aleatorio → sha256 en la DB → entrega por el room
  B) "Vincular" en la tarjeta de una pantalla existente (solo ADMIN)
     → token nuevo → entrega por el room de la TV que espera

TV
  → recibe {screenCode, token} → persiste en localStorage
  → se registra con el token → VERIFICADA (sha256 coincide)
  → reinicios conservan la identidad (localStorage)
```

## Propiedades de seguridad

- **`screenCode` NUNCA es el secreto**: cualquier TV puede *saber* que existe TV-001; sin el token no puede suplantarla.
- El token existe en claro solo: (a) durante la entrega única al room, (b) en el localStorage de la TV. En la DB solo hay **sha256(token)** — un robo de BD no permite suplantar pantallas.
- La entrega va SOLO al room `pair:<código>` (prefijo validado en el servicio): únicamente la TV que mostró ese código en pantalla lo recibe. Código de 6 dígitos + TTL 10 min + rate-limit (5 intentos/socket).
- **Regenerar invalida el anterior de inmediato**: la TV con token viejo es rechazada al re-registrarse → limpia su identidad → muestra código nuevo para re-vincular.
- Orden crítico verificado: el hash nuevo rige en la DB **antes** del broadcast (la TV re-registra al instante; un hash huérfano se revierte a null si nadie recibió el token).

## Casos de rechazo (todos verificados por tests)

| Caso | Resultado en la TV |
|---|---|
| Código inventado / pantalla no reconocida | `screen:rejected` → selector |
| Pantalla INACTIVA | `screen:rejected` → selector |
| Token incorrecto (suplantación) | `screen:rejected` → limpia identidad → selector con código nuevo |
| Token correcto | Registrada + `verified: true` |
| Token regenerado (antiguo ya inválido) | Rechazo → re-vinculación |

## Selección manual (pantallas de prueba)

El selector también permite elegir una pantalla de la lista SIN código — da
identidad **no verificada** (útil para pruebas). Las pantallas con token
solo aceptan vinculación por código.

## Recomendación operativa

Vincular cada TV física con su código el día de la instalación y etiquetar el
código de pantalla en la own TV (TV-001 "Barra", TV-002 "Terraza"…). Para
re-vincular (TV cambiada de sitio, fábrica reseteada): tecla `S` en la TV →
botón "Vincular" del panel.
