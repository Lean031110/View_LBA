# Política de seguridad

## Versiones soportadas

| Versión | Soporte |
|---|---|
| 1.0.x | ✅ |

## Reportar una vulnerabilidad

Si descubres una vulnerabilidad de seguridad en ViewLBA, **no abras un issue
público**. Escríbela directamente al propietario del repositorio
([@Lean031110](https://github.com/Lean031110)) mediante un reporte de seguridad
privado de GitHub:

> *Security → Report a vulnerability*

Incluye: descripción del problema, pasos para reproducirlo, impacto estimado
y, si es posible, una prueba de concepto. Recibirás respuesta en un plazo
razonable y se te acreditará en el hallazgo si lo deseas.

## Modelo de amenazas y decisiones de diseño

- **Todo local (LAN)**: el sistema está diseñado para operar sin Internet; el
  servidor de streaming y la aplicación viven en la red del restaurante.
- **Clave de transmisión**: se valida en el servidor RTMP (hook `prePublish`),
  se enmascara en el panel y **nunca viaja al navegador de la TV** — el FLV se
  consume a través de un proxy server-side (`/api/stream/live.flv`).
- **Sesiones**: cookies httpOnly firmadas con HMAC; contraseñas con scrypt y
  salt por usuario.
- **Roles**: ADMIN (todo, incl. rotar clave y gestionar usuarios), OPERATOR
  (contenido y transmisión), VIEWER (solo lectura).
- **API admin**: protegida por sesión; la API pública de contenido no expone
  secretos (solo lo que la TV necesita para pintar).
- **Archivos subidos**: validación de tipo MIME y tamaño; guard anti
  path-traversal al servirlos.
- **Secretos**: `.env` está ignorado por git; el repositorio solo incluye
  `.env.example`.

## Buenas prácticas de despliegue

1. Cambia las contraseñas de los usuarios sembrados (`admin123` / `operador123`
   son solo demo).
2. Regenera la clave de transmisión desde el panel si sospechas que se filtró.
3. Mantén el puerto de control interno (8100) accesible únicamente desde
   localhost.
4. No expongas el puerto 3000 a Internet sin un proxy con autenticación.
