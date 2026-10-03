import { usePrivy } from '@privy-io/expo'
import { useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native'

import { font } from '../../design/fonts'
import { Icon } from '../../design/icons'
import { color, radius, space } from '../../design/tokens'
import {
  Avatar,
  Badge,
  Card,
  Divider,
  EmptyState,
  GlowCard,
  ListRow,
  QuickAction,
  Row,
  Screen,
  SectionHeader,
  Skeleton,
  StockAvatar,
  T,
} from '../../design/ui'
import { displayShares, useAssetMap, useLiveCampaigns, useMe, useMyCampaigns, useMyClaims, useNetwork, usePositions } from '../../lib/data'
import { CAMPAIGN_STATUS_LABEL, CAMPAIGN_TYPE_ICON, CAMPAIGN_TYPE_LABEL, greeting, networkLabel, shortAddress } from '../../lib/format'
import { userEmail } from '../../lib/privy-user'
import type { CampaignSummary } from '../../shared'

function statusTone(s: CampaignSummary['status']) {
  return s === 'LIVE' ? 'live' : s === 'PAUSED' || s === 'ENDED' || s === 'CLOSED' ? 'neutral' : 'warn'
}

function DropTicket({ c, onPress }: { c: CampaignSummary; onPress: () => void }) {
  const assets = useAssetMap()
  const asset = assets.get(c.mint)
  const amount = displayShares(asset, c.allowanceRaw)
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.ticket, pressed && { opacity: 0.85 }]}>
      <Row style={{ justifyContent: 'space-between' }}>
        <StockAvatar isTest={asset?.isTest} logo={asset?.logo} size={42} symbol={c.xstockSymbol} />
        <Badge dot label="Live" tone="live" />
      </Row>
      <View style={{ gap: 2 }}>
        <T style={{ ...font('display'), fontSize: 26, color: color.text }}>{c.xstockSymbol}</T>
        <T variant="label">{amount ? `${amount} shares up for grabs` : 'Stock drop'}</T>
      </View>
      <View style={styles.ticketCut} />
      <Row style={{ justifyContent: 'space-between' }}>
        <Row gap={6}>
          <Icon name={CAMPAIGN_TYPE_ICON[c.type]} size={16} stroke={color.lime} />
          <T variant="label" color={color.text}>
            {CAMPAIGN_TYPE_LABEL[c.type]}
          </T>
        </Row>
        <Icon name="arrowUpRight" size={18} stroke={color.textDim} />
      </Row>
    </Pressable>
  )
}

export default function Home() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const { user } = usePrivy()
  const me = useMe()
  const network = useNetwork()
  const live = useLiveCampaigns()
  const mine = useMyCampaigns()
  const claims = useMyClaims()
  const assets = useAssetMap()
  const { positions, isLoading: positionsLoading } = usePositions()
  const [refreshing, setRefreshing] = useState(false)

  const email = userEmail(user)
  const name = email ? email.split('@')[0]! : me.data?.verifiedCreatorWallets[0] ? shortAddress(me.data.verifiedCreatorWallets[0]) : 'there'
  const net = networkLabel(network.data?.cluster)
  const isCreator = (me.data?.verifiedCreatorWallets.length ?? 0) > 0
  const myCampaigns = mine.data?.campaigns ?? []
  const liveDrops = live.data?.campaigns ?? []
  const rewards = (claims.data?.claims ?? []).filter((c) => c.status !== 'FAILED')

  async function onRefresh() {
    setRefreshing(true)
    await queryClient.invalidateQueries()
    setRefreshing(false)
  }

  return (
    <Screen refreshControl={<RefreshControl onRefresh={() => void onRefresh()} refreshing={refreshing} tintColor={color.lime} />} tabBar>
      {/* Header */}
      <Row style={{ justifyContent: 'space-between' }}>
        <Row>
          <Avatar label={name} size={44} />
          <View>
            <T variant="caption">{greeting()}</T>
            <T variant="heading" numberOfLines={1}>
              {name}
            </T>
          </View>
        </Row>
        <View style={[styles.netPill, net.isTest && { borderColor: color.warning }]}>
          <View style={[styles.netDot, { backgroundColor: net.isTest ? color.warning : color.success }]} />
          <T variant="caption" color={net.isTest ? color.warning : color.success}>
            {net.label}
          </T>
        </View>
      </Row>

      {/* Portfolio */}
      <GlowCard>
        <Row style={{ justifyContent: 'space-between' }}>
          <T variant="overline">Your stocks</T>
          <Row gap={6}>
            <Icon name="shield" size={14} stroke={color.textDim} />
            <T variant="caption">Held in your wallet</T>
          </Row>
        </Row>
        <View style={{ marginTop: space.md, gap: space.xs }}>
          {positionsLoading ? (
            <Skeleton height={40} width={160} />
          ) : (
            <T variant="hero" style={{ fontSize: 40, lineHeight: 44 }}>
              {positions.length}
              <T variant="title" color={color.textDim}>
                {positions.length === 1 ? '  position' : '  positions'}
              </T>
            </T>
          )}
        </View>
        <View style={{ marginTop: space.lg, gap: space.md }}>
          {positions.map((p) => (
            <Row key={p.asset.mint} style={{ justifyContent: 'space-between' }}>
              <Row>
                <StockAvatar isTest={p.asset.isTest} logo={p.asset.logo} size={34} symbol={p.asset.symbol} />
                <View>
                  <T variant="bodyStrong">{p.asset.symbol}</T>
                  <T variant="caption">{p.kinds.includes('creator') ? 'Creator wallet' : 'Stock wallet'}</T>
                </View>
              </Row>
              <T variant="numeric" style={{ fontSize: 17 }}>
                {p.shares ?? '—'}
              </T>
            </Row>
          ))}
          {!positionsLoading && positions.length === 0 ? (
            <Pressable onPress={() => router.push('/scan')} style={styles.inlineCta}>
              <Icon name="sparkle" size={18} stroke={color.lime} />
              <T variant="bodyStrong" style={{ flex: 1 }}>
                Claim your first stock from a Blink drop
              </T>
              <Icon name="arrowRight" size={18} stroke={color.lime} />
            </Pressable>
          ) : null}
        </View>
      </GlowCard>

      {/* Quick actions */}
      <Row gap={space.sm}>
        <QuickAction highlight icon="scan" label="Scan" onPress={() => router.push('/scan')} />
        <QuickAction icon="plus" label="Create" onPress={() => router.push('/create')} />
        <QuickAction icon="bolt" label="Drops" onPress={() => router.push('/drops')} />
        <QuickAction icon="wallet" label="Wallet" onPress={() => router.push('/wallet')} />
      </Row>

      {/* Live drops */}
      <View style={{ gap: space.md }}>
        <SectionHeader action={liveDrops.length ? 'See all' : undefined} onAction={() => router.push('/drops')} title="Live drops" />
        {live.isPending ? (
          <Row>
            <Skeleton height={176} radius={radius.lg} width={220} />
            <Skeleton height={176} radius={radius.lg} width={220} />
          </Row>
        ) : liveDrops.length === 0 ? (
          <EmptyState
            action={isCreator ? 'Start a campaign' : undefined}
            body="When a creator funds a campaign, it lands here. Got a QR from a friend? Scan it."
            icon="bolt"
            onAction={() => router.push('/create')}
            title="No live drops right now"
          />
        ) : (
          <ScrollView contentContainerStyle={{ gap: space.md, paddingRight: space.xl }} horizontal showsHorizontalScrollIndicator={false} style={{ marginRight: -20 }}>
            {liveDrops.map((c) => (
              <DropTicket c={c} key={c.id} onPress={() => router.push(`/campaign/${c.id}`)} />
            ))}
          </ScrollView>
        )}
      </View>

      {/* Rewards the user earned from drops */}
      {rewards.length ? (
        <View style={{ gap: space.md }}>
          <SectionHeader title="Your rewards" />
          <Card padded={false} style={{ paddingHorizontal: space.lg }}>
            {rewards.slice(0, 5).map((r, i) => {
              const asset = assets.get(r.mint)
              const amount = displayShares(asset, r.amountRaw)
              return (
                <View key={r.id}>
                  {i > 0 ? <Divider /> : null}
                  <ListRow
                    leading={<StockAvatar isTest={asset?.isTest} logo={asset?.logo} size={36} symbol={r.xstockSymbol} />}
                    onPress={() => router.push(`/campaign/${r.campaignId}`)}
                    subtitle={`${r.kind === 'REFERRAL_BONUS' ? 'Referral bonus' : 'Claimed'} · ${r.status === 'PAID' ? 'received' : 'sending…'}`}
                    title={`${amount ? `${amount} ` : ''}${r.xstockSymbol}`}
                    trailing={<Badge label={r.status === 'PAID' ? 'Paid' : 'Pending'} tone={r.status === 'PAID' ? 'live' : 'warn'} />}
                  />
                </View>
              )
            })}
          </Card>
        </View>
      ) : null}

      {/* Creator campaigns */}
      {isCreator ? (
        <View style={{ gap: space.md }}>
          <SectionHeader action="New" onAction={() => router.push('/create')} title="Your campaigns" />
          {myCampaigns.length === 0 ? (
            <EmptyState body="Fund a campaign from your wallet and share it as a link or QR." icon="plus" title="No campaigns yet" />
          ) : (
            <Card padded={false} style={{ paddingHorizontal: space.lg }}>
              {myCampaigns.slice(0, 4).map((c, i) => {
                const asset = assets.get(c.mint)
                const amount = displayShares(asset, c.allowanceRaw)
                return (
                  <View key={c.id}>
                    {i > 0 ? <Divider /> : null}
                    <ListRow
                      leading={<StockAvatar isTest={asset?.isTest} logo={asset?.logo} size={36} symbol={c.xstockSymbol} />}
                      onPress={() => router.push(`/campaign/${c.id}`)}
                      subtitle={`${CAMPAIGN_TYPE_LABEL[c.type]}${amount ? ` · ${amount} shares` : ''}`}
                      title={c.xstockSymbol}
                      trailing={<Badge label={CAMPAIGN_STATUS_LABEL[c.status]} tone={statusTone(c.status)} />}
                    />
                  </View>
                )
              })}
            </Card>
          )}
        </View>
      ) : (
        <Card style={{ gap: space.md }} tone="raised">
          <Row>
            <View style={styles.creatorIcon}>
              <Icon name="sparkle" size={20} stroke={color.violet} />
            </View>
            <View style={{ flex: 1 }}>
              <T variant="bodyStrong">Want to give away stock?</T>
              <T variant="label">Connect a Solana wallet to create campaigns.</T>
            </View>
          </Row>
          <Pressable onPress={() => router.push('/login/wallet')} style={styles.inlineLink}>
            <T variant="label" color={color.lime}>
              Become a creator
            </T>
            <Icon name="arrowRight" size={16} stroke={color.lime} />
          </Pressable>
        </Card>
      )}
    </Screen>
  )
}

const styles = StyleSheet.create({
  netPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.success,
    backgroundColor: color.surface,
  },
  netDot: { width: 6, height: 6, borderRadius: 3 },
  inlineCta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: color.limeSoft,
    borderWidth: 1,
    borderColor: color.limeLine,
  },
  ticket: {
    width: 220,
    padding: space.lg,
    gap: space.md,
    borderRadius: radius.lg,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.borderStrong,
  },
  ticketCut: { height: 1, borderStyle: 'dashed', borderWidth: 1, borderColor: color.border, marginHorizontal: -space.lg },
  creatorIcon: { width: 42, height: 42, borderRadius: 21, backgroundColor: color.violetSoft, alignItems: 'center', justifyContent: 'center' },
  inlineLink: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start' },
})
