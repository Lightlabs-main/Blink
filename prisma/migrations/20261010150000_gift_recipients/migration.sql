-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "recipientIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "ClubGift" ALTER COLUMN "clubId" DROP NOT NULL;

