-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'OPERATOR',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "authVersion" INTEGER NOT NULL DEFAULT 0,
    "lastLoginAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Screen" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "location" TEXT,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "tokenHash" TEXT,
    "lastSeenAt" DATETIME,
    "metadata" TEXT,
    "audioDeviceId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Promotion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "price" TEXT,
    "oldPrice" TEXT,
    "discount" TEXT,
    "badge" TEXT,
    "imageUrl" TEXT,
    "startDate" DATETIME,
    "endDate" DATETIME,
    "startTime" TEXT,
    "endTime" TEXT,
    "duration" INTEGER NOT NULL DEFAULT 10,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Dish" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price" TEXT,
    "imageUrl" TEXT,
    "ingredients" TEXT,
    "tag" TEXT,
    "nutrition" TEXT,
    "dayOfWeek" INTEGER,
    "date" DATETIME,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Schedule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "dayOfWeek" INTEGER,
    "icon" TEXT,
    "color" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SocialLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "network" TEXT NOT NULL,
    "username" TEXT,
    "url" TEXT,
    "color" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "TickerMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "text" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Settings" (
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
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Log" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "userName" TEXT,
    "action" TEXT NOT NULL,
    "section" TEXT,
    "details" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Screen_code_key" ON "Screen"("code");

