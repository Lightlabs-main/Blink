import { Button } from 'heroui-native/button'
import { Card } from 'heroui-native/card'
import { ReactNode } from 'react'
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

/** Status-bar/notch spacer. A real View is used because className and style padding don't merge reliably. */
export function TopInset({ extra = 20 }: { extra?: number }) {
  const insets = useSafeAreaInsets()
  return <View style={{ height: insets.top + extra }} />
}

function BottomInset() {
  const insets = useSafeAreaInsets()
  return <View style={{ height: insets.bottom + 24 }} />
}

/** Screen container that respects the notch/status bar and gesture bar on every device. */
export function Screen({ children, scroll = true }: { children: ReactNode; scroll?: boolean }) {
  if (!scroll) {
    return (
      <View className="flex-1 bg-zinc-950 px-5">
        <TopInset />
        <View className="flex-1">{children}</View>
        <BottomInset />
      </View>
    )
  }
  return (
    <ScrollView className="flex-1 bg-zinc-950" contentContainerClassName="gap-5 px-5" keyboardShouldPersistTaps="handled">
      <TopInset extra={0} />
      {children}
      <BottomInset />
    </ScrollView>
  )
}

export function Title({ children, kicker }: { children: ReactNode; kicker?: string }) {
  return (
    <View className="gap-2">
      {kicker ? <Text className="text-xs font-bold uppercase tracking-widest text-emerald-300">{kicker}</Text> : null}
      <Text className="text-4xl font-extrabold text-white">{children}</Text>
    </View>
  )
}

export function Muted({ children }: { children: ReactNode }) {
  return <Text className="text-base leading-6 text-zinc-400">{children}</Text>
}

export function Panel({ children }: { children: ReactNode }) {
  return (
    <Card className="border border-zinc-800 bg-zinc-900">
      <Card.Body className="gap-3">{children}</Card.Body>
    </Card>
  )
}

export function PrimaryButton({
  children,
  onPress,
  disabled,
  loading,
  variant = 'primary',
}: {
  children: string
  onPress: () => void
  disabled?: boolean
  loading?: boolean
  variant?: 'primary' | 'secondary' | 'danger'
}) {
  return (
    <Button className="w-full" isDisabled={disabled || loading} onPress={onPress} variant={variant}>
      {loading ? 'Please wait…' : children}
    </Button>
  )
}

export function ErrorNote({ message }: { message: string | null | undefined }) {
  if (!message) return null
  return <Text className="rounded-lg bg-red-900/70 px-3 py-2 text-sm text-red-100">{message}</Text>
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <View className="flex-1 items-center justify-center gap-3 bg-zinc-950">
      <ActivityIndicator color="#6ee7b7" />
      <Text className="text-zinc-400">{label}</Text>
    </View>
  )
}

export function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      className={`rounded-full border px-4 py-2 ${selected ? 'border-emerald-400 bg-emerald-400/15' : 'border-zinc-700 bg-zinc-900'}`}
      onPress={onPress}
    >
      <Text className={selected ? 'font-semibold text-emerald-200' : 'text-zinc-300'}>{label}</Text>
    </Pressable>
  )
}

export function Badge({ label, tone = 'default' }: { label: string; tone?: 'default' | 'live' | 'warn' }) {
  const cls =
    tone === 'live' ? 'bg-emerald-400/15 text-emerald-300' : tone === 'warn' ? 'bg-amber-400/15 text-amber-200' : 'bg-zinc-800 text-zinc-300'
  return <Text className={`self-start rounded-full px-3 py-1 text-xs font-bold uppercase ${cls}`}>{label}</Text>
}
