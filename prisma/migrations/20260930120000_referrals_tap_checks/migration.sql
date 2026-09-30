-- CreateEnum
CREATE TYPE "ClaimKind" AS ENUM ('CLAIM', 'REFERRAL_BONUS');

-- DropIndex
DROP INDEX "Claim_campaignId_privyUserId_key";

-- DropIndex
DROP INDEX "Claim_campaignId_recipientWallet_key";

-- AlterTable
ALTER TABLE "Claim" ADD COLUMN     "bonusForClaimId" UUID,
ADD COLUMN     "kind" "ClaimKind" NOT NULL DEFAULT 'CLAIM',
ADD COLUMN     "referralCode" TEXT;

-- AlterTable
ALTER TABLE "TapRushSession" ADD COLUMN     "rejectReason" TEXT;

-- CreateTable
CREATE TABLE "Referral" (
    "code" TEXT NOT NULL,
    "campaignId" UUID NOT NULL,
    "privyUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Referral_pkey" PRIMARY KEY ("code")
);

-- CreateIndex
CREATE UNIQUE INDEX "Referral_campaignId_privyUserId_key" ON "Referral"("campaignId", "privyUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Claim_bonusForClaimId_key" ON "Claim"("bonusForClaimId");

-- CreateIndex
CREATE UNIQUE INDEX "Claim_campaignId_privyUserId_kind_key" ON "Claim"("campaignId", "privyUserId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "Claim_campaignId_recipientWallet_kind_key" ON "Claim"("campaignId", "recipientWallet", "kind");

