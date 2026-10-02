import { usePrivy } from '@privy-io/expo'
import { Redirect, Tabs } from 'expo-router'

import { BlinkTabBar } from '../../design/tab-bar'
import { color } from '../../design/tokens'
import { Loading } from '../../design/ui'
import { usePushNotifications } from '../../lib/push'

export default function TabsLayout() {
  const { isReady, user } = usePrivy()
  usePushNotifications()
  if (!isReady) return <Loading />
  if (!user) return <Redirect href="/" />

  return (
    <Tabs
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: color.bg } }}
      tabBar={(props) => <BlinkTabBar {...props} />}
    >
      <Tabs.Screen name="home" />
      <Tabs.Screen name="drops" />
      <Tabs.Screen name="create" />
      <Tabs.Screen name="profile" />
    </Tabs>
  )
}
