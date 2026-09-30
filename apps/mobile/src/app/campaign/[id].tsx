import { usePrivy } from '@privy-io/expo'
import { useQuery } from '@tanstack/react-query'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { Share, StyleSheet, View } from 'react-native'
import QRCode from 'react-native-qrcode-svg'

import { font } from '../../design/fonts'
import { Icon } from '../../design/icons'
import { color, radius, space } from '../../design/tokens'
import { Badge, Button, Card, Divider, GlowCard, Loading, NavBar, Notice, Row, Screen, Stepper, StockAvatar, T } from '../../design/ui'
import { ClaimPanel } from '../../features/campaign/claim-panel'
import { FundCampaign } from '../../features/campaign/fund-campaign'
import { api, ApiError } from '../../lib/api'
import { displayShares, useAssetMap, useMe } from '../../lib/data'
import { CAMPAIGN_STATUS_LABEL, CAMPAIGN_TYPE_ICON, CAMPAIGN_TYPE_LABEL, campaignLink, networkLabel, shortAddress } from '../../lib/format'
import { haptics } from '../../lib/haptics'
import { maxClaims, PRODUCT_COPY } from '../../shared'

const STEP_OF = { DRAFT: 0, AWAITING_FUNDING: 1, AWAITING_DELEGATION: 1, LIVE: 3, PAUSED: 3, ENDED: 3, CLOSED: 3 } as const

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <Row style={{ justifyContent: 'space-between' }}>
      <T variant="label">{label}</T>
      <T variant="numeric" style={{ fontSize: 14 }}>
        {value}
      </T>
    </Row>
  )
}

export default function CampaignScreen() {
  const router = useRouter()
  const { id } = useLocalSearchParams<{ id: string }>()
  const { user } = usePrivy()
  const me = useMe()
  const assets = useAssetMap()
  const campaign = useQuery({ queryKey: ['campaign', id], queryFn: () => api.campaign(String(id)), enabled: Boolean(id) })
  const back = () => (router.canGoBack() ? router.back() : router.replace('/'))

  if (campaign.isPending) return <Loading label="Opening campaign…" />
  if (campaign.error) {
    const notFound = campaign.error instanceof ApiError && campaign.error.status === 404
    return (
      <Screen>
        <NavBar onBack={back} />
        <T variant="display">{notFound ? 'Campaign not found' : 'Something went wrong'}</T>
        <Notice message={notFound ? 'This link doesn’t match a Blink campaign.' : campaign.error.message} />
        <Button onPress={() => router.replace('/')}>Go home</Button>
      </Screen>
    )
  }

  const c = campaign.data.campaign
  const asset = assets.get(c.mint)
  const amount = displayShares(asset, c.allowanceRaw)
  const amountLabel = amount ? `${amount} ${c.xstockSymbol}` : c.xstockSymbol
  const link = campaignLink(c.id)
  const isLive = c.status === 'LIVE'
  const isCreator = Boolean(me.data?.verifiedCreatorWallets.includes(c.creatorWallet))
  const canFund = isCreator && (c.status === 'DRAFT' || c.status === 'AWAITING_FUNDING')
  const preLive = c.status === 'DRAFT' || c.status === 'AWAITING_FUNDING' || c.status === 'AWAITING_DELEGATION'
  const reward = c.rewardPerClaimRaw ? BigInt(c.rewardPerClaimRaw) : null
  const rewardShares = reward ? displayShares(asset, reward) : null
  const net = networkLabel(c.cluster)
  const share = () => {
    haptics.tap()
    void Share.share({ message: `Get ${c.xstockSymbol} stock on Blink-to-Stock: ${link}` })
  }

  return (
    <Screen>
      <NavBar
        onBack={back}
        right={
          <Button icon="share" onPress={share} size="sm" variant="secondary">
            Share
          </Button>
        }
      />

      <GlowCard>
        <Row style={{ justifyContent: 'space-between' }}>
          <StockAvatar isTest={asset?.isTest} logo={asset?.logo} size={56} symbol={c.xstockSymbol} />
          <Badge dot={isLive} label={CAMPAIGN_STATUS_LABEL[c.status]} tone={isLive ? 'live' : 'warn'} />
        </Row>
        <View style={{ marginTop: space.lg, gap: 4 }}>
          <Row gap={6}>
            <Icon name={CAMPAIGN_TYPE_ICON[c.type]} size={16} stroke={color.lime} />
            <T variant="overline">{CAMPAIGN_TYPE_LABEL[c.type]}</T>
          </Row>
          <T variant="hero">{c.xstockSymbol}</T>
          <T style={{ fontSize: 17 }}>{amount ? `${amount} shares to give away` : (asset?.name ?? 'Stock campaign')}</T>
          {rewardShares ? <T variant="label">{`${rewardShares} ${c.xstockSymbol} per person`}</T> : null}
        </View>
        <View style={{ marginTop: space.xl }}>
          <Stepper current={STEP_OF[c.status]} steps={['Draft', 'Funded', 'Live']} />
        </View>
      </GlowCard>

      {canFund ? <FundCampaign amountLabel={amountLabel} campaign={c} /> : null}

      {!isCreator && preLive ? (
        <Card style={{ gap: space.sm }} tone="raised">
          <T variant="heading">Not live yet</T>
          <T variant="label">The creator is still funding this drop. Check back soon — it’ll appear in Drops when it goes live.</T>
        </Card>
      ) : null}

      {!isCreator && !preLive ? <ClaimPanel asset={asset} campaign={c} /> : null}

      {isCreator && !preLive && reward ? (
        <Card style={{ gap: space.sm }} tone={isLive ? 'lime' : 'raised'}>
          <Row>
            <Icon name="bolt" size={20} stroke={color.lime} />
            <T variant="heading">{isLive ? 'Your drop is live' : `Your drop is ${CAMPAIGN_STATUS_LABEL[c.status].toLowerCase()}`}</T>
          </Row>
          <T variant="label" color={color.text}>
            {`${(BigInt(c.claimedRaw) / reward).toString()} of ${maxClaims(BigInt(c.allowanceRaw), reward).toString()} people have claimed. Share the QR code to reach more.`}
          </T>
        </Card>
      ) : null}

      <Card style={{ alignItems: 'center', gap: space.lg }}>
        <View style={{ alignSelf: 'stretch', gap: 2 }}>
          <T variant="heading">Share this drop</T>
          <T variant="label">Anyone who scans this opens it in Blink.</T>
        </View>
        <View style={styles.qrFrame}>
          <QRCode backgroundColor="#ffffff" color={color.bg} ecl="H" size={210} value={link} />
          <View style={styles.qrBadge}>
            <Icon name="bolt" size={18} stroke={color.onLime} strokeWidth={2.4} />
          </View>
        </View>
        <T align="center" style={{ ...font('numeric'), fontSize: 12, color: color.textMuted }}>
          {link}
        </T>
        <Button icon="share" onPress={share} style={{ alignSelf: 'stretch' }}>
          Share link
        </Button>
      </Card>

      <Card style={{ gap: space.md }}>
        <T variant="heading">Details</T>
        <Detail label="Creator" value={shortAddress(c.creatorWallet)} />
        <Divider />
        <Detail label="Campaign account" value={shortAddress(c.campaignTokenAccount)} />
        <Divider />
        <Detail label="Distributor" value={c.delegateAddress ? shortAddress(c.delegateAddress) : 'Assigned at funding'} />
        <Divider />
        <Detail label="Network" value={net.label} />
        <T variant="caption" style={{ marginTop: space.xs }}>
          {PRODUCT_COPY.treasuryStatement}
        </T>
      </Card>

      {!user && preLive ? (
        <Button onPress={() => router.push({ pathname: '/login/email', params: { next: `/campaign/${c.id}` } })}>Sign in to take part</Button>
      ) : null}
    </Screen>
  )
}

const styles = StyleSheet.create({
  qrFrame: { padding: 14, borderRadius: radius.lg, backgroundColor: '#ffffff', alignItems: 'center', justifyContent: 'center' },
  qrBadge: {
    position: 'absolute',
    width: 38,
    height: 38,
    borderRadius: 12,
    backgroundColor: color.lime,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 4,
    borderColor: '#ffffff',
  },
})
