import { usePrivy } from '@privy-io/expo'
import { useQuery } from '@tanstack/react-query'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { Pressable, StyleSheet, View } from 'react-native'

import { font } from '../design/fonts'
import { Icon } from '../design/icons'
import { PersonName } from '../design/og'
import { color, radius, space } from '../design/tokens'
import { Avatar, Badge, Button, Card, EmptyState, GlowCard, NavBar, Row, Screen, SectionHeader, Skeleton, T } from '../design/ui'
import { api, apiUrl } from '../lib/api'
import { useFeatures } from '../lib/data'
import type { ClubRole } from '../shared'

const ROLE_LABEL: Record<ClubRole, string> = { OWNER: 'Owner', MOD: 'Admin', MEMBER: 'Member' }

/** A member's public card, opened by tapping their name in a club (chat, members, leaderboard). */
export default function ClubMember() {
  const router = useRouter()
  const { slug, ref } = useLocalSearchParams<{ slug: string; ref: string }>()
  const { getAccessToken } = usePrivy()
  const features = useFeatures()
  const q = useQuery({ queryKey: ['member-profile', String(slug), String(ref)], queryFn: () => api.memberProfile(getAccessToken, String(slug), String(ref)) })
  const p = q.data?.profile

  if (q.isPending) {
    return (
      <Screen>
        <NavBar onBack={() => router.back()} />
        <Skeleton height={180} radius={radius.lg} />
      </Screen>
    )
  }
  if (!p) {
    return (
      <Screen>
        <NavBar onBack={() => router.back()} />
        <EmptyState body="This person isn’t in the club anymore." icon="user" title="Not found" />
      </Screen>
    )
  }

  const name = p.who.skrName ?? p.who.label
  return (
    <Screen>
      <NavBar onBack={() => router.back()} />
      <GlowCard>
        <Row>
          <Avatar label={p.who.username ?? p.who.label} size={64} uri={apiUrl(p.who.avatarUrl)} />
          <View style={{ flex: 1, gap: 4 }}>
            <PersonName iconSize={16} style={{ ...font('display'), fontSize: 22, color: color.text }} who={p.who} />
            {p.who.skrName && p.who.username ? <T variant="label">{`@${p.who.username}`}</T> : null}
            <Row gap={space.sm}>
              <Badge label={ROLE_LABEL[p.role]} tone={p.role === 'MEMBER' ? 'neutral' : 'live'} />
              {p.who.og?.includes('SEEKER') ? <Badge label="Verified Seeker" tone="live" /> : null}
              {p.who.og?.includes('ORE') ? <Badge label="ORE Miner" tone="warn" /> : null}
            </Row>
          </View>
        </Row>
        <Row gap={0} style={{ marginTop: space.xl }}>
          <Stat label="Day streak" value={p.stats.streakDays} highlight={p.stats.streakDays > 0} />
          <View style={styles.divider} />
          <Stat label="Rewards" value={p.stats.rewards} />
          <View style={styles.divider} />
          <Stat label="Check-ins" value={p.stats.checkins} />
          {p.stats.oreDeploys ? (
            <>
              <View style={styles.divider} />
              <Stat label="ORE deploys" value={p.stats.oreDeploys} />
            </>
          ) : null}
        </Row>
        <T style={{ marginTop: space.md }} variant="caption">{`In this club since ${new Date(p.joinedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`}</T>
      </GlowCard>

      {!p.me && features.data?.tips.enabled ? (
        <Button icon="send" onPress={() => router.push({ pathname: '/club-tip', params: { slug: String(slug), to: String(ref), name } })}>
          {`Tip ${name} SKR`}
        </Button>
      ) : null}

      <View style={{ gap: space.md }}>
        <SectionHeader title="Clubs" />
        <Card padded={false} style={{ paddingHorizontal: space.lg }}>
          {p.clubs.map((c, i) => (
            <Pressable
              key={c.slug}
              onPress={() => (c.slug === slug ? router.back() : router.push({ pathname: '/club/[slug]', params: { slug: c.slug } }))}
              style={[styles.clubRow, i > 0 && { borderTopWidth: 1, borderColor: color.border }]}
            >
              <Icon name="users" size={18} stroke={color.lime} />
              <T numberOfLines={1} style={{ flex: 1 }} variant="bodyStrong">
                {c.name}
              </T>
              <Badge label={ROLE_LABEL[c.role]} tone={c.role === 'MEMBER' ? 'neutral' : 'live'} />
            </Pressable>
          ))}
        </Card>
        <T variant="caption">Only public clubs are shown. Streak: days in a row with a message, claim, check-in, tip or ORE deploy.</T>
      </View>
    </Screen>
  )
}

function Stat({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <View style={styles.stat}>
      <T style={{ ...font('display'), fontSize: 24, color: highlight ? color.lime : color.text }}>{value}</T>
      <T variant="caption">{label}</T>
    </View>
  )
}

const styles = StyleSheet.create({
  stat: { flex: 1, alignItems: 'center', gap: 2 },
  divider: { width: 1, height: 32, backgroundColor: color.border },
  clubRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md },
})
