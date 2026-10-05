import { useRouter } from 'expo-router'
import { useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { Icon } from '../design/icons'
import { color, gutter, radius, space } from '../design/tokens'
import { Button, EmptyState, IconButton, Loading, NavBar, Notice, Row, Screen, T } from '../design/ui'
import { campaignRoute, parseScanTarget } from '../lib/format'
import { haptics } from '../lib/haptics'
import { hasNativeModule } from '../lib/native'

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
  const router = useRouter()
  const camera = loadCamera()
  if (!camera) {
    return (
      <Screen>
        <NavBar onBack={() => router.back()} title="Scan" />
        <EmptyState body="This test build doesn’t include the camera yet. Install the newest Blink build to scan QR codes." icon="scan" title="Update needed" />
      </Screen>
    )
  }
  return <Scanner camera={camera} />
}

const FRAME = 250

function Scanner({ camera }: { camera: CameraModule }) {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { CameraView, useCameraPermissions } = camera
  const [permission, requestPermission] = useCameraPermissions()
  const [error, setError] = useState<string | null>(null)
  const handled = useRef(false)

  if (!permission) return <Loading label="Checking camera permission…" />
  if (!permission.granted) {
    return (
      <Screen>
        <NavBar onBack={() => router.back()} title="Scan" />
        <EmptyState
          action="Allow camera"
          body="Blink uses the camera only to scan campaign QR codes. Nothing is recorded or uploaded."
          icon="scan"
          onAction={() => void requestPermission()}
          title="Camera access"
        />
      </Screen>
    )
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <CameraView
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        facing="back"
        onBarcodeScanned={({ data }) => {
          if (handled.current) return
          // D-40: campaigns, event check-ins and club invites. Each opens a Blink screen that asks before doing anything.
          const target = parseScanTarget(data)
          if (!target) {
            setError('That QR code isn’t a Blink code.')
            return
          }
          handled.current = true
          haptics.success()
          if (target.kind === 'CAMPAIGN') router.replace(campaignRoute(target.campaignId, target.ref) as `/campaign/${string}`)
          else if (target.kind === 'EVENT') router.replace({ pathname: '/e/[token]', params: { token: target.token } })
          else router.replace({ pathname: '/club/[slug]', params: target.invite ? { slug: target.slug, invite: target.invite } : { slug: target.slug } })
        }}
        style={StyleSheet.absoluteFill}
      />

      {/* Dimmed surround with a clear viewfinder */}
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <View style={styles.shade} />
        <Row gap={0}>
          <View style={[styles.shade, { height: FRAME }]} />
          <View style={styles.frame}>
            <View style={[styles.corner, { top: 0, left: 0, borderTopWidth: 4, borderLeftWidth: 4, borderTopLeftRadius: radius.lg }]} />
            <View style={[styles.corner, { top: 0, right: 0, borderTopWidth: 4, borderRightWidth: 4, borderTopRightRadius: radius.lg }]} />
            <View style={[styles.corner, { bottom: 0, left: 0, borderBottomWidth: 4, borderLeftWidth: 4, borderBottomLeftRadius: radius.lg }]} />
            <View style={[styles.corner, { bottom: 0, right: 0, borderBottomWidth: 4, borderRightWidth: 4, borderBottomRightRadius: radius.lg }]} />
          </View>
          <View style={[styles.shade, { height: FRAME }]} />
        </Row>
        <View style={styles.shade} />
      </View>

      <View style={[styles.top, { paddingTop: insets.top + space.md }]}>
        <IconButton icon="close" label="Close scanner" onPress={() => router.back()} />
        <View style={styles.pill}>
          <Icon name="bolt" size={14} stroke={color.lime} strokeWidth={2.2} />
          <T variant="label" color={color.text}>
            Blink scanner
          </T>
        </View>
        <View style={{ width: 40 }} />
      </View>

      <View style={[styles.bottom, { paddingBottom: insets.bottom + space.xxl }]}>
        <T variant="title" align="center">
          Point at a Blink QR code
        </T>
        <T variant="label" align="center">
          Drops, event check-ins and club invites.
        </T>
        <Notice message={error} />
        {error ? (
          <Button onPress={() => setError(null)} size="md" variant="secondary">
            Try again
          </Button>
        ) : null}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  shade: { flex: 1, backgroundColor: 'rgba(7,8,11,0.62)' },
  frame: { width: FRAME, height: FRAME },
  corner: { position: 'absolute', width: 44, height: 44, borderColor: color.lime },
  top: { position: 'absolute', top: 0, left: 0, right: 0, paddingHorizontal: gutter, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(17,20,25,0.85)',
    borderWidth: 1,
    borderColor: color.border,
  },
  bottom: { position: 'absolute', bottom: 0, left: 0, right: 0, paddingHorizontal: gutter, gap: space.sm },
})
