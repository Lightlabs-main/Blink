import { forwardRef, useState } from 'react'
import { Image, StyleSheet, View } from 'react-native'

import { font } from '../../design/fonts'
import { T } from '../../design/ui'
import { OgIcons, isFullOg } from '../../design/og'
import { type OgType, type Passport, passportLevel } from '../../shared'

/*
 * D-42: the Stock Passport as an ID card (16:9, sized for X). Designed on a 600-unit-wide grid and scaled to
 * `width`, then captured at 1200 × 675 for sharing. Fixed Blink ink/cream/lime so it looks the same everywhere.
 * Public-safe only: picture, @username, a one-way passport number, level, counts and stamp titles — never balances,
 * wallets, email or country.
 */
const INK = '#0D0D0B'
const INK_2 = '#1A1A17'
const RULE = '#2A2A25'
const CREAM = '#F4F0E6'
const MUTED = '#8C887E'
const LIME = '#ABFF1A'
/** D-45: the OG name colour (all three marks), fixed like the rest of the card. */
const OG_GOLD = '#F5C451'

/** Passport-style machine-readable line ("P<BLK<<MARIS<<…"), from public fields only. */
function mrz(username: string | null, number: string, since: string | null) {
  const name = (username ?? 'MEMBER').toUpperCase().replace(/[^A-Z0-9]/g, '<')
  const year = since ? new Date(since).getUTCFullYear().toString() : '<<<<'
  const line = `P<BLK<<${name}<<<<${number.replace(/-/g, '')}<<${year}`
  return (line + '<'.repeat(60)).slice(0, 52)
}

function Field({ u, label, children }: { u: number; label: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 3 * u }}>
      <T style={[font('mono'), { fontSize: 8.5 * u, letterSpacing: 1.6 * u, color: MUTED }]}>{label}</T>
      {children}
    </View>
  )
}

export const PassportIdCard = forwardRef<
  View,
  { width: number; passport: Passport; username: string | null; avatarUri: string | null; og?: OgType[]; onImageSettled?: () => void }
>(function PassportIdCard({ width, passport, username, avatarUri, og, onImageSettled }, ref) {
  const u = width / 600
  const [failed, setFailed] = useState(false)
  const level = passportLevel(passport.badges.length)
  const since = passport.memberSince ? new Date(passport.memberSince).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) : 'New'
  const stats: [number, string][] = [
    [passport.rewards, 'Rewards'],
    [passport.checkins, 'Check-ins'],
    [passport.clubs, 'Clubs'],
    [passport.squadWins, 'Squad goals'],
  ]
  const showPhoto = Boolean(avatarUri) && !failed

  return (
    <View collapsable={false} ref={ref} style={[styles.card, { width, height: width * 0.5625, borderRadius: 26 * u, padding: 24 * u }]}>
      {/* Large faint ring: the logo's dot, as a watermark. Flat, no glow. */}
      <View style={{ position: 'absolute', right: -70 * u, top: -70 * u, width: 300 * u, height: 300 * u, borderRadius: 150 * u, borderWidth: 26 * u, borderColor: INK_2 }} />

      {/* Header */}
      <View style={styles.row}>
        <Image source={require('../../../assets/logo-tile.png')} style={{ width: 28 * u, height: 28 * u, borderRadius: 7 * u }} />
        <T style={[font('display'), { fontSize: 19 * u, color: CREAM, marginLeft: 9 * u }]}>Blink</T>
        <View style={{ flex: 1 }} />
        <View style={{ alignItems: 'flex-end', gap: 2 * u }}>
          <T style={[font('mono'), { fontSize: 9 * u, letterSpacing: 2.4 * u, color: CREAM }]}>STOCK PASSPORT</T>
          <View style={styles.row}>
            <View style={{ width: 22 * u, height: 1, backgroundColor: LIME, marginRight: 6 * u }} />
            <T style={[font('mono'), { fontSize: 8 * u, letterSpacing: 2 * u, color: MUTED }]}>SOLANA · XSTOCKS</T>
          </View>
        </View>
      </View>

      {/* Body */}
      <View style={[styles.row, { marginTop: 18 * u, alignItems: 'flex-start', gap: 22 * u }]}>
        <View style={{ gap: 9 * u }}>
          <View style={{ width: 132 * u, height: 132 * u, borderRadius: 22 * u, overflow: 'hidden', backgroundColor: INK_2, borderWidth: 1, borderColor: RULE }}>
            {showPhoto ? (
              <Image
                onError={() => {
                  setFailed(true)
                  onImageSettled?.()
                }}
                onLoadEnd={() => onImageSettled?.()}
                source={{ uri: avatarUri! }}
                style={{ width: '100%', height: '100%' }}
              />
            ) : (
              <View style={styles.center}>
                <T style={[font('display'), { fontSize: 52 * u, color: CREAM }]}>{(username ?? 'B').slice(0, 1).toUpperCase()}</T>
              </View>
            )}
          </View>
          <View style={styles.row}>
            <View style={{ width: 7 * u, height: 7 * u, borderRadius: 4 * u, backgroundColor: LIME, marginRight: 6 * u }} />
            <T style={[font('mono'), { fontSize: 8 * u, letterSpacing: 1.4 * u, color: CREAM }]}>VERIFIED BY BLINK</T>
          </View>
        </View>

        <View style={{ flex: 1, gap: 9 * u }}>
          <Field label="HOLDER" u={u}>
            <View style={[styles.row, { gap: 6 * u }]}>
              <OgIcons og={og} size={17 * u} />
              <T numberOfLines={1} style={[font('display'), { flexShrink: 1, fontSize: 27 * u, lineHeight: 31 * u, color: isFullOg(og) ? OG_GOLD : CREAM }]}>
                {username ? `@${username}` : 'Blink member'}
              </T>
            </View>
          </Field>
          <View style={[styles.rule, { marginTop: 1 * u }]} />
          <View style={[styles.row, { gap: 18 * u }]}>
            <Field label="PASSPORT NO." u={u}>
              <T style={[font('mono'), { fontSize: 12.5 * u, letterSpacing: 1.2 * u, color: CREAM }]}>{passport.number}</T>
            </Field>
            <Field label="SINCE" u={u}>
              <T style={[font('mono'), { fontSize: 12.5 * u, color: CREAM }]}>{since}</T>
            </Field>
            <View style={{ flex: 1 }} />
            <Field label="LEVEL" u={u}>
              <View style={styles.row}>
                <View style={{ width: 8 * u, height: 8 * u, borderRadius: 4 * u, backgroundColor: LIME, marginRight: 6 * u }} />
                <T style={[font('bodySemi'), { fontSize: 13 * u, letterSpacing: 0.6 * u, color: LIME }]}>{level.label.toUpperCase()}</T>
              </View>
            </Field>
          </View>
          <View style={styles.rule} />
          <View style={styles.row}>
            {stats.map(([n, label]) => (
              <View key={label} style={{ flex: 1 }}>
                <T style={[font('display'), { fontSize: 22 * u, lineHeight: 26 * u, color: CREAM }]}>{n.toLocaleString()}</T>
                <T style={[font('mono'), { fontSize: 7.5 * u, letterSpacing: 1 * u, color: MUTED }]}>{label.toUpperCase()}</T>
              </View>
            ))}
          </View>
          {passport.badges.length ? (
            <View style={[styles.row, { gap: 5 * u, flexWrap: 'wrap' }]}>
              {passport.badges.slice(0, 3).map((b) => (
                <View key={b.id} style={{ paddingHorizontal: 7 * u, paddingVertical: 3 * u, borderRadius: 99, borderWidth: 1, borderColor: RULE }}>
                  <T numberOfLines={1} style={[font('bodyMedium'), { fontSize: 8.5 * u, color: CREAM, maxWidth: 120 * u }]}>{`✓ ${b.title}`}</T>
                </View>
              ))}
            </View>
          ) : null}
        </View>
      </View>

      {/* Footer: machine-readable line + site */}
      <View style={{ position: 'absolute', left: 24 * u, right: 24 * u, bottom: 16 * u, gap: 4 * u }}>
        <View style={styles.rule} />
        <View style={styles.row}>
          <T numberOfLines={1} style={[font('mono'), { flex: 1, fontSize: 9 * u, letterSpacing: 1.3 * u, color: MUTED }]}>
            {mrz(username, passport.number, passport.memberSince)}
          </T>
          <T style={[font('mono'), { fontSize: 9 * u, color: CREAM, marginLeft: 10 * u }]}>blinksol.site</T>
        </View>
      </View>
    </View>
  )
})

const styles = StyleSheet.create({
  card: { backgroundColor: INK, overflow: 'hidden', borderWidth: 1, borderColor: RULE },
  row: { flexDirection: 'row', alignItems: 'center' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  rule: { height: 1, backgroundColor: RULE },
})
