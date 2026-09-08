# Cómo contribuir a ViewLBA

¡Gracias por tu interés en mejorar ViewLBA! Este documento describe el flujo
de contribución del proyecto.

## Flujo de trabajo

1. Haz **fork** del repositorio y clona tu fork.
2. Crea una rama descriptiva desde `main`:
   ```bash
   git checkout -b feat/mi-caracteristica
   # o:  fix/mi-correccion  ·  docs/mi-documento
   ```
3. Realiza tus cambios con **commits pequeños y atómicos**, en español o
   inglés, siguiendo [Conventional Commits](https://www.conventionalcommits.org/es/):
   `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, `ci:`.
4. Asegúrate de que todo está en verde antes de abrir el Pull Request:
   ```bash
   bun run lint        # ESLint — 0 errores, 0 warnings
   bun run typecheck   # tsc --noEmit — 0 errores
   bun test            # suite de tests
   ```
   El CI de GitHub Actions ejecutará exactamente estos pasos.
5. Abre un **Pull Request** hacia `main` completando la plantilla.

## Entorno de desarrollo

| Requisito | Versión |
|---|---|
| [Bun](https://bun.sh) | 1.1 o superior (recomendado) |
| Node.js (alternativo) | 18+ |

```bash
git clone https://github.com/Lean031110/Pantalla_Restaurante.git
cd Pantalla_Restaurante
bun install
cp .env.example .env        # edita los secretos
bun run setup               # prisma generate + db push + seed
bun run dev                 # app en http://localhost:3000
```

Los mini-servicios (realtime y streaming) se inician con sus supervisores:

```bash
bash scripts/realtime-supervisor.sh &
bash scripts/stream-supervisor.sh &
```

## Estructura relevante

```
src/app/                  páginas (TV y admin) y API routes
src/components/display/   componentes de la pantalla TV
src/components/admin/     secciones del panel de administración
src/lib/                  lógica compartida (auth, crud, net, brand…)
mini-services/            servicios independientes (realtime, RTMP)
prisma/                   esquema y seed de la base de datos
tests/                    tests unitarios (bun test)
```

## Convenciones

- **TypeScript estricto** en todo el código de la app (`tsc --noEmit` en CI).
- Componentes de UI con **shadcn/ui** + Tailwind CSS; iconos con **lucide-react**.
- Comentarios del código en español, explicando el *porqué* de las decisiones
  (especialmente en los flujos de streaming y reconexión).
- No uses colores azules/índigo salvo que el diseño lo pida (identidad ámbar).
- Los secretos viven en `.env` — **nunca** se commitean.
- Cambios en el esquema de base de datos: edita `prisma/schema.prisma` y
  ejecuta `bun run db:push`.

## Reporte de bugs

Abre un *issue* con la plantilla de reporte de errores e incluye: pasos para
reproducir, comportamiento esperado vs. obtenido, logs relevantes y, si
aplica, una captura.
