import { useLinkWithSiws, useLoginWithSiws, usePrivy } from '@privy-io/expo'
import { useQueryClient } from '@tanstack/react-query'
import { fromUint8Array, useMobileWallet } from '@wallet-ui/react-native-kit'
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { StyleSheet, View } from 'react-native'

import { Icon, type IconName } from '../../design/icons'
import { color, space } from '../../design/tokens'
import { Button, Card, NavBar, Notice, Row, Screen, T } from '../../design/ui'
import { haptics } from '../../lib/haptics'

// Must match the Privy client's allowed URL scheme and the app scheme (DECISIONS D-2).
const siwsDomain = 'blinktostock'
const siwsUri = 'blinktostock://privy-login'

type Step = 'idle' | 'connecting' | 'signing' | 'verifying'

const ORDER: Step[] = ['connecting', 'signing', 'verifying']

function StepRow({ n, icon, title, body, state }: { n: number; icon: IconName; title: string; body: string; state: 'todo' | 'active' | 'done' }) {
  return (
    <Row style={{ alignItems: 'flex-start' }}>
      <View style={[styles.stepIcon, state === 'active' && { borderColor: color.lime }, state === 'done' && { backgroundColor: color.lime, borderColor: color.lime }]}>
        {state === 'done' ? <Icon name="check" size={16} stroke={color.onLime} strokeWidth={2.6} /> : <Icon name={icon} size={16} stroke={state === 'active' ? color.lime : color.textDim} />}
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <T variant="bodyStrong">{`${n}. ${title}`}</T>
        <T variant="label">{body}</T>
      </View>
    </Row>
  )
}

/**
 * Creator login (MASTER_PROMPT §25, owner correction 2): MWA connect → Privy-generated SIWS message →
 * wallet signs → Privy verifies. Links the wallet instead when the user is already signed in (e.g. by email).
 */
export default function WalletLogin() {
  const router = useRouter()
  const { connect, signMessages } = useMobileWallet()
  const queryClient = useQueryClient()
  const { user } = usePrivy()
  const loginSiws = useLoginWithSiws()
  const linkSiws = useLinkWithSiws()
  const isLinking = Boolean(user)
  const siws = isLinking ? linkSiws : loginSiws
  const [step, setStep] = useState<Step>('idle')
  const [error, setError] = useState<string | null>(null)

  const stateOf = (s: Step) => {
    if (step === 'idle') return 'todo'
    const cur = ORDER.indexOf(step)
    const idx = ORDER.indexOf(s)
    return idx < cur ? 'done' : idx === cur ? 'active' : 'todo'
  }

  async function onConnect() {
    setError(null)
    try {
      setStep('connecting')
      const account = await connect()
      setStep('signing')
      const { message } = await siws.generateMessage({
        from: { domain: siwsDomain, uri: siwsUri },
        wallet: { address: account.address.toString() },
      })
      const signatureBytes = await signMessages(new TextEncoder().encode(message))
      setStep('verifying')
      const signature = fromUint8Array(signatureBytes)
      if (isLinking) {
        await linkSiws.link({ message, signature })
        await Promise.all([queryClient.invalidateQueries({ queryKey: ['me'] }), queryClient.invalidateQueries({ queryKey: ['holdings'] })])
      } else {
        await loginSiws.login({ message, signature })
      }
      haptics.success()
      if (isLinking && router.canGoBack()) router.back()
      else router.replace('/home')
    } catch (e) {
      haptics.error()
      setError(e instanceof Error ? e.message : 'Wallet sign-in failed')
      setStep('idle')
    }
  }

  const label = step === 'connecting' ? 'Approve in your wallet…' : step === 'signing' ? 'Sign the message…' : step === 'verifying' ? 'Verifying…' : 'Connect wallet'

  return (
    <Screen>
      <NavBar onBack={() => router.back()} />
      <View style={{ gap: space.md }}>
        <View style={styles.badgeIcon}>
          <Icon name="wallet" size={24} stroke={color.lime} />
        </View>
        <T variant="display">{isLinking ? 'Add your creator wallet' : 'Sign in with your wallet'}</T>
        <T>Campaign stock comes from your own Solana wallet. Your wallet app opens twice — both are free and move no funds.</T>
      </View>

      <Card style={{ gap: space.lg }}>
        <StepRow body="Approve the connection to Blink-to-Stock." icon="wallet" n={1} state={stateOf('connecting')} title="Connect" />
        <StepRow body="A one-time message proves the wallet is yours." icon="sparkle" n={2} state={stateOf('signing')} title="Sign" />
        <StepRow body="Blink confirms it with Privy." icon="shield" n={3} state={stateOf('verifying')} title="Verify" />
      </Card>

      <Notice message={error} />
      <Button disabled={step !== 'idle'} icon="wallet" onPress={() => void onConnect()}>
        {label}
      </Button>
      <Row gap={space.sm} style={{ justifyContent: 'center' }}>
        <Icon name="lock" size={14} stroke={color.textMuted} />
        <T variant="caption">Blink never sees your private keys.</T>
      </Row>
    </Screen>
  )
}

const styles = StyleSheet.create({
  badgeIcon: { width: 52, height: 52, borderRadius: 18, backgroundColor: color.limeSoft, alignItems: 'center', justifyContent: 'center' },
  stepIcon: {
    width: 34,
    height: 34,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: color.border,
    backgroundColor: color.surface2,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
