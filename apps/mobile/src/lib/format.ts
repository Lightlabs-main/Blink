import type { CampaignStatus, CampaignType } from '../shared'

export function shortAddress(value: string, head = 4, tail = 4): string {
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`
}

export const CAMPAIGN_TYPE_LABEL: Record<CampaignType, string> = {
  GIFT: 'Gift',
  TAP_RUSH: 'Tap Rush',
  EARLY_CLAIM: 'Early Claim',
  REFERRAL: 'Referral',
  SEEKER: 'Seeker Drop',
}

export const CAMPAIGN_TYPE_BLURB: Record<CampaignType, string> = {
  GIFT: 'Send stock to someone with a link.',
  TAP_RUSH: 'People tap fast to earn stock.',
  EARLY_CLAIM: 'First people to claim get stock.',
  REFERRAL: 'Reward people who bring friends.',
  SEEKER: 'A drop for Seeker phone owners.',
}

export const CAMPAIGN_STATUS_LABEL: Record<CampaignStatus, string> = {
  DRAFT: 'Draft',
  AWAITING_FUNDING: 'Needs funding',
  AWAITING_DELEGATION: 'Needs approval',
  LIVE: 'Live',
  PAUSED: 'Paused',
  ENDED: 'Ended',
  CLOSED: 'Closed',
}

/** Deep link for a campaign. Becomes an https App Link once a domain exists (DECISIONS D-12). */
export function campaignLink(id: string): string {
  return `blinktostock://campaign/${id}`
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/

/** Accept only Blink campaign links from a scanned QR; never open arbitrary URLs. */
export function campaignIdFromScan(data: string): string | null {
  const prefix = 'blinktostock://campaign/'
  const trimmed = data.trim()
  if (!trimmed.startsWith(prefix)) return null
  const rest = trimmed.slice(prefix.length)
  const id = rest.match(UUID)?.[0]
  return id && rest === id ? id : null
}

export const CAMPAIGN_TYPE_ICON = {
  GIFT: 'gift',
  TAP_RUSH: 'target',
  EARLY_CLAIM: 'clock',
  REFERRAL: 'users',
  SEEKER: 'phone',
} as const

export function greeting(date = new Date()): string {
  const h = date.getHours()
  return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

export function networkLabel(cluster: string | undefined): { label: string; isTest: boolean } {
  if (cluster === 'mainnet-beta') return { label: 'Mainnet', isTest: false }
  if (cluster === 'devnet') return { label: 'Devnet · test money', isTest: true }
  return { label: cluster ?? 'Connecting…', isTest: true }
}
