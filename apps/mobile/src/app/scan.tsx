import { useRouter } from 'expo-router'
import { useRef, useState } from 'react'
import { Text, View } from 'react-native'

import { campaignIdFromScan } from '../lib/format'
import { haptics } from '../lib/haptics'
import { hasNativeModule } from '../lib/native'
import { ErrorNote, Muted, PrimaryButton, Screen, Title } from '../ui/screen'

type CameraModule = typeof import('expo-camera')

// expo-camera is native: builds without it (the first dev build) must show a message instead of crashing.
function loadCamera(): CameraModule | null {
  if (!hasNativeModule('ExpoCamera')) return null
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-camera') as CameraModule
  } catch {
    return null
  }
}

export default function Scan() {
  const camera = loadCamera()
  if (!camera) {
    return (
      <Screen>
        <Title kicker="Scan">Update needed</Title>
        <Muted>This test build doesn’t include the camera yet. Install the newest Blink build to scan QR codes.</Muted>
      </Screen>
    )
  }
  return <Scanner camera={camera} />
}

function Scanner({ camera }: { camera: CameraModule }) {
  const router = useRouter()
  const { CameraView, useCameraPermissions } = camera
  const [permission, requestPermission] = useCameraPermissions()
  const [error, setError] = useState<string | null>(null)
  const handled = useRef(false)

  if (!permission) return <Screen><Muted>Checking camera permission…</Muted></Screen>
  if (!permission.granted) {
    return (
      <Screen>
        <Title kicker="Scan">Camera access</Title>
        <Muted>Blink uses the camera only to scan campaign QR codes.</Muted>
        <PrimaryButton onPress={() => void requestPermission()}>Allow camera</PrimaryButton>
      </Screen>
    )
  }

  return (
    <View className="flex-1 bg-black">
      <CameraView
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        facing="back"
        onBarcodeScanned={({ data }) => {
          if (handled.current) return
          const id = campaignIdFromScan(data)
          if (!id) {
            setError('That QR code isn’t a Blink campaign.')
            return
          }
          handled.current = true
          haptics.success()
          router.replace(`/campaign/${id}`)
        }}
        style={{ flex: 1 }}
      />
      <View className="absolute bottom-0 left-0 right-0 gap-3 bg-black/70 px-5 pb-12 pt-5">
        <Text className="text-center text-lg font-semibold text-white">Point at a Blink QR code</Text>
        <ErrorNote message={error} />
        <PrimaryButton variant="secondary" onPress={() => router.back()}>
          Cancel
        </PrimaryButton>
      </View>
    </View>
  )
}
