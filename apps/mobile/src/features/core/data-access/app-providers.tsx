import { PrivyProvider } from '@privy-io/expo'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { AppIdentity, createSolanaDevnet, createSolanaLocalnet, createSolanaMainnet, MobileWalletProvider } from '@wallet-ui/react-native-kit'
import { HeroUINativeProvider } from 'heroui-native/provider'
import { ReactNode, useMemo } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'

import { api } from '../../../lib/api'
import { color } from '../../../design/tokens'
// D-12: the https origin wallets show and can verify; the icon is resolved relative to it.
export const identity: AppIdentity = { name: 'Blink-to-Stock', uri: 'https://blinksol.site', icon: 'icon.png' }
const privyAppId = process.env.EXPO_PUBLIC_PRIVY_APP_ID
const privyClientId = process.env.EXPO_PUBLIC_PRIVY_CLIENT_ID
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 15_000 } } })

export function AppProviders({ children }: { children: ReactNode }) {
  if (!privyAppId || !privyClientId) {
    throw new Error('Missing Privy environment variables')
  }

  return (
    <GestureHandlerRootView className="flex-1">
      <HeroUINativeProvider config={{ devInfo: { stylingPrinciples: false } }}>
        <QueryClientProvider client={queryClient}>
          <PrivyProvider
            appId={privyAppId}
            clientId={privyClientId}
            // Email users get a Privy embedded Solana wallet to receive stock (MASTER_PROMPT §24).
            // Creators who sign in with an external wallet keep using that wallet.
            config={{ embedded: { solana: { createOnLogin: 'users-without-wallets' } } }}
          >
            <NetworkGate>{children}</NetworkGate>
          </PrivyProvider>
        </QueryClientProvider>
      </HeroUINativeProvider>
    </GestureHandlerRootView>
  )
}

/**
 * D-12: the wallet cluster always matches the backend's SOLANA_CLUSTER, read from /health — never inferred or
 * hard-coded, so one APK follows the server from devnet to mainnet. Without the answer the app waits rather than guess.
 */
function NetworkGate({ children }: { children: ReactNode }) {
  const health = useQuery({ queryKey: ['health'], queryFn: api.health, staleTime: 5 * 60_000, retry: 2 })
  const cluster = useMemo(() => {
    switch (health.data?.cluster) {
      case 'mainnet-beta':
        // Used only for the developer wallet lab's balance read; app data comes from the Blink API.
        return createSolanaMainnet('https://api.mainnet.solana.com')
      case 'devnet':
        return createSolanaDevnet()
      case 'localnet':
        return createSolanaLocalnet()
      default:
        return null
    }
  }, [health.data?.cluster])

  if (!cluster) {
    // Rendered before fonts and the design system load, so plain React Native only.
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24, backgroundColor: color.bg }}>
        {health.isError ? (
          <>
            <Text style={{ color: color.text, fontSize: 17, textAlign: 'center' }}>Can’t reach Blink right now.</Text>
            <Pressable accessibilityRole="button" onPress={() => void health.refetch()} style={{ paddingVertical: 12, paddingHorizontal: 20, borderRadius: 999, backgroundColor: color.text }}>
              <Text style={{ color: color.bg, fontWeight: '600' }}>Try again</Text>
            </Pressable>
          </>
        ) : (
          <ActivityIndicator color={color.text} />
        )}
      </View>
    )
  }
  return (
    <MobileWalletProvider cluster={cluster} identity={identity}>
      {children}
    </MobileWalletProvider>
  )
}
