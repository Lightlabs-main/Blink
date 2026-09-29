import { usePrivy } from '@privy-io/expo'
import { useQuery } from '@tanstack/react-query'
import { useMobileWallet } from '@wallet-ui/react-native-kit'
import { useRouter } from 'expo-router'
import { Pressable, Text, View } from 'react-native'

import { api } from '../../lib/api'
import { CAMPAIGN_STATUS_LABEL, CAMPAIGN_TYPE_LABEL, shortAddress } from '../../lib/format'
import { embeddedSolanaAddress, userEmail } from '../../lib/privy-user'
import { Badge, ErrorNote, Muted, Panel, PrimaryButton, Screen, Title } from '../../ui/screen'

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row items-center justify-between gap-3">
      <Text className="text-zinc-400">{label}</Text>
      <Text className="font-mono text-zinc-100">{value}</Text>
    </View>
  )
}

export default function Profile() {
  const router = useRouter()
  const { user, logout, getAccessToken } = usePrivy()
  const { disconnect, account } = useMobileWallet()
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.me(getAccessToken) })
  const mine = useQuery({ queryKey: ['my-campaigns'], queryFn: () => api.myCampaigns(getAccessToken) })

  const email = userEmail(user)
  const embedded = embeddedSolanaAddress(user)
  const creatorWallets = me.data?.verifiedCreatorWallets ?? []

  async function onLogout() {
    if (account) await disconnect().catch(() => {})
    await logout()
    router.replace('/')
  }

  return (
    <Screen>
      <Title kicker="You">Profile</Title>

      <Panel>
        {email ? <Row label="Email" value={email} /> : null}
        <Row label="Stock wallet" value={embedded ? shortAddress(embedded) : 'Creating…'} />
        {creatorWallets.map((w) => (
          <Row key={w} label="Creator wallet" value={shortAddress(w)} />
        ))}
        <ErrorNote message={me.error?.message} />
      </Panel>

      <Panel>
        <Text className="text-lg font-semibold text-white">Your stocks</Text>
        <Muted>Stocks you earn from campaigns will appear here.</Muted>
      </Panel>

      <Panel>
        <Text className="text-lg font-semibold text-white">Your campaigns</Text>
        {mine.isSuccess && mine.data.campaigns.length === 0 ? <Muted>You haven’t created a campaign yet.</Muted> : null}
        {mine.data?.campaigns.map((c) => (
          <Pressable key={c.id} className="flex-row items-center justify-between py-1" onPress={() => router.push(`/campaign/${c.id}`)}>
            <Text className="text-base text-white">{`${c.xstockSymbol} · ${CAMPAIGN_TYPE_LABEL[c.type]}`}</Text>
            <Badge label={CAMPAIGN_STATUS_LABEL[c.status]} tone={c.status === 'LIVE' ? 'live' : 'default'} />
          </Pressable>
        ))}
        <ErrorNote message={mine.error?.message} />
      </Panel>

      <PrimaryButton variant="secondary" onPress={() => router.push('/dev/wallet-lab')}>
        Wallet lab (developer tests)
      </PrimaryButton>
      <PrimaryButton variant="danger" onPress={() => void onLogout()}>
        Sign out
      </PrimaryButton>
    </Screen>
  )
}
