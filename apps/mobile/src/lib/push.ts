// D-24: push notifications (reward received, invite bonus, your drop is live). Best-effort: builds without the native
// module, a missing Firebase config or a denied permission simply mean no notifications, never a crash.
import { usePrivy } from '@privy-io/expo'
import Constants from 'expo-constants'
import { type Href, useRouter } from 'expo-router'
import { useEffect } from 'react'
import { Platform } from 'react-native'

import { api, type GetAccessToken } from './api'
import { hasNativeModule } from './native'

type NotificationsModule = typeof import('expo-notifications')

let mod: NotificationsModule | null | undefined
let registeredToken: string | null = null

function load(): NotificationsModule | null {
  if (mod !== undefined) return mod
  if (!hasNativeModule('ExpoPushTokenManager')) {
    mod = null
    return mod
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('expo-notifications') as NotificationsModule
    mod.setNotificationHandler({
      handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
    })
  } catch {
    mod = null
  }
  return mod
}

export type PushState = 'unsupported' | 'denied' | 'enabled' | 'unavailable'

/** Asks for permission (Android 13+ shows the system prompt once), gets the Expo token and gives it to Blink. */
export async function registerForPush(getAccessToken: GetAccessToken): Promise<PushState> {
  const n = load()
  if (!n || (Platform.OS !== 'android' && Platform.OS !== 'ios')) return 'unsupported'
  try {
    if (Platform.OS === 'android') {
      await n.setNotificationChannelAsync('default', { name: 'Rewards and drops', importance: n.AndroidImportance.HIGH })
    }
    let { status } = await n.getPermissionsAsync()
    if (status !== 'granted') status = (await n.requestPermissionsAsync()).status
    if (status !== 'granted') return 'denied'
    const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId
    const { data: token } = await n.getExpoPushTokenAsync(projectId ? { projectId } : undefined)
    await api.savePushToken(getAccessToken, token, Platform.OS)
    registeredToken = token
    return 'enabled'
  } catch {
    // e.g. no Firebase config in this build, or offline.
    return 'unavailable'
  }
}

/** Call before signing out so this device stops receiving the account's notifications. */
export async function unregisterPush(getAccessToken: GetAccessToken) {
  if (!registeredToken) return
  const token = registeredToken
  registeredToken = null
  await api.deletePushToken(getAccessToken, token).catch(() => {})
}

/** Only in-app routes are followed from a notification. */
function safeRoute(url: unknown): Href | null {
  return typeof url === 'string' && /^\/[A-Za-z0-9/_-]{0,120}$/.test(url) ? (url as Href) : null
}

/** Registers while signed in and opens the screen a tapped notification points to. */
export function usePushNotifications() {
  const { user, getAccessToken } = usePrivy()
  const router = useRouter()
  const userId = user?.id

  useEffect(() => {
    if (!userId) return
    void registerForPush(getAccessToken)
  }, [userId, getAccessToken])

  useEffect(() => {
    const n = load()
    if (!n) return
    const open = (data: unknown) => {
      const route = safeRoute((data as { url?: unknown } | undefined)?.url)
      if (route) router.push(route)
    }
    void n.getLastNotificationResponseAsync().then((r) => {
      if (r) open(r.notification.request.content.data)
    })
    const sub = n.addNotificationResponseReceivedListener((r) => open(r.notification.request.content.data))
    return () => sub.remove()
  }, [router])
}
