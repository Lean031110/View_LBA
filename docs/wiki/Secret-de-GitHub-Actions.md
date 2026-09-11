# Secret de GitHub Actions — `VIEWLBA_LICENSE_PRIVATE_KEY`

El workflow **License Generator** (`.github/workflows/license-generator.yml`) emite licencias firmadas desde la propia interfaz de GitHub. Para firmar necesita la clave privada de PRODUCCIÓN, que GitHub almacena **cifrada** como *repository secret*: `VIEWLBA_LICENSE_PRIVATE_KEY`.

> **Estado actual:** el secret `VIEWLBA_LICENSE_PRIVATE_KEY` está **creado y operativo** (2026-09-11, rotación v1.2.1). Verificado con una ejecución real del workflow: licencia firmada + ZIP verificado + artifact publicado.

## Qué es y qué NO es

- ✅ Es: un valor cifrado (sealed-box libsodium) que GitHub inyecta **solo** en los pasos del workflow que lo declaran (`env: VIEWLBA_LICENSE_PRIVATE_KEY: ${{ secrets.… }}`).
- ✅ GitHub **enmascara** automáticamente el valor en cualquier log accidental.
- ❌ No es: algo que pueda leerse de vuelta (ni por API ni por UI — GitHub nunca devuelve el valor), ni algo que viaje al navegador o al artifact.
- ⚠️ El workflow además hace una verificación extra: antes de publicar el artifact, comprueba que el **ZIP no contenga** ningún fragmento de la clave y aborta si lo encuentra.

## Cómo ver que existe (verificación)

**Por UI:** repo → **Settings** → **Secrets and variables** → **Actions** → debe aparecer `VIEWLBA_LICENSE_PRIVATE_KEY` con su fecha de actualización.

**Por API** (con un PAT con permisos de administración del repo):

```bash
curl -s -H "Authorization: Bearer <TU_PAT>" \
  https://api.github.com/repos/Lean031110/Pantalla_Restaurante/actions/secrets
```

Respuesta esperada: `{"total_count":1,"secrets":[{"name":"VIEWLBA_LICENSE_PRIVATE_KEY","updated_at":"…"}]}` (nunca incluye el valor).

**La prueba real (la más importante):** pestaña **Actions** → **License Generator** → *Run workflow* con cualquier cliente de prueba. Si el run termina en verde, el secret existe Y la clave privada coincide con la pública incrustada en el código (el workflow auto-verifica la firma de ida y vuelta). Si faltara el secret, el workflow **falla inmediatamente** con un mensaje explícito (`::error::Falta el secret VIEWLBA_LICENSE_PRIVATE_KEY…`) — por diseño: sin clave no se emite nada.

## Cómo crearlo / actualizarlo (rotación)

### Opción A — UI (la más simple)

1. Consigue el valor de la clave privada (archivo custodiado por el dueño, o genera un par nuevo con `bun tools/license-generator/cli.ts keys` — ver [[Claves-Ed25519]]).
2. Repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**.
3. Name: `VIEWLBA_LICENSE_PRIVATE_KEY` · Secret: el valor base64url exacto (43 caracteres, sin comillas, sin espacios ni saltos de línea).
4. **Add secret**. Para rotar, usa el botón *Update* sobre el existente.

### Opción B — API (programática, la usada en la rotación v1.2.1)

GitHub cifra los secrets con **libsodium sealed-box** usando una clave pública propia del repo. Proceso:

1. `GET /repos/{owner}/{repo}/actions/secrets/public-key` → devuelve `{key, key_id}`.
2. Cifra el valor del secret con `crypto_box_seal(message, repoPublicKey)`.
3. `PUT /repos/{owner}/{repo}/actions/secrets/VIEWLBA_LICENSE_PRIVATE_KEY` con body `{"encrypted_value": "<base64>","key_id": "<key_id>"}` → 201 (creado) o 204 (actualizado).

Ejemplo funcional con Node/Bun (`libsodium-wrappers`):

```ts
import sodium from "libsodium-wrappers"
await sodium.ready
const binKey = sodium.from_base64(repoPublicKeyB64)           // de la API
const encrypted = sodium.crypto_box_seal(
  sodium.from_string(privateKeyValue), binKey)
const body = {
  encrypted_value: sodium.to_base64(encrypted),
  key_id: repoKeyId,                                          // de la API
}
// PUT /repos/…/actions/secrets/VIEWLBA_LICENSE_PRIVATE_KEY con body
```

## Reglas de seguridad del workflow

- El secret se inyecta **solo** en los dos pasos que firman/verifican; nunca en pasos de checkout o logs.
- El workflow **nunca imprime** la clave (ni `echo` ni `env`).
- El artifact contiene **solo** `license.json` + `README.txt` (nada de claves) y expira a los **14 días**.
- Los inputs del formulario se validan: formatos `VWLB-XXXX-XXXX-XXXX-XXXX` / `DSK-XXXX-XXXX-XXXX`, plan `monthly|annual`, fecha `YYYY-MM-DD`.

## Checklist si el workflow falla

| Síntoma | Causa probable | Fix |
|---|---|---|
| `::error::Falta el secret VIEWLBA_LICENSE_PRIVATE_KEY` | El secret no existe | Crearlo (Opción A/B de arriba) |
| Firma inválida al verificar / `AUTO-VERIFICACIÓN FALLÓ` | El secret tiene una clave que no corresponde a la pública del código | Revisar qué par está incrustado en `public-key.ts` y actualizar el secret con la privada correcta (o rotar de forma coherente) |
| `Clave privada Ed25519 mal formada` | El valor pegado tiene saltos de línea, comillas o padding `=` | Pegar el valor base64url exacto (43 chars) |
| `Installation ID inválido…` | Input mal formado | Formato correcto: `VWLB-8F2A-91CD-2D31-77AA` |

Siguiente: [[Emisión-de-Licencias]].
