# Manual de Usuario (PDF para clientes) — ViewLBA v3.1

> Documentación INTERNA del manual (misión §25–§29). El PDF en sí es para
> CLIENTES: español sencillo, sin conceptos técnicos, sin claves internas.

---

## 1. Qué es

`ViewLBA-Manual-Usuario-v{VERSIÓN}.pdf` — manual profesional de 16 capítulos
(misión §26): qué es ViewLBA, qué puede hacer, instalación (Windows/Linux/
Docker), primer arranque, prueba de 7 días, activación por WhatsApp, precios,
administración, pantalla TV, temas (con capturas reales), backup, solución de
problemas, seguridad y contacto.

## 2. Construcción (determinista)

```bash
pip install "reportlab==4.4.9" "pillow==11.3.0"
python3 scripts/build_customer_manual.py
# → dist/manual/ViewLBA-Manual-Usuario-v3.1.0.pdf
```

- **Fuente de verdad de la versión**: `/VERSION` (única del repo).
- **Contenido visual**: `docs/manual/assets/*.png` — capturas REALES del
  sistema (ver §3) + logos oficiales renderizados.
- Fuentes: familia Helvetica integrada de ReportLab (cobertura latin-1
  completa del español — cero dependencia de fuentes del sistema).
- Mismos assets + misma versión → mismo PDF: el release del tag re-ejecuta
  el mismo script (§28: «generarlo desde el mismo commit/tag»).

## 3. Capturas reales (§27: NO inventar capturas)

| Archivo | Contenido | Cómo se captura |
|---|---|---|
| `login.png` | Acceso a Administración | `scripts/manual-screenshots.ts` |
| `admin-themes.png` | Gestor de Temas de Pantalla | ídem |
| `admin-license.png` | Sección Licencia activa | ídem (activación con el flujo real request-code→token) |
| `tv-default.png` | TV con tema Default + transmisión EN VIVO | ídem (stack real + publicador RTMP) |
| `tv-classic.png` | TV con tema ViewLBA Classic | ídem |
| `tv-neon.png` | TV con tema ViewLBA Neon | ídem |
| `logo-full.png` / `logo-mark.png` | Branding | `scripts/render-logos.ts` (SVG→PNG con sharp) |

Regenerar capturas (requiere stack en marcha + publicador RTMP):

```bash
bash scripts/screenshots-stack.sh   # o levantar servicios manualmente
bash scripts/screenshots-stream.sh  # publicador ffmpeg (fuente: public/demo)
bun scripts/manual-screenshots.ts
bun scripts/render-logos.ts
python3 scripts/build_customer_manual.py
```

## 4. Validación en CI (§28/§29)

Workflow `.github/workflows/customer-manual.yml` (push a main con paths
relevantes, PRs, tags y dispatch):

1. Construye el PDF (reportlab+pillow exactos).
2. `pdfinfo`: el PDF abre y tiene **> 0 páginas** (+ tamaño mínimo).
3. `pdftotext` + grep de los textos OBLIGATORIOS: `ViewLBA` · `7 días` ·
   `10 USD` · `100 USD` · `52973387` · `Activar` · `Licencia` · `Temas`.
   Si falta cualquiera → **FAIL**.
4. Versión: el nombre lleva la versión del commit y aparece en el texto.
5. Branding: metadatos `Author: ViewLBA` / `Title: … ViewLBA`.
6. Artefacto `viewlba-customer-manual`.

El job `release` de `release-installer.yml` re-ejecuta la MISMA construcción
+ validación en el commit del tag y añade el PDF al GitHub Release y a
`SHA256SUMS.txt`.

## 5. Reglas de contenido (§26/§41)

- El cliente NO necesita: claves privadas, certificados, JSON, Installation
  ID, Disk ID, GitHub ni Internet para activar. El manual solo enseña el
  flujo copiar-código → WhatsApp → pegar-token.
- Precios y contacto exactos: Mensual 10 USD · Anual 100 USD · 52973387.
- El capítulo de temas indica que el gestor «requiere licencia completa».
- Copias de seguridad: sin prometer recuperar claves que el sistema
  deliberadamente no puede recuperar (la licencia se revalida contra el
  equipo actual).
- Seguridad: funcionamiento offline, licencia vinculada, no compartir tokens;
  sin revelar mecanismos internos que faciliten bypass.
