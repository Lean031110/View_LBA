-- CreateTable
CREATE TABLE "Theme" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "themeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "author" TEXT NOT NULL DEFAULT '',
    "version" TEXT NOT NULL DEFAULT '1.0.0',
    "description" TEXT NOT NULL DEFAULT '',
    "manifestJson" TEXT NOT NULL,
    "themeJson" TEXT NOT NULL,
    "dir" TEXT NOT NULL,
    "assetsJson" TEXT NOT NULL DEFAULT '[]',
    "source" TEXT NOT NULL DEFAULT 'imported',
    "installedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_LicenseState" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'main',
    "token" TEXT,
    "payloadJson" TEXT,
    "activatedAt" DATETIME,
    "activatedBy" TEXT,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_LicenseState" ("activatedAt", "activatedBy", "id", "payloadJson", "token", "updatedAt") SELECT "activatedAt", "activatedBy", "id", "payloadJson", "token", "updatedAt" FROM "LicenseState";
DROP TABLE "LicenseState";
ALTER TABLE "new_LicenseState" RENAME TO "LicenseState";
CREATE TABLE "new_Settings" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'main',
    "restaurantName" TEXT NOT NULL DEFAULT 'La Terraza Grill & Bar',
    "logoUrl" TEXT,
    "logoSize" TEXT NOT NULL DEFAULT 'md',
    "logoPosition" TEXT NOT NULL DEFAULT 'right',
    "clockFormat" TEXT NOT NULL DEFAULT '12',
    "showDate" BOOLEAN NOT NULL DEFAULT true,
    "showSeconds" BOOLEAN NOT NULL DEFAULT false,
    "showDay" BOOLEAN NOT NULL DEFAULT true,
    "timezone" TEXT NOT NULL DEFAULT 'America/Havana',
    "language" TEXT NOT NULL DEFAULT 'es',
    "streamSource" TEXT NOT NULL DEFAULT 'local',
    "rtmpPort" INTEGER NOT NULL DEFAULT 1935,
    "rtmpApp" TEXT NOT NULL DEFAULT 'live',
    "rtmpHost" TEXT,
    "streamEnabled" BOOLEAN NOT NULL DEFAULT true,
    "streamUrl" TEXT,
    "streamProtocol" TEXT NOT NULL DEFAULT 'hls',
    "streamServer" TEXT,
    "streamKey" TEXT,
    "autoplay" BOOLEAN NOT NULL DEFAULT true,
    "reconnectBehavior" TEXT NOT NULL DEFAULT 'auto',
    "fallbackType" TEXT NOT NULL DEFAULT 'message',
    "fallbackMessage" TEXT NOT NULL DEFAULT 'LA TRANSMISIÓN SE REANUDARÁ EN BREVE',
    "fallbackImageUrl" TEXT,
    "fallbackVideoUrl" TEXT,
    "audioVolume" INTEGER NOT NULL DEFAULT 80,
    "audioMuted" BOOLEAN NOT NULL DEFAULT true,
    "audioDeviceId" TEXT,
    "audioAutoUnmute" BOOLEAN NOT NULL DEFAULT false,
    "tickerEnabled" BOOLEAN NOT NULL DEFAULT true,
    "tickerSpeed" INTEGER NOT NULL DEFAULT 55,
    "tickerPaused" BOOLEAN NOT NULL DEFAULT false,
    "primaryColor" TEXT NOT NULL DEFAULT '#f5a623',
    "accentColor" TEXT NOT NULL DEFAULT '#e8452c',
    "bgColor" TEXT NOT NULL DEFAULT '#0b0b0f',
    "surfaceColor" TEXT NOT NULL DEFAULT '#15151b',
    "fontScale" REAL NOT NULL DEFAULT 1,
    "streamRatio" REAL NOT NULL DEFAULT 0.5,
    "animationsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "animationSpeed" REAL NOT NULL DEFAULT 1,
    "showPromotions" BOOLEAN NOT NULL DEFAULT true,
    "showDish" BOOLEAN NOT NULL DEFAULT true,
    "showSocials" BOOLEAN NOT NULL DEFAULT true,
    "showSchedule" BOOLEAN NOT NULL DEFAULT true,
    "showTicker" BOOLEAN NOT NULL DEFAULT true,
    "activeThemeId" TEXT NOT NULL DEFAULT 'default',
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Settings" ("accentColor", "animationSpeed", "animationsEnabled", "audioAutoUnmute", "audioDeviceId", "audioMuted", "audioVolume", "autoplay", "bgColor", "clockFormat", "fallbackImageUrl", "fallbackMessage", "fallbackType", "fallbackVideoUrl", "fontScale", "id", "language", "logoPosition", "logoSize", "logoUrl", "primaryColor", "reconnectBehavior", "restaurantName", "rtmpApp", "rtmpHost", "rtmpPort", "showDate", "showDay", "showDish", "showPromotions", "showSchedule", "showSeconds", "showSocials", "showTicker", "streamEnabled", "streamKey", "streamProtocol", "streamRatio", "streamServer", "streamSource", "streamUrl", "surfaceColor", "tickerEnabled", "tickerPaused", "tickerSpeed", "timezone", "updatedAt") SELECT "accentColor", "animationSpeed", "animationsEnabled", "audioAutoUnmute", "audioDeviceId", "audioMuted", "audioVolume", "autoplay", "bgColor", "clockFormat", "fallbackImageUrl", "fallbackMessage", "fallbackType", "fallbackVideoUrl", "fontScale", "id", "language", "logoPosition", "logoSize", "logoUrl", "primaryColor", "reconnectBehavior", "restaurantName", "rtmpApp", "rtmpHost", "rtmpPort", "showDate", "showDay", "showDish", "showPromotions", "showSchedule", "showSeconds", "showSocials", "showTicker", "streamEnabled", "streamKey", "streamProtocol", "streamRatio", "streamServer", "streamSource", "streamUrl", "surfaceColor", "tickerEnabled", "tickerPaused", "tickerSpeed", "timezone", "updatedAt" FROM "Settings";
DROP TABLE "Settings";
ALTER TABLE "new_Settings" RENAME TO "Settings";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "Theme_themeId_key" ON "Theme"("themeId");

-- CreateIndex
CREATE UNIQUE INDEX "Theme_dir_key" ON "Theme"("dir");

-- CreateIndex
CREATE INDEX "Theme_installedAt_idx" ON "Theme"("installedAt");
