-- CreateTable
CREATE TABLE "Profile" (
    "privyUserId" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "username" TEXT,
    "avatar" BYTEA,
    "avatarType" TEXT,
    "avatarVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Profile_pkey" PRIMARY KEY ("privyUserId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Profile_publicId_key" ON "Profile"("publicId");

-- CreateIndex
CREATE UNIQUE INDEX "Profile_username_key" ON "Profile"("username");
