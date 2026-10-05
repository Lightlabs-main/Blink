import { usePrivy } from '@privy-io/expo'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, Share, StyleSheet, View } from 'react-native'
import QRCode from 'react-native-qrcode-svg'

import { font } from '../../design/fonts'
import { Icon } from '../../design/icons'
import { color, radius, space } from '../../design/tokens'
import { Button, Card, Notice, Row, Skeleton, T } from '../../design/ui'
import { api } from '../../lib/api'
import { haptics } from '../../lib/haptics'

/**
 * D-40: the creator's event QR. Show it at the venue; people scan it with Blink to check in. The code is random and
 * server-issued; "New code" retires the old one (e.g. if a photo of it spreads online).
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

  return (
    <Card style={{ alignItems: 'center', gap: space.lg }} tone="raised">
      <View style={{ alignSelf: 'stretch', gap: 2 }}>
        <Row>
          <Icon name="scan" size={20} stroke={color.lime} />
          <T variant="heading">Event check-in QR</T>
        </Row>
        <T variant="label">Show this at your event. Guests scan it in Blink to check in — once each.</T>
      </View>
      {link ? (
        <View style={styles.qrFrame}>
          <QRCode backgroundColor="#ffffff" color="#0D0D0B" ecl="M" size={210} value={link} />
        </View>
      ) : (
        <Skeleton height={238} width={238} />
      )}
      {link ? <T style={{ ...font('mono'), fontSize: 11, color: color.textMuted }}>{link}</T> : null}
      <Notice message={code.error ? code.error.message : rotate.error ? rotate.error.message : null} />
      <Row gap={space.sm} style={{ alignSelf: 'stretch' }}>
        <Button disabled={!link} icon="share" onPress={() => link && void Share.share({ message: `Check in at the event on Blink: ${link}` })} style={{ flex: 1 }} variant="secondary">
          Share
        </Button>
        <Button
          icon="refresh"
          loading={rotate.isPending}
          onPress={() =>
            Alert.alert('Replace the code?', 'The current QR stops working. People who already checked in stay checked in.', [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Replace', style: 'destructive', onPress: () => rotate.mutate() },
            ])
          }
          style={{ flex: 1 }}
          variant="ghost"
        >
          New code
        </Button>
      </Row>
    </Card>
  )
}

const styles = StyleSheet.create({
  qrFrame: { padding: 14, borderRadius: radius.lg, backgroundColor: '#ffffff' },
})
