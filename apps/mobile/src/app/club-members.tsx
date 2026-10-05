import { usePrivy } from '@privy-io/expo'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useState } from 'react'
import { Alert, Pressable, RefreshControl, View } from 'react-native'

import { color, space } from '../design/tokens'
import { Avatar, Badge, Card, Chip, Divider, EmptyState, Loading, NavBar, Notice, Row, Screen, T } from '../design/ui'
import { api, apiUrl } from '../lib/api'
import { haptics } from '../lib/haptics'
import type { ClubMemberView } from '../shared'

const MUTES = [
  { label: '1 hour', minutes: 60 },
  { label: '8 hours', minutes: 480 },
  { label: '1 day', minutes: 1440 },
  { label: '1 week', minutes: 10080 },
] as const

function until(iso: string) {
  return new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })
}

/**
 * D-43: club members. Everyone sees who's in; admins tap a member to mute or remove them, and the owner can make or
 * remove admins. Nobody can act on the owner, and only the owner acts on other admins (the server enforces all of it).
 */
export default function ClubMembers() {
  const router = useRouter()
  const { slug } = useLocalSearchParams<{ slug: string }>()
  const { getAccessToken } = usePrivy()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState<string | null>(null)
  const list = useQuery({ queryKey: ['club-members', String(slug)], queryFn: () => api.clubMembers(getAccessToken, String(slug)) })
  const club = useQuery({ queryKey: ['club', String(slug)], queryFn: () => api.club(getAccessToken, String(slug)) })
  const myRole = club.data?.club.role
  const isOwner = myRole === 'OWNER'
  const isAdmin = isOwner || myRole === 'MOD'

  const done = () => {
    haptics.success()
    setOpen(null)
    void queryClient.invalidateQueries({ queryKey: ['club-members', String(slug)] })
    void queryClient.invalidateQueries({ queryKey: ['club', String(slug)] })
  }
  const act = useMutation({
    mutationFn: async (a: { kind: 'role'; id: string; role: 'MOD' | 'MEMBER' } | { kind: 'mute'; id: string; minutes: number } | { kind: 'remove' | 'restore'; id: string }) => {
      if (a.kind === 'role') return api.setMemberRole(getAccessToken, String(slug), a.id, a.role)
      if (a.kind === 'mute') return api.muteMember(getAccessToken, String(slug), a.id, a.minutes)
      if (a.kind === 'remove') return api.removeMember(getAccessToken, String(slug), a.id)
      return api.restoreMember(getAccessToken, String(slug), a.id)
    },
    onSuccess: done,
    onError: () => haptics.error(),
  })

  if (list.isPending || club.isPending) return <Loading label="Loading members…" />
  const members = list.data?.members ?? []
  const removed = list.data?.removed ?? null
  const canActOn = (m: ClubMemberView) => isAdmin && !m.me && m.role !== 'OWNER' && (m.role !== 'MOD' || isOwner)

  return (
    <Screen refreshControl={<RefreshControl onRefresh={() => void list.refetch()} refreshing={list.isRefetching} tintColor={color.text} />}>
      <NavBar onBack={() => router.back()} title={`Members · ${members.length}`} />
      <Notice message={list.error ? list.error.message : act.error ? act.error.message : null} />
      {isAdmin ? <T variant="caption">Tap a member to mute or remove them{isOwner ? ', or to make them an admin' : ''}.</T> : null}
      <Card padded={false} style={{ paddingHorizontal: space.lg }}>
        {members.map((m, i) => (
          <View key={m.id}>
            {i > 0 ? <Divider /> : null}
            <Pressable disabled={!canActOn(m)} onPress={() => setOpen((o) => (o === m.id ? null : m.id))} style={{ paddingVertical: space.md, gap: space.sm }}>
              <Row>
                <Avatar label={m.who.username ?? m.who.label} size={38} uri={apiUrl(m.who.avatarUrl)} />
                <View style={{ flex: 1, gap: 2 }}>
                  <T numberOfLines={1} variant="bodyStrong">{`${m.who.label}${m.me ? ' (you)' : ''}`}</T>
                  <T variant="caption">{m.mutedUntil ? `Muted until ${until(m.mutedUntil)}` : `Joined ${new Date(m.joinedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`}</T>
                </View>
                {m.role === 'OWNER' ? <Badge label="Owner" tone="live" /> : m.role === 'MOD' ? <Badge label="Admin" tone="neutral" /> : null}
              </Row>
              {open === m.id ? (
                <View style={{ gap: space.sm }}>
                  <T variant="overline">Mute</T>
                  <Row gap={space.sm} style={{ flexWrap: 'wrap' }}>
                    {MUTES.map((x) => (
                      <Chip key={x.minutes} label={x.label} onPress={() => act.mutate({ kind: 'mute', id: m.id, minutes: x.minutes })} selected={false} />
                    ))}
                    {m.mutedUntil ? <Chip label="Unmute" onPress={() => act.mutate({ kind: 'mute', id: m.id, minutes: 0 })} selected /> : null}
                  </Row>
                  <Row gap={space.sm} style={{ flexWrap: 'wrap' }}>
                    {isOwner ? (
                      <Chip
                        icon="shield"
                        label={m.role === 'MOD' ? 'Remove admin' : 'Make admin'}
                        onPress={() => act.mutate({ kind: 'role', id: m.id, role: m.role === 'MOD' ? 'MEMBER' : 'MOD' })}
                        selected={false}
                      />
                    ) : null}
                    <Chip
                      icon="close"
                      label="Remove from club"
                      onPress={() =>
                        Alert.alert(`Remove ${m.who.label}?`, 'They leave the club and can’t rejoin until an admin lets them back in.', [
                          { text: 'Cancel', style: 'cancel' },
                          { text: 'Remove', style: 'destructive', onPress: () => act.mutate({ kind: 'remove', id: m.id }) },
                        ])
                      }
                      selected={false}
                    />
                  </Row>
                </View>
              ) : null}
            </Pressable>
          </View>
        ))}
      </Card>
      {members.length === 0 ? <EmptyState body="Nobody has joined yet." icon="users" title="No members" /> : null}

      {removed && removed.length ? (
        <View style={{ gap: space.sm }}>
          <T variant="overline">Removed</T>
          <Card padded={false} style={{ paddingHorizontal: space.lg }}>
            {removed.map((r, i) => (
              <View key={r.id}>
                {i > 0 ? <Divider /> : null}
                <Row style={{ paddingVertical: space.md }}>
                  <Avatar label={r.who.username ?? r.who.label} size={34} uri={apiUrl(r.who.avatarUrl)} />
                  <T numberOfLines={1} style={{ flex: 1 }} variant="bodyStrong">
                    {r.who.label}
                  </T>
                  <Chip label="Let back in" onPress={() => act.mutate({ kind: 'restore', id: r.id })} selected={false} />
                </Row>
              </View>
            ))}
          </Card>
        </View>
      ) : null}
    </Screen>
  )
}
