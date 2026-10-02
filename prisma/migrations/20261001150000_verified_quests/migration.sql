-- AlterEnum
ALTER TYPE "CampaignType" ADD VALUE 'VERIFIED_QUEST';

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "endsAt" TIMESTAMP(3),
ADD COLUMN     "requirementsHash" TEXT,
ADD COLUMN     "requirementsJson" JSONB,
ADD COLUMN     "startsAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "TapRushSession" ADD COLUMN     "publicWallet" TEXT;

-- CreateTable
CREATE TABLE "QuestVerification" (
    "campaignId" UUID NOT NULL,
    "privyUserId" TEXT NOT NULL,
    "qualified" BOOLEAN NOT NULL,
    "summary" JSONB NOT NULL,
    "publicWallet" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuestVerification_pkey" PRIMARY KEY ("campaignId","privyUserId")
);

-- CreateIndex
CREATE INDEX "QuestVerification_campaignId_checkedAt_idx" ON "QuestVerification"("campaignId", "checkedAt");

