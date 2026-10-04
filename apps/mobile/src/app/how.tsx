import { useRouter } from 'expo-router'
import { View } from 'react-native'

import { Icon, type IconName } from '../design/icons'
import { color, space } from '../design/tokens'
import { BlinkLogo, Card, GlowCard, NavBar, Row, Screen, T } from '../design/ui'

function Step({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <Row style={{ alignItems: 'flex-start' }}>
      <View style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: color.primary, alignItems: 'center', justifyContent: 'center' }}>
        <T style={{ color: color.onPrimary, fontSize: 14, fontWeight: '700' }}>{String(n)}</T>
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <T variant="bodyStrong">{title}</T>
        <T variant="label">{body}</T>
      </View>
    </Row>
  )
}

function Point({ icon, title, body }: { icon: IconName; title: string; body: string }) {
  return (
    <Row style={{ alignItems: 'flex-start' }}>
      <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: color.limeSoft, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={icon} size={17} stroke={color.lime} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <T variant="bodyStrong">{title}</T>
        <T variant="label">{body}</T>
      </View>
    </Row>
  )
}

/** Plain-language explainer, opened from Profile → How Blink works. */
export default function HowBlinkWorks() {
  const router = useRouter()
  return (
    <Screen>
      <NavBar onBack={() => router.back()} title="How Blink works" />
      <GlowCard>
        <View style={{ gap: space.md }}>
          <BlinkLogo size={44} />
          <T variant="display">Tokenized stocks, made social.</T>
          <T variant="body">
            Creators fund campaigns with real tokenized stocks (xStocks on Solana). You join, complete what the campaign asks, and the stock lands in
            your Blink wallet — free, with a public receipt.
          </T>
        </View>
      </GlowCard>

      <View style={{ gap: space.md }}>
        <T variant="title">Taking part</T>
        <Card>
          <View style={{ gap: space.lg }}>
            <Step body="Scan a Blink QR code or open a link a friend shared. Drops also appear in the Drops tab." n={1} title="Find a drop" />
            <Step body="Each drop says who can join and what to do: play Tap Rush, hold or stake SKR, mine ORE, post on X, or just claim." n={2} title="Check what it asks" />
            <Step body="Blink checks every requirement itself, on Solana or on X, right before it pays. Nothing is self-reported." n={3} title="Blink verifies it" />
            <Step body="The stock is sent to your Blink wallet. You get a receipt with the Blink logo to keep or share." n={4} title="Get the stock" />
          </View>
        </Card>
      </View>

      <View style={{ gap: space.md }}>
        <T variant="title">Your wallet</T>
        <Card>
          <View style={{ gap: space.lg }}>
            <Point body="Created for you when you sign in with email. No seed phrase to write down." icon="wallet" title="Made for you" />
            <Point body="Receive with your address or QR code. Send stock or SOL to any Solana wallet — Blink pays the network fee." icon="share" title="Send and receive" />
            <Point body="Claiming is free. Blink covers the network fees for rewards." icon="gift" title="No fees to claim" />
          </View>
        </Card>
      </View>

      <View style={{ gap: space.md }}>
        <T variant="title">Running a campaign</T>
        <Card>
          <View style={{ gap: space.lg }}>
            <Step body="Pick who can join (Seeker owners, SKR or ORE holders) and what they must do." n={1} title="Set the conditions" />
            <Step body="One approval in your own wallet moves the stock into a campaign account you own." n={2} title="Fund it" />
            <Step body="Share the link or QR. Watch the live room as people join and win." n={3} title="Share it" />
          </View>
        </Card>
      </View>

      <View style={{ gap: space.md }}>
        <T variant="title">Safety</T>
        <Card>
          <View style={{ gap: space.lg }}>
            <Point body="Campaign stock stays in an account the creator owns. Blink can hand out only the exact amount approved — never more." icon="lock" title="No custody" />
            <Point body="Every payout is simulated first and re-checked onchain before any stock moves." icon="shield" title="Checked every time" />
            <Point body="Each reward is a real Solana transaction you can open in the explorer." icon="check" title="Public receipts" />
          </View>
        </Card>
      </View>

      <T variant="caption">
        xStocks are tokenized tracker certificates issued by a third party; they give economic exposure to a stock but are not registered shares. They
        are not available to U.S. persons or in some countries. Nothing in Blink is investment advice.
      </T>
    </Screen>
  )
}
