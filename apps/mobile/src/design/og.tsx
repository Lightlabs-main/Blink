import { type StyleProp, type TextStyle, View } from 'react-native'
import Svg, { Path, Rect } from 'react-native-svg'

import { OG_TYPES, type OgType, type PublicParticipant } from '../shared'
import { color } from './tokens'
import { T } from './ui'

/*
 * D-45: OG marks in front of a name — ORE miner (pickaxe), Solana Mobile / Seeker owner (phone), SKR staker (stake
 * stack). Someone with all three also gets the OG name colour. Checked on Solana mainnet; never self-declared.
 */
const TINT: Record<OgType, string> = { ORE: color.ogOre, SEEKER: color.ogSeeker, SKR: color.ogSkr }

export function OgIcon({ type, size = 14 }: { type: OgType; size?: number }) {
  const c = TINT[type]
  const p = { stroke: c, strokeWidth: 2.2, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  return (
    <Svg accessibilityLabel={type === 'ORE' ? 'ORE miner' : type === 'SEEKER' ? 'Seeker owner' : 'SKR staker'} height={size} viewBox="0 0 24 24" width={size}>
      {type === 'ORE' ? (
        <Path d="M4 8.5C8 4 15.5 3.5 20 6.5M12 6.2 19.5 20.5M12 6.2l-2.6 4.9" {...p} />
      ) : type === 'SEEKER' ? (
        <>
          <Rect height={18} rx={3} width={11} x={6.5} y={3} {...p} />
          <Path d="M10.5 17.5h3" {...p} />
        </>
      ) : (
        <Path d="M4 8.5 12 4.5l8 4-8 4zM4 12.5l8 4 8-4M4 16.5l8 4 8-4" {...p} />
      )}
    </Svg>
  )
}

export const isFullOg = (og: readonly OgType[] | undefined) => OG_TYPES.every((t) => og?.includes(t))

export function OgIcons({ og, size = 14 }: { og: readonly OgType[] | undefined; size?: number }) {
  if (!og?.length) return null
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
      {OG_TYPES.filter((t) => og.includes(t)).map((t) => (
        <OgIcon key={t} size={size} type={t} />
      ))}
    </View>
  )
}

/** A person's name with their OG icons in front; all three marks → the OG colour. */
export function PersonName({
  who,
  style,
  text,
  iconSize = 13,
  numberOfLines = 1,
}: {
  who: Pick<PublicParticipant, 'label' | 'og'>
  style?: StyleProp<TextStyle>
  /** Override the shown text (e.g. "You"); the marks still come from `who`. */
  text?: string
  iconSize?: number
  numberOfLines?: number
}) {
  const full = isFullOg(who.og)
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1 }}>
      <OgIcons og={who.og} size={iconSize} />
      <T numberOfLines={numberOfLines} style={[style, { flexShrink: 1 }, full ? { color: color.og } : null]}>
        {text ?? who.label}
      </T>
    </View>
  )
}
