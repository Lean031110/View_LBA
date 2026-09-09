# INSTALACIÓN — máquina nueva (FASE 31, VERIFIED)

> Objetivo: instalar en una máquina limpia **sin editar código ni archivos manualmente**.
> El instalador es multiplataforma (Linux/Windows), idempotente y genera los secretos por ti.

## Instalación rápida (recomendada)

```bash
# 1) Clonar (o copiar) el repositorio en la máquina servidor
git clone https://github.com/Lean031110/Pantalla_Restaurante
cd Pantalla_Restaurante

# 2) Instalar Bun 1.1+ si no está: https://bun.sh  (Windows: irm bun.sh/install.ps1 | iex)

# 3) Ejecutar el instalador interactivo
bun scripts/install.ts
```

El instalador hace TODO el flujo con verificaciones reales:

| Paso | Qué hace | Verifica |
|---|---|---|
| 1 | Preflight: Bun ≥1.1, Node ≥20.9 (recomendado), git, espacio en disco, permisos de escritura | ✓/⚠ con detalles |
| 2 | `bun install --frozen-lockfile` (reproducible) | ✓ |
| 3 | Prisma Client | ✓ |
| 4 | `.env`: secretos aleatorios (crypto), `DATABASE_URL` **absoluta**, permisos 600 — si ya existe uno incompleto, REPARA solo lo que falta (nunca regenera secretos existentes) | ✓ |
| 5 | `initializeProduction()`: valida entorno → **verifica el datasource real de Prisma** (aborta si el objetivo difiere: *"Database target mismatch: aborting to prevent modifying another database."*) → `prisma migrate deploy` (no destructivo) → primer ADMIN (política de contraseña estricta) → settings base → demo opcional → health checks | ✓ paso a paso |
| 6 | Build standalone de producción (omitir con `--no-build`) | ✓ |
| 7 | Resumen con URLs (panel/TV/health), OBS y documentación | ✓ |

### Modo no interactivo (automatización/CI)

```bash
bun scripts/install.ts --email=admin@mirestaurante.com --password='MiClave123' --no-demo
```

Flags: `--email=` · `--password=` · `--no-demo` · `--demo` · `--no-build` · `--port=` · `--timezone=`

### Solo inicializar DB+admin (repo ya instalado)

```bash
bun scripts/init-production.ts [--email=...] [--password=...] [--database-url=file:...]
```

## Protección de la base de datos (importante)

- El instalador **verifica el datasource real** antes de migrar: si el entorno del shell tiene una `DATABASE_URL` exportada que difiere de la seleccionada, aborta (evita migrar una DB equivocada).
- Las rutas SQLite relativas se resuelven contra el CWD de cada proceso — el instalador siempre genera rutas **absolutas**.

## Despliegues de producción 24/7

| Plataforma | Guía | Instalador |
|---|---|---|
| Linux (systemd) | `docs/LINUX_PRODUCTION.md` + runbook `docs/OPERATIONS.md` | `sudo bash deploy/linux/install.sh` |
| Windows (NSSM) | `docs/WINDOWS_PRODUCTION.md` | `deploy\windows\install.ps1` |

## Primer arranque tras instalar

1. Abrir `http://<IP-del-servidor>:3000/?view=admin` y entrar con el admin creado.
2. Configurar branding/promos/horarios desde el panel.
3. Vincular las TVs: ver `docs/TV_SETUP.md` y `docs/SCREEN_PAIRING.md`.
4. Configurar OBS: ver `docs/OBS_SETUP.md`.
5. Comprobar `http://<IP>:3000/api/health` → `status: "ok"`.

## Requisitos

| Componente | Versión | Nota |
|---|---|---|
| Bun | 1.1+ | Ejecuta app, Prisma y mini-servicios |
| Node.js | 20.9+ | Recomendado para herramientas externas |
| OBS Studio | 28+ | Solo en el PC que transmite |
| Navegador TV | Chrome/Edge/Firefox modernos | mpegts.js + setSinkId (audio por TV) |
| ffmpeg | opcional | Solo para tests E2E del pipeline |
