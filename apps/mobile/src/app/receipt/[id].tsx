import { useLocalSearchParams, useRouter } from 'expo-router'
import { useRef, useState } from 'react'
import { Linking, View } from 'react-native'

import { space } from '../../design/tokens'
import { Button, Loading, NavBar, Notice, Row, Screen, T } from '../../design/ui'
import { BLINK_X_HANDLE, postReceiptOnX, ReceiptCard, saveReceiptImage, shareReceiptImage } from '../../features/receipts/receipt'
import { apiUrl } from '../../lib/api'
import { useAssetMap, useProfile } from '../../lib/data'
import { explorerTxUrl } from '../../lib/format'
import { haptics } from '../../lib/haptics'
import { useHistory } from '../history'

/** D-38: one receipt with the Blink logo — share it as an image, post it on X, or open the transaction. */
export default function Receipt() {
  const router = useRouter()
  const { id } = useLocalSearchParams<{ id: string }>()
  const history = useHistory()
  const assets = useAssetMap()
  const profile = useProfile()
  const card = useRef<View>(null)
  const [error, setError] = useState<string | null>(null)
  const [sharing, setSharing] = useState(false)
  const [busy, setBusy] = useState<'x' | 'save' | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  const item = history.data?.items.find((i) => i.id === id)
  // A brand-new reward may not be in the cached list yet: wait for the refresh before saying it's missing.
  if (history.isLoading || (!item && history.isFetching)) return <Loading label="Loading receipt…" />
  if (!item) {
    return (
      <Screen>
        <NavBar onBack={() => router.back()} title="Receipt" />
        <Notice message="This receipt isn’t available. Pull down on Activity to refresh." tone="warn" />
      </Screen>
    )
  }
  const asset = item.mint ? assets.get(item.mint) : undefined

  async function onShare() {
    setError(null)
    setSharing(true)
    try {
      await shareReceiptImage(card)
      haptics.success()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not share the receipt.')
    } finally {
      setSharing(false)
    }
  }

  async function onPostX() {
    if (!item) return
    setError(null)
    setBusy('x')
    try {
      await postReceiptOnX(card, item, asset)
      setInfo(`Caption with ${BLINK_X_HANDLE} copied — in X, long-press the text box and paste.`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open X.')
    } finally {
      setBusy(null)
    }
  }

  async function onSave() {
    setError(null)
    setBusy('save')
    try {
      await saveReceiptImage(card)
      haptics.success()
      setInfo('Saved to your photos.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the receipt.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Screen>
      <NavBar onBack={() => router.back()} title="Receipt" />
      <ReceiptCard asset={asset} item={item} ref={card} username={profile.data?.profile.username ?? null} avatarUri={apiUrl(profile.data?.profile.avatarUrl)} />
      <View style={{ gap: space.sm }}>
        <Button icon="share" loading={sharing} onPress={() => void onShare()}>
          Share receipt
        </Button>
        <Row gap={space.sm}>
          <Button loading={busy === 'x'} onPress={() => void onPostX()} style={{ flex: 1 }} variant="secondary">
            Post on X
          </Button>
          <Button icon="arrowRight" loading={busy === 'save'} onPress={() => void onSave()} style={{ flex: 1 }} variant="secondary">
            Save image
          </Button>
        </Row>
        <Row gap={space.sm}>
          {item.signature ? (
            <Button onPress={() => void Linking.openURL(explorerTxUrl(item.signature!, item.cluster))} style={{ flex: 1 }} variant="secondary">
              Explorer
            </Button>
          ) : null}
        </Row>
        {item.campaignId ? (
          <Button onPress={() => router.push(`/campaign/${item.campaignId}`)} variant="ghost">
            Open the drop
          </Button>
        ) : null}
      </View>
      <Notice message={info} tone="info" />
      <Notice message={error} />
      <T align="center" variant="caption">
        {`“Post on X” shares this card as a picture and copies a caption that tags ${BLINK_X_HANDLE}. “Save image” puts it in your photos.`}
      </T>
    </Screen>
  )
}
