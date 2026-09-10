import { defineConfig } from "@playwright/test"

/**
 * Playwright — E2E de la FASE 22 (misión: 23 escenarios).
 *
 * Stack real por test-run (webServer):
 *   1. realtime-service  → :3003 (socket.io) / :3004 (health interno)
 *   2. stream-service    → :1935 (RTMP) / :8000 (HTTP-FLV, localhost) / :8100 (control)
 *   3. Next.js dev       → :3000 (la app; compila bajo demanda — timeouts amplios)
 *
 * La DB es AISLADA: scripts/e2e-setup.ts la resetea (db/e2e.db) ANTES de
 * levantar el stack (orden garantizado por `npm run test:e2e`).
 *
 * Nota: realtime usa el puerto 3003 REAL porque client-socket.ts construye
 * ws://<host>:3003 (LAN) — el E2E debe ejercitar exactamente el flujo real.
 */
// LICENSING E2E: overrides de identidad (solo NODE_ENV != production) +
// clave pública DUMMY de test → el server valida la licencia importada por
// e2e-setup.ts (activo). Ver e2e/fixtures/licensing/keys.ts.
const E2E_LICENSE_ENV = "VIEWLBA_TEST_DEVICE_FINGERPRINT=00946114a3a48905be6f60d95f945a1b29f3f2b261e32f30521afed84407f8e7 VIEWLBA_TEST_DISK_ID_HASH=a5ed432a37dde11ef146fcc98049c07d06e0db193cc1cf69dc2214d7b2cc8b02 VIEWLBA_TEST_INSTALL_PATH=/srv/viewlba-e2e VIEWLBA_LICENSE_PUBLIC_KEY=DEYlcmsRR7oWGjm7E72KhO2G5BzgirmO5w0mmsVtz6w"
const E2E_ENV = "DATABASE_URL=file:../db/e2e.db AUTH_SECRET=e2e-secret-0123456789abcdef0123456789 REALTIME_TOKEN=e2e-rt-internal-token-0123456789abcdef LOGIN_RATE_LIMIT_IP_MAX=500 " + E2E_LICENSE_ENV

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  // Un solo worker: stack compartido (DB única + servicios únicos) — serie estricta
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 20_000,
    locale: "es-ES",
  },
  outputDir: "test-results",
  webServer: [
    {
      command: `${E2E_ENV} bun mini-services/realtime-service/index.ts`,
      url: "http://127.0.0.1:3004/health",
      timeout: 60_000,
      reuseExistingServer: false,
    },
    {
      command: `${E2E_ENV} bun mini-services/stream-service/index.ts`,
      url: "http://127.0.0.1:8100/health",
      timeout: 60_000,
      reuseExistingServer: false,
    },
    {
      command: `${E2E_ENV} bunx next dev -p 3000`,
      url: "http://127.0.0.1:3000/api/health",
      timeout: 180_000,
      reuseExistingServer: false,
    },
  ],
})
