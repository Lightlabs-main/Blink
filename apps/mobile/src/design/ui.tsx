import { ReactNode, useEffect, useState } from 'react'
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleProp,
  StyleSheet,
  Text,
  TextStyle,
  View,
  ViewStyle,
} from 'react-native'
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { haptics } from '../lib/haptics'
import { font } from './fonts'
import { Icon, type IconName } from './icons'
import { color, gutter, radius, space, TAB_BAR_CLEARANCE } from './tokens'

/* ───────────────────────────── Typography ───────────────────────────── */

export type TextVariant = 'hero' | 'display' | 'title' | 'heading' | 'body' | 'bodyStrong' | 'label' | 'caption' | 'overline' | 'numeric'

const VARIANT: Record<TextVariant, () => TextStyle> = {
  hero: () => ({ ...font('display'), fontSize: 42, lineHeight: 46, letterSpacing: -1.2, color: color.text }),
  display: () => ({ ...font('display'), fontSize: 32, lineHeight: 37, letterSpacing: -0.8, color: color.text }),
  title: () => ({ ...font('displayMedium'), fontSize: 23, lineHeight: 29, letterSpacing: -0.3, color: color.text }),
  heading: () => ({ ...font('bodySemi'), fontSize: 17, lineHeight: 22, letterSpacing: -0.1, color: color.text }),
  body: () => ({ ...font('body'), fontSize: 15.5, lineHeight: 23, color: color.textDim }),
  bodyStrong: () => ({ ...font('bodyMedium'), fontSize: 15.5, lineHeight: 22, color: color.text }),
  label: () => ({ ...font('body'), fontSize: 13.5, lineHeight: 19, color: color.textDim }),
  caption: () => ({ ...font('body'), fontSize: 12.5, lineHeight: 17, color: color.textMuted }),
  overline: () => ({ ...font('bodySemi'), fontSize: 12.5, lineHeight: 16, letterSpacing: 0.2, color: color.textMuted }),
  numeric: () => ({ ...font('numeric'), fontSize: 15, lineHeight: 20, color: color.text, fontVariant: ['tabular-nums'] }),
}

export function T({
  variant = 'body',
  color: c,
  align,
  numberOfLines,
  style,
  children,
}: {
  variant?: TextVariant
  color?: string
  align?: TextStyle['textAlign']
  numberOfLines?: number
  style?: StyleProp<TextStyle>
  children: ReactNode
}) {
  return (
    <Text numberOfLines={numberOfLines} style={[VARIANT[variant](), c ? { color: c } : null, align ? { textAlign: align } : null, style]}>
      {children}
    </Text>
  )
}

/* ───────────────────────────── Layout ───────────────────────────── */

/** No decorative glows (D-31: calm surfaces). Kept as a component so callers stay unchanged. */
export function Backdrop(_props: { tone?: 'mixed' | 'lime' | 'violet'; height?: number }) {
  return null
}

/** Page container: safe-area aware, gutter padding, optional tab-bar clearance and backdrop glow. */
export function Screen({
  children,
  scroll = true,
  tabBar = false,
  backdrop = true,
  refreshControl,
  contentStyle,
}: {
  children: ReactNode
  scroll?: boolean
  tabBar?: boolean
  backdrop?: boolean
  refreshControl?: React.ComponentProps<typeof ScrollView>['refreshControl']
  contentStyle?: StyleProp<ViewStyle>
}) {
  const insets = useSafeAreaInsets()
  const top = insets.top + space.lg
  const bottom = (tabBar ? TAB_BAR_CLEARANCE : space.xxl) + insets.bottom
  return (
    <View style={styles.page}>
      {backdrop ? <Backdrop /> : null}
      {scroll ? (
        <ScrollView
          contentContainerStyle={[{ paddingTop: top, paddingBottom: bottom, paddingHorizontal: gutter, gap: space.xl }, contentStyle]}
          keyboardShouldPersistTaps="handled"
          refreshControl={refreshControl}
          showsVerticalScrollIndicator={false}
        >
          {children}
        </ScrollView>
      ) : (
        <View style={[{ flex: 1, paddingTop: top, paddingBottom: bottom, paddingHorizontal: gutter }, contentStyle]}>{children}</View>
      )}
    </View>
  )
}

/** Top bar for pushed (non-tab) screens. */
export function NavBar({ title, onBack, right }: { title?: string; onBack?: () => void; right?: ReactNode }) {
  return (
    <View style={styles.navBar}>
      {onBack ? <IconButton icon="chevronLeft" label="Back" onPress={onBack} /> : <View style={{ width: 40 }} />}
      {title ? <T variant="heading">{title}</T> : <View />}
      {right ?? <View style={{ width: 40 }} />}
    </View>
  )
}

export function Row({ children, gap = space.md, style }: { children: ReactNode; gap?: number; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap }, style]}>{children}</View>
}

export function Spacer({ size = space.md }: { size?: number }) {
  return <View style={{ height: size }} />
}

export function Divider() {
  return <View style={{ height: 1, backgroundColor: color.border }} />
}

/** The Blink mark on its ink tile (the mark is cream + lime, so it always sits on ink, in both editions). */
export function BlinkLogo({ size = 32 }: { size?: number }) {
  return (
    <Image
      accessibilityLabel="Blink"
      source={require('../../assets/logo-tile.png')}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.22) }}
    />
  )
}

/** The logo's lime dot, used as a small accent (active tab, hero cards, live states). */
export function LimeDot({ size = 8, style }: { size?: number; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ width: size, height: size, borderRadius: size / 2, backgroundColor: color.marker }, style]} />
}

/** Section separator (kept for callers of the former masthead rule). */
export function DoubleRule() {
  return <View style={{ height: 1, backgroundColor: color.border }} />
}

/* ───────────────────────────── Surfaces ───────────────────────────── */

export function Card({ children, style, padded = true, tone = 'default' }: { children: ReactNode; style?: StyleProp<ViewStyle>; padded?: boolean; tone?: 'default' | 'raised' | 'lime' | 'danger' }) {
  const toneStyle =
    tone === 'lime'
      ? { backgroundColor: color.limeSoft, borderColor: color.limeLine }
      : tone === 'danger'
        ? { backgroundColor: color.dangerSoft, borderColor: color.danger }
        : tone === 'raised'
          ? { backgroundColor: color.surface2 }
          : null
  return <View style={[styles.card, padded && { padding: space.lg }, toneStyle, style]}>{children}</View>
}

/** Hero card: a raised, softly rounded surface marked with the logo's lime dot. */
export function GlowCard({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.hero, style]}>
      <LimeDot size={10} style={styles.heroDot} />
      {children}
    </View>
  )
}

/* ───────────────────────────── Controls ───────────────────────────── */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

const AnimatedPressable = Animated.createAnimatedComponent(Pressable)

function usePressScale() {
  const scale = useSharedValue(1)
  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.get() }] }))
  return {
    style,
    onPressIn: () => scale.set(withSpring(0.97, { damping: 18, stiffness: 400 })),
    onPressOut: () => scale.set(withSpring(1, { damping: 18, stiffness: 400 })),
  }
}

export function Button({
  children,
  onPress,
  variant = 'primary',
  size = 'lg',
  icon,
  iconRight,
  disabled,
  loading,
  style,
}: {
  children: string
  onPress: () => void
  variant?: ButtonVariant
  size?: 'lg' | 'md' | 'sm'
  icon?: IconName
  iconRight?: IconName
  disabled?: boolean
  loading?: boolean
  style?: StyleProp<ViewStyle>
}) {
  const press = usePressScale()
  const v = BUTTON[variant]
  const h = size === 'lg' ? 54 : size === 'md' ? 44 : 34
  const inactive = disabled || loading
  return (
    <View style={[{ height: h }, style]}>
      <AnimatedPressable
        accessibilityRole="button"
        accessibilityState={{ disabled: inactive, busy: loading }}
        disabled={inactive}
        onPress={() => {
          haptics.tap()
          onPress()
        }}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        style={[styles.button, { height: h, backgroundColor: v.bg, borderColor: v.border, opacity: inactive ? 0.45 : 1 }, press.style]}
      >
        {loading ? (
          <ActivityIndicator color={v.fg} />
        ) : (
          <>
            {icon ? <Icon name={icon} size={size === 'sm' ? 15 : 18} stroke={v.fg} strokeWidth={2} /> : null}
            <T style={{ ...font('bodySemi'), fontSize: size === 'sm' ? 13.5 : 15.5, color: v.fg }}>{children}</T>
            {iconRight ? <Icon name={iconRight} size={size === 'sm' ? 15 : 17} stroke={v.fg} strokeWidth={2} /> : null}
          </>
        )}
      </AnimatedPressable>
    </View>
  )
}

const BUTTON: Record<ButtonVariant, { bg: string; fg: string; border: string }> = {
  primary: { bg: color.primary, fg: color.onPrimary, border: color.primary },
  secondary: { bg: color.surface2, fg: color.text, border: color.border },
  ghost: { bg: 'transparent', fg: color.textDim, border: 'transparent' },
  danger: { bg: color.dangerSoft, fg: color.danger, border: 'transparent' },
}

export function IconButton({ icon, onPress, label, tone = 'default', size = 40 }: { icon: IconName; onPress: () => void; label: string; tone?: 'default' | 'lime'; size?: number }) {
  const press = usePressScale()
  return (
    <AnimatedPressable
      accessibilityLabel={label}
      accessibilityRole="button"
      hitSlop={8}
      onPress={() => {
        haptics.tap()
        onPress()
      }}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
      style={[
        styles.iconButton,
        { width: size, height: size, borderRadius: size / 2 },
        tone === 'lime' ? { backgroundColor: color.marker, borderColor: color.marker } : null,
        press.style,
      ]}
    >
      <Icon name={icon} size={size * 0.48} stroke={tone === 'lime' ? color.onMarker : color.text} strokeWidth={2} />
    </AnimatedPressable>
  )
}

/** Round quick-action tile with icon + label (dashboard). */
export function QuickAction({ icon, label, onPress, highlight }: { icon: IconName; label: string; onPress: () => void; highlight?: boolean }) {
  const press = usePressScale()
  return (
    <AnimatedPressable
      accessibilityRole="button"
      onPress={() => {
        haptics.tap()
        onPress()
      }}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
      style={[{ flex: 1, alignItems: 'center', gap: space.sm }, press.style]}
    >
      <View style={[styles.quickIcon, highlight && { backgroundColor: color.marker, borderColor: color.marker }]}>
        <Icon name={icon} size={22} stroke={highlight ? color.onMarker : color.text} strokeWidth={2} />
      </View>
      <T variant="label" style={{ color: color.text }}>
        {label}
      </T>
    </AnimatedPressable>
  )
}

export function Chip({ label, selected, onPress, icon }: { label: string; selected: boolean; onPress: () => void; icon?: IconName }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={() => {
        haptics.tap()
        onPress()
      }}
      style={[styles.chip, selected && { backgroundColor: color.primary, borderColor: color.primary }]}
    >
      {icon ? <Icon name={icon} size={15} stroke={selected ? color.onPrimary : color.textDim} /> : null}
      <T style={{ ...font('bodyMedium'), fontSize: 13.5, color: selected ? color.onPrimary : color.textDim }}>{label}</T>
    </Pressable>
  )
}

/* ───────────────────────────── Status ───────────────────────────── */

type BadgeTone = 'live' | 'warn' | 'neutral' | 'test' | 'danger'

const BADGE: Record<BadgeTone, { bg: string; fg: string }> = {
  live: { bg: color.successSoft, fg: color.success },
  warn: { bg: color.warningSoft, fg: color.warning },
  neutral: { bg: color.surface3, fg: color.textDim },
  test: { bg: color.violetSoft, fg: color.violet },
  danger: { bg: color.dangerSoft, fg: color.danger },
}

export function Badge({ label, tone = 'neutral', dot }: { label: string; tone?: BadgeTone; dot?: boolean }) {
  const b = BADGE[tone]
  return (
    <View style={[styles.badge, { backgroundColor: b.bg }]}>
      {dot ? <PulseDot color={b.fg} /> : null}
      <T style={{ ...font('bodySemi'), fontSize: 11.5, letterSpacing: 0.1, color: b.fg }}>{label}</T>
    </View>
  )
}

export function PulseDot({ color: c = color.success }: { color?: string }) {
  const o = useSharedValue(1)
  useEffect(() => {
    o.set(withRepeat(withSequence(withTiming(0.25, { duration: 900 }), withTiming(1, { duration: 900 })), -1))
  }, [o])
  const style = useAnimatedStyle(() => ({ opacity: o.get() }))
  return <Animated.View style={[{ width: 6, height: 6, borderRadius: 3, backgroundColor: c }, style]} />
}

export function Skeleton({ height = 16, width = '100%', radius: r = radius.sm, style }: { height?: number; width?: number | `${number}%`; radius?: number; style?: StyleProp<ViewStyle> }) {
  const o = useSharedValue(0.45)
  useEffect(() => {
    o.set(withRepeat(withTiming(0.9, { duration: 800, easing: Easing.inOut(Easing.quad) }), -1, true))
  }, [o])
  const anim = useAnimatedStyle(() => ({ opacity: o.get() }))
  return <Animated.View style={[{ height, width, borderRadius: r, backgroundColor: color.surface3 }, anim, style]} />
}

export function Notice({ message, tone = 'danger' }: { message: string | null | undefined; tone?: 'danger' | 'warn' | 'info' }) {
  if (!message) return null
  const c = tone === 'danger' ? color.danger : tone === 'warn' ? color.warning : color.textDim
  const bg = tone === 'danger' ? color.dangerSoft : tone === 'warn' ? color.warningSoft : color.surface2
  return (
    <View style={[styles.notice, { backgroundColor: bg }]}>
      <T style={{ ...font('bodyMedium'), fontSize: 14, lineHeight: 20, color: c }}>{message}</T>
    </View>
  )
}

/* ───────────────────────────── Content ───────────────────────────── */

export function SectionHeader({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  return (
    <Row style={{ justifyContent: 'space-between' }}>
      <T variant="heading">{title}</T>
      {action && onAction ? (
        <Pressable accessibilityRole="button" hitSlop={10} onPress={onAction}>
          <Row gap={4}>
            <T variant="label" color={color.lime}>
              {action}
            </T>
            <Icon name="chevronRight" size={16} stroke={color.lime} />
          </Row>
        </Pressable>
      ) : null}
    </Row>
  )
}

export function EmptyState({ icon, title, body, action, onAction }: { icon: IconName; title: string; body: string; action?: string; onAction?: () => void }) {
  return (
    <Card style={{ alignItems: 'center', paddingVertical: space.xxl, gap: space.md }}>
      <View style={styles.emptyIcon}>
        <Icon name={icon} size={24} stroke={color.lime} />
      </View>
      <T variant="heading" align="center">
        {title}
      </T>
      <T align="center" style={{ maxWidth: 280 }}>
        {body}
      </T>
      {action && onAction ? <Button onPress={onAction} size="md" style={{ marginTop: space.sm, paddingHorizontal: space.xxl }} variant="secondary">{action}</Button> : null}
    </Card>
  )
}

export function ListRow({
  leading,
  title,
  subtitle,
  trailing,
  onPress,
  chevron = Boolean(onPress),
}: {
  leading?: ReactNode
  title: string
  subtitle?: string
  trailing?: ReactNode
  onPress?: () => void
  chevron?: boolean
}) {
  const content = (
    <Row style={{ paddingVertical: space.md }}>
      {leading}
      <View style={{ flex: 1, gap: 2 }}>
        <T variant="bodyStrong" numberOfLines={1}>
          {title}
        </T>
        {subtitle ? (
          <T variant="caption" numberOfLines={1}>
            {subtitle}
          </T>
        ) : null}
      </View>
      {trailing}
      {chevron ? <Icon name="chevronRight" size={18} stroke={color.textMuted} /> : null}
    </Row>
  )
  if (!onPress) return content
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => {
        haptics.tap()
        onPress()
      }}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      {content}
    </Pressable>
  )
}

/** Stock logo (official xStock artwork) with a monogram fallback for assets without one (e.g. devnet test stock). */
export function StockAvatar({ symbol, logo, size = 40, isTest }: { symbol: string; logo?: string | null; size?: number; isTest?: boolean }) {
  const [failed, setFailed] = useState(false)
  const showImage = Boolean(logo) && !failed
  return (
    <View style={{ width: size, height: size }}>
      {showImage ? (
        <Image onError={() => setFailed(true)} source={{ uri: logo! }} style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color.surface3 }} />
      ) : (
        <View style={[styles.monogram, { width: size, height: size, borderRadius: size / 2 }]}>
          <T style={{ ...font('displayMedium'), fontSize: size * 0.38, color: color.text }}>{symbol.replace(/^t/, '').slice(0, 2).toUpperCase()}</T>
        </View>
      )}
      {isTest ? (
        <View style={styles.testTag}>
          <T style={{ ...font('bodyBold'), fontSize: 7.5, color: color.bg }}>TEST</T>
        </View>
      ) : null}
    </View>
  )
}

/** Horizontal progress stepper (e.g. Draft → Funded → Live). */
export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <Row gap={0}>
      {steps.map((s, i) => {
        const done = i < current
        const active = i === current
        return (
          <View key={s} style={{ flex: 1, alignItems: 'center', gap: space.sm }}>
            <Row gap={0} style={{ width: '100%' }}>
              <View style={[styles.stepLine, { opacity: i === 0 ? 0 : 1, backgroundColor: done || active ? color.text : color.border }]} />
              <View style={[styles.stepDot, done && { backgroundColor: color.marker, borderColor: color.marker }, active && { borderColor: color.marker }]}>
                {done ? <Icon name="check" size={12} stroke={color.onMarker} strokeWidth={3} /> : null}
              </View>
              <View style={[styles.stepLine, { opacity: i === steps.length - 1 ? 0 : 1, backgroundColor: done ? color.text : color.border }]} />
            </Row>
            <T variant="caption" color={done || active ? color.text : color.textMuted}>
              {s}
            </T>
          </View>
        )
      })}
    </Row>
  )
}

export function Avatar({ label, size = 40 }: { label: string; size?: number }) {
  return (
    <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2 }]}>
      <T style={{ ...font('displayMedium'), fontSize: size * 0.42, color: color.text }}>{label.slice(0, 1).toUpperCase()}</T>
    </View>
  )
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <View style={[styles.page, { alignItems: 'center', justifyContent: 'center', gap: space.md }]}>
      <ActivityIndicator color={color.text} />
      <T variant="label">{label}</T>
    </View>
  )
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.bg },
  navBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  card: { backgroundColor: color.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: color.border },
  hero: { backgroundColor: color.surface2, borderRadius: radius.xl, padding: space.xl, borderWidth: 1, borderColor: color.border, overflow: 'hidden' },
  heroDot: { position: 'absolute', top: space.lg, right: space.lg },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    paddingHorizontal: space.xl,
  },
  iconButton: { alignItems: 'center', justifyContent: 'center', backgroundColor: color.surface2, borderWidth: 1, borderColor: color.border },
  quickIcon: {
    width: 58,
    height: 58,
    borderRadius: 29,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.surface2,
    borderWidth: 1,
    borderColor: color.border,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.surface2,
  },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill },
  notice: { borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 12 },
  emptyIcon: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', backgroundColor: color.limeSoft },
  monogram: { alignItems: 'center', justifyContent: 'center', backgroundColor: color.surface3 },
  testTag: { position: 'absolute', bottom: -3, right: -6, backgroundColor: color.text, borderRadius: radius.pill, paddingHorizontal: 4, paddingVertical: 1 },
  stepLine: { flex: 1, height: 2 },
  stepDot: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: color.border, backgroundColor: color.bg, alignItems: 'center', justifyContent: 'center' },
  avatar: { alignItems: 'center', justifyContent: 'center', backgroundColor: color.surface3, borderWidth: 1, borderColor: color.border },
})
