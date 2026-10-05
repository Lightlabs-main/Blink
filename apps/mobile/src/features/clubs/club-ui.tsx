import { usePrivy } from '@privy-io/expo'
import { useQuery } from '@tanstack/react-query'
import { Pressable, StyleSheet, View } from 'react-native'

import { font } from '../../design/fonts'
import { color, radius, space } from '../../design/tokens'
import { Row, T } from '../../design/ui'
import { api } from '../../lib/api'
import { CLUB_CATEGORY_LABEL, type ClubSummary } from '../../shared'

/** D-40: clubs the caller joined (Home row, Joined tab, club picker in Create). */
export function useMyClubs() {
  const { getAccessToken, user } = usePrivy()
  return useQuery({ queryKey: ['clubs', 'joined'], queryFn: () => api.clubs(getAccessToken, { tab: 'joined' }), enabled: Boolean(user) })
}

export function memberLabel(n: number) {
  return n === 1 ? '1 member' : `${n.toLocaleString()} members`
}

/** Monogram tile for a club (clubs have no uploaded artwork yet; P1). Stock clubs read as their ticker. */
export function ClubMark({ club, size = 44 }: { club: Pick<ClubSummary, 'name' | 'category'>; size?: number }) {
  const label = club.name.replace(/\bclub\b/i, '').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 3).toUpperCase() || 'B'
  const asset = club.category === 'ASSET'
  return (
    <View style={[styles.mark, { width: size, height: size, borderRadius: size * 0.3 }, asset && { backgroundColor: color.limeSoft, borderColor: color.limeLine }]}>
      <T style={{ ...font('displayMedium'), fontSize: size * (label.length > 2 ? 0.3 : 0.38), color: asset ? color.lime : color.text }}>{label}</T>
    </View>
  )
}

/** Compact card for the Home row. */
export function ClubTile({ club, onPress }: { club: ClubSummary; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.tile, pressed && { opacity: 0.85 }]}>
      <ClubMark club={club} size={40} />
      <View style={{ gap: 2 }}>
        <T variant="bodyStrong" numberOfLines={1}>
          {club.name}
        </T>
        <T variant="caption">{memberLabel(club.memberCount)}</T>
      </View>
    </Pressable>
  )
}

/** Full-width row for the Clubs list. */
export function ClubRow({ club, onPress, right }: { club: ClubSummary; onPress: () => void; right?: React.ReactNode }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.row, pressed && { opacity: 0.85 }]}>
      <Row style={{ alignItems: 'flex-start' }}>
        <ClubMark club={club} />
        <View style={{ flex: 1, gap: 4 }}>
          <Row gap={6}>
            <T variant="bodyStrong" numberOfLines={1} style={{ flexShrink: 1 }}>
              {club.name}
            </T>
            {club.visibility === 'PRIVATE' ? <T variant="caption">· Private</T> : null}
          </Row>
          <T variant="caption">
            {memberLabel(club.memberCount)} · {CLUB_CATEGORY_LABEL[club.category]}
          </T>
          <T numberOfLines={2} variant="label">
            {club.description}
          </T>
          {club.tags.length ? (
            <T style={{ ...font('mono'), fontSize: 12, color: color.textMuted }} numberOfLines={1}>
              {club.tags.map((t) => `#${t}`).join('  ')}
            </T>
          ) : null}
        </View>
        {right}
      </Row>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  mark: { alignItems: 'center', justifyContent: 'center', backgroundColor: color.surface3, borderWidth: 1, borderColor: color.border },
  tile: { width: 150, padding: space.lg, gap: space.md, borderRadius: radius.lg, backgroundColor: color.surface, borderWidth: 1, borderColor: color.border },
  row: { padding: space.lg, borderRadius: radius.lg, backgroundColor: color.surface, borderWidth: 1, borderColor: color.border },
})
