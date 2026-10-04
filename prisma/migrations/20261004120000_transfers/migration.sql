-- CreateTable
CREATE TABLE "Transfer" (
    "id" UUID NOT NULL,
    "privyUserId" TEXT NOT NULL,
    "cluster" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "decimals" INTEGER NOT NULL,
    "amountRaw" DECIMAL(20,0) NOT NULL,
    "toAddress" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Transfer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Transfer_signature_key" ON "Transfer"("signature");

-- CreateIndex
CREATE INDEX "Transfer_privyUserId_createdAt_idx" ON "Transfer"("privyUserId", "createdAt");
