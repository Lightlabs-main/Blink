import { useQueryClient } from '@tanstack/react-query'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useMemo, useState } from 'react'
import { Pressable, RefreshControl, ScrollView, View } from 'react-native'

import { Icon } from '../../design/icons'
import { color, space } from '../../design/tokens'
import { Badge, Card, Chip, EmptyState, IconButton, Notice, Row, Screen, Skeleton, StockAvatar, T } from '../../design/ui'
import { displayShares, useAssetMap, useLiveCampaigns } from '../../lib/data'
import { CAMPAIGN_TYPE_ICON, CAMPAIGN_TYPE_LABEL } from '../../lib/format'
import { CAMPAIGN_TYPES, type CampaignSummary, type CampaignType, VERIFIERS } from '../../shared'

/** D-40: filters by what you do, not only by mechanic. Tap Rush includes quests with a Tap Rush step. */
type Filter = 'ALL' | CampaignType | 'EVENT' | 'CLUB'
const conditions = (c: CampaignSummary) => (c.requirements ? [...c.requirements.eligibility, ...c.requirements.actions].flatMap((g) => g.conditions) : [])
function matches(c: CampaignSummary, f: Filter) {
  if (f === 'ALL') return true
  if (f === 'EVENT') return conditions(c).some((x) => x.verifier === 'QR_CHECKIN')
  if (f === 'CLUB') return Boolean(c.clubId)
  if (f === 'TAP_RUSH') return c.type === 'TAP_RUSH' || Boolean(c.tapRush)
  return c.type === f
}
const FILTER_LABEL: Partial<Record<Filter, string>> = { EVENT: 'Event', CLUB: 'Club' }

export default function Drops() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const live = useLiveCampaigns()
  const assets = useAssetMap()
  const params = useLocalSearchParams<{ filter?: string }>()
  const [filter, setFilter] = useState<Filter>(params.filter === 'TAP_RUSH' ? 'TAP_RUSH' : 'ALL')
  const [refreshing, setRefreshing] = useState(false)

  const drops = useMemo(() => (live.data?.campaigns ?? []).filter((c) => matches(c, filter)), [live.data, filter])
  // Only offer filters backed by drops that are actually live (update §31: no empty categories).
  const present = useMemo(
    () => ([...CAMPAIGN_TYPES, 'EVENT', 'CLUB'] as Filter[]).filter((t) => t === filter || (live.data?.campaigns ?? []).some((c) => matches(c, t))),
    [live.data, filter],
  )

  return (
    <Screen
      refreshControl={
        <RefreshControl
          onRefresh={async () => {
            setRefreshing(true)
            await queryClient.invalidateQueries({ queryKey: ['campaigns', 'live'] })
            setRefreshing(false)
          }}
          refreshing={refreshing}
          tintColor={color.lime}
        />
      }
      tabBar
    >
      <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <View style={{ gap: space.sm, flex: 1 }}>
          <T variant="overline">Live now</T>
          <T variant="display">Drops</T>
          <T>xStocks you can claim, play for or earn — straight from creators.</T>
        </View>
        <IconButton icon="plus" label="Create a drop" onPress={() => router.push('/create')} />
      </Row>

      <ScrollView contentContainerStyle={{ gap: space.sm, paddingRight: space.xl }} horizontal showsHorizontalScrollIndicator={false} style={{ marginRight: -20 }}>
        <Chip label="All" onPress={() => setFilter('ALL')} selected={filter === 'ALL'} />
        {present.map((t) =>
          t === 'EVENT' || t === 'CLUB' ? (
            <Chip icon={t === 'EVENT' ? 'scan' : 'users'} key={t} label={FILTER_LABEL[t]!} onPress={() => setFilter(t)} selected={filter === t} />
          ) : t === 'ALL' ? null : (
            <Chip icon={CAMPAIGN_TYPE_ICON[t]} key={t} label={CAMPAIGN_TYPE_LABEL[t]} onPress={() => setFilter(t)} selected={filter === t} />
          ),
        )}
      </ScrollView>

      <Notice message={live.error?.message} />

      {live.isPending ? (
        <View style={{ gap: space.md }}>
          <Skeleton height={96} radius={20} />
          <Skeleton height={96} radius={20} />
        </View>
      ) : drops.length === 0 ? (
        <EmptyState
          action="Scan a QR code"
          body={filter === 'ALL' ? 'Nothing is live yet. Drops appear here the moment a creator funds one.' : `No ${FILTER_LABEL[filter] ?? CAMPAIGN_TYPE_LABEL[filter as CampaignType]} drops live right now.`}
          icon="bolt"
          onAction={() => router.push('/scan')}
          title="No drops here yet"
        />
      ) : (
        drops.map((c) => {
          const asset = assets.get(c.mint)
          const amount = displayShares(asset, c.allowanceRaw)
          const reward = c.rewardPerClaimRaw ? displayShares(asset, c.rewardPerClaimRaw) : null
          // Real campaign facts only: the mechanic's numbers and its requirement labels. No invented engagement.
          const facts = [
            c.tapRush ? `${c.tapRush.goal.toLocaleString()} taps · ${c.tapRush.seconds >= 60 ? `${c.tapRush.seconds / 60} min` : `${c.tapRush.seconds}s`}` : null,
            reward ? `${reward} each` : null,
            c.membersOnly ? 'Club members only' : null,
            ...[...new Set(conditions(c).filter((x) => x.verifier !== 'TAP_RUSH').map((x) => VERIFIERS[x.verifier].label))],
          ].filter(Boolean)
          return (
            <Pressable
              accessibilityRole="button"
              key={c.id}
              onPress={() => router.push(`/campaign/${c.id}`)}
              style={({ pressed }) => ({ opacity: pressed ? 0.8 : 1 })}
            >
            <Card style={{ gap: space.md }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <Row>
                  <StockAvatar isTest={asset?.isTest} logo={asset?.logo} size={46} symbol={c.xstockSymbol} />
                  <View>
                    <T variant="title">{c.xstockSymbol}</T>
                    <Row gap={6}>
                      <Icon name={CAMPAIGN_TYPE_ICON[c.type]} size={14} stroke={color.lime} />
                      <T variant="label">{CAMPAIGN_TYPE_LABEL[c.type]}</T>
                    </Row>
                  </View>
                </Row>
                {c.boostedUntil ? <Badge label="Boosted with SKR" tone="skr" /> : <Badge dot label="Live" tone="live" />}
              </Row>
              {facts.length ? <T variant="caption">{facts.join(' · ')}</T> : null}
              <Row style={{ justifyContent: 'space-between' }}>
                <T variant="label">{amount ? `${amount} shares in the pool` : 'Stock pool'}</T>
                <Row gap={4}>
                  <T variant="label" color={color.lime}>
                    Open drop
                  </T>
                  <Icon name="arrowRight" size={16} stroke={color.lime} />
                </Row>
              </Row>
            </Card>
            </Pressable>
          )
        })
      )}
    </Screen>
  )
}
