import { usePrivy } from '@privy-io/expo'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useState } from 'react'
import { Share, View } from 'react-native'

import { Icon } from '../../design/icons'
import { color, space } from '../../design/tokens'
import { Avatar, Badge, Button, Card, Chip, Divider, EmptyState, ListRow, Loading, NavBar, Notice, Row, Screen, Skeleton, StockAvatar, T } from '../../design/ui'
import { ClubChat } from '../../features/clubs/chat'
import { ClubMark, memberLabel } from '../../features/clubs/club-ui'
import { api, ApiError } from '../../lib/api'
import { displayShares, useAssetMap } from '../../lib/data'
import { CAMPAIGN_TYPE_LABEL, clubLink } from '../../lib/format'
import { haptics } from '../../lib/haptics'
import { type CampaignSummary, CLUB_CATEGORY_LABEL, type ClubDetail } from '../../shared'

type Tab = 'chat' | 'drops' | 'leaderboard' | 'about'
const TABS: { key: Tab; label: string }[] = [
  { key: 'chat', label: 'Chat' },
  { key: 'drops', label: 'Drops' },
  { key: 'leaderboard', label: 'Leaderboard' },
  { key: 'about', label: 'About' },
]
const base = process.env.EXPO_PUBLIC_BLINK_API_URL ?? ''

function phase(c: CampaignSummary): 'live' | 'upcoming' | 'ended' {
  if (c.status === 'ENDED' || c.status === 'CLOSED' || (c.endsAt && Date.parse(c.endsAt) <= Date.now())) return 'ended'
  if (c.startsAt && Date.parse(c.startsAt) > Date.now()) return 'upcoming'
  return c.status === 'LIVE' ? 'live' : 'ended'
}

function Drops({ club }: { club: ClubDetail }) {
  const router = useRouter()
  const assets = useAssetMap()
  const groups = (['live', 'upcoming', 'ended'] as const).map((p) => ({ p, items: club.campaigns.filter((c) => phase(c) === p) }))
  return (
    <View style={{ gap: space.lg }}>
      {club.joined ? (
        <Button icon="plus" onPress={() => router.push({ pathname: '/create', params: { clubId: club.id } })} variant="secondary">
          Post a drop in this club
        </Button>
      ) : null}
      {club.campaigns.length === 0 ? <EmptyState body="Drops posted in this club will show up here." icon="bolt" title="No drops yet" /> : null}
      {groups.map(({ p, items }) =>
        items.length ? (
          <View key={p} style={{ gap: space.sm }}>
            <T variant="overline">{p === 'live' ? 'Live' : p === 'upcoming' ? 'Upcoming' : 'Ended'}</T>
            <Card padded={false} style={{ paddingHorizontal: space.lg }}>
              {items.map((c, i) => {
                const asset = assets.get(c.mint)
                const reward = c.rewardPerClaimRaw ? displayShares(asset, c.rewardPerClaimRaw) : null
                return (
                  <View key={c.id}>
                    {i > 0 ? <Divider /> : null}
                    <ListRow
                      leading={<StockAvatar isTest={asset?.isTest} logo={asset?.logo} size={36} symbol={c.xstockSymbol} />}
                      onPress={() => router.push(`/campaign/${c.id}`)}
                      subtitle={`${CAMPAIGN_TYPE_LABEL[c.type]}${reward ? ` · ${reward} each` : ''}${c.tapRush ? ` · ${c.tapRush.goal.toLocaleString()} taps` : ''}`}
                      title={c.xstockSymbol}
                      trailing={p === 'live' ? <Badge dot label="Live" tone="live" /> : p === 'upcoming' ? <Badge label="Soon" tone="warn" /> : null}
                    />
                  </View>
                )
              })}
            </Card>
          </View>
        ) : null,
      )}
    </View>
  )
}

function Leaderboard({ club }: { club: ClubDetail }) {
  const { getAccessToken } = usePrivy()
  const [period, setPeriod] = useState<'week' | 'all'>('week')
  const board = useQuery({ queryKey: ['club-board', club.slug, period], queryFn: () => api.clubLeaderboard(getAccessToken, club.slug, period) })
  const pts = board.data?.points
  return (
    <View style={{ gap: space.lg }}>
      <Row gap={space.sm}>
        <Chip label="This week" onPress={() => setPeriod('week')} selected={period === 'week'} />
        <Chip label="All time" onPress={() => setPeriod('all')} selected={period === 'all'} />
      </Row>
      {board.isPending ? (
        <Skeleton height={160} />
      ) : !board.data?.leaderboard.length ? (
        <EmptyState body="Points come from this club’s drops: win a reward, qualify, or check in at an event." icon="trophy" title="No points yet" />
      ) : (
        <Card padded={false} style={{ paddingHorizontal: space.lg }}>
          {board.data.leaderboard.map((e, i) => (
            <View key={`${e.rank}-${e.who.label}`}>
              {i > 0 ? <Divider /> : null}
              <ListRow
                leading={
                  <Row gap={space.sm}>
                    <T style={{ width: 22 }} variant="numeric" color={e.rank <= 3 ? color.lime : color.textMuted}>
                      {e.rank}
                    </T>
                    <Avatar label={e.who.username ?? e.who.label} size={32} uri={e.who.avatarUrl ? `${base}${e.who.avatarUrl}` : null} />
                  </Row>
                }
                subtitle={[e.rewards && `${e.rewards} won`, e.qualified && `${e.qualified} qualified`, e.checkins && `${e.checkins} check-ins`].filter(Boolean).join(' · ')}
                title={e.who.label}
                trailing={<T variant="numeric">{`${e.points} pts`}</T>}
              />
            </View>
          ))}
        </Card>
      )}
      {pts ? (
        <T variant="caption">{`How points work: ${pts.REWARD} for a reward won, ${pts.QUALIFIED} for qualifying and ${pts.CHECKIN} for an event check-in — once per drop, in this club’s drops only. Wallet balances never count.`}</T>
      ) : null}
    </View>
  )
}

function About({ club, onLeave, leaving }: { club: ClubDetail; onLeave: () => void; leaving: boolean }) {
  const link = clubLink(club.slug, club.visibility === 'PRIVATE' ? club.inviteCode : null)
  return (
    <View style={{ gap: space.lg }}>
      <Card style={{ gap: space.md }}>
        <T>{club.description}</T>
        {club.tags.length ? <T variant="label" color={color.lime}>{club.tags.map((t) => `#${t}`).join('  ')}</T> : null}
        <Divider />
        <Row style={{ justifyContent: 'space-between' }}>
          <T variant="label">Type</T>
          <T variant="bodyStrong">{`${CLUB_CATEGORY_LABEL[club.category]} · ${club.visibility === 'PRIVATE' ? 'Private' : 'Public'}`}</T>
        </Row>
        <Row style={{ justifyContent: 'space-between' }}>
          <T variant="label">Started by</T>
          <T variant="bodyStrong">{club.owner?.label ?? 'Blink'}</T>
        </Row>
        <Row style={{ justifyContent: 'space-between' }}>
          <T variant="label">Since</T>
          <T variant="bodyStrong">{new Date(club.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</T>
        </Row>
        {club.inviteCode ? (
          <Row style={{ justifyContent: 'space-between' }}>
            <T variant="label">Invite code</T>
            <T variant="numeric">{club.inviteCode}</T>
          </Row>
        ) : null}
      </Card>
      {club.visibility === 'PUBLIC' || club.inviteCode ? (
        <Button
          icon="share"
          onPress={() => void Share.share({ message: `Join ${club.name} on Blink: ${link}` })}
          variant="secondary"
        >
          Invite friends
        </Button>
      ) : null}
      <T variant="caption">Clubs are run by their members. A club named after a company is not run or endorsed by that company. Joining is free and never touches your wallet.</T>
      {club.joined && club.role !== 'OWNER' ? (
        <Button loading={leaving} onPress={onLeave} variant="ghost">
          Leave club
        </Button>
      ) : null}
    </View>
  )
}

export default function ClubScreen() {
  const router = useRouter()
  const { slug, invite } = useLocalSearchParams<{ slug: string; invite?: string }>()
  const inviteCode = typeof invite === 'string' && /^[A-Z0-9]{8}$/.test(invite) ? invite : undefined
  const { getAccessToken } = usePrivy()
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<Tab>('chat')
  const club = useQuery({ queryKey: ['club', String(slug)], queryFn: () => api.club(getAccessToken, String(slug), inviteCode) })
  const back = () => (router.canGoBack() ? router.back() : router.replace('/clubs'))
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['club', String(slug)] })
    void queryClient.invalidateQueries({ queryKey: ['clubs'] })
    void queryClient.invalidateQueries({ queryKey: ['history'] })
  }
  const join = useMutation({
    mutationFn: () => api.joinClub(getAccessToken, club.data!.club.slug, inviteCode),
    onSuccess: () => {
      haptics.success()
      refresh()
    },
    onError: () => haptics.error(),
  })
  const leave = useMutation({ mutationFn: () => api.leaveClub(getAccessToken, club.data!.club.slug), onSuccess: refresh })

  if (club.isPending) return <Loading label="Opening club…" />
  if (club.error) {
    const missing = club.error instanceof ApiError && club.error.status === 404
    return (
      <Screen>
        <NavBar onBack={back} />
        <EmptyState body={missing ? 'This club doesn’t exist, or it’s private and needs an invite.' : club.error.message} icon="users" title={missing ? 'Club not found' : 'Something went wrong'} />
      </Screen>
    )
  }
  const c = club.data.club
  const header = (
    <View style={{ gap: space.md }}>
      <NavBar onBack={back} />
      <Row>
        <ClubMark club={c} size={52} />
        <View style={{ flex: 1, gap: 2 }}>
          <T numberOfLines={1} variant="title">
            {c.name}
          </T>
          <Row gap={6}>
            <Icon name="users" size={14} stroke={color.textMuted} />
            <T variant="caption">{memberLabel(c.memberCount)}</T>
          </Row>
        </View>
        {c.joined ? (
          <Badge label={c.role === 'OWNER' ? 'Owner' : 'Joined'} tone="live" />
        ) : (
          <Button loading={join.isPending} onPress={() => join.mutate()} size="sm">
            Join
          </Button>
        )}
      </Row>
      <Notice message={join.error ? join.error.message : null} />
      <Row gap={space.sm} style={{ flexWrap: 'wrap' }}>
        {TABS.map((t) => (
          <Chip key={t.key} label={t.label} onPress={() => setTab(t.key)} selected={tab === t.key} />
        ))}
      </Row>
    </View>
  )

  if (tab === 'chat') {
    return (
      <Screen contentStyle={{ gap: space.md }} scroll={false}>
        {header}
        <ClubChat canModerate={c.role === 'OWNER' || c.role === 'MOD'} canPost={c.joined} joining={join.isPending} onJoin={() => join.mutate()} slug={c.slug} />
      </Screen>
    )
  }
  return (
    <Screen>
      {header}
      {tab === 'drops' ? <Drops club={c} /> : tab === 'leaderboard' ? <Leaderboard club={c} /> : <About club={c} leaving={leave.isPending} onLeave={() => leave.mutate()} />}
    </Screen>
  )
}
