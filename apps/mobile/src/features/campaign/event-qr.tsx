import { usePrivy } from '@privy-io/expo'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import * as Sharing from 'expo-sharing'
import { useRef, useState } from 'react'
import { Alert, Image, Share, StyleSheet, View } from 'react-native'
import QRCode from 'react-native-qrcode-svg'
import { captureRef } from 'react-native-view-shot'

import { font } from '../../design/fonts'
import { Icon } from '../../design/icons'
import { color, radius, space } from '../../design/tokens'
import { Button, Card, Notice, Row, Skeleton, T } from '../../design/ui'
import { api } from '../../lib/api'
import { haptics } from '../../lib/haptics'

/**
 * D-40: the creator's event QR. Show it at the venue; people scan it with Blink to check in. The code is random and
 * server-issued; "New code" retires the old one (e.g. if a photo of it spreads online).
 * "Share QR" sends the QR itself as a branded image (print it or show it on a screen); "Link" shares the URL.
 */
export function EventQrCard({ campaignId }: { campaignId: string }) {
  const { getAccessToken } = usePrivy()
  const queryClient = useQueryClient()
  const key = ['event-code', campaignId]
  const code = useQuery({ queryKey: key, queryFn: () => api.eventCode(getAccessToken, campaignId) })
  const rotate = useMutation({
    mutationFn: () => api.eventCode(getAccessToken, campaignId, true),
    onSuccess: (res) => {
      haptics.success()
      queryClient.setQueryData(key, res)
    },
  })
  const link = code.data?.event.link
  const poster = useRef<View>(null)
  const [sharing, setSharing] = useState(false)
  const [shareError, setShareError] = useState<string | null>(null)

  async function shareImage() {
    setShareError(null)
    setSharing(true)
    try {
      const uri = await captureRef(poster, { format: 'png', quality: 1, result: 'tmpfile' })
      if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing is not available on this phone')
      await Sharing.shareAsync(uri, { mimeType: 'image/png', dialogTitle: 'Share the event check-in QR' })
      haptics.success()
    } catch (e) {
      setShareError(e instanceof Error ? e.message : 'Could not share the QR')
    } finally {
      setSharing(false)
    }
  }

  return (
    <Card style={{ alignItems: 'center', gap: space.lg }} tone="raised">
      <View style={{ alignSelf: 'stretch', gap: 2 }}>
        <Row>
          <Icon name="scan" size={20} stroke={color.lime} />
          <T variant="heading">Event check-in QR</T>
        </Row>
        <T variant="label">Show this at your event or share the image. Guests scan it in Blink to check in — once each.</T>
      </View>
      {link ? (
        // The poster below is what "Share QR" sends: fixed white/ink so it prints and scans well anywhere.
        <View collapsable={false} ref={poster} style={styles.poster}>
          <Row gap={8}>
            <Image source={require('../../../assets/logo-tile.png')} style={{ width: 26, height: 26, borderRadius: 6 }} />
            <T style={[font('display'), { fontSize: 18, color: '#0D0D0B' }]}>Blink</T>
          </Row>
          <QRCode backgroundColor="#ffffff" color="#0D0D0B" ecl="M" size={220} value={link} />
          <T style={[font('bodySemi'), { fontSize: 15, color: '#0D0D0B' }]}>Scan with Blink to check in</T>
          <T style={[font('mono'), { fontSize: 10, color: '#5F5E5A' }]}>{link}</T>
        </View>
      ) : (
        <Skeleton height={320} width={260} />
      )}
      <Notice message={code.error ? code.error.message : rotate.error ? rotate.error.message : shareError} />
      <Row gap={space.sm} style={{ alignSelf: 'stretch' }}>
        <Button disabled={!link} icon="share" loading={sharing} onPress={() => void shareImage()} style={{ flex: 1 }}>
          Share QR
        </Button>
        <Button disabled={!link} onPress={() => link && void Share.share({ message: `Check in at the event on Blink: ${link}` })} style={{ flex: 1 }} variant="secondary">
          Share link
        </Button>
      </Row>
      <Button
        icon="refresh"
        loading={rotate.isPending}
        onPress={() =>
          Alert.alert('Replace the code?', 'The current QR stops working. People who already checked in stay checked in.', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Replace', style: 'destructive', onPress: () => rotate.mutate() },
          ])
        }
        size="md"
        variant="ghost"
      >
        New code
      </Button>
    </Card>
  )
}

const styles = StyleSheet.create({
  poster: { alignItems: 'center', gap: 12, padding: 20, borderRadius: radius.lg, backgroundColor: '#ffffff' },
})
