/**
 * ViewLBA License Generator — CLI (secciones 6/7/18/25).
 *
 * USO (bun tools/license-generator/cli.ts <comando> …):
 *
 *   generate — nueva licencia:
 *     --customer "Leandro Bueno"
 *     --installation-id VWLB-8F2A-91CD-2D31-77AA
 *     --disk-id DSK-A5ED-432A-37DD
 *     --install-path "C:\\PantallaRestaurante"
 *     --plan monthly|annual
 *     [--start 2026-09-10]          (default: hoy)
 *     [--features '{"multiDisplay":true}']
 *     [--private-key-file /ruta/segura.key]
 *     [--out-dir ./licenses] [--force]
 *
 *   renew — renovación (NUEVA licencia, mismo binding, fechas nuevas):
 *     --from <licencia.json|zip> --plan annual [--start 2026-10-10]
 *
 *   verify — verificar una licencia:
 *     --file <licencia.json|zip> [--public-key <base64url>]
 *     [--installation-id VWLB-…] [--disk-id DSK-…]
 *
 *   keys — generar par de claves:
 *     [--write-private /ruta/segura.key]  (default: solo imprimir)
 *
 *   history — historial local de emisiones (tools/license-generator/history/)
 *
 * La clave PRIVADA llega por env VIEWLBA_LICENSE_PRIVATE_KEY o
 * --private-key-file. NUNCA se guarda en el repo ni se imprime en logs de CI.
 */
import { writeFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  generateLicenseZip,
  validateGenerateInput,
  loadPrivateKey,
  readLicenseFile,
  verifyWithKey,
  appendHistory,
  readHistory,
  GENERATOR_VERSION,
  DEFAULT_OUT_DIR,
  buildLicense,
  readZip,
  findZipEntry,
  generateLicenseKeyPair,
  CONTACT_PHONE,
  PLAN_DURATION_DAYS,
  PLAN_PRICE_USD,
} from "./lib"
import { resolveVerifierPublicKey, isValidRawKey } from "../../src/lib/licensing/crypto"

const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"
const GREEN = "\x1b[32m"
const AMBER = "\x1b[33m"
const RED = "\x1b[31m"
const RESET = "\x1b[0m"

const ok = (msg: string) => console.log(`${GREEN}✓${RESET} ${msg}`)
const warn = (msg: string) => console.log(`${AMBER}⚠${RESET} ${msg}`)
const fail = (msg: string) => console.error(`${RED}✗${RESET} ${msg}`)

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith("--")) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith("--")) {
        out[key] = next
        i++
      } else {
        out[key] = true
      }
    }
  }
  return out
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function printSummary(params: {
  customer: string
  plan: string
  startsAt: string
  expiresAt: string
  installationId: string
  diskId: string
  installPath: string
  licenseId: string
  file: string
}) {
  console.log("")
  console.log(`${BOLD}──────────────── RESUMEN DE LA LICENCIA ────────────────${RESET}`)
  console.log(`  Cliente:        ${params.customer}`)
  console.log(`  Plan:           ${params.plan}`)
  console.log(`  Inicio:         ${params.startsAt.slice(0, 10)}`)
  console.log(`  Vencimiento:    ${params.expiresAt.slice(0, 10)}`)
  console.log(`  Installation ID:${params.installationId}`)
  console.log(`  Disk:           ${params.diskId}`)
  console.log(`  Ruta:           ${params.installPath}`)
  console.log(`  Licencia:       ${params.licenseId}`)
  console.log(`  Archivo:        ${params.file}`)
  console.log(`${BOLD}────────────────────────────────────────────────────────${RESET}`)
}

// ---------------------------------------------------------------------------
// Comandos
// ---------------------------------------------------------------------------

async function cmdGenerate(args: Record<string, string | boolean>) {
  const input = {
    customerName: String(args.customer ?? ""),
    installationId: String(args["installation-id"] ?? ""),
    diskId: String(args["disk-id"] ?? ""),
    installPath: String(args["install-path"] ?? ""),
    plan: String(args.plan ?? ""),
    startDate: String(args.start ?? todayIso()),
    features: args.features ? (JSON.parse(String(args.features)) as Record<string, boolean>) : undefined,
  }

  const errors = validateGenerateInput(input)
  if (errors.length > 0) {
    fail("Entrada inválida — no se generó nada:")
    for (const e of errors) console.error(`   · ${e}`)
    process.exit(1)
  }

  const { key, source } = loadPrivateKey(args["private-key-file"] ? String(args["private-key-file"]) : undefined)
  ok(`Clave privada cargada (${DIM}${source}${RESET})`)

  const result = generateLicenseZip(input, key, {
    outDir: args["out-dir"] ? String(args["out-dir"]) : undefined,
    force: args.force === true,
  })

  ok("Licencia firmada (Ed25519)")
  ok("Firma verificada de ida y vuelta" + (process.env.VIEWLBA_LICENSE_PUBLIC_KEY ? " (contra VIEWLBA_LICENSE_PUBLIC_KEY)" : ""))
  ok(`Binding correcto: ${result.license.deviceId} + ${result.license.diskId}`)
  ok(`ZIP listo: ${result.zipPath}`)

  appendHistory({
    ts: new Date().toISOString(),
    licenseId: result.license.licenseId,
    customerName: result.license.customerName,
    installationId: result.license.deviceId,
    diskId: result.license.diskId,
    plan: result.license.plan,
    issuedAt: result.license.issuedAt,
    startsAt: result.license.startsAt,
    expiresAt: result.license.expiresAt,
    file: result.zipPath,
    generatorVersion: GENERATOR_VERSION,
  })
  ok(`Historial actualizado (${DIM}tools/license-generator/history/${RESET})`)

  printSummary({
    customer: result.license.customerName,
    plan: `${result.license.plan === "annual" ? "Anual" : "Mensual"} (${PLAN_DURATION_DAYS[result.license.plan]} días · USD ${PLAN_PRICE_USD[result.license.plan]})`,
    startsAt: result.license.startsAt,
    expiresAt: result.license.expiresAt,
    installationId: result.license.deviceId,
    diskId: result.license.diskId,
    installPath: result.license.installPath,
    licenseId: result.license.licenseId,
    file: result.zipPath,
  })
  console.log(`\nEnvíale el ZIP al cliente. Contacto soporte: ${CONTACT_PHONE}`)
}

async function cmdRenew(args: Record<string, string | boolean>) {
  const from = String(args.from ?? "")
  if (!from) {
    fail("Renovación: falta --from <ruta a license.json o ZIP de la licencia actual>")
    process.exit(1)
  }

  const current = readLicenseFile(from)
  const publicKey = String(args["public-key"] ?? resolveVerifierPublicKey())
  if (!verifyWithKey(current, publicKey)) {
    fail("La licencia de origen NO pasa la verificación de firma — no se renueva nada (sección 18: nunca modificar la anterior sin garantías)")
    process.exit(1)
  }
  ok(`Licencia de origen verificada (${current.licenseId} · vence ${current.expiresAt.slice(0, 10)})`)

  const plan = String(args.plan ?? current.plan) as "monthly" | "annual"
  const startDate = String(args.start ?? todayIso())
  const input = {
    customerName: current.customerName,
    installationId: current.deviceId,
    diskId: current.diskId,
    installPath: current.installPath,
    plan,
    startDate,
    features: current.features,
  }
  const errors = validateGenerateInput(input)
  if (errors.length > 0) {
    fail("Renovación inválida:")
    for (const e of errors) console.error(`   · ${e}`)
    process.exit(1)
  }

  const { key, source } = loadPrivateKey(args["private-key-file"] ? String(args["private-key-file"]) : undefined)
  ok(`Clave privada cargada (${DIM}${source}${RESET})`)

  // Validar que la renovación NO acorte vigencia (anti-downgrade, sección 18)
  const newLicense = buildLicense(input, key)
  if (Date.parse(newLicense.expiresAt) < Date.parse(current.expiresAt)) {
    fail(`La renovación vence ANTES que la licencia actual (${newLicense.expiresAt.slice(0, 10)} < ${current.expiresAt.slice(0, 10)}) — no se permite downgrade`)
    process.exit(1)
  }

  const result = generateLicenseZip(input, key, {
    outDir: args["out-dir"] ? String(args["out-dir"]) : undefined,
    force: args.force === true,
  })

  ok("Renovación firmada como licencia NUEVA (la anterior queda intacta)")
  ok(`ZIP listo: ${result.zipPath}`)

  appendHistory({
    ts: new Date().toISOString(),
    licenseId: result.license.licenseId,
    customerName: result.license.customerName,
    installationId: result.license.deviceId,
    diskId: result.license.diskId,
    plan: result.license.plan,
    issuedAt: result.license.issuedAt,
    startsAt: result.license.startsAt,
    expiresAt: result.license.expiresAt,
    file: result.zipPath,
    generatorVersion: GENERATOR_VERSION,
  })

  printSummary({
    customer: result.license.customerName,
    plan: `${result.license.plan === "annual" ? "Anual" : "Mensual"} (${PLAN_DURATION_DAYS[result.license.plan]} días)`,
    startsAt: result.license.startsAt,
    expiresAt: result.license.expiresAt,
    installationId: result.license.deviceId,
    diskId: result.license.diskId,
    installPath: result.license.installPath,
    licenseId: result.license.licenseId,
    file: result.zipPath,
  })
  console.log(`\nEl cliente importa el nuevo ZIP desde Administración → Licencia. Contacto: ${CONTACT_PHONE}`)
}

async function cmdVerify(args: Record<string, string | boolean>) {
  const file = String(args.file ?? "")
  if (!file) {
    fail("Verificación: falta --file <licencia.json|zip>")
    process.exit(1)
  }
  const license = readLicenseFile(file)
  const publicKey = String(args["public-key"] ?? resolveVerifierPublicKey())
  if (!isValidRawKey(publicKey)) {
    fail("--public-key mal formada (base64url de 32 bytes)")
    process.exit(1)
  }

  const signatureOk = verifyWithKey(license, publicKey)
  console.log("")
  console.log(`${BOLD}Verificación de licencia${RESET}`)
  console.log(`  Archivo:     ${resolve(file)}`)
  console.log(`  Licencia:    ${license.licenseId}`)
  console.log(`  Cliente:     ${license.customerName}`)
  console.log(`  Plan:        ${license.plan}`)
  console.log(`  Vigencia:    ${license.startsAt.slice(0, 10)} → ${license.expiresAt.slice(0, 10)}`)
  console.log(`  Equipo:      ${license.deviceId}`)
  console.log(`  Disco:       ${license.diskId}`)
  console.log(`  Ruta:        ${license.installPath}`)
  console.log("")
  if (signatureOk) ok("Firma digital VÁLIDA (emitida por la clave correspondiente)")
  else fail("Firma digital INVÁLIDA — el archivo fue modificado o emitido con otra clave")

  const now = Date.now()
  if (Date.parse(license.expiresAt) < now) warn(`VENCIDA (expiró ${license.expiresAt.slice(0, 10)})`)
  else if (Date.parse(license.startsAt) > now) warn(`AÚN NO VIGENTE (comienza ${license.startsAt.slice(0, 10)})`)
  else ok(`Vigente (${Math.ceil((Date.parse(license.expiresAt) - now) / 86400000)} días restantes)`)

  const expectInstall = String(args["installation-id"] ?? "").toUpperCase()
  const expectDisk = String(args["disk-id"] ?? "").toUpperCase()
  if (expectInstall) {
    if (expectInstall === license.deviceId.toUpperCase()) ok("Installation ID coincide")
    else fail(`Installation ID NO coincide (licencia: ${license.deviceId}, esperado: ${expectInstall})`)
  }
  if (expectDisk) {
    if (expectDisk === license.diskId.toUpperCase()) ok("Disk ID coincide")
    else fail(`Disk ID NO coincide (licencia: ${license.diskId}, esperado: ${expectDisk})`)
  }

  if (!signatureOk) process.exit(1)
}

async function cmdKeys(args: Record<string, string | boolean>) {
  const { publicKey, privateKey } = generateLicenseKeyPair()
  console.log("")
  console.log(`${BOLD}Par de claves Ed25519 para ViewLBA Licensing${RESET}`)
  console.log("")
  ok("Clave PÚBLICA (va en la app / verificador / VIEWLBA_LICENSE_PUBLIC_KEY):")
  console.log(`  ${publicKey}`)
  console.log("")
  const writePath = args["write-private"] ? String(args["write-private"]) : null
  if (writePath) {
    writeFileSync(resolve(writePath), privateKey + "\n", { encoding: "utf8", mode: 0o600 })
    ok(`Clave PRIVADA escrita en ${resolve(writePath)} (permisos 600)`)
    warn("Guarda ese archivo FUERA del repositorio y de cualquier backup público.")
  } else {
    warn("Clave PRIVADA (guárdala AHORA en un lugar seguro; no se vuelve a mostrar):")
    console.log(`  ${privateKey}`)
    console.log("")
    console.log(`  ${DIM}Consejo: --write-private /ruta/segura/viewlba-private.key para escribirla con permisos 600${RESET}`)
  }
  console.log("")
  console.log(`Para GitHub Actions: crea el secret VIEWLBA_LICENSE_PRIVATE_KEY con el valor de la clave privada.`)
  console.log(`La clave pública puede fijarse con env VIEWLBA_LICENSE_PUBLIC_KEY para verificar en el generador.`)
}

async function cmdHistory() {
  const records = readHistory()
  if (records.length === 0) {
    console.log(`Historial vacío (${DEFAULT_OUT_DIR} no ha emitido licencias aún).`)
    return
  }
  console.log("")
  console.log(`${BOLD}Historial local de emisiones (más recientes primero)${RESET}`)
  for (const r of records) {
    console.log(`  ${r.licenseId}  ${r.customerName.padEnd(22).slice(0, 22)} ${r.plan.padEnd(8)} ${r.startsAt.slice(0, 10)} → ${r.expiresAt.slice(0, 10)}  ${r.deviceId}`)
  }
  console.log(`\n${DIM}${records.length} registro(s) — nunca se guarda la clave privada.${RESET}`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const [command, ...rest] = process.argv.slice(2)
const args = parseArgs(rest)

switch (command) {
  case "generate":
  case "new":
    await cmdGenerate(args)
    break
  case "renew":
    await cmdRenew(args)
    break
  case "verify":
    await cmdVerify(args)
    break
  case "keys":
    await cmdKeys(args)
    break
  case "history":
    await cmdHistory()
    break
  default:
    console.log(
      [
        "",
        `${BOLD}ViewLBA License Generator v${GENERATOR_VERSION}${RESET}`,
        "",
        "Comandos:",
        "  generate   Nueva licencia (cliente, installation ID, disk ID, plan, inicio)",
        "  renew      Renovar: nueva licencia firmada con el mismo binding",
        "  verify     Verificar firma/validez de un license.json o ZIP",
        "  keys       Generar par de claves Ed25519",
        "  history    Historial local de emisiones",
        "",
        "Ejemplo:",
        `  bun tools/license-generator/cli.ts generate \\`,
        `    --customer "Leandro Bueno" \\`,
        `    --installation-id VWLB-8F2A-91CD-2D31-77AA \\`,
        `    --disk-id DSK-A5ED-432A-37DD \\`,
        `    --install-path "C:\\\\PantallaRestaurante" \\`,
        `    --plan annual`,
        "",
      ].join("\n")
    )
    process.exit(command ? 1 : 0)
}
