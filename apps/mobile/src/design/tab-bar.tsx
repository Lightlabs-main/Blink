import type { BottomTabBarProps } from 'expo-router/tabs'
import { useRouter } from 'expo-router'
import { Pressable, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { haptics } from '../lib/haptics'
import { font } from './fonts'
import { Icon, type IconName } from './icons'
import { color, isNight, radius } from './tokens'
import { T } from './ui'

const TAB_ICON: Record<string, { icon: IconName; label: string }> = {
  home: { icon: 'home', label: 'Home' },
  drops: { icon: 'bolt', label: 'Drops' },
  create: { icon: 'plus', label: 'Create' },
  profile: { icon: 'user', label: 'You' },
}

/** Floating tab bar with a raised Scan action in the middle (Scan is a screen, not a tab). */
export function BlinkTabBar({ state, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const routes = state.routes.filter((r) => TAB_ICON[r.name])
  const left = routes.slice(0, 2)
  const right = routes.slice(2)

  function renderTab(route: (typeof routes)[number]) {
    const index = state.routes.indexOf(route)
    const focused = state.index === index
    const meta = TAB_ICON[route.name]!
    return (
      <Pressable
        accessibilityLabel={meta.label}
        accessibilityRole="tab"
        accessibilityState={{ selected: focused }}
        key={route.key}
        onPress={() => {
          const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true })
          if (!focused && !event.defaultPrevented) {
            haptics.tap()
            navigation.navigate(route.name)
          }
        }}
        style={styles.tab}
      >
        <Icon name={meta.icon} size={22} stroke={focused ? color.text : color.textMuted} strokeWidth={focused ? 2.2 : 1.8} />
        <T style={{ ...font(focused ? 'bodySemi' : 'bodyMedium'), fontSize: 11, color: focused ? color.text : color.textMuted }}>{meta.label}</T>
        <View style={[styles.activeDot, { opacity: focused ? 1 : 0 }]} />
      </Pressable>
    )
  }

  return (
    <View pointerEvents="box-none" style={[styles.wrap, { paddingBottom: Math.max(insets.bottom, 12) }]}>
      <View style={styles.bar}>
        {left.map(renderTab)}
        <View style={styles.centerSlot}>
          <Pressable
            accessibilityLabel="Scan a Blink QR code"
            accessibilityRole="button"
            onPress={() => {
              haptics.tap()
              router.push('/scan')
            }}
            style={({ pressed }) => [styles.scan, pressed && { transform: [{ scale: 0.94 }] }]}
          >
            <Icon name="scan" size={26} stroke={color.onMarker} strokeWidth={2.2} />
          </Pressable>
        </View>
        {right.map(renderTab)}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 16 },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 70,
    borderRadius: radius.xl,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.border,
    paddingHorizontal: 6,
    shadowColor: '#000',
    shadowOpacity: isNight ? 0.4 : 0.08,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 10,
  },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3, height: '100%', paddingTop: 4 },
  activeDot: { width: 5, height: 5, borderRadius: 2.5, backgroundColor: color.marker },
  centerSlot: { width: 76, alignItems: 'center' },
  scan: {
    width: 60,
    height: 60,
    borderRadius: 30,
    marginTop: -30,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.marker,
    borderWidth: 4,
    borderColor: color.bg,
  },
})
