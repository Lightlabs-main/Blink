import type {
  ChatMessage,
  ClubCategory,
  ClubDetail,
  ClubLeaderboardEntry,
  ClubMemberProfile,
  ClubMemberView,
  OgType,
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
  /** D-45: OG marks from the last mainnet check. */
  og: OgType[]
  ogCheckedAt: string | null
  /** D-52: server-verified .skr name; null + checkedAt = verified none; null + no checkedAt = never checked. */
  skrName: string | null
  skrCheckedAt: string | null
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

/** D-49..D-51: what the server has switched on, and the owner-approved packages. Nothing else is shown. */
export interface Features {
  network: 'localnet' | 'devnet' | 'mainnet-beta'
  tips: { enabled: boolean; maxRaw: string }
  boost: { enabled: false } | { enabled: true; priceRaw: string; hours: number; destination: string; refundable: false }
  ore: { deployEnabled: boolean; maxLamportsPerSquare: string | null; maxSquares: number; clubSlug: string | null; rewardsEnabled: boolean }
}

export interface SkrPerson {
  label: string
  username?: string
  skrName?: string
  avatarUrl: string | null
  og?: OgType[]
}

export interface TipReview {
  amountRaw: string
  recipient: SkrPerson
  recipientWallet: string
  recipientWalletKind: 'VERIFIED_WALLET' | 'BLINK_WALLET'
  senderWallet: string
  createsRecipientAccount: boolean
  rentLamports: string
  networkFeeLamports: string
  network: string
}

export interface TipView {
  id: string
  direction: 'SENT' | 'RECEIVED'
  amountRaw: string
  status: 'PREPARED' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'EXPIRED'
  signature: string | null
  network: string
  from: SkrPerson
  to: SkrPerson
  recipientWallet: string
  createdAt: string
  confirmedAt: string | null
}

export interface BoostReview {
  amountRaw: string
  hours: number
  destination: string
  payerWallet: string
  placement: string
  startsAt: string
  refundable: false
  ifDropEnds: string
  createsRecipientAccount: boolean
  rentLamports: string
  networkFeeLamports: string
  network: string
}

export interface BoostView {
  id: string
  campaignId: string
  amountRaw: string
  hours: number
  destination: string
  status: TipView['status']
  signature: string | null
  startsAt: string | null
  endsAt: string | null
  network: string
}

/** A person found by name on Blink (never their wallet or email). `handle` is how to address them again. */
export interface FoundPerson extends SkrPerson {
  handle: string
}
export type NameLookup = { input: string; found: true; isYou: boolean; person: FoundPerson } | { input: string; found: false; reason: 'NOT_FOUND' | 'INVALID' }

export interface OreBoard {
  roundId: string
  phase: 'WAITING' | 'MINING' | 'BETWEEN'
  slot: string
  endSlot: string | null
  slotsLeft: string
  secondsLeftEstimate: number
  squares: { index: number; deployedLamports: string; miners: number }[]
  totalDeployedLamports: string
  totalMiners: number
  readAt: string
  config: Features['ore']
}

export interface OreMe {
  wallet: string | null
  roundId: string | null
  squaresThisRound: number[]
  verifiedDeploys: number
  minerMark: boolean
  recent: { signature: string; roundId: string; squares: number[]; totalLamports: string; at: string }[]
}

export interface OreReview {
  wallet: string
  roundId: string
  squares: number[]
  lamportsPerSquare: string
  cost: { stake: string; checkpointFee: string; minerRent: string; networkFee: string; total: string }
  includesCheckpoint: boolean
  roundEndsInSlots: string
  risk: string
  network: string
}

export interface OreDeployResult {
  signature: string
  created: boolean
  roundId: string
  squares: number[]
  lamportsPerSquare: string
  totalLamports: string
  slot: string
  deployedAt: string
  network: string
  minerMark: true
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
  /** W-1: end the drop and build the creator's revoke + return + close transaction. */
  closePrepare: (t: GetAccessToken, id: string) =>
    authed<{ campaign: CampaignSummary; prepared: { transaction: string; minContextSlot: string; summary: { campaignAccount: string; returnRaw: string; rentLamports: string; revokesDelegate: boolean } } }>(
      t,
      `/v1/campaigns/${encodeURIComponent(id)}/close/prepare`,
      { method: 'POST' },
    ),
  closeSubmit: (t: GetAccessToken, id: string, signedTransaction: string) =>
    authed<{ signature: string; closed: boolean; campaign: CampaignSummary }>(t, `/v1/campaigns/${encodeURIComponent(id)}/close/submit`, {
      method: 'POST',
      body: JSON.stringify({ signedTransaction }),
    }),
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
      /** Gift drop to named people (Blink usernames or .skr names). */
      recipients?: string[]
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
  /** D-45: check OG marks now (mainnet; 3 checks per 10 minutes). */
  checkOg: (t: GetAccessToken) => authed<{ profile: MyProfile; unknown: OgType[] }>(t, '/v1/me/og', { method: 'POST', body: '{}' }),
  // ---- D-44: xStock gifts in club chat (prepare → the stock wallet signs → submit) ----
  giftPrepare: (t: GetAccessToken, slug: string, body: { to: string; asset: string; amountRaw: string }) =>
    authed<{ prepared: { transaction: string; createsRecipientAccount: boolean } }>(t, `/v1/clubs/${encodeURIComponent(slug)}/gifts/prepare`, { method: 'POST', body: JSON.stringify(body) }),
  giftSubmit: (t: GetAccessToken, slug: string, signedTransaction: string) =>
    authed<{ gift: { id: string; signature: string; status: 'CONFIRMED' | 'PENDING' }; message: ChatMessage | null }>(t, `/v1/clubs/${encodeURIComponent(slug)}/gifts/submit`, {
      method: 'POST',
      body: JSON.stringify({ signedTransaction }),
    }),
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
  resolvePeople: (t: GetAccessToken, names: string[]) => authed<{ results: NameLookup[] }>(t, '/v1/people/resolve', { method: 'POST', body: JSON.stringify({ names }) }),
  giftPersonPrepare: (t: GetAccessToken, body: { to: string; asset: string; amountRaw: string }) =>
    authed<{ prepared: { transaction: string; createsRecipientAccount: boolean }; person: FoundPerson }>(t, '/v1/gifts/prepare', { method: 'POST', body: JSON.stringify(body) }),
  giftPersonSubmit: (t: GetAccessToken, signedTransaction: string) =>
    authed<{ gift: { id: string; signature: string; status: 'CONFIRMED' | 'PENDING' } }>(t, '/v1/gifts/submit', { method: 'POST', body: JSON.stringify({ signedTransaction }) }),
  skrGiftPrepare: (t: GetAccessToken, body: { to: string; amountRaw: string; wallet?: string }) =>
    authed<{ tipId: string; transaction: string; review: TipReview }>(t, '/v1/skr/gifts/prepare', { method: 'POST', body: JSON.stringify(body) }),
  giftsForMe: (t: GetAccessToken) => authed<{ drops: { campaign: CampaignSummary; from: string }[] }>(t, '/v1/me/gifts-for-me'),
  memberProfile: (t: GetAccessToken, slug: string, ref: string) =>
    authed<{ profile: ClubMemberProfile }>(t, `/v1/clubs/${encodeURIComponent(slug)}/members/${encodeURIComponent(ref)}/profile`),
  deleteClub: (t: GetAccessToken, slug: string) => authed<{ deleted: true }>(t, `/v1/clubs/${encodeURIComponent(slug)}`, { method: 'DELETE' }),
  // ── D-49..D-52 ──
  features: () => request<Features>('/v1/features'),
  checkSkrIdentity: (t: GetAccessToken) =>
    authed<{ status: 'VERIFIED' | 'NONE' | 'UNAVAILABLE'; skrName: string | null; skrWallet: string | null; checkedAt: string | null }>(t, '/v1/me/skr-identity', { method: 'POST', body: '{}' }),
  tipPrepare: (t: GetAccessToken, slug: string, body: { to: string; amountRaw: string; wallet?: string }) =>
    authed<{ tipId: string; transaction: string; review: TipReview }>(t, `/v1/clubs/${encodeURIComponent(slug)}/tips/prepare`, { method: 'POST', body: JSON.stringify(body) }),
  tipSubmit: (t: GetAccessToken, tipId: string, signedTransaction: string) =>
    authed<{ tip: TipView }>(t, `/v1/skr/tips/${encodeURIComponent(tipId)}/submit`, { method: 'POST', body: JSON.stringify({ signedTransaction }) }),
  tip: (t: GetAccessToken, tipId: string) => authed<{ tip: TipView }>(t, `/v1/skr/tips/${encodeURIComponent(tipId)}`),
  boostPrepare: (t: GetAccessToken, campaignId: string, wallet?: string) =>
    authed<{ boostId: string; transaction: string; review: BoostReview }>(t, `/v1/campaigns/${encodeURIComponent(campaignId)}/boost/prepare`, { method: 'POST', body: JSON.stringify(wallet ? { wallet } : {}) }),
  boostSubmit: (t: GetAccessToken, campaignId: string, boostId: string, signedTransaction: string) =>
    authed<{ boost: BoostView }>(t, `/v1/campaigns/${encodeURIComponent(campaignId)}/boost/${encodeURIComponent(boostId)}/submit`, { method: 'POST', body: JSON.stringify({ signedTransaction }) }),
  boost: (t: GetAccessToken, campaignId: string, boostId: string) =>
    authed<{ boost: BoostView }>(t, `/v1/campaigns/${encodeURIComponent(campaignId)}/boost/${encodeURIComponent(boostId)}`),
  oreBoard: () => request<OreBoard>('/v1/ore/board'),
  oreMe: (t: GetAccessToken) => authed<OreMe>(t, '/v1/ore/me'),
  orePrepare: (t: GetAccessToken, body: { squares: number[]; amountLamports: string; wallet?: string }) =>
    authed<{ transaction: string; review: OreReview }>(t, '/v1/ore/deploy/prepare', { method: 'POST', body: JSON.stringify(body) }),
  oreSubmit: (t: GetAccessToken, signedTransaction: string) =>
    authed<{ deploy: OreDeployResult }>(t, '/v1/ore/deploy/submit', { method: 'POST', body: JSON.stringify({ signedTransaction }) }),
  oreVerify: (t: GetAccessToken, signature: string) =>
    authed<{ deploy: OreDeployResult }>(t, '/v1/ore/deploy/verify', { method: 'POST', body: JSON.stringify({ signature }) }),
}
