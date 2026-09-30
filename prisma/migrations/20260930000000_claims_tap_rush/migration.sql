-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('RESERVED', 'SENDING', 'PAID', 'FAILED');

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "claimedRaw" DECIMAL(20,0) NOT NULL DEFAULT 0,
ADD COLUMN     "rewardPerClaimRaw" DECIMAL(20,0),
ADD COLUMN     "tapGoal" INTEGER,
ADD COLUMN     "tapSeconds" INTEGER;

-- CreateTable
CREATE TABLE "Claim" (
    "id" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "privyUserId" TEXT NOT NULL,
    "recipientWallet" TEXT NOT NULL,
    "amountRaw" DECIMAL(20,0) NOT NULL,
    "status" "ClaimStatus" NOT NULL DEFAULT 'RESERVED',
    "txSignature" TEXT,
    "lastValidBlockHeight" BIGINT,
    "failureReason" TEXT,
    "tapSessionId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Claim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TapRushSession" (
    "id" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "privyUserId" TEXT NOT NULL,
    "goal" INTEGER NOT NULL,
    "seconds" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "taps" INTEGER,
    "qualified" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "TapRushSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceWallet" (
    "role" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "walletRef" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceWallet_pkey" PRIMARY KEY ("role")
);

-- CreateIndex
CREATE UNIQUE INDEX "Claim_txSignature_key" ON "Claim"("txSignature");

-- CreateIndex
CREATE UNIQUE INDEX "Claim_tapSessionId_key" ON "Claim"("tapSessionId");

-- CreateIndex
CREATE INDEX "Claim_privyUserId_createdAt_idx" ON "Claim"("privyUserId", "createdAt");

-- CreateIndex
CREATE INDEX "Claim_status_idx" ON "Claim"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Claim_campaignId_privyUserId_key" ON "Claim"("campaignId", "privyUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Claim_campaignId_recipientWallet_key" ON "Claim"("campaignId", "recipientWallet");

-- CreateIndex
CREATE INDEX "TapRushSession_campaignId_privyUserId_idx" ON "TapRushSession"("campaignId", "privyUserId");


-- Defense in depth (D-13): the pool can never be over-committed, even by a buggy update.
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_claimedRaw_within_allowance" CHECK ("claimedRaw" >= 0 AND "claimedRaw" <= "allowanceRaw");
