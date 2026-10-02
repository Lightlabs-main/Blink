-- CreateTable
CREATE TABLE "PushToken" (
    "token" TEXT NOT NULL,
    "privyUserId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PushToken_pkey" PRIMARY KEY ("token")
);

-- CreateIndex
CREATE INDEX "PushToken_privyUserId_idx" ON "PushToken"("privyUserId");
