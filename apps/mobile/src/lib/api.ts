import type {
  ChatMessage,
  ClubCategory,
  ClubDetail,
  ClubLeaderboardEntry,
  ClubMemberView,
  PublicParticipant,
  ClubReaction,
  ClubSummary,
  Passport,
  SquadSummary,
  CampaignSummary,
  CampaignType,
  CampaignRoom,
  ClaimSummary,
  HistoryItem,
  QuestEvaluation,
  QuestGroup,
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
    /** The whole error body (e.g. D-41 `evaluation` for CLUB_RULES_NOT_MET). */
    readonly details?: unknown,
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
    throw new ApiError(res.status, err?.code ?? 'HTTP_ERROR', err?.message ?? `Request failed (${res.status})`, json)
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

/** D-37: the caller's public profile. `avatarUrl` is a path on the API origin; use `apiUrl()` to load it. */
export interface MyProfile {
  username: string | null
  avatarUrl: string | null
}

/** Absolute URL for a path the API returned (e.g. a profile picture). */
export function apiUrl(path: string | null | undefined): string | null {
  return path && baseUrl ? `${baseUrl}${path}` : null
}

/** D-32: the Blink stock wallet (Privy embedded wallet) and its balances. */
export interface StockWallet {
  wallet: string
  solLamports: string
  assets: { mint: string; symbol: string; decimals: number; logo: string | null; isTest: boolean; raw: string }[]
}

export type SkrAction = 'stake' | 'unstake' | 'withdraw' | 'cancel_unstake'

/** D-39: the caller's X task for a drop. */
export interface XTask {
  code: string | null
  mustInclude: string | null
  suggestedText: string | null
  verified: boolean
  postUrl: string | null
  authorHandle: string | null
}

export const api = {
  xTask: (t: GetAccessToken, campaignId: string) => authed<{ task: XTask }>(t, `/v1/campaigns/${encodeURIComponent(campaignId)}/x-task`),
  submitXTask: (t: GetAccessToken, campaignId: string, url: string) =>
    authed<{ task: XTask }>(t, `/v1/campaigns/${encodeURIComponent(campaignId)}/x-task`, { method: 'POST', body: JSON.stringify({ url }) }),
  /** D-38: rewards, invite bonuses, sends and funded drops, newest first. */
  history: (t: GetAccessToken) => authed<{ items: HistoryItem[] }>(t, '/v1/me/history'),
  myProfile: (t: GetAccessToken) => authed<{ profile: MyProfile }>(t, '/v1/me/profile'),
  setUsername: (t: GetAccessToken, username: string | null) =>
    authed<{ profile: MyProfile }>(t, '/v1/me/profile', { method: 'PUT', body: JSON.stringify({ username }) }),
  setAvatar: (t: GetAccessToken, imageBase64: string) =>
    authed<{ profile: MyProfile }>(t, '/v1/me/avatar', { method: 'PUT', body: JSON.stringify({ image: imageBase64 }) }),
  removeAvatar: (t: GetAccessToken) => authed<{ profile: MyProfile }>(t, '/v1/me/avatar', { method: 'DELETE' }),
  stockWallet: (t: GetAccessToken) => authed<{ wallet: StockWallet }>(t, '/v1/me/wallet'),
  /** Blink pays the fee; the stock wallet signs in the app, then `sendSubmit` sends it. */
  sendPrepare: (t: GetAccessToken, body: { asset: string; to: string; amountRaw: string }) =>
    authed<{ prepared: { transaction: string; from: string; createsRecipientAccount: boolean } }>(t, '/v1/me/send/prepare', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  sendSubmit: (t: GetAccessToken, signedTransaction: string) =>
    authed<{ signature: string }>(t, '/v1/me/send/submit', { method: 'POST', body: JSON.stringify({ signedTransaction }) }),
  skrPosition: (t: GetAccessToken, wallet: string) => authed<{ position: SkrPosition }>(t, `/v1/skr/position?wallet=${encodeURIComponent(wallet)}`),
  skrPrepare: (t: GetAccessToken, body: { wallet: string; action: SkrAction; amountRaw?: string; all?: boolean }) =>
    authed<{ prepared: { transaction: string; minContextSlot: string; lastValidBlockHeight: string } }>(t, '/v1/skr/prepare', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  savePushToken: (t: GetAccessToken, token: string, platform: 'android' | 'ios') =>
    authed<{ ok: true }>(t, '/v1/me/push-token', { method: 'POST', body: JSON.stringify({ token, platform }) }),
  /** D-26: Privy's Expo SDK can only unlink Ethereum wallets, so Solana wallets are removed by the server. */
  unlinkCreatorWallet: (t: GetAccessToken, wallet: string) =>
    authed<{ verifiedCreatorWallets: string[] }>(t, `/v1/me/wallets/${encodeURIComponent(wallet)}`, { method: 'DELETE' }),
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
      clubId?: string
      membersOnly?: boolean
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
  // ---- D-40: clubs, chat, squads, event check-in, passport ----
  clubs: (t: GetAccessToken, opts: { tab?: 'discover' | 'joined'; q?: string } = {}) => {
    const qs = new URLSearchParams()
    if (opts.tab) qs.set('tab', opts.tab)
    if (opts.q) qs.set('q', opts.q)
    return authed<{ clubs: ClubSummary[] }>(t, `/v1/clubs${qs.size ? `?${qs.toString()}` : ''}`)
  },
  club: (t: GetAccessToken, slug: string, invite?: string) =>
    authed<{ club: ClubDetail }>(t, `/v1/clubs/${encodeURIComponent(slug)}${invite ? `?invite=${encodeURIComponent(invite)}` : ''}`),
  createClub: (t: GetAccessToken, body: { name: string; description: string; category: ClubCategory; tags: string[]; visibility: 'PUBLIC' | 'PRIVATE'; rules: QuestGroup[] }) =>
    authed<{ club: ClubSummary }>(t, '/v1/clubs', { method: 'POST', body: JSON.stringify(body) }),
  /** D-41: owner only; applies to new joins. */
  setClubRules: (t: GetAccessToken, slug: string, rules: QuestGroup[]) =>
    authed<{ club: ClubSummary }>(t, `/v1/clubs/${encodeURIComponent(slug)}/rules`, { method: 'PUT', body: JSON.stringify({ rules }) }),
  joinClub: (t: GetAccessToken, slug: string, invite?: string) =>
    authed<{ club: ClubSummary }>(t, `/v1/clubs/${encodeURIComponent(slug)}/join`, { method: 'POST', body: JSON.stringify(invite ? { invite } : {}) }),
  leaveClub: (t: GetAccessToken, slug: string) => authed<{ club: ClubSummary }>(t, `/v1/clubs/${encodeURIComponent(slug)}/leave`, { method: 'POST', body: '{}' }),
  messages: (t: GetAccessToken, slug: string, cursor: { before?: string; after?: string } = {}) => {
    const qs = new URLSearchParams()
    if (cursor.before) qs.set('before', cursor.before)
    if (cursor.after) qs.set('after', cursor.after)
    return authed<{ messages: ChatMessage[]; serverTime: string }>(t, `/v1/clubs/${encodeURIComponent(slug)}/messages${qs.size ? `?${qs.toString()}` : ''}`)
  },
  sendMessage: (t: GetAccessToken, slug: string, body: string, replyTo?: string) =>
    authed<{ message: ChatMessage }>(t, `/v1/clubs/${encodeURIComponent(slug)}/messages`, { method: 'POST', body: JSON.stringify(replyTo ? { body, replyTo } : { body }) }),
  deleteMessage: (t: GetAccessToken, slug: string, id: string) =>
    authed<{ ok: true }>(t, `/v1/clubs/${encodeURIComponent(slug)}/messages/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  react: (t: GetAccessToken, slug: string, id: string, emoji: ClubReaction) =>
    authed<{ message: ChatMessage }>(t, `/v1/clubs/${encodeURIComponent(slug)}/messages/${encodeURIComponent(id)}/reactions`, { method: 'POST', body: JSON.stringify({ emoji }) }),
  // ---- D-43: voice notes and admin controls ----
  sendVoice: (t: GetAccessToken, slug: string, audioBase64: string, durationMs: number, replyTo?: string) =>
    authed<{ message: ChatMessage }>(t, `/v1/clubs/${encodeURIComponent(slug)}/voice`, {
      method: 'POST',
      body: JSON.stringify(replyTo ? { audio: audioBase64, durationMs, replyTo } : { audio: audioBase64, durationMs }),
    }),
  clubMembers: (t: GetAccessToken, slug: string) =>
    authed<{ members: ClubMemberView[]; removed: { id: string; who: PublicParticipant; at: string }[] | null }>(t, `/v1/clubs/${encodeURIComponent(slug)}/members`),
  setMemberRole: (t: GetAccessToken, slug: string, memberId: string, role: 'MOD' | 'MEMBER') =>
    authed<{ ok: true }>(t, `/v1/clubs/${encodeURIComponent(slug)}/members/${memberId}/role`, { method: 'POST', body: JSON.stringify({ role }) }),
  muteMember: (t: GetAccessToken, slug: string, memberId: string, minutes: number) =>
    authed<{ ok: true; mutedUntil: string | null }>(t, `/v1/clubs/${encodeURIComponent(slug)}/members/${memberId}/mute`, { method: 'POST', body: JSON.stringify({ minutes }) }),
  removeMember: (t: GetAccessToken, slug: string, memberId: string) =>
    authed<{ ok: true }>(t, `/v1/clubs/${encodeURIComponent(slug)}/members/${memberId}/remove`, { method: 'POST', body: '{}' }),
  restoreMember: (t: GetAccessToken, slug: string, memberId: string) =>
    authed<{ ok: true }>(t, `/v1/clubs/${encodeURIComponent(slug)}/removed/${memberId}/restore`, { method: 'POST', body: '{}' }),
  clubSettings: (t: GetAccessToken, slug: string, body: { adminsOnly?: boolean; description?: string }) =>
    authed<{ ok: true; adminsOnly: boolean }>(t, `/v1/clubs/${encodeURIComponent(slug)}/settings`, { method: 'PUT', body: JSON.stringify(body) }),
  pinMessage: (t: GetAccessToken, slug: string, id: string, on: boolean) =>
    authed<{ ok: true }>(t, `/v1/clubs/${encodeURIComponent(slug)}/messages/${encodeURIComponent(id)}/pin`, { method: on ? 'POST' : 'DELETE' }),
  reportMessage: (t: GetAccessToken, slug: string, id: string) =>
    authed<{ reported: true; hidden: boolean }>(t, `/v1/clubs/${encodeURIComponent(slug)}/messages/${encodeURIComponent(id)}/report`, { method: 'POST', body: '{}' }),
  clubLeaderboard: (t: GetAccessToken, slug: string, period: 'week' | 'all') =>
    authed<{ leaderboard: ClubLeaderboardEntry[]; points: { REWARD: number; QUALIFIED: number; CHECKIN: number } }>(t, `/v1/clubs/${encodeURIComponent(slug)}/leaderboard?period=${period}`),
  eventCode: (t: GetAccessToken, campaignId: string, rotate = false) =>
    authed<{ event: { token: string; link: string } }>(t, `/v1/campaigns/${encodeURIComponent(campaignId)}/event-code`, rotate ? { method: 'POST' } : {}),
  checkIn: (t: GetAccessToken, token: string) =>
    authed<{ checkin: { campaignId: string; alreadyCheckedIn: boolean } }>(t, '/v1/checkin', { method: 'POST', body: JSON.stringify({ token }) }),
  squads: (t: GetAccessToken, campaignId: string) => authed<{ mine: SquadSummary | null; squads: SquadSummary[] }>(t, `/v1/campaigns/${encodeURIComponent(campaignId)}/squads`),
  createSquad: (t: GetAccessToken, campaignId: string, name: string) =>
    authed<{ squad: SquadSummary }>(t, `/v1/campaigns/${encodeURIComponent(campaignId)}/squads`, { method: 'POST', body: JSON.stringify({ name }) }),
  joinSquad: (t: GetAccessToken, code: string) => authed<{ squad: SquadSummary }>(t, '/v1/squads/join', { method: 'POST', body: JSON.stringify({ code }) }),
  leaveSquad: (t: GetAccessToken, id: string) => authed<{ ok: true; disbanded: boolean }>(t, `/v1/squads/${encodeURIComponent(id)}/leave`, { method: 'POST', body: '{}' }),
  passport: (t: GetAccessToken) => authed<{ passport: Passport }>(t, '/v1/me/passport'),
}
