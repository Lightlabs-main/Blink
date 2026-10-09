import { usePrivy } from '@privy-io/expo'
import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { RefreshControl, ScrollView, View } from 'react-native'

import { Icon, type IconName } from '../design/icons'
import { color, space } from '../design/tokens'
import { Card, Chip, Divider, EmptyState, ListRow, NavBar, Screen, Skeleton, T } from '../design/ui'
import { isOffchain, receiptHeadline, receiptTitle } from '../features/receipts/receipt'
import { api } from '../lib/api'
import { useAssetMap } from '../lib/data'
import type { HistoryItem } from '../shared'

const ICON: Record<HistoryItem['kind'], IconName> = {
  REWARD: 'gift',
  INVITE_BONUS: 'users',
  SENT: 'arrowUpRight',
  FUNDED: 'sparkle',
  CHECKIN: 'scan',
  CLUB_JOINED: 'users',
  GIFT_RECEIVED: 'gift',
  SKR_TIP_SENT: 'send',
  SKR_TIP_RECEIVED: 'sparkle',
  SKR_BOOST_PURCHASED: 'bolt',
  ORE_DEPLOY_CONFIRMED: 'target',
  ORE_MINER_VERIFIED: 'shield',
}

/** D-40: Receipts & Activity filters. Only offchain records and onchain settlements that actually happened. */
type Filter = 'ALL' | 'REWARDS' | 'EVENTS' | 'CLUBS' | 'WALLET' | 'SKR' | 'ORE'
const FILTERS: { key: Filter; label: string; kinds: HistoryItem['kind'][] }[] = [
  { key: 'ALL', label: 'All', kinds: [] },
  { key: 'REWARDS', label: 'Rewards & gifts', kinds: ['REWARD', 'INVITE_BONUS', 'GIFT_RECEIVED'] },
  { key: 'EVENTS', label: 'Events', kinds: ['CHECKIN'] },
  { key: 'CLUBS', label: 'Clubs', kinds: ['CLUB_JOINED'] },
  { key: 'WALLET', label: 'Sent & funded', kinds: ['SENT', 'FUNDED'] },
  { key: 'SKR', label: 'SKR', kinds: ['SKR_TIP_SENT', 'SKR_TIP_RECEIVED', 'SKR_BOOST_PURCHASED'] },
  { key: 'ORE', label: 'ORE', kinds: ['ORE_DEPLOY_CONFIRMED', 'ORE_MINER_VERIFIED'] },
]

export function useHistory() {
  const { getAccessToken, user } = usePrivy()
  return useQuery({ queryKey: ['history'], queryFn: () => api.history(getAccessToken), enabled: Boolean(user) })
}

function dayLabel(iso: string) {
  const d = new Date(iso)
  const today = new Date()
  const y = new Date(today)
  y.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === y.toDateString()) return 'Yesterday'
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' })
}

/** D-38/D-40: Receipts & Activity — rewards, check-ins, clubs, sends and funded drops, newest first; each opens a receipt. */
export default function History() {
  const router = useRouter()
  const history = useHistory()
  const assets = useAssetMap()
  const [filter, setFilter] = useState<Filter>('ALL')
  const all = history.data?.items ?? []
  const kinds = FILTERS.find((f) => f.key === filter)!.kinds
  const items = filter === 'ALL' ? all : all.filter((i) => kinds.includes(i.kind))

  const groups: { day: string; items: HistoryItem[] }[] = []
  for (const it of items) {
    const day = dayLabel(it.at)
    const last = groups[groups.length - 1]
    if (last?.day === day) last.items.push(it)
    else groups.push({ day, items: [it] })
  }

  return (
    <Screen refreshControl={<RefreshControl onRefresh={() => void history.refetch()} refreshing={history.isRefetching} tintColor={color.text} />}>
      <NavBar onBack={() => router.back()} title="Receipts & Activity" />
      <ScrollView contentContainerStyle={{ gap: space.sm, paddingRight: space.xl }} horizontal showsHorizontalScrollIndicator={false} style={{ marginRight: -20, flexGrow: 0 }}>
        {FILTERS.filter((f) => f.key === 'ALL' || f.key === filter || all.some((i) => f.kinds.includes(i.kind))).map((f) => (
          <Chip key={f.key} label={f.label} onPress={() => setFilter(f.key)} selected={filter === f.key} />
        ))}
      </ScrollView>
      {history.isLoading ? (
        <View style={{ gap: space.md }}>
          <Skeleton height={64} />
          <Skeleton height={64} />
          <Skeleton height={64} />
        </View>
      ) : items.length === 0 ? (
        <EmptyState body="Rewards, event check-ins, clubs you join, stock you send and drops you fund show up here, each with a receipt." icon="layers" title="Nothing here yet" />
      ) : (
        groups.map((g) => (
          <View key={g.day} style={{ gap: space.sm }}>
            <T variant="overline">{g.day}</T>
            <Card padded={false} style={{ paddingHorizontal: space.lg }}>
              {g.items.map((it, i) => (
                <View key={it.id}>
                  {i > 0 ? <Divider /> : null}
                  <ListRow
                    leading={
                      <View style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: it.kind === 'SENT' || it.kind === 'FUNDED' ? color.surface3 : color.limeSoft, alignItems: 'center', justifyContent: 'center' }}>
                        <Icon name={ICON[it.kind]} size={18} stroke={it.kind === 'SENT' || it.kind === 'FUNDED' ? color.text : color.lime} />
                      </View>
                    }
                    onPress={() => router.push({ pathname: '/receipt/[id]', params: { id: it.id } })}
                    subtitle={`${it.status === 'CONFIRMED' ? new Date(it.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : it.status === 'PENDING' ? 'Confirming…' : 'Failed'}${isOffchain(it) ? ` · ${receiptHeadline(it, undefined)}` : ''}`}
                    title={receiptTitle(it)}
                    trailing={
                      isOffchain(it) ? undefined : (
                        <T variant="numeric" color={it.kind === 'SENT' || it.kind === 'FUNDED' ? color.text : color.lime}>
                          {receiptHeadline(it, it.mint ? assets.get(it.mint) : undefined)}
                        </T>
                      )
                    }
                  />
                </View>
              ))}
            </Card>
          </View>
        ))
      )}
    </Screen>
  )
}
