import * as Clipboard from 'expo-clipboard'
import * as MediaLibrary from 'expo-media-library'
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
    case 'CHECKIN':
      return 'Event check-in'
    case 'CLUB_JOINED':
      return 'Joined a club'
    case 'GIFT_RECEIVED':
      return item.title ? `Gift from ${item.title}` : 'Gift received'
    case 'SKR_TIP_SENT':
      return item.title ? `SKR tip to ${item.title}` : 'SKR tip sent'
    case 'SKR_TIP_RECEIVED':
      return item.title ? `SKR tip from ${item.title}` : 'SKR tip received'
    case 'SKR_BOOST_PURCHASED':
      return 'Drop boosted with SKR'
    case 'ORE_DEPLOY_CONFIRMED':
      return 'ORE deploy'
    case 'ORE_MINER_VERIFIED':
      return 'Verified ORE Miner'
  }
}

/** D-40: check-ins and club joins are Blink records, not Solana transactions: no amount, no network. */
export const isOffchain = (item: HistoryItem) => item.kind === 'CHECKIN' || item.kind === 'CLUB_JOINED'
/** D-51: a profile mark backed by a verified deploy (the deploy itself has its own receipt). No amount. */
const isMark = (item: HistoryItem) => item.kind === 'ORE_MINER_VERIFIED'

/** The big line on the receipt and the trailing text in the list. */
export function receiptHeadline(item: HistoryItem, asset: XStockListing | undefined): string {
  if (item.kind === 'CHECKIN') return `${item.title ?? item.symbol} event ✓`
  if (item.kind === 'CLUB_JOINED') return item.title ?? 'Club'
  if (isMark(item)) return 'ORE Miner ✓'
  return receiptAmount(item, asset)
}

/** "BLK-1A2B3C4D": a short, human reference for the receipt (from its record id; carries nothing private). */
export function receiptRef(item: HistoryItem): string {
  return `BLK-${(item.id.split(':')[1] ?? item.id).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toUpperCase()}`
}

export function receiptAmount(item: HistoryItem, asset: XStockListing | undefined): string {
  const shares = item.mint ? displayShares(asset, item.amountRaw) : null
  const amount = shares ?? formatRaw(BigInt(item.amountRaw), item.decimals, 4)
  const outgoing: HistoryItem['kind'][] = ['SENT', 'FUNDED', 'SKR_TIP_SENT', 'SKR_BOOST_PURCHASED', 'ORE_DEPLOY_CONFIRMED']
  const sign = outgoing.includes(item.kind) ? '−' : '+'
  return `${sign}${amount} ${item.symbol}`
}

const STATUS_TEXT: Record<HistoryItem['status'], string> = { CONFIRMED: 'Confirmed on Solana', PENDING: 'Confirming…', FAILED: 'Failed' }

/** Never says a reward arrived before the network confirmed it. */
function statusText(item: HistoryItem) {
  if (isOffchain(item)) return 'Recorded by Blink ✓'
  if (item.kind === 'GIFT_RECEIVED') return 'Gift received ✓'
  if (isMark(item)) return 'Verified onchain ✓'
  if (item.kind === 'ORE_DEPLOY_CONFIRMED') return 'Deploy confirmed on Solana ✓'
  if (item.kind === 'REWARD' || item.kind === 'INVITE_BONUS') return item.status === 'CONFIRMED' ? 'Reward settled ✓' : item.status === 'PENDING' ? 'Completed · reward sending' : 'Completed · payout failed'
  return STATUS_TEXT[item.status]
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.line}>
      <T style={[font('body'), { color: MUTED, fontSize: 13.5 }]}>{label}</T>
      <T style={[font('numeric'), { color: CREAM, fontSize: 13.5 }]}>{value}</T>
    </View>
  )
}

/** The receipt card. `ref` is captured to a PNG for sharing. */
export const ReceiptCard = forwardRef<View, { item: HistoryItem; asset: XStockListing | undefined; username: string | null; avatarUri?: string | null }>(function ReceiptCard(
  { item, asset, username, avatarUri },
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
        <T style={[font('display'), { color: CREAM, fontSize: isOffchain(item) ? 32 : 40, lineHeight: isOffchain(item) ? 38 : 46, letterSpacing: -1 }]}>{receiptHeadline(item, asset)}</T>
        {username || avatarUri ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 }}>
            {avatarUri ? <Image source={{ uri: avatarUri }} style={styles.avatar} /> : null}
            {username ? <T style={[font('bodySemi'), { color: LIME, fontSize: 15 }]}>{`@${username}`}</T> : null}
          </View>
        ) : null}
      </View>

      <View style={styles.lines}>
        <Line label="Date" value={when.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })} />
        <Line label="Time" value={when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} />
        <Line label="Status" value={statusText(item)} />
        {item.kind === 'SENT' && item.counterparty ? <Line label="To" value={shortAddress(item.counterparty, 5, 5)} /> : null}
        {item.kind === 'SKR_TIP_SENT' && item.counterparty ? <Line label="To wallet" value={shortAddress(item.counterparty, 5, 5)} /> : null}
        {item.kind === 'SKR_BOOST_PURCHASED' && item.details?.startsAt && item.details.endsAt ? (
          <Line label="Featured" value={`${shortTime(item.details.startsAt)} → ${shortTime(item.details.endsAt)}`} />
        ) : null}
        {item.details?.roundId ? <Line label="Round" value={`#${item.details.roundId}`} /> : null}
        {item.details?.squares?.length ? <Line label={item.details.squares.length === 1 ? 'Square' : 'Squares'} value={item.details.squares.map((q) => q + 1).join(', ')} /> : null}
        {isOffchain(item) || isMark(item) ? null : <Line label="Network" value={item.cluster === 'mainnet-beta' ? 'Solana Mainnet' : 'Solana devnet (test)'} />}
        <Line label="Receipt" value={receiptRef(item)} />
        {item.signature ? <Line label="Transaction" value={shortAddress(item.signature, 6, 6)} /> : null}
      </View>

      <T style={[font('body'), { color: MUTED, fontSize: 12, marginTop: 18 }]}>Completed on Blink · blinksol.site</T>
    </View>
  )
})

function shortTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

/** Captures the card and opens the share sheet (X, WhatsApp, Photos…). */
export async function shareReceiptImage(ref: React.RefObject<View | null>) {
  const uri = await captureCard(ref)
  if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing is not available on this phone')
  await Sharing.shareAsync(uri, { mimeType: 'image/png', dialogTitle: 'Share your Blink receipt' })
}

/** Blink's official X account, tagged on every post (owner, 2026-10-10). */
export const BLINK_X_HANDLE = '@Blinksols'

/** The text for a post about this receipt: what actually happened, Blink's handle and a link. */
export function receiptCaption(item: HistoryItem, asset: XStockListing | undefined): string {
  const amount = receiptAmount(item, asset).replace(/^[+−]/, '')
  const line: Record<HistoryItem['kind'], string> = {
    REWARD: `Just earned ${amount} on Blink ⚡ tokenized stocks, made social.`,
    INVITE_BONUS: `Just earned ${amount} for inviting a friend on Blink ⚡`,
    SENT: `Just sent ${amount} on Blink — tokenized stocks, made social.`,
    FUNDED: `I just launched a ${amount} drop on Blink. Come get some.`,
    CHECKIN: `Checked in at a ${item.title ?? item.symbol} event on Blink ✓`,
    CLUB_JOINED: `I just joined ${item.title ?? 'a club'} on Blink — tokenized stocks, made social.`,
    GIFT_RECEIVED: `Just got ${amount} as a gift on Blink 🎁 tokenized stocks, made social.`,
    SKR_TIP_SENT: `Just tipped ${item.title ?? 'a club member'} ${amount} on Blink ⚡`,
    SKR_TIP_RECEIVED: `Just got tipped ${amount} on Blink ⚡`,
    SKR_BOOST_PURCHASED: `Boosted my drop with ${amount} on Blink ⚡`,
    ORE_DEPLOY_CONFIRMED: `Deployed on the ORE board from Blink ⛏️ ${item.title ?? ''}`.trim(),
    ORE_MINER_VERIFIED: 'Verified ORE Miner on Blink ⛏️',
  }
  const url =
    item.kind === 'CLUB_JOINED' && item.clubSlug
      ? `https://blinksol.site/club/${item.clubSlug}`
      : item.campaignId && item.kind !== 'SENT'
        ? `https://blinksol.site/c/${item.campaignId}`
        : item.signature
          ? explorerTxUrl(item.signature, item.cluster)
          : 'https://blinksol.site'
  return `${line[item.kind]} ${BLINK_X_HANDLE}
${url}`
}

/** Captures the receipt card to a temporary PNG. */
async function captureCard(ref: React.RefObject<View | null>) {
  return captureRef(ref, { format: 'png', quality: 1, result: 'tmpfile' })
}

/**
 * Post on X with the picture: X can't take an image and text together from another app, so the caption (with
 * @Blinksols and the link) goes to the clipboard and the share sheet opens with the image — pick X and paste.
 */
export async function postReceiptOnX(ref: React.RefObject<View | null>, item: HistoryItem, asset: XStockListing | undefined) {
  const caption = receiptCaption(item, asset)
  await Clipboard.setStringAsync(caption)
  const uri = await captureCard(ref)
  if (!(await Sharing.isAvailableAsync())) {
    // No share sheet: fall back to a text post (no picture).
    await Linking.openURL(`https://x.com/intent/post?text=${encodeURIComponent(caption)}`)
    return
  }
  await Sharing.shareAsync(uri, { mimeType: 'image/png', dialogTitle: 'Pick X, then paste the caption' })
}

/** Saves the receipt card to the phone's photos (write-only access, photos only). */
export async function saveReceiptImage(ref: React.RefObject<View | null>) {
  const perm = await MediaLibrary.requestPermissionsAsync(true, ['photo'])
  if (!perm.granted) throw new Error('Allow Blink to save photos to download receipts (Settings → Apps → Blink → Permissions).')
  const uri = await captureCard(ref)
  await MediaLibrary.Asset.create(uri)
}

const styles = StyleSheet.create({
  card: { backgroundColor: INK, borderRadius: 28, padding: 24, overflow: 'hidden', borderWidth: 1, borderColor: INK_2 },
  dot: { position: 'absolute', top: 22, right: 22, width: 12, height: 12, borderRadius: 6, backgroundColor: LIME },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  logo: { width: 32, height: 32, borderRadius: 8 },
  avatar: { width: 26, height: 26, borderRadius: 13, backgroundColor: INK_2 },
  lines: { marginTop: 22, borderTopWidth: 1, borderColor: INK_2, paddingTop: 8 },
  line: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8, gap: 12 },
})
