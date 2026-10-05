import { usePrivy } from '@privy-io/expo'
import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { RefreshControl, StyleSheet, TextInput, View } from 'react-native'

import { font } from '../../design/fonts'
import { Icon } from '../../design/icons'
import { color, radius, space } from '../../design/tokens'
import { Badge, Chip, EmptyState, IconButton, Notice, Row, Screen, Skeleton, T } from '../../design/ui'
import { ClubRow, useMyClubs } from '../../features/clubs/club-ui'
import { api } from '../../lib/api'

type Tab = 'discover' | 'joined'

/** D-40: communities around stocks and ecosystems. Joining is free and offchain. */
export default function Clubs() {
  const router = useRouter()
  const { getAccessToken, user } = usePrivy()
  const [tab, setTab] = useState<Tab>('discover')
  const [q, setQ] = useState('')
  const query = q.trim().toLowerCase()
  const discover = useQuery({
    queryKey: ['clubs', 'discover', query],
    queryFn: () => api.clubs(getAccessToken, { tab: 'discover', q: query || undefined }),
    enabled: Boolean(user) && tab === 'discover',
    placeholderData: (prev) => prev,
  })
  const joined = useMyClubs()
  const active = tab === 'discover' ? discover : joined
  const clubs = (active.data?.clubs ?? []).filter((c) => tab === 'discover' || !query || c.name.toLowerCase().includes(query))

  return (
    <Screen refreshControl={<RefreshControl onRefresh={() => void active.refetch()} refreshing={active.isRefetching} tintColor={color.lime} />} tabBar>
      <Row style={{ justifyContent: 'space-between' }}>
        <View>
          <T variant="display">Clubs</T>
          <T variant="label">Communities around the stocks you care about</T>
        </View>
        <IconButton icon="plus" label="Start a club" onPress={() => router.push('/club-new')} />
      </Row>

      <View style={styles.search}>
        <Icon name="search" size={18} stroke={color.textMuted} />
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setQ}
          placeholder="Search clubs or #tags"
          placeholderTextColor={color.textMuted}
          style={styles.searchInput}
          value={q}
        />
      </View>

      <Row gap={space.sm}>
        <Chip label="Discover" onPress={() => setTab('discover')} selected={tab === 'discover'} />
        <Chip label={`Joined${joined.data ? ` · ${joined.data.clubs.length}` : ''}`} onPress={() => setTab('joined')} selected={tab === 'joined'} />
      </Row>

      <Notice message={active.error ? (active.error as Error).message : null} />

      {active.isPending ? (
        <View style={{ gap: space.md }}>
          <Skeleton height={110} radius={radius.lg} />
          <Skeleton height={110} radius={radius.lg} />
          <Skeleton height={110} radius={radius.lg} />
        </View>
      ) : clubs.length === 0 ? (
        tab === 'joined' ? (
          <EmptyState action="Discover clubs" body="Join a club to chat, see its drops and climb its leaderboard." icon="users" onAction={() => setTab('discover')} title="No clubs yet" />
        ) : (
          <EmptyState action="Start a club" body={query ? 'No club matches that search.' : 'Be the first to start one.'} icon="users" onAction={() => router.push('/club-new')} title="Nothing here" />
        )
      ) : (
        <View style={{ gap: space.md }}>
          {clubs.map((c) => (
            <ClubRow
              club={c}
              key={c.id}
              onPress={() => router.push({ pathname: '/club/[slug]', params: { slug: c.slug } })}
              right={c.joined ? <Badge label={c.role === 'OWNER' ? 'Owner' : 'Joined'} tone="live" /> : <Badge label="Join" tone="neutral" />}
            />
          ))}
        </View>
      )}
      <T align="center" variant="caption">
        Clubs are run by their members. A club named after a company is not run by that company.
      </T>
    </Screen>
  )
}

const styles = StyleSheet.create({
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 48,
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.border,
  },
  searchInput: { flex: 1, marginLeft: space.sm, ...font('body'), fontSize: 15, color: color.text },
})
