import { usePrivy } from '@privy-io/expo'
import { useQuery } from '@tanstack/react-query'
import * as Sharing from 'expo-sharing'
import { useRouter } from 'expo-router'
import { useRef, useState } from 'react'
import { Linking, Pressable, RefreshControl, StyleSheet, View } from 'react-native'
import { captureRef } from 'react-native-view-shot'

import { font } from '../design/fonts'
import { Icon } from '../design/icons'
import { color, radius, space } from '../design/tokens'
import { Avatar, BlinkLogo, Button, Card, Divider, EmptyState, ListRow, NavBar, Notice, Row, Screen, Skeleton, T } from '../design/ui'
import { api, apiUrl } from '../lib/api'
import { useProfile } from '../lib/data'
import { haptics } from '../lib/haptics'

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
  const card = useRef<View>(null)
  const [sharing, setSharing] = useState(false)
  const [shareError, setShareError] = useState<string | null>(null)

  /** Captures the Passport card (picture, @username, counts, latest stamps) as a PNG and opens the share sheet. */
  async function shareImage() {
    setShareError(null)
    setSharing(true)
    try {
      const uri = await captureRef(card, { format: 'png', quality: 1, result: 'tmpfile' })
      if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing is not available on this phone')
      await Sharing.shareAsync(uri, { mimeType: 'image/png', dialogTitle: 'Share your Blink Passport' })
      haptics.success()
    } catch (e) {
      setShareError(e instanceof Error ? e.message : 'Could not share your Passport.')
    } finally {
      setSharing(false)
    }
  }

  /** X can't take an image from a link, so this posts the line + link; attach the image from "Share Passport". */
  function postOnX() {
    const stamps = p?.badges.length ?? 0
    const text = `My Blink Passport: ${stamps} ${stamps === 1 ? 'stamp' : 'stamps'}${p?.rewards ? `, ${p.rewards} stock ${p.rewards === 1 ? 'reward' : 'rewards'}` : ''}${p?.squadWins ? `, ${p.squadWins} squad ${p.squadWins === 1 ? 'goal' : 'goals'}` : ''} ⚡ tokenized stocks, made social.`
    void Linking.openURL(`https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent('https://blinksol.site')}`)
  }

  return (
    <Screen refreshControl={<RefreshControl onRefresh={() => void passport.refetch()} refreshing={passport.isRefetching} tintColor={color.text} />}>
      <NavBar onBack={() => router.back()} title="Stock Passport" />
      {/* The card below is also the share image: fixed ink colours so it looks the same everywhere. */}
      <View collapsable={false} ref={card} style={styles.cover}>
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
        {p?.badges.length ? (
          <View style={styles.latest}>
            {p.badges.slice(0, 3).map((b) => (
              <Row gap={space.sm} key={b.id}>
                <View style={styles.inkStamp}>
                  <Icon name="check" size={12} stroke="#ABFF1A" strokeWidth={3} />
                </View>
                <T numberOfLines={1} style={{ ...font('bodyMedium'), fontSize: 14, color: '#F4F0E6', flex: 1 }}>
                  {b.title}
                </T>
              </Row>
            ))}
            {p.badges.length > 3 ? <T style={{ ...font('body'), fontSize: 12.5, color: '#8C887E' }}>{`+${p.badges.length - 3} more`}</T> : null}
          </View>
        ) : null}
        <T style={{ ...font('body'), fontSize: 12, color: '#8C887E', marginTop: space.lg }}>Verified on Blink · blinksol.site</T>
      </View>

      {p ? (
        <View style={{ gap: space.sm }}>
          <Button icon="share" loading={sharing} onPress={() => void shareImage()}>
            Share Passport
          </Button>
          <Button onPress={postOnX} variant="secondary">
            Post on X
          </Button>
          <Notice message={shareError} />
        </View>
      ) : null}

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
  latest: { marginTop: space.lg, paddingTop: space.md, borderTopWidth: 1, borderColor: '#1F1F1B', gap: space.sm },
  inkStamp: { width: 20, height: 20, borderRadius: 10, backgroundColor: 'rgba(171,255,26,0.14)', alignItems: 'center', justifyContent: 'center' },
  stamp: { width: 36, height: 36, borderRadius: 18, backgroundColor: color.limeSoft, borderWidth: 1, borderColor: color.limeLine, alignItems: 'center', justifyContent: 'center' },
})
