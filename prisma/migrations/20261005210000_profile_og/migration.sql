-- AlterTable
ALTER TABLE "Profile" ADD COLUMN     "og" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "ogCheckedAt" TIMESTAMP(3);

