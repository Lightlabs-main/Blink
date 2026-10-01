-- CreateTable
CREATE TABLE "XStockEligibility" (
    "privyUserId" TEXT NOT NULL,
    "declaredCountry" VARCHAR(2) NOT NULL,
    "notUsPerson" BOOLEAN NOT NULL,
    "attestations" TEXT[],
    "ipCountry" VARCHAR(2),
    "eligible" BOOLEAN NOT NULL,
    "reason" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "XStockEligibility_pkey" PRIMARY KEY ("privyUserId")
);

