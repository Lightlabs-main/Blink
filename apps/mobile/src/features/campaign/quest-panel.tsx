import { usePrivy } from '@privy-io/expo'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { ActivityIndicator, Linking, StyleSheet, View } from 'react-native'

import { Icon, type IconName } from '../../design/icons'
import { color, space } from '../../design/tokens'
import { Button, Card, Notice, Row, T } from '../../design/ui'
import { api, ApiError, type XStockListing } from '../../lib/api'
import { displayShares } from '../../lib/data'
import { campaignRoute } from '../../lib/format'
import { haptics } from '../../lib/haptics'
import {
  type CampaignSummary,
  type ConditionResult,
  formatRaw,
  PRODUCT_COPY,
  type QuestCondition,
  type VerificationStatus,
  VERIFIERS,
} from '../../shared'
import { ClaimReceipt, claimQueryKey, sentence, useClaimRefresh, useMyClaim } from './claim-panel'
import { openOfficialSkrStaking, SKR_SEED_VAULT_NOTE, SKR_STAKE_LABEL } from '../skr/official-staking'
import { XTaskPanel } from './x-task'

const STATUS: Record<VerificationStatus, { icon: IconName; tint: string; text: string }> = {
  PASSED: { icon: 'check', tint: color.lime, text: 'Requirement complete' },
  FAILED: { icon: 'close', tint: color.danger, text: 'Not yet' },
  NOT_STARTED: { icon: 'arrowRight', tint: color.textMuted, text: 'To do' },
  CHECKING: { icon: 'refresh', tint: color.textDim, text: 'Checking…' },
  PENDING: { icon: 'clock', tint: color.warning, text: 'Pending' },
  ERROR: { icon: 'refresh', tint: color.warning, text: 'Couldn’t check right now' },
  STALE: { icon: 'clock', tint: color.warning, text: 'Check again' },
}

/** "Has at least 500 SKR staked" from the registry template and the configured raw minimum. */
export function describeCondition(c: QuestCondition) {
  const def = VERIFIERS[c.verifier]
  const min = def.amount && c.minRaw ? `${formatRaw(BigInt(c.minRaw), def.amount.decimals)}` : ''
  return def.describe.replace('{min}', min)
}

function amountDetail(c: QuestCondition, r: ConditionResult | undefined) {
  const def = VERIFIERS[c.verifier]
  if (!def.amount || !r?.actualRaw || !r.requiredRaw) return null
  const actual = BigInt(r.actualRaw)
  const required = BigInt(r.requiredRaw)
  const yours = `Yours: ${formatRaw(actual, def.amount.decimals)} ${def.amount.symbol}`
  return actual >= required ? yours : `${yours} · ${formatRaw(required - actual, def.amount.decimals)} more needed`
}

/**
 * Verified Quest participant view (update §32): every requirement on its own line with its server-checked state and a
 * helpful action. "Qualified" only after the server says so; the reward flow starts only then.
 */
export function QuestPanel({ campaign, asset }: { campaign: CampaignSummary; asset: XStockListing | undefined }) {
  const router = useRouter()
  const { user, getAccessToken } = usePrivy()
  const queryClient = useQueryClient()
  const refresh = useClaimRefresh(campaign.id)
  const mine = useMyClaim(campaign.id)
  const live = campaign.status === 'LIVE'
  const check = useQuery({
    queryKey: ['quest', campaign.id],
    queryFn: () => api.verifyQuest(getAccessToken, campaign.id),
    enabled: Boolean(user) && live && !mine.data?.claim,
    staleTime: 15_000,
    retry: false,
  })
  const claim = useMutation({
    mutationFn: () => api.claim(getAccessToken, campaign.id),
    onSuccess: (res) => {
      queryClient.setQueryData(claimQueryKey(campaign.id), res)
      if (res.claim.status === 'PAID') haptics.success()
      void refresh()
    },
    onError: () => haptics.error(),
  })

  const requirements = campaign.requirements
  if (!requirements || !campaign.rewardPerClaimRaw) return null
  const rewardLabel = `${displayShares(asset, campaign.rewardPerClaimRaw) ?? ''} ${campaign.xstockSymbol}`.trim()
  const share = `I completed the ${campaign.xstockSymbol} Verified Quest on Blink. Can you qualify too?`

  const existing = mine.data?.claim
  if (existing && existing.status !== 'FAILED') return <ClaimReceipt asset={asset} challenge={{ campaign, text: share }} claim={existing} />

  const ev = check.data?.evaluation
  const qualified = Boolean(ev?.qualified)
  const resultOf = (side: 'eligibility' | 'actions', gi: number, ci: number) => ev?.[side][gi]?.results[ci]
  const checkError = check.error instanceof ApiError || check.error instanceof Error ? sentence(check.error.message) : null
  const claimError = claim.error instanceof ApiError || claim.error instanceof Error ? sentence(claim.error.message) : null
  const needsCheck = claim.error instanceof ApiError && claim.error.code === 'NEEDS_ELIGIBILITY'

  function cta(c: QuestCondition, r: ConditionResult | undefined) {
    if (!user || r?.status === 'PASSED') return null
    if (c.verifier === 'TAP_RUSH') return { label: 'Play Tap Rush', icon: 'bolt' as const, go: () => router.push(`/tap-rush/${campaign.id}`) }
    if (c.verifier === 'X_QUEST') return null
    // D-40: the club is opened by id (the API accepts an id or a slug); joining is free.
    if (c.verifier === 'CLUB_MEMBER') {
      return campaign.clubId ? { label: 'Open the club', icon: 'users' as const, go: () => router.push({ pathname: '/club/[slug]', params: { slug: campaign.clubId! } }) } : null
    }
    if (c.verifier === 'QR_CHECKIN') return { label: 'Scan the event QR', icon: 'scan' as const, go: () => router.push('/scan') }
    if (c.verifier === 'ORE_ACTIVITY') {
      return r?.status === 'ERROR' || r?.status === 'FAILED' || !r
        ? { label: 'Open ORE to mine', icon: 'arrowUpRight' as const, go: () => void Linking.openURL('https://ore.supply') }
        : null
    }
    if (c.verifier === 'SEEKER_SGT') return { label: 'Connect my Seeker', icon: 'phone' as const, go: () => router.push({ pathname: '/login/wallet', params: { purpose: 'seeker' } }) }
    // D-48: a verified wallet that is short on staked SKR stakes on Solana Mobile's official site; Blink only reads it.
    if ((c.verifier === 'SKR_STAKED' || c.verifier === 'SKR_TOTAL') && r?.status === 'FAILED' && r.actualRaw !== undefined) {
      return { label: SKR_STAKE_LABEL, icon: 'arrowUpRight' as const, go: openOfficialSkrStaking, note: SKR_SEED_VAULT_NOTE }
    }
    return { label: 'Verify a wallet', icon: 'wallet' as const, go: () => router.push('/login/wallet') }
  }

  const sections = [
    ['Who can join', 'eligibility'],
    ['What to do', 'actions'],
  ] as const

  return (
    <Card style={{ gap: space.lg }} tone={qualified ? 'lime' : 'default'}>
      <View style={{ gap: 4 }}>
        <Row>
          <Icon name="shield" size={20} stroke={color.lime} />
          <T variant="heading">{qualified ? 'Qualified' : `Win ${rewardLabel}`}</T>
        </Row>
        <T variant="label" color={color.text}>
          {qualified ? 'Every requirement is complete. Claim your reward below.' : 'Complete every requirement. Blink checks each one itself.'}
        </T>
      </View>

      {sections.map(([title, side]) =>
        requirements[side].length ? (
          <View key={side} style={{ gap: space.md }}>
            <T variant="overline">{title}</T>
            {requirements[side].map((g, gi) => (
              <View key={gi} style={[styles.group, g.mode === 'ANY' && g.conditions.length > 1 && styles.anyGroup]}>
                {g.mode === 'ANY' && g.conditions.length > 1 ? <T variant="caption">Any one of these</T> : null}
                {g.conditions.map((c, ci) => {
                  const r = resultOf(side, gi, ci)
                  const st = check.isFetching && !r ? STATUS.CHECKING : r ? STATUS[r.status] : user ? STATUS.NOT_STARTED : STATUS.NOT_STARTED
                  const detail = amountDetail(c, r)
                  const action = cta(c, r)
                  return (
                    <View key={ci} style={{ gap: space.sm }}>
                      <Row style={{ alignItems: 'flex-start' }}>
                        <View style={[styles.dot, { borderColor: st.tint }, r?.status === 'PASSED' && { backgroundColor: color.lime, borderColor: color.lime }]}>
                          {check.isFetching && !r ? (
                            <ActivityIndicator color={color.textDim} size="small" />
                          ) : (
                            <Icon name={st.icon} size={14} stroke={r?.status === 'PASSED' ? color.onLime : st.tint} strokeWidth={2.6} />
                          )}
                        </View>
                        <View style={{ flex: 1, gap: 2 }}>
                          <T variant="bodyStrong">{VERIFIERS[c.verifier].label}</T>
                          <T variant="label">{describeCondition(c)}</T>
                          {detail ? (
                            <T variant="caption" color={r?.status === 'PASSED' ? color.lime : color.textDim}>
                              {detail}
                            </T>
                          ) : (
                            <T variant="caption" color={st.tint}>
                              {r ? st.text : ''}
                            </T>
                          )}
                        </View>
                      </Row>
                      {c.verifier === 'X_QUEST' && live && user && r?.status !== 'PASSED' ? (
                        <XTaskPanel campaignId={campaign.id} onVerified={() => void check.refetch()} />
                      ) : null}
                      {action && live ? (
                        <Button icon={action.icon} onPress={action.go} size="sm" style={{ alignSelf: 'flex-start' }} variant="secondary">
                          {action.label}
                        </Button>
                      ) : null}
                      {action && live && 'note' in action ? <T variant="caption">{action.note}</T> : null}
                    </View>
                  )
                })}
              </View>
            ))}
          </View>
        ) : null,
      )}

      <T variant="caption">{PRODUCT_COPY.issuerControlStatement}</T>
      <Notice message={checkError} />
      <Notice message={claimError} />
      {!user ? (
        <Button icon="mail" onPress={() => router.push({ pathname: '/login/email', params: { next: campaignRoute(campaign.id) } })}>
          Sign in to start
        </Button>
      ) : !live ? null : needsCheck ? (
        <Button icon="shield" onPress={() => router.push({ pathname: '/eligibility', params: { next: campaignRoute(campaign.id) } })}>
          Confirm eligibility
        </Button>
      ) : qualified ? (
        <Button icon="gift" loading={claim.isPending} onPress={() => claim.mutate()}>
          {claim.isPending ? 'Reserving your reward…' : `Claim ${rewardLabel}`}
        </Button>
      ) : (
        <Button icon="refresh" loading={check.isFetching} onPress={() => void check.refetch()} variant="secondary">
          Check my requirements
        </Button>
      )}
    </Card>
  )
}

const styles = StyleSheet.create({
  group: { gap: space.md },
  anyGroup: { padding: space.md, borderRadius: 14, borderWidth: 1, borderStyle: 'dashed', borderColor: color.borderStrong },
  dot: { width: 26, height: 26, borderRadius: 13, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
})
