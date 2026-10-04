import * as Sharing from 'expo-sharing'
import { forwardRef } from 'react'
import { Image, Linking, StyleSheet, View } from 'react-native'
import { captureRef } from 'react-native-view-shot'

import { font } from '../../design/fonts'
import { T } from '../../design/ui'
import { displayShares } from '../../lib/data'
import type { XStockListing } from '../../lib/api'
import { CAMPAIGN_TYPE_LABEL, explorerTxUrl, shortAddress } from '../../lib/format'
import { formatRaw, type HistoryItem } from '../../shared'

/**
 * D-38: receipts. Always printed in Blink ink with the logo and the lime dot (same in Day and Night), so a shared
 * image looks the same everywhere. Fixed colours on purpose: this card is an image as much as a view.
 */
const INK = '#0D0D0B'
const INK_2 = '#1F1F1B'
const CREAM = '#F4F0E6'
const MUTED = '#8C887E'
const LIME = '#ABFF1A'

export function receiptTitle(item: HistoryItem): string {
  switch (item.kind) {
    case 'REWARD':
      return item.campaignType ? `${CAMPAIGN_TYPE_LABEL[item.campaignType]} reward` : 'Reward'
    case 'INVITE_BONUS':
      return 'Invite bonus'
    case 'SENT':
      return 'Sent'
    case 'FUNDED':
      return item.campaignType ? `${CAMPAIGN_TYPE_LABEL[item.campaignType]} drop funded` : 'Drop funded'
  }
}

export function receiptAmount(item: HistoryItem, asset: XStockListing | undefined): string {
  const shares = item.mint ? displayShares(asset, item.amountRaw) : null
  const amount = shares ?? formatRaw(BigInt(item.amountRaw), item.decimals, 4)
  const sign = item.kind === 'SENT' || item.kind === 'FUNDED' ? '−' : '+'
  return `${sign}${amount} ${item.symbol}`
}

const STATUS_TEXT: Record<HistoryItem['status'], string> = { CONFIRMED: 'Confirmed on Solana', PENDING: 'Confirming…', FAILED: 'Failed' }

function Line({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.line}>
      <T style={[font('body'), { color: MUTED, fontSize: 13.5 }]}>{label}</T>
      <T style={[font('numeric'), { color: CREAM, fontSize: 13.5 }]}>{value}</T>
    </View>
  )
}

/** The receipt card. `ref` is captured to a PNG for sharing. */
export const ReceiptCard = forwardRef<View, { item: HistoryItem; asset: XStockListing | undefined; username: string | null }>(function ReceiptCard(
  { item, asset, username },
  ref,
) {
  const when = new Date(item.at)
  return (
    <View collapsable={false} ref={ref} style={styles.card}>
      <View style={styles.dot} />
      <View style={styles.brand}>
        <Image source={require('../../../assets/logo-tile.png')} style={styles.logo} />
        <T style={[font('display'), { color: CREAM, fontSize: 20 }]}>Blink</T>
        <T style={[font('bodyMedium'), { color: MUTED, fontSize: 13, marginLeft: 'auto', marginRight: 18 }]}>Receipt</T>
      </View>

      <View style={{ gap: 4, marginTop: 26 }}>
        <T style={[font('bodyMedium'), { color: MUTED, fontSize: 15 }]}>{receiptTitle(item)}</T>
        <T style={[font('display'), { color: CREAM, fontSize: 40, lineHeight: 46, letterSpacing: -1 }]}>{receiptAmount(item, asset)}</T>
        {username ? <T style={[font('bodySemi'), { color: LIME, fontSize: 15 }]}>{`@${username}`}</T> : null}
      </View>

      <View style={styles.lines}>
        <Line label="Date" value={when.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })} />
        <Line label="Time" value={when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} />
        <Line label="Status" value={STATUS_TEXT[item.status]} />
        {item.kind === 'SENT' && item.counterparty ? <Line label="To" value={shortAddress(item.counterparty, 5, 5)} /> : null}
        <Line label="Network" value={item.cluster === 'mainnet-beta' ? 'Solana' : 'Solana devnet (test)'} />
        {item.signature ? <Line label="Transaction" value={shortAddress(item.signature, 6, 6)} /> : null}
      </View>

      <T style={[font('body'), { color: MUTED, fontSize: 12, marginTop: 18 }]}>blinksol.site · tokenized stocks, made social</T>
    </View>
  )
})

/** Captures the card and opens the share sheet (X, WhatsApp, Photos…). */
export async function shareReceiptImage(ref: React.RefObject<View | null>) {
  const uri = await captureRef(ref, { format: 'png', quality: 1, result: 'tmpfile' })
  if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing is not available on this phone')
  await Sharing.shareAsync(uri, { mimeType: 'image/png', dialogTitle: 'Share your Blink receipt' })
}

/** Opens X with a ready-to-post line and a link (the image can be attached from the share sheet). */
export function postReceiptOnX(item: HistoryItem, asset: XStockListing | undefined) {
  const amount = receiptAmount(item, asset).replace(/^[+−]/, '')
  const text =
    item.kind === 'SENT'
      ? `Just sent ${amount} on Blink — tokenized stocks, made social.`
      : item.kind === 'FUNDED'
        ? `I just launched a ${amount} drop on Blink. Come get some.`
        : `Just earned ${amount} on Blink ⚡ tokenized stocks, made social.`
  const url = item.campaignId && item.kind !== 'SENT' ? `https://blinksol.site/c/${item.campaignId}` : item.signature ? explorerTxUrl(item.signature, item.cluster) : 'https://blinksol.site'
  return Linking.openURL(`https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`)
}

const styles = StyleSheet.create({
  card: { backgroundColor: INK, borderRadius: 28, padding: 24, overflow: 'hidden', borderWidth: 1, borderColor: INK_2 },
  dot: { position: 'absolute', top: 22, right: 22, width: 12, height: 12, borderRadius: 6, backgroundColor: LIME },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  logo: { width: 32, height: 32, borderRadius: 8 },
  lines: { marginTop: 22, borderTopWidth: 1, borderColor: INK_2, paddingTop: 8 },
  line: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8, gap: 12 },
})
