import type { BlinkEnv } from '@blink/config'
import { evaluateXStockEligibility, XSTOCK_POLICY, type XStockEligibilityReason, type XStockEligibilitySummary } from '@blink/domain'

import type { IpCountryResolver } from './ip-country.ts'
import { ClaimError } from './payout-service.ts'

/** D-20 minimum-data record: country codes, result, reason, policy version, method, time. */
export interface StoredEligibility {
  privyUserId: string
  declaredCountry: string
  notUsPerson: boolean
  attestations: string[]
  ipCountry: string | null
  eligible: boolean
  reason: XStockEligibilityReason
  policyId: string
  policyVersion: string
  method: string
  decidedAt: Date
}

export interface EligibilityStore {
  getEligibility(privyUserId: string): Promise<StoredEligibility | null>
  putEligibility(record: Omit<StoredEligibility, 'decidedAt'>): Promise<StoredEligibility>
}

const REASON_TEXT: Record<XStockEligibilityReason, string> = {
  ELIGIBLE: 'eligible',
  US_PERSON: 'xStocks are not available to U.S. persons',
  DECLARED_COUNTRY_RESTRICTED: 'xStocks are not available in your country',
  IP_COUNTRY_RESTRICTED: 'xStocks are not available where you are connecting from',
  IP_COUNTRY_UNKNOWN: 'we could not confirm where you are connecting from',
  REGION_ATTESTATION_MISSING: 'please confirm the region question to continue',
  INVALID_COUNTRY: 'please choose your country',
}

/**
 * xStocks eligibility gate (SECURITY.md §1, DECISIONS D-19/D-20). Separate from every campaign verifier and
 * mandatory for every path that ends in an xStock transfer, and for creators before funding.
 */
export class EligibilityService {
  constructor(
    private readonly deps: { env: BlinkEnv; store: EligibilityStore; ipCountry: IpCountryResolver },
  ) {}

  get enforced() {
    return this.deps.env.XSTOCK_COMPLIANCE === 'enforce'
  }

  /** Records the user's declaration with the server's decision, using the request's IP country as cross-check. */
  async declare(privyUserId: string, input: { country: string; notUsPerson: boolean; attestations: string[] }, ip: string) {
    const ipCountry = this.deps.ipCountry.countryOf(ip)
    const result = evaluateXStockEligibility({
      declaredCountry: input.country,
      notUsPerson: input.notUsPerson,
      attestations: input.attestations,
      ipCountry,
    })
    const stored = await this.deps.store.putEligibility({
      privyUserId,
      declaredCountry: input.country.toUpperCase(),
      notUsPerson: input.notUsPerson,
      attestations: input.attestations,
      ipCountry,
      eligible: result.eligible,
      reason: result.reason,
      policyId: XSTOCK_POLICY.id,
      policyVersion: XSTOCK_POLICY.version,
      method: XSTOCK_POLICY.method,
    })
    return this.toSummary(stored)
  }

  async summary(privyUserId: string): Promise<XStockEligibilitySummary | null> {
    const stored = await this.deps.store.getEligibility(privyUserId)
    return stored ? this.toSummary(stored) : null
  }

  /**
   * Throws unless the user's current-policy decision is eligible AND the current request's IP country is allowed.
   * Fails closed: no record, an outdated policy or an unknown IP country all block.
   */
  async requireEligible(privyUserId: string, ip: string): Promise<void> {
    if (!this.enforced) return
    const stored = await this.deps.store.getEligibility(privyUserId)
    if (!stored || stored.policyId !== XSTOCK_POLICY.id || stored.policyVersion !== XSTOCK_POLICY.version) {
      throw new ClaimError('NEEDS_ELIGIBILITY', 'confirm where you live to receive xStocks', 403)
    }
    const now = evaluateXStockEligibility({
      declaredCountry: stored.declaredCountry,
      notUsPerson: stored.notUsPerson,
      attestations: stored.attestations,
      ipCountry: this.deps.ipCountry.countryOf(ip),
    })
    if (!stored.eligible || !now.eligible) {
      const reason = stored.eligible ? now.reason : stored.reason
      throw new ClaimError('NOT_ELIGIBLE', REASON_TEXT[reason], 403)
    }
  }

  /** For a third party without a live request (e.g. a referrer's bonus): their stored, current decision. */
  async isEligibleStored(privyUserId: string): Promise<boolean> {
    if (!this.enforced) return true
    const stored = await this.deps.store.getEligibility(privyUserId)
    return Boolean(stored && stored.eligible && stored.policyVersion === XSTOCK_POLICY.version)
  }

  private toSummary(s: StoredEligibility): XStockEligibilitySummary {
    return {
      policyId: s.policyId,
      policyVersion: s.policyVersion,
      current: s.policyId === XSTOCK_POLICY.id && s.policyVersion === XSTOCK_POLICY.version,
      declaredCountry: s.declaredCountry,
      eligible: s.eligible,
      reason: s.reason,
      decidedAt: s.decidedAt.toISOString(),
    }
  }
}
