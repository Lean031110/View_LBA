# Emisión de Licencias — Las 3 vías

El emisor (dueño del negocio, contacto **52973387**) puede emitir licencias por tres vías, todas con el mismo motor de firma. La vía recomendada para operación diaria es **GitHub Actions** (sin entorno local, todo auditado); el **CLI** es la vía completa (incluye renovación e historial); la **demo web** es cómoda para emitir desde el navegador.

## Datos que el cliente debe enviarte SIEMPRE

El cliente abre **Administración → Licencia** en su instalación y copia el bloque de solicitud:

```
ViewLBA — Solicitud de licencia
Nombre del cliente: <nombre>
Installation ID: VWLB-XXXX-XXXX-XXXX-XXXX
Disk ID: DSK-XXXX-XXXX-XXXX
Ruta: C:\PantallaRestaurante   (o /opt/viewlba en Linux)
```

Estos 3 identificadores son los que vinculan la licencia a ese equipo y ese disco (ver [[Binding-Hardware-y-Disco]]). Sin ellos no se puede emitir una licencia válida para esa instalación.

---

## Vía 1 — GitHub Actions (recomendada, 100% en GitHub)

1. Entra al repo → pestaña **Actions** → flujo **License Generator** → botón **Run workflow** (rama `main`).
2. Completa el formulario:
   - `customerName` — nombre del cliente (ej. `Leandro Bueno`)
   - `installationId` — tal cual lo envió el cliente (`VWLB-…`)
   - `diskId` — tal cual (`DSK-…`)
   - `installPath` — la ruta del cliente (default `C:\PantallaRestaurante`)
   - `plan` — `monthly` o `annual`
   - `startDate` — `YYYY-MM-DD` (vacío = hoy UTC)
3. **Run workflow** y espera ~1–2 min. El workflow: valida inputs → firma con el secret → **auto-verifica la firma de ida y vuelta** → comprueba que el ZIP no contenga material de clave → publica el **artifact**.
4. En la página del run, sección **Artifacts**, descarga `<cliente> license` (ZIP con `license.json` + `README.txt`). Caduca a los **14 días** (retención de artifacts) — si pasa ese tiempo, re-emite.
5. Envíale el ZIP al cliente por tu canal habitual (email, WhatsApp…).

Notas: el run falla inmediatamente (mensaje claro) si falta el secret `VIEWLBA_LICENSE_PRIVATE_KEY`; el resumen del run muestra los datos de la licencia (sin secretos).

---

## Vía 2 — CLI local (`tools/license-generator/`)

Requisitos: repo clonado + `bun install --frozen-lockfile` + la clave privada en un archivo con permisos 600 (o env `VIEWLBA_LICENSE_PRIVATE_KEY`).

```bash
# Emitir:
VIEWLBA_LICENSE_PRIVATE_KEY="$(cat /ruta/segura/viewlba-private.key)" \
bun tools/license-generator/cli.ts generate \
  --customer "Leandro Bueno" \
  --installation-id VWLB-8F2A-91CD-2D31-77AA \
  --disk-id DSK-A5ED-432A-37DD \
  --install-path "C:\\PantallaRestaurante" \
  --plan annual \
  --start 2026-09-11 \
  --out-dir out --force

# Renovar (verifica la licencia ORIGEN y emite una NUEVA con el mismo binding;
# rechaza downgrades — nunca vence antes que la origen):
bun tools/license-generator/cli.ts renew \
  --from ViewLBA-License-Leandro-Bueno-20260911.zip \
  --plan annual --start 2027-09-11

# Verificar cualquier licencia (tuya o del cliente):
bun tools/license-generator/cli.ts verify --file <zip-o-json> \
  [--installation-id VWLB-…] [--disk-id DSK-…]

# Historial local de emisiones (append-only, gitignored):
bun tools/license-generator/cli.ts history
```

Salida de `generate`: `ViewLBA-License-<Cliente>-<AAAAMMDD>.zip` (fecha = inicio de vigencia) + resumen con vencimiento y `licenseId` (`VLBA-XXXXXXXXXXXX`). El historial vive en `tools/license-generator/history/history.jsonl` — **nunca** contiene la clave privada.

Atajos de `package.json`: `bun run license:generate -- …` y `bun run license:keys`.

---

## Vía 3 — Demo web (`license-demo/`)

Servidor independiente (Bun puro, 0 dependencias) con UI para emitir/renovar/regenerar/verificar/exportar desde el navegador. **La clave privada nunca llega al navegador.**

```bash
# MODO ADMIN (emisión REAL — clave de producción del env + token de protección):
VIEWLBA_LICENSE_PRIVATE_KEY="<base64url>" \
DEMO_ADMIN_TOKEN="<token-largo>" \
bun license-demo/server.ts          # escucha 0.0.0.0:3210

# MODO DEMO (público, para enseñar el flujo — clave EFÍMERA por arranque,
# las licencias NO valen en producción):
DEMO_MODE=true bun license-demo/server.ts    # localhost:3210
```

Reglas de seguridad: sin `DEMO_ADMIN_TOKEN` el modo ADMIN solo escucha `127.0.0.1` (acceso remoto seguro SOLO con token); las respuestas HTTP nunca incluyen la clave ni fragmentos; en modo demo las claves se regeneran en cada arranque. Ver `license-demo/README.md`.

---

## Qué contiene el ZIP entregado al cliente

- **`license.json`** — payload firmado (`schemaVersion`, `licenseId`, `customerName`, `plan`, `issuedAt`, `startsAt`, `expiresAt`, `deviceId`, `diskId`, `installPath`, `product`, `features`) + `signature` Ed25519 (base64url, 64 bytes).
- **`README.txt`** — instrucciones de importación y contacto de soporte (52973387).

El cliente lo importa en **Administración → Licencia → IMPORTAR LICENCIA** — ver [[Importación-de-Licencia]].

## Elección de plan y cálculo de vigencia (exacto)

- `monthly`: **30 días exactos** desde `startDate` (USD 10)
- `annual`: **365 días exactos** desde `startDate` (USD 100) — **nunca** 30×12
- `trial`: no se emite — es automático en la app (7 días)

Siguiente: [[Planes-y-Precios]].
