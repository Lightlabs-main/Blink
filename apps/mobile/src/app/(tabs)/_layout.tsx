import { usePrivy } from '@privy-io/expo'
import { Redirect, Tabs } from 'expo-router'
import { Text } from 'react-native'

import { haptics } from '../../lib/haptics'
import { Loading } from '../../ui/screen'

function TabIcon({ glyph, focused }: { glyph: string; focused: boolean }) {
  return <Text style={{ fontSize: 18, color: focused ? '#6ee7b7' : '#71717a' }}>{glyph}</Text>
}

export default function TabsLayout() {
  const { isReady, user } = usePrivy()
  if (!isReady) return <Loading />
  if (!user) return <Redirect href="/" />

  return (
    <Tabs
      screenListeners={{ tabPress: () => haptics.tap() }}
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: '#6ee7b7',
        tabBarInactiveTintColor: '#71717a',
        tabBarStyle: { backgroundColor: '#09090b', borderTopColor: '#27272a' },
      }}
    >
      <Tabs.Screen name="drops" options={{ title: 'Drops', tabBarIcon: ({ focused }) => <TabIcon focused={focused} glyph="⚡" /> }} />
      <Tabs.Screen name="create" options={{ title: 'Create', tabBarIcon: ({ focused }) => <TabIcon focused={focused} glyph="＋" /> }} />
      <Tabs.Screen name="profile" options={{ title: 'Profile', tabBarIcon: ({ focused }) => <TabIcon focused={focused} glyph="◉" /> }} />
    </Tabs>
  )
}
