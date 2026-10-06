import { usePrivy } from '@privy-io/expo'
import { address, getAddressEncoder, getBase64Decoder, getBase64EncodedWireTransaction, getBase64Encoder, getTransactionDecoder } from '@solana/kit'
import { useQueryClient } from '@tanstack/react-query'
import { transact, useMobileWallet } from '@wallet-ui/react-native-kit'
import { useRef, useState } from 'react'
import { Alert, AppState, Linking } from 'react-native'

import { Icon } from '../../design/icons'
import { color, space } from '../../design/tokens'
import { Button, Card, Notice, Row, T } from '../../design/ui'
import { api, ApiError, type XStockListing } from '../../lib/api'
import { displayShares } from '../../lib/data'
import { explorerTxUrl, shortAddress } from '../../lib/format'
import { haptics } from '../../lib/haptics'
import type { CampaignSummary } from '../../shared'

type Step = 'idle' | 'preparing' | 'signing' | 'submitting' | 'done'

/**
 * W-1 creator wind-down: one wallet approval that revokes Blink's permission, returns every unused share to the
 * creator's own wallet and closes the campaign account (its deposit comes back). Closing ends the drop for everyone.
 */
export function CloseCampaign({ campaign, asset }: { campaign: CampaignSummary; asset: XStockListing | undefined }) {
  const { getAccessToken } = usePrivy()
  const { chain, identity } = useMobileWallet()
  const queryClient = useQueryClient()
  const [step, setStep] = useState<Step>('idle')
  const [error, setError] = useState<string | null>(null)
  const [walletStuck, setWalletStuck] = useState(false)
  const [result, setResult] = useState<{ signature: string; returned: string } | null>(null)
  const attempt = useRef(0)
  const left = BigInt(campaign.allowanceRaw) - BigInt(campaign.claimedRaw)
  const leftLabel = `${displayShares(asset, left > 0n ? left : 0n) ?? 'the unused'} ${campaign.xstockSymbol}`

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['campaign', campaign.id] }),
      queryClient.invalidateQueries({ queryKey: ['my-campaigns'] }),
      queryClient.invalidateQueries({ queryKey: ['campaigns', 'live'] }),
      queryClient.invalidateQueries({ queryKey: ['holdings'] }),
    ])

  async function run() {
    setError(null)
    setWalletStuck(false)
    const mine = ++attempt.current
    try {
      setStep('preparing')
      // Prepare right before opening the wallet (never call Blink while the wallet is on screen, D-35).
      const { prepared } = await api.closePrepare(getAccessToken, campaign.id)
      void refresh()
      const unsigned = getTransactionDecoder().decode(getBase64Encoder().encode(prepared.transaction))
      setStep('signing')
      const watch = setTimeout(() => {
        if (attempt.current === mine && AppState.currentState === 'active') setWalletStuck(true)
      }, 6000)
      const signed = await transact(async (wallet) => {
        const auth = await wallet.authorize({ chain, identity })
        const wanted = getBase64Decoder().decode(getAddressEncoder().encode(address(campaign.creatorWallet)))
        if (!auth.accounts.some((a) => a.address === wanted)) {
          throw new Error(`Switch to wallet ${shortAddress(campaign.creatorWallet)} in your wallet app, then try again.`)
        }
        const [tx] = await wallet.signTransactions({ transactions: [unsigned] })
        if (!tx) throw new Error('Your wallet app did not return a signed transaction')
        return tx
      }).finally(() => clearTimeout(watch))
      if (attempt.current !== mine) return
      setWalletStuck(false)
      setStep('submitting')
      const res = await api.closeSubmit(getAccessToken, campaign.id, getBase64EncodedWireTransaction(signed))
      await refresh()
      if (!res.closed) {
        setError('Sent, but the campaign account is still there. Pull to refresh in a moment.')
        setStep('idle')
        return
      }
      haptics.success()
      setResult({ signature: res.signature, returned: displayShares(asset, BigInt(prepared.summary.returnRaw)) ?? prepared.summary.returnRaw })
      setStep('done')
    } catch (e) {
      if (attempt.current !== mine) return
      haptics.error()
      setWalletStuck(false)
      setError(e instanceof ApiError || e instanceof Error ? e.message : 'Closing did not complete.')
      setStep('idle')
    }
  }

  function confirm() {
    Alert.alert(
      'Close this drop?',
      `It ends the drop for everyone. Your wallet approves one transaction that removes Blink's permission, sends ${leftLabel} back to your wallet and refunds the account deposit. You pay a tiny network fee.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Close drop', style: 'destructive', onPress: () => void run() },
      ],
    )
  }

  if (step === 'done' && result) {
    return (
      <Card style={{ gap: space.sm }} tone="lime">
        <Row>
          <Icon name="check" size={20} stroke={color.lime} strokeWidth={2.4} />
          <T variant="heading">Drop closed</T>
        </Row>
        <T variant="label" color={color.text}>
          {`${result.returned} ${campaign.xstockSymbol} is back in your wallet, Blink's permission is removed and the account deposit was refunded.`}
        </T>
        <Button onPress={() => void Linking.openURL(explorerTxUrl(result.signature, campaign.cluster))} size="sm" variant="secondary">
          View on explorer
        </Button>
      </Card>
    )
  }

  return (
    <Card style={{ gap: space.md }}>
      <Row>
        <Icon name="lock" size={18} stroke={color.textDim} />
        <T variant="heading">Close drop & get stock back</T>
      </Row>
      <T variant="label">{`Ends the drop, removes Blink's permission and returns ${leftLabel} to your wallet in one approval.`}</T>
      <Notice message={error} />
      {walletStuck ? (
        <Notice
          message={
            campaign.cluster === 'mainnet-beta'
              ? 'Your wallet didn’t open. Open your wallet app once, then try again.'
              : 'Your wallet didn’t open. This drop is on devnet: turn on Testnet Mode (Phantom) or switch to Devnet (Solflare), then try again.'
          }
          tone="warn"
        />
      ) : null}
      <Button
        icon="wallet"
        loading={step === 'preparing' || step === 'submitting'}
        disabled={step !== 'idle' && !walletStuck}
        onPress={() => {
          if (walletStuck) {
            attempt.current += 1
            setWalletStuck(false)
            setStep('idle')
            return
          }
          confirm()
        }}
        variant="secondary"
      >
        {step === 'signing' && !walletStuck ? 'Waiting for your wallet…' : walletStuck ? 'Try again' : 'Close drop'}
      </Button>
    </Card>
  )
}
