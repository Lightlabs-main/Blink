-- AlterTable
ALTER TABLE "Profile" ADD COLUMN     "skrCheckedAt" TIMESTAMP(3),
ADD COLUMN     "skrName" TEXT,
ADD COLUMN     "skrWallet" TEXT;

-- CreateTable
CREATE TABLE "SkrTip" (
    "id" UUID NOT NULL,
    "senderPrivyUserId" TEXT NOT NULL,
    "recipientPrivyUserId" TEXT NOT NULL,
    "senderWallet" TEXT NOT NULL,
    "recipientWallet" TEXT NOT NULL,
    "clubId" UUID,
    "amountRaw" DECIMAL(20,0) NOT NULL,
    "cluster" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "signature" TEXT,
    "failure" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "SkrTip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SkrBoost" (
    "id" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "payerPrivyUserId" TEXT NOT NULL,
    "payerWallet" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "amountRaw" DECIMAL(20,0) NOT NULL,
    "hours" INTEGER NOT NULL,
    "cluster" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "signature" TEXT,
    "failure" TEXT,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "SkrBoost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OreDeployProof" (
    "signature" TEXT NOT NULL,
    "privyUserId" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "roundId" DECIMAL(20,0) NOT NULL,
    "squares" INTEGER[],
    "amountPerSquare" DECIMAL(20,0) NOT NULL,
    "totalLamports" DECIMAL(20,0) NOT NULL,
    "slot" DECIMAL(20,0) NOT NULL,
    "deployedAt" TIMESTAMP(3) NOT NULL,
    "campaignId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OreDeployProof_pkey" PRIMARY KEY ("signature")
);

-- CreateIndex
CREATE UNIQUE INDEX "SkrTip_signature_key" ON "SkrTip"("signature");

-- CreateIndex
CREATE INDEX "SkrTip_senderPrivyUserId_createdAt_idx" ON "SkrTip"("senderPrivyUserId", "createdAt");

-- CreateIndex
CREATE INDEX "SkrTip_recipientPrivyUserId_createdAt_idx" ON "SkrTip"("recipientPrivyUserId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SkrBoost_signature_key" ON "SkrBoost"("signature");

-- CreateIndex
CREATE INDEX "SkrBoost_campaignId_endsAt_idx" ON "SkrBoost"("campaignId", "endsAt");

-- CreateIndex
CREATE INDEX "SkrBoost_payerPrivyUserId_createdAt_idx" ON "SkrBoost"("payerPrivyUserId", "createdAt");

-- CreateIndex
CREATE INDEX "OreDeployProof_privyUserId_createdAt_idx" ON "OreDeployProof"("privyUserId", "createdAt");

