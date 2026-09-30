import { PrivyProvider } from '@privy-io/expo'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AppIdentity, createSolanaDevnet, MobileWalletProvider } from '@wallet-ui/react-native-kit'
import { HeroUINativeProvider } from 'heroui-native/provider'
import { ReactNode } from 'react'
import { GestureHandlerRootView } from 'react-native-gesture-handler'

// Cluster must match the backend's SOLANA_CLUSTER (DECISIONS D-12). Devnet until mainnet go-approval.
const cluster = createSolanaDevnet()
// D-12: the https origin wallets show and can verify; the icon is resolved relative to it.
const identity: AppIdentity = { name: 'Blink-to-Stock', uri: 'https://blinksol.site', icon: 'icon.png' }
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
            <MobileWalletProvider cluster={cluster} identity={identity}>
              {children}
            </MobileWalletProvider>
          </PrivyProvider>
        </QueryClientProvider>
      </HeroUINativeProvider>
    </GestureHandlerRootView>
  )
}
