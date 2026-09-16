/**
 * ViewLBA — Gate de coherencia de versión (FASE 5 de la release 3.0.0).
 *
 * Fuente única de verdad: archivo /VERSION de la raíz.
 * Este script FAIL (exit 1) si cualquier consumidor de la versión diverge:
 *   · package.json (servidor)
 *   · CHANGELOG.md (debe existir la sección "## [<version>]")
 *   · android build.gradle.kts (NO puede hardcodear versionName/versionCode)
 *   · workflows (NO pueden hardcodear nombres de APK versionados)
 *   · android gradle.properties VERSION_CODE (entero monótono ≥ 2)
 *
 * Ejecutado en CI (job quality) y auditable localmente:
 *   bun scripts/check-version.ts
 */
import { readFileSync, existsSync } from "node:fs";

const fail = (msg: string): never => {
  console.error(`✗ [check-version] ${msg}`);
  process.exit(1);
};

// 1. Archivo VERSION
if (!existsSync("VERSION")) fail("falta /VERSION (fuente única de verdad)");
const version = readFileSync("VERSION", "utf8").trim();
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  fail(`VERSION '${version}' no es semver (X.Y.Z[-rc.N])`);
}
console.log(`✓ /VERSION = ${version}`);

// 2. package.json
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
if (pkg.version !== version) {
  fail(`package.json (${pkg.version}) ≠ VERSION (${version})`);
}
console.log(`✓ package.json = ${pkg.version}`);

// 3. CHANGELOG.md — sección de la versión (texto exacto, sin sufijo rc)
const base = version.split("-")[0];
const changelog = readFileSync("CHANGELOG.md", "utf8");
if (!changelog.includes(`## [${base}]`)) {
  fail(`CHANGELOG.md no tiene sección '## [${base}]'`);
}
console.log(`✓ CHANGELOG.md tiene sección [${base}]`);

// 4. Android build.gradle.kts — sin versiones hardcodeadas
const gradleApp = readFileSync(
  "android-license-generator/app/build.gradle.kts",
  "utf8",
);
if (/versionName\s*=\s*"/.test(gradleApp) || /versionCode\s*=\s*\d/.test(gradleApp)) {
  fail("build.gradle.kts hardcodea versionName/versionCode (debe leer /VERSION)");
}
if (!gradleApp.includes('File(rootDir.parentFile, "VERSION")')) {
  fail("build.gradle.kts no lee /VERSION (fuente única de verdad rota)");
}
console.log("✓ build.gradle.kts deriva la versión de /VERSION");

// 5. Android VERSION_CODE monótono
const gradleProps = readFileSync(
  "android-license-generator/gradle.properties",
  "utf8",
);
const m = gradleProps.match(/^VERSION_CODE=(\d+)$/m);
if (!m) fail("falta VERSION_CODE en android-license-generator/gradle.properties");
const code = Number(m?.[1] ?? 0);
if (code < 2) fail(`VERSION_CODE=${code} no es monótono (v1.0.0 publicada con 1)`);
console.log(`✓ VERSION_CODE = ${code} (monótono > 1)`);

// 6. Workflows — sin nombres de APK versionados hardcodeados
const workflows = [
  ".github/workflows/android-license-generator.yml",
  ".github/workflows/release-installer.yml",
  ".github/workflows/ci.yml",
];
for (const wf of workflows) {
  const text = readFileSync(wf, "utf8");
  if (/License-Generator-v\d+\.\d+\.\d+\.apk/.test(text)) {
    fail(`${wf} hardcodea el nombre del APK (debe derivarlo del tag/VERSION)`);
  }
}
console.log("✓ workflows derivan el nombre del APK (sin hardcodeo)");

console.log(`\nOK — versión ${version} coherente en todas las fuentes`);
