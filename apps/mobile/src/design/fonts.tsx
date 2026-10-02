import { IBMPlexMono_500Medium, IBMPlexMono_600SemiBold } from '@expo-google-fonts/ibm-plex-mono'
import { InstrumentSerif_400Regular, InstrumentSerif_400Regular_Italic } from '@expo-google-fonts/instrument-serif'
import { Newsreader_400Regular, Newsreader_500Medium, Newsreader_600SemiBold, Newsreader_700Bold } from '@expo-google-fonts/newsreader'
import { isLoaded, useFonts } from 'expo-font'
import { ReactNode } from 'react'
import { TextStyle, View } from 'react-native'

import { hasNativeModule } from '../lib/native'
import { color } from './tokens'

/** Broadsheet type, matching blinksol.site: serif headlines, serif text, mono labels. */
const FONT_MAP = {
  InstrumentSerif_400Regular,
  InstrumentSerif_400Regular_Italic,
  Newsreader_400Regular,
  Newsreader_500Medium,
  Newsreader_600SemiBold,
  Newsreader_700Bold,
  IBMPlexMono_500Medium,
  IBMPlexMono_600SemiBold,
}

/** Builds without the font loader fall back to system fonts instead of crashing. */
const FONTS_SUPPORTED = hasNativeModule('ExpoFontLoader')

export type FontRole = 'display' | 'displayMedium' | 'displayItalic' | 'numeric' | 'mono' | 'body' | 'bodyMedium' | 'bodySemi' | 'bodyBold'

const FAMILY: Record<FontRole, keyof typeof FONT_MAP> = {
  display: 'InstrumentSerif_400Regular',
  displayMedium: 'InstrumentSerif_400Regular',
  displayItalic: 'InstrumentSerif_400Regular_Italic',
  numeric: 'IBMPlexMono_500Medium',
  mono: 'IBMPlexMono_600SemiBold',
  body: 'Newsreader_400Regular',
  bodyMedium: 'Newsreader_500Medium',
  bodySemi: 'Newsreader_600SemiBold',
  bodyBold: 'Newsreader_700Bold',
}

const FALLBACK: Record<FontRole, TextStyle> = {
  display: { fontFamily: 'serif' },
  displayMedium: { fontFamily: 'serif' },
  displayItalic: { fontFamily: 'serif', fontStyle: 'italic' },
  numeric: { fontFamily: 'monospace', fontWeight: '500' },
  mono: { fontFamily: 'monospace', fontWeight: '600' },
  body: { fontFamily: 'serif' },
  bodyMedium: { fontFamily: 'serif', fontWeight: '500' },
  bodySemi: { fontFamily: 'serif', fontWeight: '600' },
  bodyBold: { fontFamily: 'serif', fontWeight: '700' },
}

/** Font style for a role. Falls back to system serif / monospace if custom fonts are unavailable. */
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
