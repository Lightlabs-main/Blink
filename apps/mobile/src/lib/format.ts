import { type CampaignStatus, type CampaignType, REFERRAL_CODE_RE } from '../shared'

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
  REFERRAL: 'People invite friends — both get stock.',
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

export const WEB_ORIGIN = 'https://blinksol.site'

/**
 * Shareable campaign link, optionally carrying a referral invite code. An Android App Link: it opens Blink when
 * installed and the campaign web page otherwise (DECISIONS D-12).
 */
export function campaignLink(id: string, ref?: string): string {
  return `${WEB_ORIGIN}/c/${id}${ref ? `?ref=${ref}` : ''}`
}

const UUID_SRC = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'
// Current https links, plus the app-scheme links printed on QR codes before the domain existed.
const LINKS = [
  new RegExp(`^https://(?:www\\.)?blinksol\\.site/c/${UUID_SRC}/?(?:\\?ref=([^&#]+))?$`),
  new RegExp(`^blinktostock://campaign/${UUID_SRC}(?:\\?ref=([^&#]+))?$`),
]

/** Accept only Blink campaign links from a scanned QR (with an optional valid invite code); never open arbitrary URLs. */
export function parseCampaignLink(data: string): { id: string; ref: string | null } | null {
  const trimmed = data.trim()
  const m = LINKS.map((re) => trimmed.match(re)).find(Boolean)
  if (!m) return null
  const ref = m[2] ?? null
  if (ref !== null && !REFERRAL_CODE_RE.test(ref)) return null
  return { id: m[1]!, ref }
}

/** In-app route for a campaign (used after scanning and as a sign-in return target). */
export function campaignRoute(id: string, ref?: string | null): string {
  return `/campaign/${id}${ref ? `?ref=${ref}` : ''}`
}

/** Why a drop is paused, in plain words (PauseReason). */
export function pauseReasonText(reason: string | null): string {
  switch (reason) {
    case 'DELEGATION_REVOKED':
      return 'Blink’s approval on your campaign account was removed.'
    case 'DELEGATE_CHANGED':
      return 'Your campaign account now approves a different address.'
    case 'ALLOWANCE_EXHAUSTED':
    case 'INSUFFICIENT_BALANCE':
      return 'Your campaign account no longer has enough stock or approval for another reward.'
    case 'ACCOUNT_FROZEN':
      return 'Your campaign account was frozen by the stock’s issuer.'
    case 'MINT_STATE_CHANGED':
      return 'The stock’s issuer paused transfers.'
    case 'BUDGET_EXHAUSTED':
      return 'Blink paused payouts for now.'
    default:
      return 'Payouts are paused.'
  }
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

/** Public explorer receipt for a transaction on the campaign's cluster. */
export function explorerTxUrl(signature: string, cluster: string): string {
  const suffix = cluster === 'mainnet-beta' ? '' : `?cluster=${cluster === 'localnet' ? 'custom' : cluster}`
  return `https://explorer.solana.com/tx/${signature}${suffix}`
}
