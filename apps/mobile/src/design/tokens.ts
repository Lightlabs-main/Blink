/** Blink-to-Stock design tokens. One source for colour, type, radius and spacing. */
export const color = {
  bg: '#07080B',
  bgRaised: '#0C0E13',
  surface: '#111419',
  surface2: '#171B22',
  surface3: '#1E232C',
  border: '#232833',
  borderStrong: '#303646',

  text: '#F4F6F9',
  textDim: '#A7ADBB',
  textMuted: '#6C7385',

  lime: '#C6FF3D',
  limeSoft: 'rgba(198,255,61,0.12)',
  limeLine: 'rgba(198,255,61,0.35)',
  onLime: '#0B0E05',

  violet: '#8C6CFF',
  violetSoft: 'rgba(140,108,255,0.16)',

  success: '#35E39F',
  successSoft: 'rgba(53,227,159,0.14)',
  warning: '#FFB547',
  warningSoft: 'rgba(255,181,71,0.14)',
  danger: '#FF5C7A',
  dangerSoft: 'rgba(255,92,122,0.14)',
} as const

export const radius = { sm: 10, md: 14, lg: 20, xl: 28, pill: 999 } as const

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 28, huge: 40 } as const

/** Horizontal page gutter. */
export const gutter = 20

/** Height reserved at the bottom of tab screens for the floating tab bar. */
export const TAB_BAR_CLEARANCE = 112
