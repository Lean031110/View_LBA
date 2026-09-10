/**
 * Tests: fingerprint de hardware + binding de disco (sección 27).
 * Se prueban las derivaciones PURAS (sin depender del hardware del runner).
 */
import { describe, expect, it } from "bun:test"
import {
  computeDeviceFingerprint,
  deriveInstallationId,
  INSTALLATION_ID_RE,
  collectHardwareFacts,
  fingerprintMethodOf,
  type HardwareFacts,
} from "@/lib/licensing/fingerprint"
import {
  computeDiskIdHash,
  deriveDiskId,
  DISK_ID_RE,
  normalizeInstallPath,
  detectDiskBinding,
  diskLabelOf,
} from "@/lib/licensing/disk-binding"

const facts: HardwareFacts = {
  machineId: "abcd1234efgh5678",
  cpuModel: "intel core i7",
  cpuCores: 8,
  totalMem: 16_000_000_000,
  hostname: "restaurante-pc",
  platform: "linux",
  arch: "x64",
  macHint: "aabbccddeeff",
}

describe("computeDeviceFingerprint", () => {
  it("determinista: mismos hechos → mismo hash (64 hex)", () => {
    const h1 = computeDeviceFingerprint(facts)
    const h2 = computeDeviceFingerprint({ ...facts })
    expect(h1).toBe(h2)
    expect(h1).toMatch(/^[0-9a-f]{64}$/)
  })

  it("machineId manda: cambios de hostname/MAC/RAM NO cambian el fingerprint", () => {
    const base = computeDeviceFingerprint(facts)
    const changedHostname = computeDeviceFingerprint({ ...facts, hostname: "otro-nombre" })
    const changedMac = computeDeviceFingerprint({ ...facts, macHint: "112233445566" })
    const changedMem = computeDeviceFingerprint({ ...facts, totalMem: 32_000_000_000 })
    expect(changedHostname).toBe(base) // estabilidad ante cambios de red/nombre
    expect(changedMac).toBe(base)
    expect(changedMem).toBe(base)
  })

  it("máquina distinta (machineId distinto) → fingerprint distinto", () => {
    expect(computeDeviceFingerprint({ ...facts, machineId: "otra-maquina" })).not.toBe(computeDeviceFingerprint(facts))
  })

  it("sin machineId → composite estable (fallback) distinto del machine-id", () => {
    const composite = computeDeviceFingerprint({ ...facts, machineId: null })
    expect(composite).toMatch(/^[0-9a-f]{64}$/)
    expect(composite).not.toBe(computeDeviceFingerprint(facts))
    // estable ante reorden de señales implícito (mismos valores)
    expect(computeDeviceFingerprint({ ...facts, machineId: null })).toBe(composite)
    // el método reportado es composite
    expect(fingerprintMethodOf({ ...facts, machineId: null })).toBe("composite")
  })

  it("hostname cambia SIN machineId (composite) → fingerprint cambia (documentado)", () => {
    const a = computeDeviceFingerprint({ ...facts, machineId: null })
    const b = computeDeviceFingerprint({ ...facts, machineId: null, hostname: "nuevo-nombre" })
    expect(a).not.toBe(b) // límite documentado del fallback composite
  })
})

describe("deriveInstallationId", () => {
  it("formato VWLB-XXXX-XXXX-XXXX-XXXX (16 hex = prefijo del hash)", () => {
    const fp = computeDeviceFingerprint(facts)
    const id = deriveInstallationId(fp)
    expect(id).toMatch(INSTALLATION_ID_RE)
    expect(id.slice(4).replace(/-/g, "")).toBe(fp.slice(0, 16).toUpperCase())
  })

  it("determinista y dependiente del hash completo", () => {
    const fp = computeDeviceFingerprint(facts)
    expect(deriveInstallationId(fp)).toBe(deriveInstallationId(fp))
    expect(deriveInstallationId("0".repeat(64))).not.toBe(deriveInstallationId("1".repeat(64)))
  })
})

describe("collectHardwareFacts (runner real)", () => {
  it("recopila hechos con normalización (cpu en minúsculas, sin espacios extra)", async () => {
    const f = await collectHardwareFacts()
    expect(f.cpuModel).toBe(f.cpuModel.trim().toLowerCase())
    expect(f.cpuCores).toBeGreaterThan(0)
    expect(f.totalMem).toBeGreaterThan(0)
    expect(["linux", "win32", "darwin", "freebsd", "openbsd", "sunos"]).toContain(f.platform)
  })
})

describe("computeDiskIdHash / deriveDiskId", () => {
  it("binding → hash 64 hex; deriveDiskId → DSK-XXXX-XXXX-XXXX (prefijo)", () => {
    const binding = {
      device: "/dev/sda2",
      uuid: "52973387-abcd-0000",
      fstype: "ext4",
      mountPoint: "/opt/viewlba",
      method: "findmnt-uuid",
    }
    const hash = computeDiskIdHash(binding)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    const id = deriveDiskId(hash)
    expect(id).toMatch(DISK_ID_RE)
    expect(id.slice(4).replace(/-/g, "")).toBe(hash.slice(0, 12).toUpperCase())
  })

  it("binding distinto (otro UUID) → diskId distinto (sección 19: mover disco)", () => {
    const b1 = { device: "/dev/sda2", uuid: "uuid-1", fstype: "ext4", mountPoint: "/", method: "m" }
    const b2 = { device: "/dev/sdb1", uuid: "uuid-2", fstype: "ext4", mountPoint: "/", method: "m" }
    expect(computeDiskIdHash(b1)).not.toBe(computeDiskIdHash(b2))
  })

  it("misma identidad de disco en otra RUTA no usada para el hash... (ruta sí participa, documentado)", () => {
    const b1 = { device: "/dev/sda2", uuid: "u", fstype: "ext4", mountPoint: "/opt/a", method: "m" }
    const b2 = { device: "/dev/sda2", uuid: "u", fstype: "ext4", mountPoint: "/opt/b", method: "m" }
    // el mountPoint participa del hash → mover la instalación a otro VOLUMEN
    // (otro mountPoint) cambia el diskId aunque el UUID se repita (raro).
    // Esto refuerza el binding por volumen.
    expect(computeDiskIdHash(b1)).not.toBe(computeDiskIdHash(b2))
  })
})

describe("normalizeInstallPath", () => {
  it("windows: drive en mayúscula + resto minúsculas + separadores /", () => {
    expect(normalizeInstallPath("C:\\PantallaRestaurante")).toBe("C:/pantallarestaurante")
    expect(normalizeInstallPath("C:\\PantallaRestaurante\\")).toBe("C:/pantallarestaurante")
    expect(normalizeInstallPath("D:/Apps/View LBA")).toBe("D:/apps/view lba")
    // el case del drive se IGNORA en la comparación de ambas direcciones
    expect(normalizeInstallPath("c:/pantallarestaurante")).toBe("C:/pantallarestaurante")
  })

  it("linux: sin barra final (excepto raíz)", () => {
    expect(normalizeInstallPath("/opt/viewlba/")).toBe("/opt/viewlba")
    expect(normalizeInstallPath("/")).toBe("/")
  })

  it("determinista y sin espacios extremos", () => {
    expect(normalizeInstallPath("  /opt/viewlba ")).toBe("/opt/viewlba")
  })
})

describe("detectDiskBinding (runner real)", () => {
  it("siempre devuelve un binding (con fallback débil en contenedores)", async () => {
    const binding = await detectDiskBinding(process.cwd())
    expect(binding.method).toBeTruthy()
    expect(binding.device).toBeTruthy()
    const hash = computeDiskIdHash(binding)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it("diskLabelOf da una etiqueta amigable (sin seriales crudos)", async () => {
    const binding = await detectDiskBinding(process.cwd())
    const label = diskLabelOf(binding)
    expect(label.length).toBeGreaterThan(0)
    expect(label.length).toBeLessThan(60)
  })
})
