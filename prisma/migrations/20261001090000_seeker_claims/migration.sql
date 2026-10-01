-- AlterTable
ALTER TABLE "Claim" ADD COLUMN     "sgtMint" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Claim_campaignId_sgtMint_key" ON "Claim"("campaignId", "sgtMint");

