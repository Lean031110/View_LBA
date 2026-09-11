# Emisión de Licencias (app Android)

> Única vía de emisión: la app **ViewLBA Licencias** (Android, privada).
> El generador CLI, la demo web y el workflow de GitHub del flujo v1 fueron
> **eliminados**. Manual completo: `docs/LICENSE-GENERATOR.md`.

## Instalar la app

1. GitHub → Actions → **Android License Generator** → último run →
   artifact `viewlba-license-generator` (APK + `SHA256SUMS.txt`).
2. Verifica el SHA-256 del APK contra el checksum.
3. Instala el APK en el teléfono del administrador (fuentes desconocidas).

## Primer uso

1. Crea el **PIN** (6–16 caracteres).
2. **Ajustes → Importar claves privadas**: pega las dos claves base64url
   (Ed25519 firma + X25519 solicitudes) que custodias fuera de banda — o
   genera claves nuevas (rotación) y copia las públicas para el servidor.
3. **Backup → Crear backup** (elige contraseña fuerte; guarda el `.vlbak`).

## Emitir una licencia

1. **Nueva licencia** → pega el `VLREQ2-…` del cliente (tolerante a saltos
   de línea de WhatsApp).
2. **Validar** → muestra el nombre del negocio y el equipo (enmascarado).
3. Duración: **Mensual 30 · Anual 365 · Personalizada (1–3650)** — la
   duración la decide SOLO el administrador.
4. **«Generar y copiar token»** → el token `VLBA2-…` queda copiado.
5. Envíalo por WhatsApp al cliente.

## Renovar

Historial → registro del cliente → **Renovar** → duración. El inicio
extiende desde el vencimiento actual (nunca acorta). Un recorte explícito
exige marcar «Acortar licencia (acción administrativa)».

## Garantías automáticas

- **Anti-replay**: cada código de solicitud solo emite UNA licencia.
- **Anti-downgrade**: renovaciones nunca acortan sin confirmación explícita.
- **licenseId único** y **auto-verificación** de firma tras emitir.
- Todo queda en la **DB cifrada** (licencias, tokens, auditoría).
