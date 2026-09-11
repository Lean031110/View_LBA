-- ViewLBA v2.0.0 — Sistema de licencias por token copiar/pegar (VLBA2).
--
-- El flujo ZIP/license.json desaparece: LicenseState guarda ahora el token
-- VLBA2 original (normalizado) + el payload decodificado, y LicenseHistory
-- registra activaciones (renovaciones) con plan "custom" y duración exacta.
--
-- ⚠ Recreación deliberada de ambas tablas: en producción NO existen licencias
--   emitidas con el flujo v1 (v1.2.1 rotó la clave con cero emisiones), por
--   lo que no hay datos que preservar. Un upgrade desde v1.x simplemente
--   limpia el estado de licencia (el cliente re-activa pegando su token v2).

DROP TABLE IF EXISTS "LicenseState";
DROP TABLE IF EXISTS "LicenseHistory";

-- Table Definition
CREATE TABLE "LicenseState" (
    "id" TEXT NOT NULL DEFAULT 'main',
    "token" TEXT,
    "payloadJson" TEXT,
    "activatedAt" DATETIME,
    "activatedBy" TEXT,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LicenseState_pkey" PRIMARY KEY ("id")
);

-- Table Definition
CREATE TABLE "LicenseHistory" (
    "id" TEXT NOT NULL,
    "licenseId" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "durationDays" INTEGER NOT NULL,
    "issuedAt" DATETIME NOT NULL,
    "startsAt" DATETIME NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "installationId" TEXT NOT NULL,
    "diskId" TEXT NOT NULL,
    "activatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedBy" TEXT,
    "current" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "LicenseHistory_pkey" PRIMARY KEY ("id")
);
