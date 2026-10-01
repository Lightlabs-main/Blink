import { usePrivy } from '@privy-io/expo'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { Linking, Share, StyleSheet, View } from 'react-native'

import { Icon } from '../../design/icons'
import { color, space } from '../../design/tokens'
import { Button, Card, Notice, Row, T } from '../../design/ui'
import { api, ApiError, type XStockListing } from '../../lib/api'
import { displayShares } from '../../lib/data'
import { campaignLink, campaignRoute, explorerTxUrl } from '../../lib/format'
import { haptics } from '../../lib/haptics'
import { type CampaignSummary, type ClaimSummary, maxClaims, PRODUCT_COPY } from '../../shared'

/** D-20: errors the eligibility screen resolves. */
export function needsEligibility(error: unknown): boolean {
  return error instanceof ApiError && (error.code === 'NEEDS_ELIGIBILITY' || (error.code === 'NOT_ELIGIBLE' && error.status === 403))
}

/** Server messages are short lowercase phrases; show them as sentences. */
export function sentence(message: string) {
  return message ? message[0]!.toUpperCase() + message.slice(1) : message
}

export function claimQueryKey(campaignId: string) {
  return ['claim', campaignId] as const
}

/** Refreshes everything a finished claim changes. */
export function useClaimRefresh(campaignId: string) {
  const queryClient = useQueryClient()
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['campaign', campaignId] }),
      queryClient.invalidateQueries({ queryKey: ['campaigns', 'live'] }),
      queryClient.invalidateQueries({ queryKey: ['my-claims'] }),
      queryClient.invalidateQueries({ queryKey: ['holdings'] }),
    ])
}

/** The signed-in user's claim for a campaign; polls while the payout is in flight. */
export function useMyClaim(campaignId: string) {
  const { getAccessToken, user } = usePrivy()
  return useQuery({
    queryKey: claimQueryKey(campaignId),
    queryFn: () => api.myClaim(getAccessToken, campaignId),
    enabled: Boolean(user),
    refetchInterval: (q) => {
      const status = q.state.data?.claim?.status
      return status === 'SENDING' || status === 'RESERVED' ? 3000 : false
    },
  })
}

export function ClaimReceipt({ claim, asset }: { claim: ClaimSummary; asset: XStockListing | undefined }) {
  const amount = displayShares(asset, claim.amountRaw)
  const label = `${amount ?? ''} ${claim.xstockSymbol}`.trim()
  const bonus = claim.kind === 'REFERRAL_BONUS'
  if (claim.status === 'PAID') {
    return (
      <Card style={{ gap: space.md }} tone="lime">
        <Row>
          <View style={styles.doneIcon}>
            <Icon name="check" size={20} stroke={color.onLime} strokeWidth={2.6} />
          </View>
          <View style={{ flex: 1 }}>
            <T variant="heading">{bonus ? `You earned ${label} for inviting a friend` : `You got ${label}`}</T>
            <T variant="label" color={color.text}>
              It’s in your Blink wallet.
            </T>
          </View>
        </Row>
        {claim.txSignature ? (
          <Button
            icon="arrowUpRight"
            onPress={() => void Linking.openURL(explorerTxUrl(claim.txSignature!, claim.cluster))}
            size="md"
            variant="secondary"
          >
            View receipt on Solana
          </Button>
        ) : null}
      </Card>
    )
  }
  return (
    <Card style={{ gap: space.sm }} tone="raised">
      <Row>
        <Icon name="refresh" size={20} stroke={color.lime} />
        <T variant="heading">{bonus ? `Your ${label} bonus is on its way…` : `Sending ${label}…`}</T>
      </Row>
      <T variant="label">The network is confirming your transfer. This usually takes a few seconds.</T>
    </Card>
  )
}

/**
 * D-14: the caller's personal invite link for a REFERRAL drop and the one-time bonus it earns when a friend claims.
 */
function InvitePanel({ campaign, rewardLabel, asset }: { campaign: CampaignSummary; rewardLabel: string; asset: XStockListing | undefined }) {
  const { getAccessToken } = usePrivy()
  const queryClient = useQueryClient()
  const key = ['referral', campaign.id]
  const mine = useQuery({
    queryKey: key,
    queryFn: () => api.myReferral(getAccessToken, campaign.id),
    refetchInterval: (q) => {
      const status = q.state.data?.referral?.bonus?.status
      return status === 'SENDING' || status === 'RESERVED' ? 3000 : false
    },
  })
  const create = useMutation({
    mutationFn: () => api.createReferral(getAccessToken, campaign.id),
    onSuccess: (res) => queryClient.setQueryData(key, res),
    onError: () => haptics.error(),
  })
  const retry = useMutation({
    mutationFn: () => api.retryBonus(getAccessToken, campaign.id),
    onSuccess: () => {
      haptics.success()
      void queryClient.invalidateQueries({ queryKey: key })
      void queryClient.invalidateQueries({ queryKey: ['holdings'] })
    },
    onError: () => haptics.error(),
  })

  const referral = mine.data?.referral
  const bonus = referral?.bonus
  const link = referral ? campaignLink(campaign.id, referral.code) : null
  const error = [create.error, retry.error].find((e) => e instanceof Error)
  const share = () => {
    if (!link) return
    haptics.tap()
    void Share.share({ message: `Join me on Blink-to-Stock and we both get ${rewardLabel}: ${link}` })
  }

  if (bonus && bonus.status !== 'FAILED') return <ClaimReceipt asset={asset} claim={bonus} />
  return (
    <Card style={{ gap: space.md }} tone="raised">
      <Row>
        <Icon name="users" size={20} stroke={color.violet} />
        <T variant="heading">{`Invite a friend — you both get ${rewardLabel}`}</T>
      </Row>
      <T variant="label">
        {referral
          ? 'Share your link. When a friend claims through it, you get the same reward. You earn once, from the first friend.'
          : 'Get your personal invite link and share it with a friend.'}
      </T>
      {bonus?.status === 'FAILED' ? <Notice message="Your bonus didn’t go through. You can send it again." tone="warn" /> : null}
      <Notice message={error instanceof Error ? sentence(error.message) : null} />
      {!referral ? (
        <Button icon="users" loading={create.isPending || mine.isPending} onPress={() => create.mutate()} variant="secondary">
          Get my invite link
        </Button>
      ) : bonus?.status === 'FAILED' ? (
        <Button icon="refresh" loading={retry.isPending} onPress={() => retry.mutate()}>
          Send my bonus again
        </Button>
      ) : (
        <>
          <View style={styles.code}>
            <T variant="caption">Your invite code</T>
            <T style={styles.codeText}>{referral.code}</T>
          </View>
          <Button icon="share" onPress={share}>
            Share invite link
          </Button>
        </>
      )}
    </Card>
  )
}

/**
 * Recipient side of a drop (DECISIONS D-13, D-14): fixed amount per person, first come first served.
 * Gift / Early Claim claim directly; Tap Rush sends the player to the game first; Referral needs a friend's invite
 * code and offers the caller their own invite link.
 */
export function ClaimPanel({ campaign, asset, referralCode }: { campaign: CampaignSummary; asset: XStockListing | undefined; referralCode?: string | null }) {
  const { user } = usePrivy()
  if (!campaign.rewardPerClaimRaw) return null
  const rewardLabel = `${displayShares(asset, campaign.rewardPerClaimRaw) ?? ''} ${campaign.xstockSymbol}`.trim()
  return (
    <>
      <ClaimCard asset={asset} campaign={campaign} referralCode={referralCode} rewardLabel={rewardLabel} />
      {campaign.type === 'REFERRAL' && user && campaign.status === 'LIVE' ? <InvitePanel asset={asset} campaign={campaign} rewardLabel={rewardLabel} /> : null}
    </>
  )
}

function ClaimCard({
  campaign,
  asset,
  referralCode,
  rewardLabel,
}: {
  campaign: CampaignSummary
  asset: XStockListing | undefined
  referralCode?: string | null
  rewardLabel: string
}) {
  const router = useRouter()
  const { user, getAccessToken } = usePrivy()
  const queryClient = useQueryClient()
  const refresh = useClaimRefresh(campaign.id)
  const mine = useMyClaim(campaign.id)
  const claim = useMutation({
    mutationFn: () => api.claim(getAccessToken, campaign.id, referralCode ? { ref: referralCode } : {}),
    onSuccess: (res) => {
      queryClient.setQueryData(claimQueryKey(campaign.id), res)
      if (res.claim.status === 'PAID') haptics.success()
      void refresh()
    },
    onError: () => haptics.error(),
  })

  const reward = BigInt(campaign.rewardPerClaimRaw!)
  const total = maxClaims(BigInt(campaign.allowanceRaw), reward)
  const taken = BigInt(campaign.claimedRaw) / reward
  const soldOut = BigInt(campaign.allowanceRaw) - BigInt(campaign.claimedRaw) < reward

  const existing = mine.data?.claim
  if (existing && existing.status !== 'FAILED') return <ClaimReceipt asset={asset} claim={existing} />
  if (campaign.status !== 'LIVE') {
    return (
      <Card style={{ gap: space.sm }} tone="raised">
        <T variant="heading">{campaign.status === 'PAUSED' ? 'This drop is paused' : 'This drop has ended'}</T>
        <T variant="label">
          {campaign.status === 'PAUSED' ? 'The creator’s stock is not available right now.' : 'Every share in this drop has been handed out.'}
        </T>
      </Card>
    )
  }

  const isTapRush = campaign.type === 'TAP_RUSH'
  const isReferral = campaign.type === 'REFERRAL'
  const isSeeker = campaign.type === 'SEEKER'
  const needsInvite = isReferral && !referralCode
  const needsSeeker = claim.error instanceof ApiError && claim.error.code === 'NEEDS_SEEKER'
  const needsCheck = claim.error instanceof ApiError && claim.error.code === 'NEEDS_ELIGIBILITY'
  const error = claim.error instanceof ApiError || claim.error instanceof Error ? sentence(claim.error.message) : null

  return (
    <Card style={{ gap: space.md }} tone="lime">
      <Row>
        <Icon name={isTapRush ? 'target' : isReferral ? 'users' : isSeeker ? 'phone' : 'gift'} size={20} stroke={color.lime} />
        <T variant="heading">{soldOut ? 'All claimed' : isReferral && referralCode ? `A friend invited you — get ${rewardLabel}` : `Get ${rewardLabel}`}</T>
      </Row>
      <T variant="label" color={color.text}>
        {soldOut
          ? 'Every share in this drop has been handed out.'
          : isTapRush && campaign.tapRush
            ? `Tap ${campaign.tapRush.goal} times in ${campaign.tapRush.seconds} seconds to earn it. Free — no fees.`
            : needsInvite
              ? `Got an invite link from a friend? Open it to claim ${rewardLabel}. You both get the reward.`
              : isSeeker
                ? 'For Solana Seeker owners: Blink checks the Seeker Genesis Token in your Seeker’s wallet. One claim per phone.'
                : 'xStocks sent to your Blink wallet. Free — no fees.'}
      </T>
      <View style={styles.meter}>
        <View style={[styles.meterFill, { width: `${total > 0n ? Math.min(100, Number((taken * 100n) / total)) : 0}%` }]} />
      </View>
      <T variant="caption">{`${taken.toString()} of ${total.toString()} ${isReferral ? 'rewards ' : ''}claimed`}</T>
      {existing?.status === 'FAILED' ? <Notice message="Your last claim didn’t go through. You can try again." tone="warn" /> : null}
      <T variant="caption">{PRODUCT_COPY.issuerControlStatement}</T>
      <Notice message={error} />
      {soldOut || (needsInvite && user) ? null : !user ? (
        <Button icon="mail" onPress={() => router.push({ pathname: '/login/email', params: { next: campaignRoute(campaign.id, referralCode) } })}>
          Sign in to claim
        </Button>
      ) : needsCheck ? (
        <Button icon="shield" onPress={() => router.push({ pathname: '/eligibility', params: { next: campaignRoute(campaign.id, referralCode) } })}>
          Confirm eligibility
        </Button>
      ) : needsSeeker ? (
        <Button icon="phone" onPress={() => router.push({ pathname: '/login/wallet', params: { purpose: 'seeker' } })}>
          Connect my Seeker
        </Button>
      ) : isTapRush ? (
        <Button icon="bolt" onPress={() => router.push(`/tap-rush/${campaign.id}`)}>
          Play Tap Rush
        </Button>
      ) : (
        <Button icon="gift" loading={claim.isPending} onPress={() => claim.mutate()}>
          {claim.isPending ? 'Sending…' : `Claim ${rewardLabel}`}
        </Button>
      )}
    </Card>
  )
}

const styles = StyleSheet.create({
  doneIcon: { width: 38, height: 38, borderRadius: 12, backgroundColor: color.lime, alignItems: 'center', justifyContent: 'center' },
  meter: { height: 6, borderRadius: 3, backgroundColor: color.surface3, overflow: 'hidden' },
  meterFill: { height: 6, borderRadius: 3, backgroundColor: color.lime },
  code: { alignItems: 'center', gap: 2, paddingVertical: space.md, borderRadius: 14, borderWidth: 1, borderColor: color.border, backgroundColor: color.surface },
  codeText: { fontSize: 28, lineHeight: 34, letterSpacing: 4, color: color.text, fontVariant: ['tabular-nums'] },
})
