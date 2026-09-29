import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native'

import { api } from '../../lib/api'
import { CAMPAIGN_TYPE_LABEL } from '../../lib/format'
import { Badge, ErrorNote, Muted, Panel, PrimaryButton, Title, TopInset } from '../../ui/screen'

export default function Drops() {
  const router = useRouter()
  const live = useQuery({ queryKey: ['campaigns', 'live'], queryFn: api.liveCampaigns })
  const campaigns = live.data?.campaigns ?? []

  return (
    <ScrollView
      className="flex-1 bg-zinc-950"
      contentContainerClassName="gap-5 px-5 pb-12"
      refreshControl={<RefreshControl onRefresh={() => void live.refetch()} refreshing={live.isRefetching} tintColor="#6ee7b7" />}
    >
      <TopInset extra={0} />
      <Title kicker="Live now">Drops</Title>

      <PrimaryButton onPress={() => router.push('/scan')}>Scan a Blink QR code</PrimaryButton>

      <ErrorNote message={live.error?.message} />

      {live.isSuccess && campaigns.length === 0 ? (
        <Panel>
          <Text className="text-lg font-semibold text-white">No live drops yet</Text>
          <Muted>
            When a creator funds a campaign and approves Blink to distribute it, it shows up here. Got a link or QR
            from a friend? Scan it above.
          </Muted>
        </Panel>
      ) : null}

      {campaigns.map((c) => (
        <Pressable key={c.id} onPress={() => router.push(`/campaign/${c.id}`)}>
          <Panel>
            <View className="flex-row items-center justify-between">
              <Text className="text-2xl font-extrabold text-white">{c.xstockSymbol}</Text>
              <Badge label="Live" tone="live" />
            </View>
            <Muted>{CAMPAIGN_TYPE_LABEL[c.type]}</Muted>
          </Panel>
        </Pressable>
      ))}
    </ScrollView>
  )
}
