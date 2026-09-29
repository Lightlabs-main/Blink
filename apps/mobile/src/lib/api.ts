import type { CampaignSummary, CampaignType } from '../shared'

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
  multiplier: number | null
  paused: boolean | null
}

export interface PreparedFunding {
  transaction: string
  minContextSlot: string
  summary: { campaignAccount: string; delegate: string; amountRaw: string; rentLamports: string; accountSpace: string }
}

export const api = {
  xstocks: () => request<{ xstocks: XStockListing[] }>('/v1/xstocks'),
  liveCampaigns: () => request<{ campaigns: CampaignSummary[] }>('/v1/campaigns'),
  campaign: (id: string) => request<{ campaign: CampaignSummary }>(`/v1/campaigns/${encodeURIComponent(id)}`),
  me: (t: GetAccessToken) => authed<{ privyUserId: string; verifiedCreatorWallets: string[] }>(t, '/v1/me'),
  holdings: (t: GetAccessToken) =>
    authed<{ available: boolean; wallets: { wallet: string; balances: Record<string, string> | null }[] }>(t, '/v1/me/holdings'),
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
    body: { type: CampaignType; mint: string; allowanceRaw: string },
    creatorWallet?: string,
  ) =>
    authed<{ campaign: CampaignSummary }>(t, '/v1/campaigns', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: creatorWallet ? { 'x-creator-wallet': creatorWallet } : undefined,
    }),
}
