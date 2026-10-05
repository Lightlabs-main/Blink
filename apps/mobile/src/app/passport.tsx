import { usePrivy } from '@privy-io/expo'
import { useQuery } from '@tanstack/react-query'
import * as Sharing from 'expo-sharing'
import { useRouter } from 'expo-router'
import { useRef, useState } from 'react'
import { Linking, Pressable, RefreshControl, StyleSheet, useWindowDimensions, View } from 'react-native'
import { captureRef } from 'react-native-view-shot'

import { Icon } from '../design/icons'
import { color, gutter, radius, space } from '../design/tokens'
import { Button, Card, Divider, EmptyState, ListRow, NavBar, Notice, Screen, Skeleton, T } from '../design/ui'
import { PassportIdCard } from '../features/passport/passport-card'
import { api, apiUrl } from '../lib/api'
import { useProfile } from '../lib/data'
import { haptics } from '../lib/haptics'
import { passportLevel } from '../shared'

export function usePassport() {
  const { getAccessToken, user } = usePrivy()
  return useQuery({ queryKey: ['passport'], queryFn: () => api.passport(getAccessToken), enabled: Boolean(user) })
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
  const cardWidth = useWindowDimensions().width - gutter * 2
  const [sharing, setSharing] = useState(false)
  const [shareError, setShareError] = useState<string | null>(null)

  /** Captures the Passport card (picture, @username, counts, latest stamps) as a PNG and opens the share sheet. */
  async function shareImage() {
    setShareError(null)
    setSharing(true)
    try {
      const uri = await captureRef(card, { format: 'png', quality: 1, result: 'tmpfile', width: 1200, height: 675 })
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
    const level = p ? passportLevel(p.badges.length).label : 'Newcomer'
    const text = `${level} on Blink. My Stock Passport: ${stamps} ${stamps === 1 ? 'stamp' : 'stamps'}${p?.rewards ? `, ${p.rewards} stock ${p.rewards === 1 ? 'reward' : 'rewards'}` : ''}${p?.squadWins ? `, ${p.squadWins} squad ${p.squadWins === 1 ? 'goal' : 'goals'}` : ''} ⚡ tokenized stocks, made social.`
    void Linking.openURL(`https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent('https://blinksol.site')}`)
  }

  return (
    <Screen refreshControl={<RefreshControl onRefresh={() => void passport.refetch()} refreshing={passport.isRefetching} tintColor={color.text} />}>
      <NavBar onBack={() => router.back()} title="Stock Passport" />
      {/* D-42: the Passport as an ID card. It is also the share image (captured at 1200 × 675). */}
      {p ? (
        <Pressable accessibilityLabel="Edit profile picture and username" onPress={() => router.push('/profile-edit')}>
          <PassportIdCard avatarUri={avatar} passport={p} ref={card} username={username ?? null} width={cardWidth} />
        </Pressable>
      ) : (
        <Skeleton height={cardWidth * 0.5625} radius={radius.xl} />
      )}
      {p && (!avatar || !username) ? (
        <T variant="caption">{`Tap the card to add ${!avatar && !username ? 'your picture and username' : !avatar ? 'your picture' : 'a username'} before sharing.`}</T>
      ) : null}

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
  stamp: { width: 36, height: 36, borderRadius: 18, backgroundColor: color.limeSoft, borderWidth: 1, borderColor: color.limeLine, alignItems: 'center', justifyContent: 'center' },
})
