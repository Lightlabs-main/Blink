import { usePrivy } from '@privy-io/expo'
import { useQuery } from '@tanstack/react-query'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { Share, Text, View } from 'react-native'
import QRCode from 'react-native-qrcode-svg'

import { FundCampaign } from '../../features/campaign/fund-campaign'
import { api, ApiError } from '../../lib/api'
import { CAMPAIGN_STATUS_LABEL, CAMPAIGN_TYPE_LABEL, campaignLink, shortAddress } from '../../lib/format'
import { haptics } from '../../lib/haptics'
import { PRODUCT_COPY, rawToUiShares } from '../../shared'
import { Badge, ErrorNote, Loading, Muted, Panel, PrimaryButton, Screen, Title } from '../../ui/screen'

export default function CampaignScreen() {
  const router = useRouter()
  const { id } = useLocalSearchParams<{ id: string }>()
  const { user, getAccessToken } = usePrivy()
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.me(getAccessToken), enabled: Boolean(user) })
  const campaign = useQuery({ queryKey: ['campaign', id], queryFn: () => api.campaign(String(id)), enabled: Boolean(id) })
  const xstocks = useQuery({ queryKey: ['xstocks'], queryFn: api.xstocks, staleTime: 60_000 })

  if (campaign.isPending) return <Loading label="Opening campaign…" />
  if (campaign.error) {
    const notFound = campaign.error instanceof ApiError && campaign.error.status === 404
    return (
      <Screen>
        <Title kicker="Campaign">{notFound ? 'Not found' : 'Something went wrong'}</Title>
        <ErrorNote message={notFound ? 'This link doesn’t match a Blink campaign.' : campaign.error.message} />
        <PrimaryButton onPress={() => router.replace('/')}>Go home</PrimaryButton>
      </Screen>
    )
  }

  const c = campaign.data.campaign
  const x = xstocks.data?.xstocks.find((s) => s.mint === c.mint)
  const amount = x?.multiplier != null ? rawToUiShares(BigInt(c.allowanceRaw), x.decimals, x.multiplier) : null
  const link = campaignLink(c.id)
  const isLive = c.status === 'LIVE'
  const isCreator = Boolean(me.data?.verifiedCreatorWallets.includes(c.creatorWallet))
  const canFund = isCreator && (c.status === 'DRAFT' || c.status === 'AWAITING_FUNDING')
  const amountLabel = amount ? `${amount} ${c.xstockSymbol}` : c.xstockSymbol

  return (
    <Screen>
      <View className="gap-2">
        <Badge label={CAMPAIGN_STATUS_LABEL[c.status]} tone={isLive ? 'live' : 'warn'} />
        <Title kicker={CAMPAIGN_TYPE_LABEL[c.type]}>{c.xstockSymbol}</Title>
        <Muted>{amount ? `${amount} ${c.xstockSymbol} to give away` : 'Stock campaign'}</Muted>
      </View>

      <Panel>
        <View className="items-center rounded-2xl bg-white p-5">
          <QRCode backgroundColor="#ffffff" color="#09090b" size={220} value={link} />
        </View>
        <Text className="text-center font-mono text-xs text-zinc-500">{link}</Text>
        <PrimaryButton
          onPress={() => {
            haptics.tap()
            void Share.share({ message: `Get ${c.xstockSymbol} stock on Blink-to-Stock: ${link}` })
          }}
        >
          Share link
        </PrimaryButton>
      </Panel>

      {canFund ? <FundCampaign amountLabel={amountLabel} campaign={c} /> : null}

      <Panel>
        {isLive ? (
          <Muted>This drop is live. Claiming opens in the next update.</Muted>
        ) : (
          <>
            <Text className="text-lg font-semibold text-white">Not live yet</Text>
            <Muted>
              The creator still needs to fund this campaign from their wallet and approve Blink to distribute it.
            </Muted>
          </>
        )}
        <Text className="text-xs leading-5 text-zinc-500">{PRODUCT_COPY.treasuryStatement}</Text>
        <Text className="text-xs text-zinc-500">{`Creator ${shortAddress(c.creatorWallet)} · ${c.cluster}`}</Text>
      </Panel>

      {!user ? <PrimaryButton onPress={() => router.push('/')}>Sign in to take part</PrimaryButton> : null}
      {router.canGoBack() ? (
        <PrimaryButton variant="secondary" onPress={() => router.back()}>
          Back
        </PrimaryButton>
      ) : (
        <PrimaryButton variant="secondary" onPress={() => router.replace('/')}>
          Home
        </PrimaryButton>
      )}
    </Screen>
  )
}
