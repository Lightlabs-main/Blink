import { usePrivy } from '@privy-io/expo'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Share, StyleSheet, TextInput, View } from 'react-native'

import { font } from '../../design/fonts'
import { Icon } from '../../design/icons'
import { color, radius, space } from '../../design/tokens'
import { Avatar, Button, Card, Notice, Row, T } from '../../design/ui'
import { api } from '../../lib/api'
import { campaignLink } from '../../lib/format'
import { haptics } from '../../lib/haptics'
import type { CampaignSummary } from '../../shared'

const base = process.env.EXPO_PUBLIC_BLINK_API_URL ?? ''

/**
 * D-40: squads for Tap Rush drops. Up to 4 friends; the squad goal is the drop's goal × 4, counted from each member's
 * best round as the server recorded it (never a client total). Each person still claims their own reward by
 * reaching the drop's goal — the squad goal is a shared achievement (Passport), not a separate payout.
 */
export function SquadPanel({ campaign }: { campaign: CampaignSummary }) {
  const { getAccessToken, user } = usePrivy()
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const key = ['squads', campaign.id]
  const squads = useQuery({ queryKey: key, queryFn: () => api.squads(getAccessToken, campaign.id), enabled: Boolean(user), refetchInterval: 8000 })
  const done = () => {
    haptics.success()
    setName('')
    setCode('')
    void queryClient.invalidateQueries({ queryKey: key })
  }
  const create = useMutation({ mutationFn: () => api.createSquad(getAccessToken, campaign.id, name.trim()), onSuccess: done, onError: () => haptics.error() })
  const join = useMutation({ mutationFn: () => api.joinSquad(getAccessToken, code.trim().toUpperCase()), onSuccess: done, onError: () => haptics.error() })
  const leave = useMutation({ mutationFn: (id: string) => api.leaveSquad(getAccessToken, id), onSuccess: done })

  if (!user || campaign.status !== 'LIVE' || !campaign.tapRush) return null
  const mine = squads.data?.mine
  const error = create.error ?? join.error ?? leave.error

  return (
    <Card style={{ gap: space.md }}>
      <Row>
        <Icon name="users" size={20} stroke={color.lime} />
        <T variant="heading">{mine ? mine.name : 'Play as a squad'}</T>
      </Row>
      {mine ? (
        <>
          <View style={{ gap: 6 }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <T variant="label">{`${mine.members.length} / ${mine.maxSize} joined`}</T>
              <T variant="numeric" color={mine.complete ? color.lime : color.text}>{`${mine.combinedTaps.toLocaleString()} / ${mine.target.toLocaleString()}`}</T>
            </Row>
            <View style={styles.track}>
              <View style={[styles.fill, { width: `${Math.min(100, (mine.combinedTaps / Math.max(1, mine.target)) * 100)}%` }]} />
            </View>
            <T variant="caption">{mine.complete ? 'Squad goal reached ✓ — it’s on everyone’s Passport.' : 'Combined best rounds of every member. Each of you still plays your own rounds.'}</T>
          </View>
          {mine.members.map((m) => (
            <Row key={m.who.label}>
              <Avatar label={m.who.username ?? m.who.label} size={30} uri={m.who.avatarUrl ? `${base}${m.who.avatarUrl}` : null} />
              <T style={{ flex: 1 }} variant="bodyStrong">{`${m.who.label}${m.captain ? ' · captain' : ''}`}</T>
              <T variant="numeric">{m.taps.toLocaleString()}</T>
            </Row>
          ))}
          {Array.from({ length: mine.maxSize - mine.members.length }).map((_, i) => (
            <T key={i} variant="caption">
              Waiting for a friend…
            </T>
          ))}
          <Row gap={space.sm}>
            {mine.members.length < mine.maxSize ? (
              <Button
                icon="share"
                onPress={() => void Share.share({ message: `Join my squad “${mine.name}” on Blink with code ${mine.code}: ${campaignLink(campaign.id)}` })}
                size="sm"
                style={{ flex: 1 }}
                variant="secondary"
              >
                {`Invite · ${mine.code}`}
              </Button>
            ) : null}
            <Button loading={leave.isPending} onPress={() => leave.mutate(mine.id)} size="sm" variant="ghost">
              Leave squad
            </Button>
          </Row>
        </>
      ) : (
        <>
          <T variant="label">Team up with up to 3 friends. Your squad goal is {(campaign.tapRush.goal * 4).toLocaleString()} combined taps.</T>
          <Row gap={space.sm}>
            <TextInput maxLength={24} onChangeText={setName} placeholder="Squad name" placeholderTextColor={color.textMuted} style={styles.input} value={name} />
            <Button disabled={name.trim().length < 2} loading={create.isPending} onPress={() => create.mutate()} size="md">
              Create
            </Button>
          </Row>
          <Row gap={space.sm}>
            <TextInput
              autoCapitalize="characters"
              maxLength={6}
              onChangeText={setCode}
              placeholder="Squad code"
              placeholderTextColor={color.textMuted}
              style={styles.input}
              value={code}
            />
            <Button disabled={code.trim().length !== 6} loading={join.isPending} onPress={() => join.mutate()} size="md" variant="secondary">
              Join
            </Button>
          </Row>
        </>
      )}
      <Notice message={error ? error.message : null} />
    </Card>
  )
}

const styles = StyleSheet.create({
  track: { height: 8, borderRadius: 4, backgroundColor: color.surface3, overflow: 'hidden' },
  fill: { height: 8, borderRadius: 4, backgroundColor: color.marker },
  input: {
    flex: 1,
    height: 44,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    backgroundColor: color.surface2,
    borderWidth: 1,
    borderColor: color.border,
    ...font('body'),
    fontSize: 15,
    color: color.text,
  },
})
