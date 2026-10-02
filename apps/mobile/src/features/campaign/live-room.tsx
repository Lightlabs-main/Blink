import { usePrivy } from '@privy-io/expo'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { StyleSheet, View } from 'react-native'

import { font } from '../../design/fonts'
import { color, space } from '../../design/tokens'
import { Card, Divider, PulseDot, Row, T } from '../../design/ui'
import { api } from '../../lib/api'
import { embeddedSolanaAddress } from '../../lib/privy-user'
import { type CampaignSummary, type LiveEvent, publicLabel } from '../../shared'

/** Ticks once a second (inside an effect, so rendering stays pure). */
function useClock(active: boolean) {
  const [now, setNow] = useState(0)
  useEffect(() => {
    if (!active) return
    const tick = () => setNow(Date.now())
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [active])
  return now
}

function countdown(ms: number) {
  if (ms <= 0) return '00:00'
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`
}

function ago(iso: string, now: number) {
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`
}

function eventText(e: LiveEvent, symbol: string) {
  const who = e.who?.label ?? 'Someone'
  switch (e.type) {
    case 'PAYOUT_CONFIRMED':
      return `${who} received ${symbol}`
    case 'PARTICIPANT_QUALIFIED':
      return `${who} qualified`
    case 'REQUIREMENT_VERIFIED':
      return `${who} met every requirement`
    case 'PARTICIPANT_JOINED':
      return `${who} joined`
    case 'CAMPAIGN_PAUSED':
      return 'The drop was paused'
    case 'CAMPAIGN_ENDED':
      return 'The drop ended'
  }
}

/**
 * Live campaign room (D-21, update §13/§33): real aggregates from the server, refreshed every few seconds while the
 * screen is open. No fabricated activity; identities are truncated wallets only.
 */
export function LiveRoom({ campaign }: { campaign: CampaignSummary }) {
  const { user } = usePrivy()
  const live = campaign.status === 'LIVE'
  const room = useQuery({
    queryKey: ['room', campaign.id],
    queryFn: () => api.room(campaign.id),
    refetchInterval: live ? 4000 : false,
  })
  const now = useClock(live && Boolean(campaign.endsAt))
  const r = room.data?.room
  if (!r) return null
  const me = publicLabel(embeddedSolanaAddress(user)).label
  const left = campaign.endsAt && now ? Date.parse(campaign.endsAt) - now : null

  return (
    <Card style={{ gap: space.md }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Row gap={space.sm}>
          {live ? <PulseDot color={color.danger} /> : null}
          <T variant="overline" color={live ? color.danger : color.textDim}>
            {live ? 'Live' : r.status === 'ENDED' ? 'Ended' : r.status === 'PAUSED' ? 'Paused' : 'Room'}
          </T>
        </Row>
        {left !== null ? (
          <T style={styles.clock} variant="numeric">
            {countdown(left)}
          </T>
        ) : null}
      </Row>

      <Row gap={0}>
        {[
          [r.joined, r.leaderboard ? 'playing' : 'joined'],
          [r.qualified, 'qualified'],
          [r.rewardsRemaining, r.rewardsRemaining === 1 ? 'reward left' : 'rewards left'],
        ].map(([n, label], i) => (
          <View key={String(label)} style={[styles.stat, i > 0 && styles.statRule]}>
            <T style={styles.statNum}>{String(n)}</T>
            <T variant="caption">{String(label)}</T>
          </View>
        ))}
      </Row>

      {r.leaderboard && r.leaderboard.length ? (
        <View style={{ gap: space.sm }}>
          <Divider />
          {r.leaderboard.slice(0, 5).map((e, i) => {
            const mine = e.who.label === me
            return (
              <Row key={`${e.who.label}-${i}`} style={{ justifyContent: 'space-between' }}>
                <Row gap={space.sm}>
                  <T variant="numeric" color={color.textMuted}>
                    {String(i + 1)}
                  </T>
                  <T variant="bodyStrong" color={mine ? color.lime : color.text}>
                    {mine ? 'You' : e.who.label}
                  </T>
                </Row>
                <T variant="numeric">{String(e.score)}</T>
              </Row>
            )
          })}
        </View>
      ) : null}

      {r.events.length ? (
        <View style={{ gap: 6 }}>
          <Divider />
          {r.events.slice(0, 4).map((e, i) => (
            <Row key={`${e.at}-${i}`} style={{ justifyContent: 'space-between' }}>
              <T variant="label" color={color.text} style={{ flex: 1 }}>
                {eventText(e, campaign.xstockSymbol)}
              </T>
              <T variant="caption">{now ? ago(e.at, now) : ''}</T>
            </Row>
          ))}
        </View>
      ) : (
        <T variant="caption">Be the first to take part.</T>
      )}
    </Card>
  )
}

const styles = StyleSheet.create({
  clock: { fontSize: 20, color: color.text },
  stat: { flex: 1, gap: 2 },
  statRule: { paddingLeft: space.md, borderLeftWidth: 1, borderLeftColor: color.border },
  statNum: { ...font('display'), fontSize: 24, color: color.text },
})
