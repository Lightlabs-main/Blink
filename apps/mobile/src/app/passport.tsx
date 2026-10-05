import { usePrivy } from '@privy-io/expo'
import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { Pressable, RefreshControl, StyleSheet, View } from 'react-native'

import { font } from '../design/fonts'
import { Icon } from '../design/icons'
import { color, radius, space } from '../design/tokens'
import { Avatar, BlinkLogo, Card, Divider, EmptyState, ListRow, NavBar, Notice, Row, Screen, Skeleton, T } from '../design/ui'
import { api, apiUrl } from '../lib/api'
import { useProfile } from '../lib/data'

export function usePassport() {
  const { getAccessToken, user } = usePrivy()
  return useQuery({ queryKey: ['passport'], queryFn: () => api.passport(getAccessToken), enabled: Boolean(user) })
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <View style={{ flex: 1, gap: 2 }}>
      <T style={{ ...font('display'), fontSize: 28, color: '#F4F0E6' }}>{value}</T>
      <T style={{ ...font('body'), fontSize: 12.5, color: '#8C887E' }}>{label}</T>
    </View>
  )
}

/**
 * D-40: Stock Passport — what you have done on Blink, derived from real records (settled rewards, event check-ins,
 * clubs, squad goals). Not a portfolio: no balances. No NFTs; nothing is written onchain.
 */
export default function PassportScreen() {
  const router = useRouter()
  const passport = usePassport()
  const profile = useProfile()
  const p = passport.data?.passport
  const username = profile.data?.profile.username
  const avatar = apiUrl(profile.data?.profile.avatarUrl)

  return (
    <Screen refreshControl={<RefreshControl onRefresh={() => void passport.refetch()} refreshing={passport.isRefetching} tintColor={color.text} />}>
      <NavBar onBack={() => router.back()} title="Stock Passport" />
      <View style={styles.cover}>
        <View style={styles.dot} />
        <Row>
          <BlinkLogo size={30} />
          <T style={{ ...font('display'), fontSize: 18, color: '#F4F0E6' }}>Blink Passport</T>
        </Row>
        {/* D-37: the holder's picture and username; tap to add or change them. */}
        <Pressable accessibilityLabel="Edit profile picture and username" onPress={() => router.push('/profile-edit')} style={{ marginTop: space.lg }}>
          <Row>
            <Avatar label={username ?? 'B'} size={56} uri={avatar} />
            <View style={{ flex: 1, gap: 2 }}>
              <T style={{ ...font('bodySemi'), fontSize: 16, color: '#ABFF1A' }}>{username ? `@${username}` : 'Your participation record'}</T>
              {!avatar || !username ? (
                <T style={{ ...font('body'), fontSize: 12.5, color: '#8C887E' }}>{`Tap to add ${!avatar && !username ? 'a picture and username' : !avatar ? 'a profile picture' : 'a username'}`}</T>
              ) : null}
            </View>
          </Row>
        </Pressable>
        {p ? (
          <Row style={{ marginTop: space.lg }}>
            <Stat label="Rewards" value={p.rewards} />
            <Stat label="Check-ins" value={p.checkins} />
            <Stat label="Clubs" value={p.clubs} />
            <Stat label="Squad goals" value={p.squadWins} />
          </Row>
        ) : (
          <Skeleton height={48} style={{ marginTop: space.lg }} />
        )}
      </View>

      <Notice message={passport.error ? passport.error.message : null} />

      {p && p.badges.length === 0 ? (
        <EmptyState action="Find a drop" body="Win a drop, check in at an event, join a club or reach a squad goal — each one adds a stamp here." icon="shield" onAction={() => router.push('/drops')} title="No stamps yet" />
      ) : p ? (
        <View style={{ gap: space.sm }}>
          <T variant="overline">Stamps</T>
          <Card padded={false} style={{ paddingHorizontal: space.lg }}>
            {p.badges.map((b, i) => (
              <View key={b.id}>
                {i > 0 ? <Divider /> : null}
                <ListRow
                  leading={
                    <View style={styles.stamp}>
                      <Icon name="check" size={16} stroke={color.lime} strokeWidth={2.6} />
                    </View>
                  }
                  subtitle={`${b.detail} · ${new Date(b.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`}
                  title={b.title}
                />
              </View>
            ))}
          </Card>
        </View>
      ) : null}
      <T variant="caption">Your Passport shows what you did, never how much you hold. Every stamp comes from a record Blink checked.</T>
    </Screen>
  )
}

const styles = StyleSheet.create({
  cover: { backgroundColor: '#0D0D0B', borderRadius: radius.xl, padding: space.xl, borderWidth: 1, borderColor: '#1F1F1B', overflow: 'hidden' },
  dot: { position: 'absolute', top: 22, right: 22, width: 12, height: 12, borderRadius: 6, backgroundColor: '#ABFF1A' },
  stamp: { width: 36, height: 36, borderRadius: 18, backgroundColor: color.limeSoft, borderWidth: 1, borderColor: color.limeLine, alignItems: 'center', justifyContent: 'center' },
})
