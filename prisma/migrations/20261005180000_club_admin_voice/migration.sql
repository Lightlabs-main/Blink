-- AlterTable
ALTER TABLE "Club" ADD COLUMN     "adminsOnly" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pinnedMessageId" BIGINT;

-- AlterTable
ALTER TABLE "ClubMember" ADD COLUMN     "mutedUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ClubMessage" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'TEXT',
ADD COLUMN     "voiceId" TEXT,
ADD COLUMN     "voiceMs" INTEGER;

-- CreateTable
CREATE TABLE "ClubBan" (
    "clubId" UUID NOT NULL,
    "privyUserId" TEXT NOT NULL,
    "publicWallet" TEXT,
    "byPrivyUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClubBan_pkey" PRIMARY KEY ("clubId","privyUserId")
);

-- CreateTable
CREATE TABLE "ClubVoice" (
    "id" TEXT NOT NULL,
    "clubId" UUID NOT NULL,
    "bytes" BYTEA NOT NULL,
    "mime" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClubVoice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClubVoice_clubId_idx" ON "ClubVoice"("clubId");

-- CreateIndex
CREATE UNIQUE INDEX "ClubMessage_voiceId_key" ON "ClubMessage"("voiceId");

