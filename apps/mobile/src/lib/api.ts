import type {
  CampaignSummary,
  CampaignType,
  CampaignRoom,
  ClaimSummary,
  QuestEvaluation,
  QuestRequirements,
  ReferralSummary,
  TapRushRules,
  TapRushSessionSummary,
  XStockEligibilitySummary,
} from '../shared'

const baseUrl = process.env.EXPO_PUBLIC_BLINK_API_URL

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export type GetAccessToken = () => Promise<string | null>

async function request<T>(path: string, init: RequestInit & { token?: string | null } = {}): Promise<T> {
  if (!baseUrl) throw new ApiError(0, 'NO_API_URL', 'EXPO_PUBLIC_BLINK_API_URL is not configured')
  const headers: Record<string, string> = { accept: 'application/json' }
  if (init.body) headers['content-type'] = 'application/json'
  if (init.token) headers.authorization = `Bearer ${init.token}`
  let res: Response
  try {
    res = await fetch(`${baseUrl}${path}`, { ...init, headers: { ...headers, ...(init.headers as object) } })
  } catch {
    throw new ApiError(0, 'NETWORK', 'Could not reach Blink. Check your connection and try again.')
  }
  const text = await res.text()
  const json = text ? (JSON.parse(text) as unknown) : null
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } } | null)?.error
    throw new ApiError(res.status, err?.code ?? 'HTTP_ERROR', err?.message ?? `Request failed (${res.status})`)
  }
  return json as T
}

async function authed<T>(getAccessToken: GetAccessToken, path: string, init: RequestInit = {}): Promise<T> {
  const token = await getAccessToken()
  if (!token) throw new ApiError(401, 'UNAUTHENTICATED', 'Please sign in again.')
  return request<T>(path, { ...init, token })
}

export interface XStockListing {
  symbol: string
  name: string
  mint: string
  decimals: number
  logo: string | null
  isTest: boolean
  multiplier: number | null
  paused: boolean | null
}

export interface WalletHoldings {
  wallet: string
  kind: 'stock' | 'creator'
  balances: Record<string, string> | null
}

export interface PreparedFunding {
  transaction: string
  minContextSlot: string
  summary: { campaignAccount: string; delegate: string; amountRaw: string; rentLamports: string; accountSpace: string }
}

/** D-23: wallet SKR and the position with Blink's guardian pool (mainnet). Raw amounts, 6 decimals. */
export interface SkrPosition {
  wallet: string
  guardianPool: string
  walletRaw: string
  stakedRaw: string
  unstakingRaw: string
  minStakeRaw: string
  cooldownSeconds: number
  withdrawableAt: string | null
}

export type SkrAction = 'stake' | 'unstake' | 'withdraw' | 'cancel_unstake'

export const api = {
  skrPosition: (t: GetAccessToken, wallet: string) => authed<{ position: SkrPosition }>(t, `/v1/skr/position?wallet=${encodeURIComponent(wallet)}`),
  skrPrepare: (t: GetAccessToken, body: { wallet: string; action: SkrAction; amountRaw?: string; all?: boolean }) =>
    authed<{ prepared: { transaction: string; minContextSlot: string; lastValidBlockHeight: string } }>(t, '/v1/skr/prepare', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  savePushToken: (t: GetAccessToken, token: string, platform: 'android' | 'ios') =>
    authed<{ ok: true }>(t, '/v1/me/push-token', { method: 'POST', body: JSON.stringify({ token, platform }) }),
  deletePushToken: (t: GetAccessToken, token: string) =>
    authed<{ ok: true }>(t, '/v1/me/push-token', { method: 'DELETE', body: JSON.stringify({ token }) }),
  xstocks: () => request<{ xstocks: XStockListing[] }>('/v1/xstocks'),
  liveCampaigns: () => request<{ campaigns: CampaignSummary[] }>('/v1/campaigns'),
  campaign: (id: string) => request<{ campaign: CampaignSummary }>(`/v1/campaigns/${encodeURIComponent(id)}`),
  me: (t: GetAccessToken) => authed<{ privyUserId: string; verifiedCreatorWallets: string[] }>(t, '/v1/me'),
  holdings: (t: GetAccessToken) =>
    authed<{ available: boolean; wallets: WalletHoldings[] }>(t, '/v1/me/holdings'),
  health: () => request<{ ok: boolean; cluster: 'localnet' | 'devnet' | 'mainnet-beta'; demoMode: boolean }>('/health'),
  myCampaigns: (t: GetAccessToken) => authed<{ campaigns: CampaignSummary[] }>(t, '/v1/me/campaigns'),
  fundingPrepare: (t: GetAccessToken, id: string) =>
    authed<PreparedFunding>(t, `/v1/campaigns/${encodeURIComponent(id)}/funding/prepare`, { method: 'POST' }),
  fundingSubmit: (t: GetAccessToken, id: string, signedTransaction: string) =>
    authed<{ signature: string; verified: boolean; campaign: CampaignSummary }>(
      t,
      `/v1/campaigns/${encodeURIComponent(id)}/funding/submit`,
      { method: 'POST', body: JSON.stringify({ signedTransaction }) },
    ),
  fundingVerify: (t: GetAccessToken, id: string) =>
    authed<{ verified: boolean; campaign: CampaignSummary }>(t, `/v1/campaigns/${encodeURIComponent(id)}/funding/verify`, {
      method: 'POST',
    }),
  createCampaign: (
    t: GetAccessToken,
    body: {
      type: CampaignType
      mint: string
      allowanceRaw: string
      rewardPerClaimRaw?: string
      tapRush?: TapRushRules
      requirements?: QuestRequirements
      startsAt?: string
      endsAt?: string
    },
    creatorWallet?: string,
  ) =>
    authed<{ campaign: CampaignSummary }>(t, '/v1/campaigns', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: creatorWallet ? { 'x-creator-wallet': creatorWallet } : undefined,
    }),
  /** Pays the fixed reward to the caller's Blink wallet. Waits for the network (up to ~30 s). */
  claim: (t: GetAccessToken, id: string, opts: { tapSessionId?: string; ref?: string } = {}) =>
    authed<{ claim: ClaimSummary }>(t, `/v1/campaigns/${encodeURIComponent(id)}/claim`, {
      method: 'POST',
      body: JSON.stringify(opts),
    }),
  /** D-21: the server checks every Verified Quest requirement now. */
  verifyQuest: (t: GetAccessToken, id: string) =>
    authed<{ evaluation: QuestEvaluation }>(t, `/v1/campaigns/${encodeURIComponent(id)}/verify`, { method: 'POST' }),
  /** D-21: public live room (real aggregates; truncated wallets only). */
  room: (id: string) => request<{ room: CampaignRoom }>(`/v1/campaigns/${encodeURIComponent(id)}/room`),
  myReferral: (t: GetAccessToken, id: string) => authed<{ referral: ReferralSummary | null }>(t, `/v1/campaigns/${encodeURIComponent(id)}/referral`),
  createReferral: (t: GetAccessToken, id: string) =>
    authed<{ referral: ReferralSummary }>(t, `/v1/campaigns/${encodeURIComponent(id)}/referral`, { method: 'POST' }),
  retryBonus: (t: GetAccessToken, id: string) =>
    authed<{ claim: ClaimSummary }>(t, `/v1/campaigns/${encodeURIComponent(id)}/referral/bonus/retry`, { method: 'POST' }),
  resume: (t: GetAccessToken, id: string) =>
    authed<{ campaign: CampaignSummary }>(t, `/v1/campaigns/${encodeURIComponent(id)}/resume`, { method: 'POST' }),
  myClaim: (t: GetAccessToken, id: string) => authed<{ claim: ClaimSummary | null }>(t, `/v1/campaigns/${encodeURIComponent(id)}/claim`),
  myClaims: (t: GetAccessToken) => authed<{ claims: ClaimSummary[] }>(t, '/v1/me/claims'),
  /** D-20: the caller's own xStocks eligibility (never public). */
  myEligibility: (t: GetAccessToken) => authed<{ enforced: boolean; eligibility: XStockEligibilitySummary | null }>(t, '/v1/me/eligibility'),
  declareEligibility: (t: GetAccessToken, body: { country: string; notUsPerson: boolean; attestations: string[] }) =>
    authed<{ enforced: boolean; eligibility: XStockEligibilitySummary }>(t, '/v1/me/eligibility', { method: 'POST', body: JSON.stringify(body) }),
  tapRushStart: (t: GetAccessToken, id: string) =>
    authed<{ session: TapRushSessionSummary }>(t, `/v1/campaigns/${encodeURIComponent(id)}/tap-rush/start`, { method: 'POST' }),
  tapRushFinish: (t: GetAccessToken, id: string, sessionId: string, tapTimesMs: number[]) =>
    authed<{ qualified: boolean; taps: number; goal: number; attemptsLeft: number }>(
      t,
      `/v1/campaigns/${encodeURIComponent(id)}/tap-rush/finish`,
      { method: 'POST', body: JSON.stringify({ sessionId, taps: tapTimesMs.length, tapTimesMs }) },
    ),
}
