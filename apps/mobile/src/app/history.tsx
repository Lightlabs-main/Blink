import { usePrivy } from '@privy-io/expo'
import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { RefreshControl, View } from 'react-native'

import { Icon, type IconName } from '../design/icons'
import { color, space } from '../design/tokens'
import { Card, Divider, EmptyState, ListRow, NavBar, Screen, Skeleton, T } from '../design/ui'
import { receiptAmount, receiptTitle } from '../features/receipts/receipt'
import { api } from '../lib/api'
import { useAssetMap } from '../lib/data'
import type { HistoryItem } from '../shared'

const ICON: Record<HistoryItem['kind'], IconName> = { REWARD: 'gift', INVITE_BONUS: 'users', SENT: 'arrowUpRight', FUNDED: 'sparkle' }

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

/** D-38: everything that moved in or out, newest first; each line opens its receipt. */
export default function History() {
  const router = useRouter()
  const history = useHistory()
  const assets = useAssetMap()
  const items = history.data?.items ?? []

  const groups: { day: string; items: HistoryItem[] }[] = []
  for (const it of items) {
    const day = dayLabel(it.at)
    const last = groups[groups.length - 1]
    if (last?.day === day) last.items.push(it)
    else groups.push({ day, items: [it] })
  }

  return (
    <Screen refreshControl={<RefreshControl onRefresh={() => void history.refetch()} refreshing={history.isRefetching} tintColor={color.text} />}>
      <NavBar onBack={() => router.back()} title="Activity" />
      {history.isLoading ? (
        <View style={{ gap: space.md }}>
          <Skeleton height={64} />
          <Skeleton height={64} />
          <Skeleton height={64} />
        </View>
      ) : items.length === 0 ? (
        <EmptyState body="Rewards you earn, stock you send and drops you fund will show up here, each with a receipt." icon="layers" title="Nothing here yet" />
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
                    subtitle={`${it.status === 'CONFIRMED' ? new Date(it.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : it.status === 'PENDING' ? 'Confirming…' : 'Failed'}`}
                    title={receiptTitle(it)}
                    trailing={
                      <T variant="numeric" color={it.kind === 'SENT' || it.kind === 'FUNDED' ? color.text : color.lime}>
                        {receiptAmount(it, it.mint ? assets.get(it.mint) : undefined)}
                      </T>
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
