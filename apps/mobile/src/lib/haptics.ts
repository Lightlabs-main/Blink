// Haptics are best-effort: builds without the native ExpoHaptics module (the first dev build) must not crash.
type HapticsModule = typeof import('expo-haptics')

let mod: HapticsModule | null | undefined

function load(): HapticsModule | null {
  if (mod !== undefined) return mod
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('expo-haptics') as HapticsModule
  } catch {
    mod = null
  }
  return mod
}

export const haptics = {
  tap() {
    load()?.selectionAsync().catch(() => {})
  },
  success() {
    const h = load()
    h?.notificationAsync(h.NotificationFeedbackType.Success).catch(() => {})
  },
  error() {
    const h = load()
    h?.notificationAsync(h.NotificationFeedbackType.Error).catch(() => {})
  },
}
