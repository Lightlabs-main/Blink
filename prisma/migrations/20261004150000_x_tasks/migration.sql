-- CreateTable
CREATE TABLE "XTask" (
    "campaignId" UUID NOT NULL,
    "privyUserId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "postId" TEXT,
    "postUrl" TEXT,
    "authorHandle" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "XTask_pkey" PRIMARY KEY ("campaignId","privyUserId")
);

-- CreateIndex
CREATE UNIQUE INDEX "XTask_campaignId_postId_key" ON "XTask"("campaignId", "postId");

-- CreateIndex
CREATE UNIQUE INDEX "XTask_campaignId_authorHandle_key" ON "XTask"("campaignId", "authorHandle");
