import Svg, { Circle, Path, Rect } from 'react-native-svg'

import { color } from './tokens'

export type IconName =
  | 'home'
  | 'bolt'
  | 'scan'
  | 'plus'
  | 'user'
  | 'share'
  | 'arrowRight'
  | 'arrowUpRight'
  | 'check'
  | 'chevronRight'
  | 'chevronLeft'
  | 'wallet'
  | 'gift'
  | 'target'
  | 'clock'
  | 'users'
  | 'phone'
  | 'mail'
  | 'logout'
  | 'shield'
  | 'sparkle'
  | 'refresh'
  | 'close'
  | 'lock'
  | 'layers'
  | 'search'
  | 'chat'
  | 'trophy'
  | 'send'
  | 'reply'
  | 'trash'

/** Minimal stroke icon set drawn with react-native-svg (no icon font or extra native module required). */
export function Icon({ name, size = 22, stroke = color.text, strokeWidth = 1.8 }: { name: IconName; size?: number; stroke?: string; strokeWidth?: number }) {
  const p: P = { stroke, strokeWidth, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  return (
    <Svg height={size} viewBox="0 0 24 24" width={size}>
      {ICONS[name](p)}
    </Svg>
  )
}

type P = { stroke: string; strokeWidth: number; fill: 'none'; strokeLinecap: 'round'; strokeLinejoin: 'round' }

const ICONS: Record<IconName, (p: P) => React.ReactNode> = {
  home: (p) => <Path d="M3.5 10.5 12 3.5l8.5 7V20a1 1 0 0 1-1 1H15v-6H9v6H4.5a1 1 0 0 1-1-1z" {...p} />,
  bolt: (p) => <Path d="M13 2.5 4.5 13.5H11l-1 8 8.5-11H12z" {...p} />,
  scan: (p) => <Path d="M4 8.5V5.5A1.5 1.5 0 0 1 5.5 4h3M15.5 4h3A1.5 1.5 0 0 1 20 5.5v3M20 15.5v3a1.5 1.5 0 0 1-1.5 1.5h-3M8.5 20h-3A1.5 1.5 0 0 1 4 18.5v-3M4 12h16" {...p} />,
  plus: (p) => <Path d="M12 5v14M5 12h14" {...p} />,
  user: (p) => (
    <>
      <Circle cx={12} cy={8} r={4} {...p} />
      <Path d="M4 21a8 8 0 0 1 16 0" {...p} />
    </>
  ),
  share: (p) => <Path d="M12 3.5v11M7.5 8 12 3.5 16.5 8M5 13.5V19a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5.5" {...p} />,
  arrowRight: (p) => <Path d="M5 12h14M13 6l6 6-6 6" {...p} />,
  arrowUpRight: (p) => <Path d="M7 17 17 7M8.5 7H17v8.5" {...p} />,
  check: (p) => <Path d="M5 12.5 9.5 17 19 7.5" {...p} />,
  chevronRight: (p) => <Path d="M9.5 6 15.5 12l-6 6" {...p} />,
  chevronLeft: (p) => <Path d="M14.5 6 8.5 12l6 6" {...p} />,
  wallet: (p) => (
    <>
      <Path d="M19 8V5.5A1.5 1.5 0 0 0 17.5 4H5.5A2.5 2.5 0 0 0 3 6.5v11A2.5 2.5 0 0 0 5.5 20H20a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1H5.5A2.5 2.5 0 0 1 3 5.5" {...p} />
      <Circle cx={16.5} cy={14} r={1.2} {...p} />
    </>
  ),
  gift: (p) => <Path d="M4 11.5h16V20a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zM3 7.5h18v4H3zM12 7.5V21M12 7.5S10.5 3 8 3.8 7.2 7.5 12 7.5zM12 7.5s1.5-4.5 4-3.7.8 3.7-4 3.7z" {...p} />,
  target: (p) => (
    <>
      <Circle cx={12} cy={12} r={9} {...p} />
      <Circle cx={12} cy={12} r={5} {...p} />
      <Circle cx={12} cy={12} r={1.3} {...p} />
    </>
  ),
  clock: (p) => (
    <>
      <Circle cx={12} cy={12} r={9} {...p} />
      <Path d="M12 7v5l3.2 2" {...p} />
    </>
  ),
  users: (p) => (
    <>
      <Circle cx={9} cy={8} r={3.5} {...p} />
      <Path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.3A6.5 6.5 0 0 1 21.5 20" {...p} />
    </>
  ),
  phone: (p) => (
    <>
      <Rect height={19} rx={2.5} width={11} x={6.5} y={2.5} {...p} />
      <Path d="M11 18h2" {...p} />
    </>
  ),
  mail: (p) => (
    <>
      <Rect height={14} rx={2} width={18} x={3} y={5} {...p} />
      <Path d="m3.5 7 8.5 6 8.5-6" {...p} />
    </>
  ),
  logout: (p) => <Path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16.5 5.5 12 10 7.5M5.5 12H15" {...p} />,
  shield: (p) => <Path d="M12 3 19.5 6v6c0 4.8-3.3 8-7.5 9-4.2-1-7.5-4.2-7.5-9V6zM8.8 12l2.2 2.2 4.2-4.4" {...p} />,
  sparkle: (p) => <Path d="M12 3.5c.6 4.2 2.3 5.9 6.5 6.5-4.2.6-5.9 2.3-6.5 6.5-.6-4.2-2.3-5.9-6.5-6.5 4.2-.6 5.9-2.3 6.5-6.5zM18.5 16l.6 2 1.9.6-1.9.6-.6 1.9-.6-1.9-2-.6 2-.6z" {...p} />,
  refresh: (p) => <Path d="M20 12a8 8 0 1 1-2.4-5.7M20 4v5h-5" {...p} />,
  close: (p) => <Path d="M6 6l12 12M18 6 6 18" {...p} />,
  lock: (p) => (
    <>
      <Rect height={10} rx={2} width={14} x={5} y={11} {...p} />
      <Path d="M8 11V7.5a4 4 0 0 1 8 0V11" {...p} />
    </>
  ),
  layers: (p) => <Path d="M12 3 21 8l-9 5-9-5zM3 12.5l9 5 9-5M3 16.5l9 5 9-5" {...p} />,
  search: (p) => (
    <>
      <Circle cx={11} cy={11} r={6.5} {...p} />
      <Path d="m16 16 4.5 4.5" {...p} />
    </>
  ),
  chat: (p) => <Path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 4v-4h0A1.5 1.5 0 0 1 4 14.5z" {...p} />,
  trophy: (p) => <Path d="M8 4h8v5a4 4 0 0 1-8 0zM8 6H4.5v1.5A3.5 3.5 0 0 0 8 11M16 6h3.5v1.5A3.5 3.5 0 0 1 16 11M12 13v4M8.5 20.5h7M10 17h4" {...p} />,
  send: (p) => <Path d="M4 12 20 4l-4.5 16-3.5-6.5zM12 13.5 20 4" {...p} />,
  reply: (p) => <Path d="M9.5 6 4 11.5 9.5 17M4 11.5h10a6 6 0 0 1 6 6V19" {...p} />,
  trash: (p) => <Path d="M4.5 6.5h15M9.5 6.5V4.5h5v2M6.5 6.5l1 13a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1l1-13" {...p} />,
}
