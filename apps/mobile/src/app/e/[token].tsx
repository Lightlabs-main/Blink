import { usePrivy } from '@privy-io/expo'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router'
import { View } from 'react-native'

import { Icon } from '../../design/icons'
import { color, space } from '../../design/tokens'
import { Button, Card, NavBar, Notice, Row, Screen, T } from '../../design/ui'
import { api } from '../../lib/api'
import { haptics } from '../../lib/haptics'

/**
 * D-40: event check-in from a scanned QR or a https://blinksol.site/e/<code> App Link. Nothing happens until the
 * person confirms; the server checks the code, the event window and that each person checks in once.
 */
export default function EventCheckin() {
  const router = useRouter()
  const { token } = useLocalSearchParams<{ token: string }>()
  const { user, getAccessToken } = usePrivy()
  const queryClient = useQueryClient()
  const valid = typeof token === 'string' && /^[A-Za-z0-9_-]{20,64}$/.test(token)
  const checkIn = useMutation({
    mutationFn: () => api.checkIn(getAccessToken, String(token)),
    onSuccess: () => {
      haptics.success()
      void queryClient.invalidateQueries({ queryKey: ['history'] })
      void queryClient.invalidateQueries({ queryKey: ['passport'] })
    },
    onError: () => haptics.error(),
  })

  if (!user) return <Redirect href={{ pathname: '/login/email', params: { next: `/e/${String(token)}` } }} />
  const done = checkIn.data?.checkin

  return (
    <Screen>
      <NavBar onBack={() => (router.canGoBack() ? router.back() : router.replace('/home'))} title="Event check-in" />
      <Card style={{ gap: space.md, alignItems: 'center', paddingVertical: space.xxl }} tone={done ? 'lime' : 'default'}>
        <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: done ? color.marker : color.surface3, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name={done ? 'check' : 'scan'} size={26} stroke={done ? color.onMarker : color.lime} strokeWidth={2.4} />
        </View>
        <T align="center" variant="title">
          {done ? (done.alreadyCheckedIn ? 'You’re already checked in' : 'Checked in ✓') : 'Check in to this event?'}
        </T>
        <T align="center" variant="label">
          {done
            ? 'Your check-in is saved in Receipts & Activity. Open the drop to finish any other steps and claim.'
            : 'Blink records that you were here. No location is stored and nothing is sent from your wallet.'}
        </T>
      </Card>
      <Notice message={!valid ? 'This isn’t a valid Blink event code.' : checkIn.error ? checkIn.error.message : null} />
      {done ? (
        <View style={{ gap: space.sm }}>
          <Button icon="arrowRight" onPress={() => router.replace(`/campaign/${done.campaignId}`)}>
            Open the drop
          </Button>
          <Row style={{ justifyContent: 'center' }}>
            <Button onPress={() => router.replace('/history')} variant="ghost">
              View activity
            </Button>
          </Row>
        </View>
      ) : (
        <Button disabled={!valid} icon="check" loading={checkIn.isPending} onPress={() => checkIn.mutate()}>
          Check in
        </Button>
      )}
    </Screen>
  )
}
