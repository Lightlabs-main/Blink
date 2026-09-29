import { createHash } from 'node:crypto'

/**
 * Maximum seed length accepted by CreateAccountWithSeed / createAddressWithSeed.
 * VERIFIED 2026-09-29: @solana/addresses@8.4.0 dist `var MAX_SEED_LENGTH = 32`, enforced in createAddressWithSeed.
 */
export const MAX_CREATE_WITH_SEED_LENGTH = 32

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export class CampaignSeedError extends Error {
  override name = 'CampaignSeedError'
}

/**
 * MASTER_PROMPT §11 preferred seed: campaign UUID with hyphens removed → exactly 32 lowercase ASCII hex chars.
 * Input must be a canonical lowercase UUID so a given campaign always yields one seed.
 */
export function campaignSeedFromUuid(campaignId: string): string {
  if (!UUID_RE.test(campaignId)) {
    throw new CampaignSeedError(`campaignId must be a lowercase canonical UUID, got "${campaignId}"`)
  }
  const seed = campaignId.replaceAll('-', '')
  assertSeedLength(seed)
  return seed
}

/**
 * MASTER_PROMPT §11 fallback seed if campaign IDs stop being UUIDs:
 * sha256(campaignId + ":" + mint) → lowercase hex → first 32 ASCII characters.
 */
export function campaignSeedFromHash(campaignId: string, mint: string): string {
  if (!campaignId || !mint) throw new CampaignSeedError('campaignId and mint are required')
  const seed = createHash('sha256').update(`${campaignId}:${mint}`, 'utf8').digest('hex').slice(0, 32)
  assertSeedLength(seed)
  return seed
}

export function assertSeedLength(seed: string): void {
  const bytes = new TextEncoder().encode(seed).byteLength
  if (bytes === 0 || bytes > MAX_CREATE_WITH_SEED_LENGTH) {
    throw new CampaignSeedError(`seed must be 1..${MAX_CREATE_WITH_SEED_LENGTH} bytes, got ${bytes}`)
  }
}
