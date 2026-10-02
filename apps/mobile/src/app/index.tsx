import { usePrivy } from '@privy-io/expo'
import { Redirect, useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import Animated, { Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated'

import { Icon } from '../design/icons'
import { color, radius, space } from '../design/tokens'
import { Button, Loading, Notice, Row, Screen, StockAvatar, T } from '../design/ui'
import { useAssets } from '../lib/data'
import { PRODUCT_COPY } from '../shared'

/** Slowly scrolling strip of the real supported stocks (symbols + official logos only, no prices). */
function TickerStrip() {
  const assets = useAssets()
  const items = assets.data?.xstocks ?? []
  // Width of one set of pills (incl. trailing gap); the strip loops by exactly this distance, so the jump is invisible.
  const [setWidth, setSetWidth] = useState(0)
  const x = useSharedValue(0)
  useEffect(() => {
    if (!setWidth) return
    x.set(0)
    x.set(withRepeat(withTiming(-setWidth, { duration: setWidth * 40, easing: Easing.linear }), -1))
  }, [x, setWidth])
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: x.get() }] }))
  if (items.length === 0) return null
  // Enough copies to cover wide screens while one set scrolls out.
  const copies = items.length < 4 ? 8 : 4
  return (
    <View style={styles.tickerWrap}>
      <Animated.View style={[{ flexDirection: 'row' }, style]}>
        {Array.from({ length: copies }).map((_, copy) => (
          <View
            key={copy}
            onLayout={copy === 0 ? (e) => setSetWidth(Math.round(e.nativeEvent.layout.width)) : undefined}
            style={{ flexDirection: 'row' }}
          >
            {items.map((a) => (
              <View key={a.mint} style={[styles.tickerPill, { marginRight: space.md }]}>
                <StockAvatar isTest={a.isTest} logo={a.logo} size={22} symbol={a.symbol} />
                <T variant="numeric" style={{ fontSize: 14 }}>
                  {a.symbol}
                </T>
              </View>
            ))}
          </View>
        ))}
      </Animated.View>
    </View>
  )
}

function Point({ icon, text }: { icon: 'lock' | 'bolt' | 'shield'; text: string }) {
  return (
    <Row>
      <View style={styles.pointIcon}>
        <Icon name={icon} size={16} stroke={color.lime} strokeWidth={2} />
      </View>
      <T variant="label" style={{ flex: 1, color: color.textDim }}>
        {text}
      </T>
    </Row>
  )
}

export default function Welcome() {
  const router = useRouter()
  const { isReady, user, error } = usePrivy()

  if (!isReady) return <Loading label="Starting Blink…" />
  if (user) return <Redirect href="/home" />

  return (
    <Screen scroll={false}>
      <View style={{ flex: 1, justifyContent: 'space-between' }}>
        <Row gap={space.sm}>
          <View style={styles.logoMark}>
            <Icon name="bolt" size={18} stroke={color.onLime} strokeWidth={2.4} />
          </View>
          <T variant="heading">Blink</T>
        </Row>

        <View style={{ gap: space.xl }}>
          <T variant="overline">Tokenized stocks, made social</T>
          <T variant="hero">
            Stocks you can{'\n'}
            <T variant="hero" color={color.lime}>
              share
            </T>{' '}
            in a blink.
          </T>
          <T style={{ fontSize: 17, lineHeight: 25 }}>
            Scan a link, play or claim, and receive xStocks — tokenized stock exposure on Solana. No seed phrase, no exchange.
          </T>
          <TickerStrip />
          <View style={{ gap: space.md }}>
            <Point icon="bolt" text="Claim stock from friends, creators and communities" />
            <Point icon="lock" text="Your wallet is created for you — nothing to install" />
            <Point icon="shield" text="Settlement is transparent and verifiable on Solana" />
          </View>
        </View>

        <View style={{ gap: space.md }}>
          <Notice message={error?.message} />
          <Button icon="mail" onPress={() => router.push('/login/email')}>
            Continue with email
          </Button>
          <Button icon="wallet" onPress={() => router.push('/login/wallet')} variant="secondary">
            I’m a creator — use my wallet
          </Button>
          <T align="center" variant="caption">
            {PRODUCT_COPY.trustStatement}
          </T>
        </View>
      </View>
    </Screen>
  )
}

const styles = StyleSheet.create({
  logoMark: { width: 32, height: 32, borderRadius: 4, backgroundColor: color.lime, alignItems: 'center', justifyContent: 'center' },
  tickerWrap: { overflow: 'hidden', marginHorizontal: -20 },
  tickerPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 6,
    paddingRight: 14,
    paddingVertical: 6,
    borderRadius: radius.sm,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.border,
  },
  pointIcon: { width: 30, height: 30, borderRadius: 4, backgroundColor: color.limeSoft, alignItems: 'center', justifyContent: 'center' },
})
