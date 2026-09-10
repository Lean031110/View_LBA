-- ViewLBA — Sistema de licenciamiento offline (feature/offline-licensing)
-- Licencia importada (autoridad del servidor) + historial de renovaciones.

-- CreateTable
CREATE TABLE "LicenseState" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "licenseJson" TEXT,
    "importedAt" DATETIME,
    "importedBy" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "LicenseHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "licenseId" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "issuedAt" DATETIME NOT NULL,
    "startsAt" DATETIME NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "deviceId" TEXT NOT NULL,
    "diskId" TEXT NOT NULL,
    "importedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "current" BOOLEAN NOT NULL DEFAULT false
);
