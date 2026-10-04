-- CreateTable
CREATE TABLE "UsernameClaim" (
    "username" TEXT NOT NULL,
    "privyUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsernameClaim_pkey" PRIMARY KEY ("username")
);

-- CreateIndex
CREATE INDEX "UsernameClaim_privyUserId_idx" ON "UsernameClaim"("privyUserId");

-- Names already in use belong to their current owners.
INSERT INTO "UsernameClaim" ("username", "privyUserId") SELECT "username", "privyUserId" FROM "Profile" WHERE "username" IS NOT NULL ON CONFLICT DO NOTHING;
