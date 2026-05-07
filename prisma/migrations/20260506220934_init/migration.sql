-- CreateEnum
CREATE TYPE "Portal" AS ENUM ('OTODOM', 'OLX', 'GRATKA', 'MORIZON', 'NIERUCHOMOSCI_ONLINE', 'RENTOLA');

-- CreateEnum
CREATE TYPE "ListingStatus" AS ENUM ('PENDING_ENRICHMENT', 'PUBLISHED', 'REJECTED', 'STALE');

-- CreateTable
CREATE TABLE "Listing" (
    "id" TEXT NOT NULL,
    "portal" "Portal" NOT NULL,
    "externalId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT,
    "district" TEXT NOT NULL,
    "rooms" INTEGER NOT NULL,
    "areaM2" DOUBLE PRECISION NOT NULL,
    "rentPrice" INTEGER NOT NULL,
    "adminFee" INTEGER,
    "deposit" INTEGER,
    "totalPrice" INTEGER NOT NULL,
    "phone" TEXT,
    "postedAt" TIMESTAMP(3),
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "nearestStation" TEXT NOT NULL,
    "haversineMeters" INTEGER NOT NULL,
    "walkingMeters" INTEGER,
    "fingerprint" VARCHAR(40) NOT NULL,
    "status" "ListingStatus" NOT NULL DEFAULT 'PENDING_ENRICHMENT',
    "rawDescription" TEXT,
    "aiParsed" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "notifiedAt" TIMESTAMP(3),

    CONSTRAINT "Listing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DuplicateLink" (
    "id" TEXT NOT NULL,
    "primaryId" TEXT NOT NULL,
    "duplicateId" TEXT NOT NULL,
    "matchScore" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DuplicateLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScrapeRun" (
    "id" TEXT NOT NULL,
    "portal" "Portal" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "itemsFound" INTEGER NOT NULL DEFAULT 0,
    "itemsKept" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB,

    CONSTRAINT "ScrapeRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Listing_url_key" ON "Listing"("url");

-- CreateIndex
CREATE INDEX "Listing_fingerprint_idx" ON "Listing"("fingerprint");

-- CreateIndex
CREATE INDEX "Listing_district_totalPrice_idx" ON "Listing"("district", "totalPrice");

-- CreateIndex
CREATE INDEX "Listing_status_createdAt_idx" ON "Listing"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Listing_portal_externalId_key" ON "Listing"("portal", "externalId");

-- CreateIndex
CREATE INDEX "DuplicateLink_duplicateId_idx" ON "DuplicateLink"("duplicateId");

-- CreateIndex
CREATE UNIQUE INDEX "DuplicateLink_primaryId_duplicateId_key" ON "DuplicateLink"("primaryId", "duplicateId");

-- CreateIndex
CREATE INDEX "ScrapeRun_portal_startedAt_idx" ON "ScrapeRun"("portal", "startedAt");

-- AddForeignKey
ALTER TABLE "DuplicateLink" ADD CONSTRAINT "DuplicateLink_primaryId_fkey" FOREIGN KEY ("primaryId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuplicateLink" ADD CONSTRAINT "DuplicateLink_duplicateId_fkey" FOREIGN KEY ("duplicateId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
