import { Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold } from '@expo-google-fonts/inter'
import {
  SpaceGrotesk_500Medium,
  SpaceGrotesk_600SemiBold,
  SpaceGrotesk_700Bold,
} from '@expo-google-fonts/space-grotesk'
import { isLoaded, useFonts } from 'expo-font'
import { ReactNode } from 'react'
import { TextStyle, View } from 'react-native'

import { hasNativeModule } from '../lib/native'
import { color } from './tokens'

const FONT_MAP = {
  SpaceGrotesk_500Medium,
  SpaceGrotesk_600SemiBold,
  SpaceGrotesk_700Bold,
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
}

/** Builds without the font loader fall back to system fonts instead of crashing. */
const FONTS_SUPPORTED = hasNativeModule('ExpoFontLoader')

export type FontRole = 'display' | 'displayMedium' | 'numeric' | 'body' | 'bodyMedium' | 'bodySemi' | 'bodyBold'

const FAMILY: Record<FontRole, keyof typeof FONT_MAP> = {
  display: 'SpaceGrotesk_700Bold',
  displayMedium: 'SpaceGrotesk_600SemiBold',
  numeric: 'SpaceGrotesk_500Medium',
  body: 'Inter_400Regular',
  bodyMedium: 'Inter_500Medium',
  bodySemi: 'Inter_600SemiBold',
  bodyBold: 'Inter_700Bold',
}

const FALLBACK_WEIGHT: Record<FontRole, TextStyle['fontWeight']> = {
  display: '800',
  displayMedium: '700',
  numeric: '600',
  body: '400',
  bodyMedium: '500',
  bodySemi: '600',
  bodyBold: '700',
}

/** Font style for a role. Falls back to the system font (with weight) if custom fonts are unavailable. */
export function font(role: FontRole): TextStyle {
  const family = FAMILY[role]
  return FONTS_SUPPORTED && isLoaded(family) ? { fontFamily: family } : { fontWeight: FALLBACK_WEIGHT[role] }
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
