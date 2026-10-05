-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "membersOnly" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Club" ADD COLUMN     "rulesJson" JSONB;

