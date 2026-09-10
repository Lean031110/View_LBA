# ViewLBA License Generator

Herramienta de emisión de licencias — **separada del producto** (sección 7 del
diseño). Posee la clave PRIVADA de firma; la app del cliente solo verifica con
la clave pública.

> Manual completo: [`docs/LICENSE-GENERATOR.md`](../../docs/LICENSE-GENERATOR.md)
> Seguridad: [`docs/LICENSE-SECURITY.md`](../../docs/LICENSE-SECURITY.md)

## Uso rápido

```bash
# 1) Claves (una sola vez — la privada NUNCA al repo)
bun tools/license-generator/cli.ts keys --write-private /ruta/segura/viewlba-private.key

# 2) Emitir licencia
VIEWLBA_LICENSE_PRIVATE_KEY="<…>" \
bun tools/license-generator/cli.ts generate \
  --customer "Leandro Bueno" \
  --installation-id VWLB-8F2A-91CD-2D31-77AA \
  --disk-id DSK-A5ED-432A-37DD \
  --install-path "C:\\PantallaRestaurante" \
  --plan annual

# 3) Renovar / verificar / historial
bun tools/license-generator/cli.ts renew   --from <zip|json> --plan annual
bun tools/license-generator/cli.ts verify  --file <zip|json>
bun tools/license-generator/cli.ts history
```

## Reglas

- La clave privada llega por `VIEWLBA_LICENSE_PRIVATE_KEY` (env) o
  `--private-key-file`. **Jamás** se commitea (`out/`, `history/`, `keys/`,
  `*.key` están en `.gitignore`).
- Validación de entradas ANTES de firmar (nombre, IDs con formato exacto, plan,
  fechas, no-sobrescritura).
- Auto-verificación de ida y vuelta de cada licencia emitida (si exportas
  `VIEWLBA_LICENSE_PUBLIC_KEY`, contra el par real).
- ZIP de salida: `license.json` + `README.txt` con instrucciones de importación
  y contacto **52973387**.
- Historial local append-only (`history/history.jsonl`) — sin secretos.
