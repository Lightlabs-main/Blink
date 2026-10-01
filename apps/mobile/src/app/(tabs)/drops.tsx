import { useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { useMemo, useState } from 'react'
import { Pressable, RefreshControl, ScrollView, View } from 'react-native'

import { Icon } from '../../design/icons'
import { color, space } from '../../design/tokens'
import { Badge, Card, Chip, EmptyState, Notice, Row, Screen, Skeleton, StockAvatar, T } from '../../design/ui'
import { displayShares, useAssetMap, useLiveCampaigns } from '../../lib/data'
import { CAMPAIGN_TYPE_ICON, CAMPAIGN_TYPE_LABEL } from '../../lib/format'
import { CAMPAIGN_TYPES, type CampaignType } from '../../shared'

export default function Drops() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const live = useLiveCampaigns()
  const assets = useAssetMap()
  const [filter, setFilter] = useState<CampaignType | 'ALL'>('ALL')
  const [refreshing, setRefreshing] = useState(false)

  const drops = useMemo(() => (live.data?.campaigns ?? []).filter((c) => filter === 'ALL' || c.type === filter), [live.data, filter])

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
      <View style={{ gap: space.sm }}>
        <T variant="overline">Live now</T>
        <T variant="display">Drops</T>
        <T>xStocks you can claim, play for or earn — straight from creators.</T>
      </View>

      <ScrollView contentContainerStyle={{ gap: space.sm, paddingRight: space.xl }} horizontal showsHorizontalScrollIndicator={false} style={{ marginRight: -20 }}>
        <Chip label="All" onPress={() => setFilter('ALL')} selected={filter === 'ALL'} />
        {CAMPAIGN_TYPES.map((t) => (
          <Chip icon={CAMPAIGN_TYPE_ICON[t]} key={t} label={CAMPAIGN_TYPE_LABEL[t]} onPress={() => setFilter(t)} selected={filter === t} />
        ))}
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
          body={filter === 'ALL' ? 'Nothing is live yet. Drops appear here the moment a creator funds one.' : `No ${CAMPAIGN_TYPE_LABEL[filter]} drops live right now.`}
          icon="bolt"
          onAction={() => router.push('/scan')}
          title="No drops here yet"
        />
      ) : (
        drops.map((c) => {
          const asset = assets.get(c.mint)
          const amount = displayShares(asset, c.allowanceRaw)
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
                <Badge dot label="Live" tone="live" />
              </Row>
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
