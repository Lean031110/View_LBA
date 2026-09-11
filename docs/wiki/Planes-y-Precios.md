# Planes y Precios

Los planes están definidos en `src/lib/licensing/types.ts` como fuente única de verdad, y las duraciones son **exactas** (días calendario, sin aproximaciones):

| Plan | Duración exacta | Precio | Cómo se obtiene |
|---|---|---|---|
| **TRIAL** | 7 días (`TRIAL_DAYS = 7`) | Gratis | **Automático** al primer arranque de cada instalación — no se emite, no se factura |
| **MENSUAL** (`monthly`) | 30 días (`PLAN_DURATION_DAYS.monthly = 30`) | USD 10 | Licencia emitida por el proveedor |
| **ANUAL** (`annual`) | 365 días (`PLAN_DURATION_DAYS.annual = 365`) | USD 100 | Licencia emitida por el proveedor |

> ⚠️ El plan anual son **365 días exactos**, NO 30×12=360. Este detalle está cubierto por tests específicos: "plan mensual: 30 días exactos de vigencia" y "plan anual: 365 días exactos" (tests de la matriz de seguridad del validador). Un error aquí recortaría 5 días a cada cliente anual.

## Trial (detallado)

- Una sola vez **por instalación** (binding a hardware + disco — ver [Trial-de-7-días](Trial-de-7-días.md) para la mecánica de anclas y anti-manipulación).
- Funcional pero **limitado + marca de agua** en la pantalla TV (ver abajo) y banner en el panel de administración.
- Al agotarse (`unlicensed`): la app sigue mostrando contenido básico, pero las funciones premium quedan bloqueadas y la marca de agua cambia a "PERÍODO DE PRUEBA FINALIZADO".

## Marca de agua de la TV (textos exactos)

| Estado | Líneas que se muestran |
|---|---|
| `trial` | `VERSIÓN DE PRUEBA · ViewLBA` / `Quedan X días` (o `Queda 1 día` / `Último día de prueba`) / `Activar licencia: 52973387` |
| `unlicensed` | `PERÍODO DE PRUEBA FINALIZADO · ViewLBA` / `Para continuar, activa tu licencia: 52973387` |
| `expired` | `LICENCIA VENCIDA · ViewLBA` / `Renueva tu licencia: 52973387` |

Con licencia `active` (o `grace`): sin marca de agua.

## Feature gating por plan/estado

El gating es **del lado del servidor** (nunca del navegador): las rutas de administración responden **403** cuando el estado no lo permite, y la UI muestra candados. Flags (funciones REALES del producto):

| Feature | Trial | Active |
|---|---|---|
| `display.watermark` (marca de agua TV) | ✅ visible | ❌ (sin marca) |
| `screens.multiDisplay` (2ª pantalla en adelante) | 🔒 bloqueado | ✅ |
| `branding.customLogo` (logotipo propio) | 🔒 | ✅ |
| `users.management` (gestión de usuarios) | 🔒 | ✅ |
| `backup.selfService` (backup manual del Dashboard) | 🔒 | ✅ |
| `analytics.advanced` (métricas avanzadas) | 🔒 | ✅ |
| `themes.custom` (Apariencia) | 🔒 | ✅ (reservado — sin UI de implementación; las licencias pueden activarlo explícitamente vía el campo `features`) |

Ni el trial ni el plan cambian el precio de la licencia: `PLAN_PRICE_USD` es informativo (documentación/UI); el cobro es gestión comercial del proveedor (contacto 52973387).

## Cómo afecta el plan a la emisión

- El emisor elige `--plan monthly|annual` (CLI) o el campo `plan` del formulario de Actions.
- `startDate` (`YYYY-MM-DD`, default hoy UTC) + duración exacta → `startsAt`/`expiresAt` (ISO 8601 UTC) en la licencia.
- La renovación (`renew`) puede cambiar de plan y siempre emite una licencia **nueva** con `licenseId` nuevo (la anterior queda en el historial; el `licenseId` es `VLBA-XXXXXXXXXXXX`, 12 hex aleatorios).
- El validador acepta **cualquier** `plan` del enum en la firma; el vencimiento real lo marcan las fechas firmadas, no el nombre del plan.

Siguiente: [Binding-Hardware-y-Disco](Binding-Hardware-y-Disco.md).
