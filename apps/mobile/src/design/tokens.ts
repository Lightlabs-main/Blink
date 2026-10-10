import * as SecureStore from 'expo-secure-store'
import { Appearance } from 'react-native'

/**
 * Blink design tokens — built from the Blink logo (D-31): ink black, cream and the logo's lime dot.
 * Soft, rounded shapes like the mark; lime is an accent (dots, the Scan button, highlights), never a wash.
 * Legacy key names stay so every screen follows: `lime` is the accent for icons/text (darkened in Day so it
 * stays readable), `marker` is the pure brand lime for fills, `primary` is the main button.
 *
 * Night (ink) or Day (cream) is chosen at launch: the person's choice in You → Appearance, else the system setting.
 */
/** The person's choice in You → Appearance; 'system' follows the phone. Read synchronously so the first frame is right. */
export type AppearancePref = 'system' | 'light' | 'dark'
const APPEARANCE_KEY = 'blink.appearance'

function readAppearancePref(): AppearancePref {
  try {
    const v = SecureStore.getItem(APPEARANCE_KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    return 'system'
  }
}

export const appearancePref: AppearancePref = readAppearancePref()
// Native parts (keyboard, system dialogs) follow the same choice.
if (appearancePref !== 'system') Appearance.setColorScheme(appearancePref)

export const isNight = appearancePref === 'system' ? Appearance.getColorScheme() !== 'light' : appearancePref === 'dark'

/** Saves the choice; colours apply the next time Blink opens (every screen reads them at launch). */
export function setAppearancePref(pref: AppearancePref) {
  SecureStore.setItem(APPEARANCE_KEY, pref)
}

const night = {
  bg: '#0D0D0B',
  bgRaised: '#121210',
  surface: '#171714',
  surface2: '#1F1F1B',
  surface3: '#2A2A25',
  border: 'rgba(244,240,230,0.08)',
  borderStrong: 'rgba(244,240,230,0.2)',

  text: '#F4F0E6',
  textDim: '#C3BEB2',
  textMuted: '#8C887E',

  lime: '#B5F23A',
  limeSoft: 'rgba(171,255,26,0.12)',
  limeLine: 'rgba(171,255,26,0.38)',
  onLime: '#0D0D0B',

  marker: '#ABFF1A',
  onMarker: '#0D0D0B',

  primary: '#F4F0E6',
  onPrimary: '#0D0D0B',

  violet: '#B9A6FF',
  violetSoft: 'rgba(185,166,255,0.14)',

  success: '#5FD39B',
  successSoft: 'rgba(95,211,155,0.14)',
  warning: '#F2B655',
  warningSoft: 'rgba(242,182,85,0.14)',
  danger: '#FF7A6B',
  dangerSoft: 'rgba(255,122,107,0.13)',

  /** D-45: OG name colour (all three marks) and the per-mark tints. */
  og: '#F5C451',
  ogOre: '#F0A35E',
  ogSeeker: '#ABFF1A',
  ogSkr: '#B9A6FF',
} as const

const day: { [K in keyof typeof night]: string } = {
  bg: '#F5F2EA',
  bgRaised: '#FAF8F3',
  surface: '#FFFFFF',
  surface2: '#EFEBE1',
  surface3: '#E5E0D4',
  border: 'rgba(13,13,11,0.08)',
  borderStrong: 'rgba(13,13,11,0.2)',

  text: '#0D0D0B',
  textDim: '#47443D',
  textMuted: '#7B776D',

  lime: '#4D7C00',
  limeSoft: 'rgba(171,255,26,0.28)',
  limeLine: 'rgba(77,124,0,0.4)',
  onLime: '#FFFFFF',

  marker: '#ABFF1A',
  onMarker: '#0D0D0B',

  primary: '#0D0D0B',
  onPrimary: '#F5F2EA',

  violet: '#5B48B0',
  violetSoft: 'rgba(91,72,176,0.12)',

  success: '#1D7F50',
  successSoft: 'rgba(29,127,80,0.12)',
  warning: '#9A6200',
  warningSoft: 'rgba(154,98,0,0.12)',
  danger: '#C23A2C',
  dangerSoft: 'rgba(194,58,44,0.1)',

  /** D-45: OG name colour (all three marks) and the per-mark tints. */
  og: '#9A6A00',
  ogOre: '#B5651D',
  ogSeeker: '#4D7C00',
  ogSkr: '#6B4FD8',
}

export const color: { readonly [K in keyof typeof night]: string } = isNight ? night : day

/** Soft and rounded, like the mark. */
export const radius = { sm: 10, md: 14, lg: 20, xl: 28, pill: 999 } as const

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 28, huge: 40 } as const

/** Horizontal page gutter. */
export const gutter = 20

/** Height reserved at the bottom of tab screens for the floating tab bar. */
export const TAB_BAR_CLEARANCE = 112
