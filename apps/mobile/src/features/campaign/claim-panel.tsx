import { usePrivy } from '@privy-io/expo'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { Linking, StyleSheet, View } from 'react-native'

import { Icon } from '../../design/icons'
import { color, space } from '../../design/tokens'
import { Button, Card, Notice, Row, T } from '../../design/ui'
import { api, ApiError, type XStockListing } from '../../lib/api'
import { displayShares } from '../../lib/data'
import { explorerTxUrl } from '../../lib/format'
import { haptics } from '../../lib/haptics'
import { type CampaignSummary, type ClaimSummary, maxClaims } from '../../shared'

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
  if (claim.status === 'PAID') {
    return (
      <Card style={{ gap: space.md }} tone="lime">
        <Row>
          <View style={styles.doneIcon}>
            <Icon name="check" size={20} stroke={color.onLime} strokeWidth={2.6} />
          </View>
          <View style={{ flex: 1 }}>
            <T variant="heading">{`You got ${label}`}</T>
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
        <T variant="heading">{`Sending ${label}…`}</T>
      </Row>
      <T variant="label">The network is confirming your transfer. This usually takes a few seconds.</T>
    </Card>
  )
}

/**
 * Recipient side of a LIVE drop (DECISIONS D-13): fixed amount per person, first come first served.
 * Gift / Early Claim claim directly; Tap Rush sends the player to the game first.
 */
export function ClaimPanel({ campaign, asset }: { campaign: CampaignSummary; asset: XStockListing | undefined }) {
  const router = useRouter()
  const { user, getAccessToken } = usePrivy()
  const queryClient = useQueryClient()
  const refresh = useClaimRefresh(campaign.id)
  const mine = useMyClaim(campaign.id)
  const claim = useMutation({
    mutationFn: () => api.claim(getAccessToken, campaign.id),
    onSuccess: (res) => {
      queryClient.setQueryData(claimQueryKey(campaign.id), res)
      if (res.claim.status === 'PAID') haptics.success()
      void refresh()
    },
    onError: () => haptics.error(),
  })

  if (!campaign.rewardPerClaimRaw) return null
  const reward = BigInt(campaign.rewardPerClaimRaw)
  const rewardLabel = `${displayShares(asset, reward) ?? ''} ${campaign.xstockSymbol}`.trim()
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
  const error = claim.error instanceof ApiError || claim.error instanceof Error ? sentence(claim.error.message) : null

  return (
    <Card style={{ gap: space.md }} tone="lime">
      <Row>
        <Icon name={isTapRush ? 'target' : 'gift'} size={20} stroke={color.lime} />
        <T variant="heading">{soldOut ? 'All claimed' : `Get ${rewardLabel}`}</T>
      </Row>
      <T variant="label" color={color.text}>
        {soldOut
          ? 'Every share in this drop has been handed out.'
          : isTapRush && campaign.tapRush
            ? `Tap ${campaign.tapRush.goal} times in ${campaign.tapRush.seconds} seconds to earn it. Free — no fees.`
            : 'Real stock, sent to your Blink wallet. Free — no fees.'}
      </T>
      <View style={styles.meter}>
        <View style={[styles.meterFill, { width: `${total > 0n ? Math.min(100, Number((taken * 100n) / total)) : 0}%` }]} />
      </View>
      <T variant="caption">{`${taken.toString()} of ${total.toString()} claimed`}</T>
      {existing?.status === 'FAILED' ? <Notice message="Your last claim didn’t go through. You can try again." tone="warn" /> : null}
      <Notice message={error} />
      {soldOut ? null : !user ? (
        <Button icon="mail" onPress={() => router.push({ pathname: '/login/email', params: { next: `/campaign/${campaign.id}` } })}>
          Sign in to claim
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
})
