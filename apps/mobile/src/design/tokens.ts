import { Appearance } from 'react-native'

/**
 * Blink-to-Stock design tokens — "financial broadsheet" (same system as blinksol.site).
 * Newsprint paper and ink; lime is only a highlighter (`marker`). The legacy key names stay so every screen
 * follows: `lime` is now the ink accent and `onLime` the paper text on ink.
 *
 * Day or Night edition is chosen at launch from the system setting, like the website.
 */
export const isNight = Appearance.getColorScheme() === 'dark'

const day = {
  bg: '#F3EEE3',
  bgRaised: '#EFE9DC',
  surface: '#F7F3EA',
  surface2: '#EBE4D5',
  surface3: '#E0D7C5',
  border: 'rgba(20,18,16,0.16)',
  borderStrong: 'rgba(20,18,16,0.6)',

  text: '#141210',
  textDim: '#3A352E',
  textMuted: '#6F675B',

  lime: '#141210',
  limeSoft: 'rgba(198,255,61,0.55)',
  limeLine: '#141210',
  onLime: '#F3EEE3',

  marker: '#C6FF3D',
  onMarker: '#141210',

  violet: '#4B3C8C',
  violetSoft: 'rgba(75,60,140,0.12)',

  success: '#1F7A4D',
  successSoft: 'rgba(31,122,77,0.12)',
  warning: '#8A5A00',
  warningSoft: 'rgba(138,90,0,0.12)',
  danger: '#B3261E',
  dangerSoft: 'rgba(179,38,30,0.10)',
} as const

const night: { [K in keyof typeof day]: string } = {
  bg: '#151412',
  bgRaised: '#1A1916',
  surface: '#1D1B18',
  surface2: '#24221E',
  surface3: '#2E2B26',
  border: 'rgba(236,230,216,0.14)',
  borderStrong: 'rgba(236,230,216,0.55)',

  text: '#ECE6D8',
  textDim: '#BDB5A6',
  textMuted: '#8B8375',

  lime: '#ECE6D8',
  limeSoft: 'rgba(198,255,61,0.18)',
  limeLine: '#ECE6D8',
  onLime: '#151412',

  marker: '#C6FF3D',
  onMarker: '#141210',

  violet: '#A99BE6',
  violetSoft: 'rgba(169,155,230,0.14)',

  success: '#5FCF97',
  successSoft: 'rgba(95,207,151,0.14)',
  warning: '#E0B45A',
  warningSoft: 'rgba(224,180,90,0.14)',
  danger: '#FF7A6B',
  dangerSoft: 'rgba(255,122,107,0.14)',
}

export const color: { readonly [K in keyof typeof day]: string } = isNight ? night : day

/** Printed, not pill-shaped. */
export const radius = { sm: 4, md: 6, lg: 8, xl: 12, pill: 999 } as const

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 28, huge: 40 } as const

/** Horizontal page gutter. */
export const gutter = 20

/** Height reserved at the bottom of tab screens for the floating tab bar. */
export const TAB_BAR_CLEARANCE = 112
