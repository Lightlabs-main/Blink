import { usePrivy, useUnlinkWallet } from '@privy-io/expo'
import { useQueryClient } from '@tanstack/react-query'
import { useMobileWallet } from '@wallet-ui/react-native-kit'
import { useRouter } from 'expo-router'
import { Alert, Pressable, Share, StyleSheet, View } from 'react-native'

import { Icon, type IconName } from '../../design/icons'
import { color, space } from '../../design/tokens'
import { Avatar, Badge, Button, Card, Divider, GlowCard, ListRow, Row, Screen, SectionHeader, StockAvatar, T } from '../../design/ui'
import { displayShares, useAssetMap, useMe, useMyCampaigns, useNetwork } from '../../lib/data'
import { CAMPAIGN_STATUS_LABEL, CAMPAIGN_TYPE_LABEL, networkLabel, shortAddress } from '../../lib/format'
import { embeddedSolanaAddress, userEmail } from '../../lib/privy-user'
import { PRODUCT_COPY } from '../../shared'

function RowIcon({ icon, tint = color.lime }: { icon: IconName; tint?: string }) {
  return (
    <View style={styles.rowIcon}>
      <Icon name={icon} size={18} stroke={tint} />
    </View>
  )
}

export default function Profile() {
  const router = useRouter()
  const { user, logout } = usePrivy()
  const { disconnect, account } = useMobileWallet()
  const queryClient = useQueryClient()
  const { unlinkWallet } = useUnlinkWallet()
  const me = useMe()
  const mine = useMyCampaigns()
  const network = useNetwork()
  const assets = useAssetMap()

  const email = userEmail(user)
  const stockWallet = embeddedSolanaAddress(user)
  const creatorWallets = me.data?.verifiedCreatorWallets ?? []
  const net = networkLabel(network.data?.cluster)
  const campaigns = mine.data?.campaigns ?? []
  const liveCount = campaigns.filter((c) => c.status === 'LIVE').length

  function onRemoveWallet(wallet: string) {
    const body = `${shortAddress(wallet, 6, 6)} will no longer be linked to your Blink account. Campaigns it already funded are not affected.`
    Alert.alert('Remove creator wallet?', body, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () =>
          void (async () => {
            try {
              await unlinkWallet({ address: wallet })
              await disconnect().catch(() => {})
              await Promise.all([queryClient.invalidateQueries({ queryKey: ['me'] }), queryClient.invalidateQueries({ queryKey: ['holdings'] })])
            } catch (e) {
              Alert.alert('Could not remove wallet', e instanceof Error ? e.message : 'Please try again.')
            }
          })(),
      },
    ])
  }

  async function onLogout() {
    if (account) await disconnect().catch(() => {})
    await logout()
    router.replace('/')
  }

  return (
    <Screen tabBar>
      <GlowCard>
        <Row>
          <Avatar label={email ?? creatorWallets[0] ?? 'B'} size={56} />
          <View style={{ flex: 1, gap: 4 }}>
            <T variant="title" numberOfLines={1}>
              {email ?? (creatorWallets[0] ? shortAddress(creatorWallets[0]) : 'Your account')}
            </T>
            <Row gap={space.sm}>
              {creatorWallets.length ? <Badge label="Creator" tone="live" /> : <Badge label="Member" tone="neutral" />}
              <Badge label={net.label} tone={net.isTest ? 'warn' : 'live'} />
            </Row>
          </View>
        </Row>
        <Row gap={0} style={{ marginTop: space.xl }}>
          <View style={styles.stat}>
            <T variant="display">{campaigns.length}</T>
            <T variant="caption">Campaigns</T>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.stat}>
            <T variant="display">{liveCount}</T>
            <T variant="caption">Live</T>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.stat}>
            <T variant="display">{creatorWallets.length + (stockWallet ? 1 : 0)}</T>
            <T variant="caption">Wallets</T>
          </View>
        </Row>
      </GlowCard>

      <View style={{ gap: space.md }}>
        <SectionHeader title="Wallets" />
        <Card padded={false} style={{ paddingHorizontal: space.lg }}>
          <ListRow
            chevron={false}
            leading={<RowIcon icon="wallet" />}
            onPress={stockWallet ? () => void Share.share({ message: stockWallet }) : undefined}
            subtitle={stockWallet ? shortAddress(stockWallet, 6, 6) : 'Being created…'}
            title="Stock wallet"
            trailing={stockWallet ? <Icon name="share" size={18} stroke={color.textDim} /> : undefined}
          />
          {creatorWallets.map((w) => (
            <View key={w}>
              <Divider />
              <ListRow
                chevron={false}
                leading={<RowIcon icon="sparkle" tint={color.violet} />}
                onPress={() => void Share.share({ message: w })}
                subtitle={shortAddress(w, 6, 6)}
                title="Creator wallet"
                trailing={
                  <Pressable accessibilityLabel="Remove creator wallet" hitSlop={12} onPress={() => onRemoveWallet(w)}>
                    <Icon name="close" size={18} stroke={color.textDim} />
                  </Pressable>
                }
              />
            </View>
          ))}
          <Divider />
          <ListRow
            leading={<RowIcon icon="plus" />}
            onPress={() => router.push('/login/wallet')}
            subtitle={creatorWallets.length ? 'Link a different wallet' : 'Create campaigns from your own wallet'}
            title="Add creator wallet"
          />
        </Card>
      </View>

      {campaigns.length ? (
        <View style={{ gap: space.md }}>
          <SectionHeader title="Your campaigns" />
          <Card padded={false} style={{ paddingHorizontal: space.lg }}>
            {campaigns.map((c, i) => {
              const asset = assets.get(c.mint)
              const amount = displayShares(asset, c.allowanceRaw)
              return (
                <View key={c.id}>
                  {i > 0 ? <Divider /> : null}
                  <ListRow
                    leading={<StockAvatar isTest={asset?.isTest} logo={asset?.logo} size={36} symbol={c.xstockSymbol} />}
                    onPress={() => router.push(`/campaign/${c.id}`)}
                    subtitle={`${CAMPAIGN_TYPE_LABEL[c.type]}${amount ? ` · ${amount}` : ''}`}
                    title={c.xstockSymbol}
                    trailing={<Badge label={CAMPAIGN_STATUS_LABEL[c.status]} tone={c.status === 'LIVE' ? 'live' : 'warn'} />}
                  />
                </View>
              )
            })}
          </Card>
        </View>
      ) : null}

      <View style={{ gap: space.md }}>
        <SectionHeader title="About" />
        <Card padded={false} style={{ paddingHorizontal: space.lg }}>
          <ListRow chevron={false} leading={<RowIcon icon="shield" />} subtitle={PRODUCT_COPY.trustStatement} title="How Blink works" />
          <Divider />
          <ListRow leading={<RowIcon icon="layers" tint={color.textDim} />} onPress={() => router.push('/dev/wallet-lab')} subtitle="Developer wallet tests" title="Wallet lab" />
        </Card>
      </View>

      <Button icon="logout" onPress={() => void onLogout()} variant="danger">
        Sign out
      </Button>
    </Screen>
  )
}

const styles = StyleSheet.create({
  rowIcon: { width: 36, height: 36, borderRadius: 12, backgroundColor: color.surface3, alignItems: 'center', justifyContent: 'center' },
  stat: { flex: 1, alignItems: 'center', gap: 2 },
  statDivider: { width: 1, height: 36, backgroundColor: color.border },
})
