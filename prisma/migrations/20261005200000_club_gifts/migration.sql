-- AlterTable
ALTER TABLE "ClubMessage" ADD COLUMN     "giftId" UUID;

-- CreateTable
CREATE TABLE "ClubGift" (
    "id" UUID NOT NULL,
    "clubId" UUID NOT NULL,
    "senderPrivyUserId" TEXT NOT NULL,
    "recipientPrivyUserId" TEXT NOT NULL,
    "senderWallet" TEXT,
    "mint" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "decimals" INTEGER NOT NULL,
    "amountRaw" DECIMAL(20,0) NOT NULL,
    "cluster" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClubGift_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClubGift_signature_key" ON "ClubGift"("signature");

-- CreateIndex
CREATE INDEX "ClubGift_recipientPrivyUserId_createdAt_idx" ON "ClubGift"("recipientPrivyUserId", "createdAt");

-- CreateIndex
CREATE INDEX "ClubGift_senderPrivyUserId_createdAt_idx" ON "ClubGift"("senderPrivyUserId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ClubMessage_giftId_key" ON "ClubMessage"("giftId");

