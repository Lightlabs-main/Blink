-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "CampaignType" AS ENUM ('GIFT', 'TAP_RUSH', 'EARLY_CLAIM', 'REFERRAL', 'SEEKER');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'AWAITING_FUNDING', 'AWAITING_DELEGATION', 'LIVE', 'PAUSED', 'ENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "SolanaCluster" AS ENUM ('localnet', 'devnet', 'mainnet-beta');

-- CreateTable
CREATE TABLE "Campaign" (
    "id" UUID NOT NULL,
    "type" "CampaignType" NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "cluster" "SolanaCluster" NOT NULL,
    "creatorPrivyUserId" TEXT NOT NULL,
    "creatorWallet" TEXT NOT NULL,
    "mint" TEXT NOT NULL,
    "xstockSymbol" TEXT NOT NULL,
    "campaignSeed" VARCHAR(32) NOT NULL,
    "campaignTokenAccount" TEXT NOT NULL,
    "delegateAddress" TEXT,
    "delegateWalletRef" TEXT,
    "allowanceRaw" DECIMAL(20,0) NOT NULL,
    "pauseReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BudgetLedgerEntry" (
    "id" UUID NOT NULL,
    "cluster" "SolanaCluster" NOT NULL,
    "kind" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "lamports" BIGINT NOT NULL,
    "campaignId" UUID,
    "txSignature" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BudgetLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "campaignId" UUID,
    "details" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Campaign_status_idx" ON "Campaign"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Campaign_cluster_campaignTokenAccount_key" ON "Campaign"("cluster", "campaignTokenAccount");

-- CreateIndex
CREATE UNIQUE INDEX "Campaign_creatorWallet_campaignSeed_key" ON "Campaign"("creatorWallet", "campaignSeed");

-- CreateIndex
CREATE UNIQUE INDEX "BudgetLedgerEntry_txSignature_key" ON "BudgetLedgerEntry"("txSignature");

-- CreateIndex
CREATE UNIQUE INDEX "BudgetLedgerEntry_idempotencyKey_key" ON "BudgetLedgerEntry"("idempotencyKey");

-- CreateIndex
CREATE INDEX "BudgetLedgerEntry_cluster_state_idx" ON "BudgetLedgerEntry"("cluster", "state");

-- CreateIndex
CREATE INDEX "AuditLog_campaignId_createdAt_idx" ON "AuditLog"("campaignId", "createdAt");
