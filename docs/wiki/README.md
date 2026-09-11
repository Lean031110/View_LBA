# Wiki de ViewLBA (espejo en `docs/wiki/`)

Este directorio es el **espejo completo de la wiki del repositorio**. Contiene la misma documentación que la pestaña *Wiki* de GitHub, lista para ser publicada ahí.

> **Por qué existe este espejo:** GitHub ofrece la wiki integrada **solo en repos públicos (plan Free) o con GitHub Pro/Team (repos privados)**. Este repositorio es privado con plan Free, por lo que la pestaña Wiki no se puede activar (Settings → Features la muestra deshabilitada). Mientras tanto, **toda la documentación de la wiki vive aquí**, versionada con el código y visible en GitHub.

## Cómo activar la wiki oficial (cuando se decida)

1. **Opción A — GitHub Pro** (~USD 4/mes): Settings → Billing → upgrade. Después: repo → Settings → General → Features → ✅ Wikis.
2. **Opción B — hacer público el repo**: la wiki se habilita gratis (valorar antes la exposición del código).
3. Después de habilitarla: clonar el wiki-repo y volcar este directorio:

```bash
git clone https://github.com/Lean031110/Pantalla_Restaurante.wiki.git wiki-push
cp docs/wiki/*.md wiki-push/        # Home.md es la portada; _Footer.md el pie
cd wiki-push && git add -A && git commit -m "Wiki inicial del sistema de licencias" && git push
```

(El wiki-repo `.wiki.git` se crea al guardar la primera página desde la interfaz web.)

## Contenido (índice)

| Página | Tema |
|---|---|
| `Home.md` | Índice general + estado actual + reglas de oro |
| `Sistema-de-Licencias.md` | Arquitectura, estados (trial/active/expired/…), flujo end-to-end |
| `Claves-Ed25519.md` | **Cómo se generan las claves** (Ed25519 firma + X25519 solicitudes), formatos, custodia, rotación |
| `Secret-de-GitHub-Actions.md` | Secrets de firma del APK Android: creación, verificación, rotación |
| `Emisión-de-Licencias.md` | Emisión desde la app Android (única vía) — paso a paso |
| `Planes-y-Precios.md` | Trial 7 días · Mensual 30 días/USD 10 · Anual 365 días/USD 100 |
| `Binding-Hardware-y-Disco.md` | Installation ID `VWLB-…`, Disk ID `DSK-…`, matriz de escenarios |
| `Trial-de-7-días.md` | Anclas duales, anti-rollback de reloj, no-repetición |
| `Importación-de-Licencia.md` | Flujo del cliente (copiar código → pegar token → activar) |
| `Seguridad.md` | Dónde NO está la clave privada, matriz de ataques y mitigaciones |
| `Mantenimiento-y-Rotación.md` | Rotación de claves, checklist de release, troubleshooting |

Documentación complementaria nivel-repo: [`LICENSE-SYSTEM.md`](../LICENSE-SYSTEM.md) · [`LICENSE-GENERATOR.md`](../LICENSE-GENERATOR.md) · [`LICENSE-SECURITY.md`](../LICENSE-SECURITY.md) · [`RELEASE.md`](../RELEASE.md).

⚠️ Esta wiki documenta **procedimientos** — jamás material de clave. La clave privada de producción NO está (ni estará) aquí.
