import { usePrivy } from '@privy-io/expo'
import { getBase64EncodedWireTransaction, getBase64Encoder, getTransactionDecoder } from '@solana/kit'
import { useQueryClient } from '@tanstack/react-query'
import { useMobileWallet } from '@wallet-ui/react-native-kit'
import { useState } from 'react'
import { Text, View } from 'react-native'

import { api, ApiError, type PreparedFunding } from '../../lib/api'
import { shortAddress } from '../../lib/format'
import { haptics } from '../../lib/haptics'
import { type CampaignSummary, PRODUCT_COPY } from '../../shared'
import { ErrorNote, Muted, Panel, PrimaryButton } from '../../ui/screen'

type Step = 'idle' | 'preparing' | 'review' | 'signing' | 'submitting' | 'done'

function formatSol(lamports: string) {
  const n = Number(lamports) / 1e9
  return n < 0.001 ? n.toFixed(6) : n.toFixed(4)
}

/**
 * Creator-only: fund the campaign account and approve Blink's exact allowance in ONE wallet signature
 * (MASTER_PROMPT §9–§13). The action is explained in plain language before the wallet opens (§26).
 */
export function FundCampaign({ campaign, amountLabel }: { campaign: CampaignSummary; amountLabel: string }) {
  const { getAccessToken } = usePrivy()
  const { connect, signTransactions, account } = useMobileWallet()
  const queryClient = useQueryClient()
  const [step, setStep] = useState<Step>('idle')
  const [plan, setPlan] = useState<PreparedFunding | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [signature, setSignature] = useState<string | null>(null)

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['campaign', campaign.id] }),
      queryClient.invalidateQueries({ queryKey: ['my-campaigns'] }),
      queryClient.invalidateQueries({ queryKey: ['campaigns', 'live'] }),
      queryClient.invalidateQueries({ queryKey: ['holdings'] }),
    ])

  function fail(e: unknown, fallback: string) {
    haptics.error()
    setError(e instanceof ApiError || e instanceof Error ? e.message : fallback)
  }

  async function onPrepare() {
    setError(null)
    setStep('preparing')
    try {
      setPlan(await api.fundingPrepare(getAccessToken, campaign.id))
      setStep('review')
    } catch (e) {
      fail(e, 'Could not prepare funding')
      setStep('idle')
    }
  }

  async function onSign() {
    if (!plan) return
    setError(null)
    try {
      // The wallet must be the campaign's creator wallet.
      const active = account ?? (await connect())
      if (active.address.toString() !== campaign.creatorWallet) {
        throw new Error(`Switch to wallet ${shortAddress(campaign.creatorWallet)} in your wallet app, then try again.`)
      }
      setStep('signing')
      const unsigned = getTransactionDecoder().decode(getBase64Encoder().encode(plan.transaction))
      const signed = await signTransactions(unsigned)
      setStep('submitting')
      const result = await api.fundingSubmit(getAccessToken, campaign.id, getBase64EncodedWireTransaction(signed))
      setSignature(result.signature)
      await refresh()
      if (result.verified) {
        haptics.success()
        setStep('done')
      } else {
        setError('Sent, but the network has not shown the funded account yet. Tap “Check again” in a moment.')
        setStep('idle')
      }
    } catch (e) {
      fail(e, 'Funding did not complete')
      setStep('review')
    }
  }

  async function onVerify() {
    setError(null)
    try {
      const res = await api.fundingVerify(getAccessToken, campaign.id)
      await refresh()
      if (res.verified) haptics.success()
      else setError('Not funded yet. If you signed, wait a few seconds and check again.')
    } catch (e) {
      fail(e, 'Could not check')
    }
  }

  if (step === 'done') {
    return (
      <Panel>
        <Text className="text-lg font-semibold text-emerald-200">Your campaign is live</Text>
        <Muted>{PRODUCT_COPY.treasuryStatement}</Muted>
        {signature ? <Text className="font-mono text-xs text-zinc-500">{`Tx ${shortAddress(signature, 8, 8)}`}</Text> : null}
      </Panel>
    )
  }

  if (step === 'review' || step === 'signing' || step === 'submitting') {
    return (
      <Panel>
        <Text className="text-lg font-semibold text-white">Approve in your wallet</Text>
        <Muted>Your wallet will ask you to approve ONE transaction that:</Muted>
        <View className="gap-2">
          <Text className="text-zinc-200">{`1. Creates your campaign account (${formatSol(plan?.summary.rentLamports ?? '0')} SOL deposit, returned when you close the campaign).`}</Text>
          <Text className="text-zinc-200">{`2. Moves ${amountLabel} from your wallet into that account. You still own it.`}</Text>
          <Text className="text-zinc-200">{`3. Lets Blink hand out up to exactly ${amountLabel} — never more. You can revoke any time.`}</Text>
        </View>
        <Text className="text-xs text-zinc-500">{`Network: ${campaign.cluster} · plus a small network fee`}</Text>
        <ErrorNote message={error} />
        <PrimaryButton disabled={step !== 'review'} onPress={() => void onSign()}>
          {step === 'signing' ? 'Waiting for your wallet…' : step === 'submitting' ? 'Confirming on Solana…' : 'Open wallet to approve'}
        </PrimaryButton>
        {step === 'review' ? (
          <PrimaryButton variant="secondary" onPress={() => { setStep('idle'); setPlan(null) }}>
            Cancel
          </PrimaryButton>
        ) : null}
      </Panel>
    )
  }

  return (
    <Panel>
      <Text className="text-lg font-semibold text-white">Fund & go live</Text>
      <Muted>{`Move ${amountLabel} into a campaign account you own and approve Blink to distribute exactly that amount.`}</Muted>
      <ErrorNote message={error} />
      <PrimaryButton loading={step === 'preparing'} onPress={() => void onPrepare()}>
        Review funding
      </PrimaryButton>
      {campaign.status === 'AWAITING_FUNDING' ? (
        <PrimaryButton variant="secondary" onPress={() => void onVerify()}>
          Check again
        </PrimaryButton>
      ) : null}
    </Panel>
  )
}
