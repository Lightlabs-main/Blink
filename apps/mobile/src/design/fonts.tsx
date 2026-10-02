import { BricolageGrotesque_600SemiBold } from '@expo-google-fonts/bricolage-grotesque/600SemiBold'
import { BricolageGrotesque_700Bold } from '@expo-google-fonts/bricolage-grotesque/700Bold'
import { DMMono_500Medium } from '@expo-google-fonts/dm-mono/500Medium'
import { DMSans_400Regular } from '@expo-google-fonts/dm-sans/400Regular'
import { DMSans_500Medium } from '@expo-google-fonts/dm-sans/500Medium'
import { DMSans_600SemiBold } from '@expo-google-fonts/dm-sans/600SemiBold'
import { DMSans_700Bold } from '@expo-google-fonts/dm-sans/700Bold'
import { isLoaded, useFonts } from 'expo-font'
import { ReactNode } from 'react'
import { TextStyle, View } from 'react-native'

import { hasNativeModule } from '../lib/native'
import { color } from './tokens'

/**
 * D-31: Bricolage Grotesque for headlines (soft, characterful, like the mark), DM Sans for text, DM Mono for
 * numbers. Only the weights used are imported, to keep the app small.
 */
const FONT_MAP = {
  BricolageGrotesque_600SemiBold,
  BricolageGrotesque_700Bold,
  DMSans_400Regular,
  DMSans_500Medium,
  DMSans_600SemiBold,
  DMSans_700Bold,
  DMMono_500Medium,
}

/** Builds without the font loader fall back to system fonts instead of crashing. */
const FONTS_SUPPORTED = hasNativeModule('ExpoFontLoader')

export type FontRole = 'display' | 'displayMedium' | 'displayItalic' | 'numeric' | 'mono' | 'body' | 'bodyMedium' | 'bodySemi' | 'bodyBold'

const FAMILY: Record<FontRole, keyof typeof FONT_MAP> = {
  display: 'BricolageGrotesque_700Bold',
  displayMedium: 'BricolageGrotesque_600SemiBold',
  displayItalic: 'BricolageGrotesque_600SemiBold',
  numeric: 'DMMono_500Medium',
  mono: 'DMMono_500Medium',
  body: 'DMSans_400Regular',
  bodyMedium: 'DMSans_500Medium',
  bodySemi: 'DMSans_600SemiBold',
  bodyBold: 'DMSans_700Bold',
}

const FALLBACK: Record<FontRole, TextStyle> = {
  display: { fontWeight: '700' },
  displayMedium: { fontWeight: '600' },
  displayItalic: { fontWeight: '600' },
  numeric: { fontFamily: 'monospace', fontWeight: '500' },
  mono: { fontFamily: 'monospace', fontWeight: '500' },
  body: {},
  bodyMedium: { fontWeight: '500' },
  bodySemi: { fontWeight: '600' },
  bodyBold: { fontWeight: '700' },
}

/** Font style for a role. Falls back to system fonts if custom fonts are unavailable. */
export function font(role: FontRole): TextStyle {
  const family = FAMILY[role]
  return FONTS_SUPPORTED && isLoaded(family) ? { fontFamily: family } : FALLBACK[role]
}

function WithFonts({ children }: { children: ReactNode }) {
  const [loaded, error] = useFonts(FONT_MAP)
  if (!loaded && !error) return <View style={{ flex: 1, backgroundColor: color.bg }} />
  return <>{children}</>
}

/** Loads brand fonts when the binary has the font loader; otherwise renders immediately with system fonts. */
export function FontProvider({ children }: { children: ReactNode }) {
  return FONTS_SUPPORTED ? <WithFonts>{children}</WithFonts> : <>{children}</>
}
