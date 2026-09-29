import { requireOptionalNativeModule } from 'expo'

/**
 * True when the running binary includes a native module. Check BEFORE requiring a JS package whose import
 * throws without it (e.g. expo-camera), so older dev builds show a fallback instead of a red error screen.
 */
export function hasNativeModule(name: 'ExpoCamera' | 'ExpoHaptics'): boolean {
  try {
    return requireOptionalNativeModule(name) != null
  } catch {
    return false
  }
}
