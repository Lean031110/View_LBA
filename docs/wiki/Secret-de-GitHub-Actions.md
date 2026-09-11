# Secrets de GitHub (firma del APK Android)

> v2.0.0: ya NO existe el secret `VIEWLBA_LICENSE_PRIVATE_KEY` del flujo v1
> (la clave privada de licencias vive en la app Android, NO en GitHub).
> Los secrets actuales firman el **APK del generador**.

## Secrets requeridos (para APK firmado)

| Secret | Contenido |
|---|---|
| `VIEWLBA_KEYSTORE_BASE64` | El keystore `.jks` codificado en base64 |
| `VIEWLBA_KEYSTORE_PASSWORD` | Contraseña del keystore |
| `VIEWLBA_KEY_ALIAS` | Alias de la clave |
| `VIEWLBA_KEY_PASSWORD` | Contraseña de la clave |

Sin estos secrets el CI construye un APK **sin firmar** (con warning) —
útil para desarrollo, no instalable en producción.

## Crearlos

```bash
# 1) Genera un keystore local (guárdalo, no se puede recuperar):
keytool -genkey -v -keystore viewlba-release.jks \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -alias viewlba

# 2) Codifícalo:
base64 -w0 viewlba-release.jks > keystore.b64

# 3) GitHub → Settings → Secrets and variables → Actions → New repository secret:
#    VIEWLBA_KEYSTORE_BASE64  = contenido de keystore.b64
#    VIEWLBA_KEYSTORE_PASSWORD / VIEWLBA_KEY_ALIAS / VIEWLBA_KEY_PASSWORD
```

## Reglas

- Los secrets **nunca** se imprimen en logs (el workflow los consume por
  env y el keystore se borra tras firmar).
- Rotación del keystore: genera uno nuevo + actualiza los 4 secrets (los
  APK antiguos ya instalados siguen funcionando; solo cambia la firma de
  futuros APKs → requiere desinstalar/reinstalar).
- La clave PRIVADA de licencias (Ed25519/X25519) **no es** un secret de
  GitHub — vive en el teléfono del administrador (ver
  [Claves-Ed25519](Claves-Ed25519.md)).
