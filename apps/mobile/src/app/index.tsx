import { usePrivy } from '@privy-io/expo'
import { Redirect, useRouter } from 'expo-router'
import { Text, View } from 'react-native'

import { PRODUCT_COPY } from '../shared'
import { ErrorNote, Loading, Muted, PrimaryButton, Screen } from '../ui/screen'

export default function Welcome() {
  const router = useRouter()
  const { isReady, user, error } = usePrivy()

  if (!isReady) return <Loading label="Starting Blink…" />
  if (user) return <Redirect href="/drops" />

  return (
    <Screen scroll={false}>
      <View className="flex-1 justify-center gap-6">
        <View className="gap-3">
          <Text className="text-xs font-bold uppercase tracking-widest text-emerald-300">Blink-to-Stock</Text>
          <Text className="text-5xl font-extrabold leading-[56px] text-white">Stocks you can share.</Text>
          <Muted>Open a link, play or claim, and receive a real tokenized stock on Solana. No seed phrase, no exchange.</Muted>
        </View>
        <ErrorNote message={error?.message} />
      </View>

      <View className="gap-3">
        <PrimaryButton onPress={() => router.push('/login/email')}>Continue with email</PrimaryButton>
        <PrimaryButton variant="secondary" onPress={() => router.push('/login/wallet')}>
          I’m a creator — use my Solana wallet
        </PrimaryButton>
        <Text className="pt-2 text-center text-xs leading-5 text-zinc-500">{PRODUCT_COPY.trustStatement}</Text>
      </View>
    </Screen>
  )
}
