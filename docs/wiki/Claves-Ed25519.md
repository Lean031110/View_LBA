# Claves del Sistema (Ed25519 + X25519)

> v2.0.0: hay DOS pares de claves. Las privadas viven SOLO en la app
> Android del administrador.

## Los 4 valores

| Clave | Dónde vive | Uso |
|---|---|---|
| **Ed25519 privada** (firma) | App Android (DB cifrada) + backup `.vlbak` | Firmar tokens `VLBA2-…` |
| **Ed25519 pública** | Servidor: `src/lib/licensing/public-key.ts` (+ env `VIEWLBA_LICENSE_PUBLIC_KEY`) | Verificar tokens |
| **X25519 privada** (apertura) | App Android (DB cifrada) + backup `.vlbak` | Abrir códigos `VLREQ2-…` |
| **X25519 pública** | Servidor: `public-key.ts` (+ env `VIEWLBA_REQUEST_PUBLIC_KEY`) | Sellar códigos `VLREQ2-…` |

Formato: base64url de los 32 bytes crudos (43 caracteres).

## Reglas de oro

1. Las privadas **JAMÁS**: en el repo, en el servidor, en el instalador, en
   logs, en BuildConfig/assets/strings, en la TV, en artifacts públicos.
2. El servidor SOLO tiene públicas — un dump completo del servidor no
   permite emitir licencias.
3. El único canal de salida de las privadas es el **backup `.vlbak`**
   (cifrado con contraseña del administrador).
4. La compatibilidad TS↔Kotlin está garantizada por **vectores dorados**
   en CI (`scripts/gen-golden-vectors.ts` ↔ `CrossCompatTest`).

## Generar / rotar

- **Generar**: app Android → Ajustes → «Generar claves nuevas» (con aviso
  de que los tokens anteriores dejarán de validar hasta actualizar el
  servidor). Copia las DOS públicas.
- **Aplicar en el servidor**: fija `VIEWLBA_LICENSE_PUBLIC_KEY` y
  `VIEWLBA_REQUEST_PUBLIC_KEY` en `.env` (o actualiza `public-key.ts` para
  un release) y reinicia.
- **Importar existentes**: Ajustes → «Importar claves privadas» (pega las
  dos base64url).

Ver [Mantenimiento-y-Rotación](Mantenimiento-y-Rotación.md) para el
procedimiento completo de rotación.
