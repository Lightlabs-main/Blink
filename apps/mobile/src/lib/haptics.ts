// Haptics are best-effort: builds without the native ExpoHaptics module (the first dev build) must not crash.
import { hasNativeModule } from './native'

type HapticsModule = typeof import('expo-haptics')

let mod: HapticsModule | null | undefined

function load(): HapticsModule | null {
  if (mod !== undefined) return mod
  if (!hasNativeModule('ExpoHaptics')) {
    mod = null
    return mod
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('expo-haptics') as HapticsModule
  } catch {
    mod = null
  }
  return mod
}

function safely(run: (h: HapticsModule) => Promise<void>) {
  const h = load()
  if (!h) return
  try {
    run(h).catch(() => {})
  } catch {
    // Haptics must never break a user action.
  }
}

export const haptics = {
  tap() {
    safely((h) => h.selectionAsync())
  },
  success() {
    safely((h) => h.notificationAsync(h.NotificationFeedbackType.Success))
  },
  error() {
    safely((h) => h.notificationAsync(h.NotificationFeedbackType.Error))
  },
}
