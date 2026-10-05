-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "clubId" UUID;

-- CreateTable
CREATE TABLE "Club" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "tags" TEXT[],
    "visibility" TEXT NOT NULL DEFAULT 'PUBLIC',
    "inviteCode" TEXT NOT NULL,
    "ownerPrivyUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Club_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClubMember" (
    "clubId" UUID NOT NULL,
    "privyUserId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'MEMBER',
    "publicWallet" TEXT,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClubMember_pkey" PRIMARY KEY ("clubId","privyUserId")
);

-- CreateTable
CREATE TABLE "ClubMessage" (
    "id" BIGSERIAL NOT NULL,
    "clubId" UUID NOT NULL,
    "authorPrivyUserId" TEXT NOT NULL,
    "authorWallet" TEXT,
    "body" TEXT NOT NULL,
    "replyToId" BIGINT,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClubMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClubMessageReaction" (
    "messageId" BIGINT NOT NULL,
    "privyUserId" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClubMessageReaction_pkey" PRIMARY KEY ("messageId","privyUserId","emoji")
);

-- CreateTable
CREATE TABLE "EventCode" (
    "campaignId" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventCode_pkey" PRIMARY KEY ("campaignId")
);

-- CreateTable
CREATE TABLE "EventCheckin" (
    "campaignId" UUID NOT NULL,
    "privyUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventCheckin_pkey" PRIMARY KEY ("campaignId","privyUserId")
);

-- CreateTable
CREATE TABLE "Squad" (
    "id" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "captainPrivyUserId" TEXT NOT NULL,
    "maxSize" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Squad_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SquadMember" (
    "squadId" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "privyUserId" TEXT NOT NULL,
    "publicWallet" TEXT,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SquadMember_pkey" PRIMARY KEY ("squadId","privyUserId")
);

-- CreateTable
CREATE TABLE "ClubMessageReport" (
    "messageId" BIGINT NOT NULL,
    "privyUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClubMessageReport_pkey" PRIMARY KEY ("messageId","privyUserId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Club_slug_key" ON "Club"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Club_inviteCode_key" ON "Club"("inviteCode");

-- CreateIndex
CREATE INDEX "Club_ownerPrivyUserId_createdAt_idx" ON "Club"("ownerPrivyUserId", "createdAt");

-- CreateIndex
CREATE INDEX "ClubMember_privyUserId_joinedAt_idx" ON "ClubMember"("privyUserId", "joinedAt");

-- CreateIndex
CREATE INDEX "ClubMessage_clubId_id_idx" ON "ClubMessage"("clubId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "EventCode_token_key" ON "EventCode"("token");

-- CreateIndex
CREATE INDEX "EventCheckin_privyUserId_createdAt_idx" ON "EventCheckin"("privyUserId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Squad_code_key" ON "Squad"("code");

-- CreateIndex
CREATE INDEX "Squad_campaignId_idx" ON "Squad"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "SquadMember_campaignId_privyUserId_key" ON "SquadMember"("campaignId", "privyUserId");

-- CreateIndex
CREATE INDEX "Campaign_clubId_idx" ON "Campaign"("clubId");

