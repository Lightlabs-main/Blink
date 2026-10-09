import { usePrivy } from '@privy-io/expo'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useMobileWallet } from '@wallet-ui/react-native-kit'
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { Alert, Linking, Pressable, Share, StyleSheet, View } from 'react-native'

import { font } from '../../design/fonts'
import { Icon, type IconName } from '../../design/icons'
import { PersonName } from '../../design/og'
import { color, space } from '../../design/tokens'
import { Avatar, Badge, Button, Card, Divider, GlowCard, ListRow, Row, Screen, SectionHeader, StockAvatar, T } from '../../design/ui'
import { openOfficialSkrStaking } from '../../features/skr/official-staking'
import { api, apiUrl } from '../../lib/api'
import { FEATURES } from '../../lib/features'
import { COUNTRIES } from '../../lib/countries'
import { displayShares, useAssetMap, useMe, useMyCampaigns, useNetwork, useProfile } from '../../lib/data'
import { CAMPAIGN_STATUS_LABEL, CAMPAIGN_TYPE_LABEL, networkLabel, shortAddress } from '../../lib/format'
import { embeddedSolanaAddress, userEmail } from '../../lib/privy-user'
import { type PushState, registerForPush, unregisterPush } from '../../lib/push'
import { usePassport } from '../passport'

function RowIcon({ icon, tint = color.lime }: { icon: IconName; tint?: string }) {
  return (
    <View style={styles.rowIcon}>
      <Icon name={icon} size={18} stroke={tint} />
    </View>
  )
}

export default function Profile() {
  const router = useRouter()
  const { user, logout, getAccessToken } = usePrivy()
  const { disconnect, account } = useMobileWallet()
  const queryClient = useQueryClient()
  const me = useMe()
  const eligibility = useQuery({ queryKey: ['eligibility'], queryFn: () => api.myEligibility(getAccessToken), enabled: Boolean(user) })
  const elig = eligibility.data?.eligibility
  const eligText = !elig || !elig.current
    ? 'Not confirmed yet'
    : `${elig.eligible ? 'Eligible' : 'Not available'} · ${COUNTRIES.find((c) => c.code === elig.declaredCountry)?.name ?? elig.declaredCountry}`
  const mine = useMyCampaigns()
  const network = useNetwork()
  const assets = useAssetMap()

  const email = userEmail(user)
  const profile = useProfile()
  const passport = usePassport()
  const username = profile.data?.profile.username ?? null
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
              // D-26: Privy's Expo unlinkWallet only accepts Ethereum addresses, so the server removes it.
              await api.unlinkCreatorWallet(getAccessToken, wallet)
              await disconnect().catch(() => {})
              await Promise.all([queryClient.invalidateQueries({ queryKey: ['me'] }), queryClient.invalidateQueries({ queryKey: ['holdings'] })])
            } catch (e) {
              Alert.alert('Could not remove wallet', e instanceof Error ? e.message : 'Please try again.')
            }
          })(),
      },
    ])
  }

  const [push, setPush] = useState<PushState | null>(null)
  async function onNotifications() {
    if (push === 'denied') return void Linking.openSettings()
    setPush(await registerForPush(getAccessToken))
  }
  const pushText =
    push === 'enabled'
      ? 'On · rewards, invite bonuses, your drops going live'
      : push === 'denied'
        ? 'Off · tap to allow in system settings'
        : push === 'unavailable' || push === 'unsupported'
          ? 'Not available in this build'
          : 'Rewards, invite bonuses, your drops going live'

  // D-52: .skr names are looked up by the server from the wallets you verified; you can't type one in.
  const [skrCheck, setSkrCheck] = useState<'idle' | 'checking' | 'none' | 'unavailable' | 'nowallet' | 'error'>('idle')
  async function onCheckSkr() {
    if (!creatorWallets.length) return setSkrCheck('nowallet')
    setSkrCheck('checking')
    try {
      const res = await api.checkSkrIdentity(getAccessToken)
      setSkrCheck(res.status === 'VERIFIED' ? 'idle' : res.status === 'NONE' ? 'none' : 'unavailable')
      await queryClient.invalidateQueries({ queryKey: ['profile'] })
    } catch {
      setSkrCheck('error')
    }
  }
  const skrSubtitle =
    skrCheck === 'checking'
      ? 'Checking on Solana…'
      : skrCheck === 'nowallet'
        ? 'Add the wallet that holds your .skr name first'
        : skrCheck === 'unavailable' || skrCheck === 'error'
          ? 'Unable to verify right now · tap to try again'
          : profile.data?.profile.skrName
            ? 'Verified .skr ✓ · tap to re-check'
            : skrCheck === 'none' || profile.data?.profile.skrCheckedAt
              ? 'No .skr name on your verified wallets · tap to re-check'
              : 'Tap to check your verified wallets'

  async function onLogout() {
    await unregisterPush(getAccessToken)
    if (account) await disconnect().catch(() => {})
    await logout()
    router.replace('/')
  }

  return (
    <Screen tabBar>
      <GlowCard>
        <Row>
          <Pressable accessibilityLabel="Edit profile" onPress={() => router.push('/profile-edit')}>
            <Avatar label={username ?? email ?? creatorWallets[0] ?? 'B'} size={56} uri={apiUrl(profile.data?.profile.avatarUrl)} />
          </Pressable>
          <View style={{ flex: 1, gap: 4 }}>
            <PersonName
              iconSize={16}
              style={{ ...font('display'), fontSize: 22, color: color.text }}
              who={{
                label: username ? `@${username}` : (email ?? (creatorWallets[0] ? shortAddress(creatorWallets[0]) : 'Your account')),
                og: profile.data?.profile.og,
                skrName: profile.data?.profile.skrName ?? undefined,
              }}
            />
            {/* D-52: the verified .skr name leads; the Blink username stays as the secondary identity. */}
            {profile.data?.profile.skrName && username ? <T variant="label">{`@${username}`}</T> : null}
            {username && email ? (
              <T variant="caption" numberOfLines={1}>
                {email}
              </T>
            ) : null}
            <Row gap={space.sm}>
              {creatorWallets.length ? <Badge label="Creator" tone="live" /> : <Badge label="Member" tone="neutral" />}
              {profile.data?.profile.og.includes('SEEKER') ? <Badge label="Verified Seeker" tone="live" /> : null}
              <Badge label={net.label} tone={net.isTest ? 'warn' : 'live'} />
            </Row>
          </View>
        </Row>
        <Button icon="user" onPress={() => router.push('/profile-edit')} size="sm" style={{ marginTop: space.lg, alignSelf: 'flex-start' }} variant="secondary">
          {username ? 'Edit profile' : 'Set username & picture'}
        </Button>
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

      {/* D-40: Passport and Receipts & Activity replace the old "Coming soon" list. */}
      <Card padded={false} style={{ paddingHorizontal: space.lg }}>
        <ListRow
          leading={<RowIcon icon="shield" />}
          onPress={() => router.push('/passport')}
          subtitle={passport.data ? `${passport.data.passport.badges.length} stamps · what you did, never what you hold` : 'Your verified participation record'}
          title="Stock Passport"
        />
        <Divider />
        <ListRow leading={<RowIcon icon="layers" />} onPress={() => router.push('/history')} subtitle="Rewards, check-ins, clubs and sends, each with a receipt" title="Receipts & Activity" />
      </Card>

      <View style={{ gap: space.md }}>
        <SectionHeader title="Wallets" />
        <Card padded={false} style={{ paddingHorizontal: space.lg }}>
          <ListRow
            chevron={false}
            leading={<RowIcon icon="wallet" />}
            onPress={stockWallet ? () => router.push('/wallet') : undefined}
            subtitle={stockWallet ? `${shortAddress(stockWallet, 6, 6)} · Send & receive` : 'Being created…'}
            title="Stock wallet"
            trailing={stockWallet ? <Icon name="chevronRight" size={18} stroke={color.textMuted} /> : undefined}
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
        <SectionHeader title="Solana Mobile identity" />
        <Card padded={false} style={{ paddingHorizontal: space.lg }}>
          <ListRow
            leading={<RowIcon icon="user" tint={color.ogSeeker} />}
            onPress={() => void onCheckSkr()}
            subtitle={skrSubtitle}
            title={profile.data?.profile.skrName ?? '.skr name'}
          />
          <Divider />
          <ListRow
            chevron={false}
            leading={<RowIcon icon="phone" tint={color.ogSeeker} />}
            subtitle={profile.data?.profile.og.includes('SEEKER') ? 'Seeker Genesis Token found in your verified wallet' : 'Checked with your OG marks in Stock Passport'}
            title={profile.data?.profile.og.includes('SEEKER') ? 'Verified Seeker ✓' : 'Seeker not verified'}
          />
        </Card>
      </View>

      <View style={{ gap: space.md }}>
        <SectionHeader title="ORE Miners" />
        <Card padded={false} style={{ paddingHorizontal: space.lg }}>
          <ListRow
            leading={<RowIcon icon="target" tint={color.ogOre} />}
            onPress={() => router.push('/ore')}
            subtitle={profile.data?.profile.og.includes('ORE') ? 'Verified ORE Miner · live board & your deploys' : 'Live board · verify your deploys'}
            title="ORE live board"
          />
        </Card>
      </View>

      <View style={{ gap: space.md }}>
        <SectionHeader title="SKR" />
        <Card padded={false} style={{ paddingHorizontal: space.lg }}>
          {FEATURES.inAppSkrStaking ? (
            <ListRow leading={<RowIcon icon="layers" />} onPress={() => router.push('/skr')} subtitle="Stake, unstake and withdraw · mainnet" title="SKR staking" />
          ) : (
            <ListRow leading={<RowIcon icon="layers" />} onPress={openOfficialSkrStaking} subtitle="stake.solanamobile.com or Seed Vault Wallet" title="Stake SKR" />
          )}
        </Card>
      </View>

      <View style={{ gap: space.md }}>
        <SectionHeader title="Notifications" />
        <Card padded={false} style={{ paddingHorizontal: space.lg }}>
          <ListRow leading={<RowIcon icon="bolt" />} onPress={() => void onNotifications()} subtitle={pushText} title={push === 'enabled' ? 'Notifications on' : 'Turn on notifications'} />
        </Card>
      </View>

      <View style={{ gap: space.md }}>
        <SectionHeader title="Privacy & eligibility" />
        <Card padded={false} style={{ paddingHorizontal: space.lg }}>
          <ListRow
            leading={<RowIcon icon="shield" />}
            onPress={() => router.push('/eligibility')}
            subtitle={`${eligText} · only you can see this`}
            title="xStocks eligibility"
          />
        </Card>
      </View>

      <View style={{ gap: space.md }}>
        <SectionHeader title="About" />
        <Card padded={false} style={{ paddingHorizontal: space.lg }}>
          <ListRow leading={<RowIcon icon="sparkle" />} onPress={() => router.push('/how')} subtitle="Join, qualify, complete, receive, keep the receipt" title="How Blink works" />
          {__DEV__ ? (
            <>
              <Divider />
              <ListRow leading={<RowIcon icon="layers" tint={color.textDim} />} onPress={() => router.push('/dev/wallet-lab')} subtitle="Developer wallet tests" title="Wallet lab" />
            </>
          ) : null}
        </Card>
      </View>

      {/* Owner roadmap: shown as coming, never as available (no actions). */}
      <View style={{ gap: space.md }}>
        <SectionHeader title="Coming to Blink" />
        <Card style={{ gap: space.md }} tone="raised">
          {[
            ['Club community funds', 'Pool SKR as a club for shared drops, with clear ownership and rules.'],
            ['Premium Clubs', 'Members-only clubs with perks from creators.'],
            ['SKR voting', 'Clubs decide together with SKR.'],
          ].map(([title, body]) => (
            <View key={title} style={{ gap: 2 }}>
              <Row gap={space.sm}>
                <T variant="bodyStrong">{title}</T>
                <Badge label="Coming" tone="neutral" />
              </Row>
              <T variant="caption">{body}</T>
            </View>
          ))}
        </Card>
      </View>

      <Button icon="logout" onPress={() => void onLogout()} variant="danger">
        Sign out
      </Button>
    </Screen>
  )
}

const styles = StyleSheet.create({
  rowIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: color.surface3, alignItems: 'center', justifyContent: 'center' },
  stat: { flex: 1, alignItems: 'center', gap: 2 },
  statDivider: { width: 1, height: 36, backgroundColor: color.border },
})
