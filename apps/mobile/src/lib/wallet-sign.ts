import { address, getAddressEncoder, getBase64Decoder, getBase64EncodedWireTransaction, getBase64Encoder, getTransactionDecoder } from '@solana/kit'
import { transact, useMobileWallet } from '@wallet-ui/react-native-kit'
import { useCallback, useRef, useState } from 'react'
import { AppState } from 'react-native'

import { shortAddress } from './format'

/** If Blink is still on screen this long after asking the wallet to open, the wallet didn't open. */
const WALLET_OPEN_TIMEOUT_MS = 6000

export class WalletDeclinedError extends Error {
  override name = 'WalletDeclinedError'
}

/**
 * D-49..D-51: one user-signed transaction through Mobile Wallet Adapter, the same way funding works (D-29, D-35):
 * a fresh authorization that names the network, the expected account must be the one the wallet uses, the wallet
 * only signs (Blink relays after checking it is byte-identical to what it built). A rejection is an error, never a
 * success. Never call Blink while the wallet app is in front.
 */
export function useWalletSigner() {
  const { chain, identity } = useMobileWallet()
  const attempt = useRef(0)
  const [walletStuck, setWalletStuck] = useState(false)

  const sign = useCallback(
    async (transactionBase64: string, expectedWallet: string): Promise<string> => {
      const mine = ++attempt.current
      setWalletStuck(false)
      const unsigned = getTransactionDecoder().decode(getBase64Encoder().encode(transactionBase64))
      const watch = setTimeout(() => {
        if (attempt.current === mine && AppState.currentState === 'active') setWalletStuck(true)
      }, WALLET_OPEN_TIMEOUT_MS)
      try {
        const signed = await transact(async (wallet) => {
          const auth = await wallet.authorize({ chain, identity })
          const wanted = getBase64Decoder().decode(getAddressEncoder().encode(address(expectedWallet)))
          if (!auth.accounts.some((a) => a.address === wanted)) {
            throw new Error(`Switch to wallet ${shortAddress(expectedWallet)} in your wallet app, then try again.`)
          }
          const [tx] = await wallet.signTransactions({ transactions: [unsigned] })
          if (!tx) throw new WalletDeclinedError('Your wallet didn’t return a signed transaction.')
          return tx
        })
        if (attempt.current !== mine) throw new WalletDeclinedError('This approval was replaced by a newer one.')
        return getBase64EncodedWireTransaction(signed)
      } catch (e) {
        const msg = e instanceof Error ? e.message : ''
        // MWA reports a user rejection as an error; say it plainly and never treat it as sent.
        if (/declin|reject|cancel|not approved|user denied/i.test(msg)) throw new WalletDeclinedError('You declined in your wallet. Nothing was sent.')
        throw e
      } finally {
        clearTimeout(watch)
        if (attempt.current === mine) setWalletStuck(false)
      }
    },
    [chain, identity],
  )

  /** Abandon a wallet that never answered, so its late reply is ignored. */
  const abandon = useCallback(() => {
    attempt.current += 1
    setWalletStuck(false)
  }, [])

  return { sign, walletStuck, abandon }
}
