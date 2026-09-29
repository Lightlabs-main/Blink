import { useLinkWithSiws, useLoginWithSiws, usePrivy } from '@privy-io/expo'
import { useQueryClient } from '@tanstack/react-query'
import { fromUint8Array, useMobileWallet } from '@wallet-ui/react-native-kit'
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { Text } from 'react-native'

import { haptics } from '../../lib/haptics'
import { ErrorNote, Muted, Panel, PrimaryButton, Screen, Title } from '../../ui/screen'

// Must match the Privy client's allowed URL scheme and the app scheme (DECISIONS D-2).
const siwsDomain = 'blinktostock'
const siwsUri = 'blinktostock://privy-login'

type Step = 'idle' | 'connecting' | 'signing' | 'verifying'

const STEP_LABEL: Record<Step, string> = {
  idle: 'Connect wallet',
  connecting: 'Approve in your wallet…',
  signing: 'Sign the sign-in message…',
  verifying: 'Verifying…',
}

/**
 * Creator login (MASTER_PROMPT §25, owner correction 2): MWA connect → Privy-generated SIWS message →
 * wallet signs → Privy verifies. The backend then trusts only Privy-verified linked wallets.
 */
export default function WalletLogin() {
  const router = useRouter()
  const { connect, signMessages } = useMobileWallet()
  const queryClient = useQueryClient()
  const { user } = usePrivy()
  const loginSiws = useLoginWithSiws()
  const linkSiws = useLinkWithSiws()
  // Already signed in (e.g. by email) → LINK the wallet to that account instead of starting a new login.
  const isLinking = Boolean(user)
  const siws = isLinking ? linkSiws : loginSiws
  const [step, setStep] = useState<Step>('idle')
  const [error, setError] = useState<string | null>(null)

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
        await queryClient.invalidateQueries({ queryKey: ['me'] })
      } else {
        await loginSiws.login({ message, signature })
      }
      haptics.success()
      if (isLinking && router.canGoBack()) router.back()
      else router.replace('/drops')
    } catch (e) {
      haptics.error()
      setError(e instanceof Error ? e.message : 'Wallet sign-in failed')
      setStep('idle')
    }
  }

  return (
    <Screen>
      <Title kicker="Creators">{isLinking ? 'Add your wallet' : 'Sign in with your wallet'}</Title>
      <Muted>Creators fund campaigns from their own Solana wallet. Your wallet app will open twice:</Muted>
      <Panel>
        <Text className="text-base leading-6 text-zinc-200">1. Approve connecting to Blink-to-Stock.</Text>
        <Text className="text-base leading-6 text-zinc-200">
          2. Sign a one-time sign-in message. This proves the wallet is yours. It is free and moves no funds.
        </Text>
        <ErrorNote message={error} />
        <PrimaryButton disabled={step !== 'idle'} onPress={() => void onConnect()}>
          {STEP_LABEL[step]}
        </PrimaryButton>
      </Panel>
      <Muted>Blink never sees your private keys. Your wallet keeps them and only signs what you approve.</Muted>
    </Screen>
  )
}
