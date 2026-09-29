import { usePrivy } from '@privy-io/expo'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { useMemo, useState } from 'react'
import { Text, TextInput, View } from 'react-native'

import { api, ApiError } from '../../lib/api'
import { CAMPAIGN_TYPE_BLURB, CAMPAIGN_TYPE_LABEL, shortAddress } from '../../lib/format'
import { haptics } from '../../lib/haptics'
import { CAMPAIGN_TYPES, type CampaignType, PRODUCT_COPY, rawToUiShares, uiSharesToRawFloor } from '../../shared'
import { Chip, ErrorNote, Muted, Panel, PrimaryButton, Screen, Title } from '../../ui/screen'

type Conversion = { ok: true; raw: bigint; display: string } | { ok: false; error: string }

export default function Create() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const { getAccessToken } = usePrivy()
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.me(getAccessToken) })
  const xstocks = useQuery({ queryKey: ['xstocks'], queryFn: api.xstocks, staleTime: 60_000 })
  const holdings = useQuery({ queryKey: ['holdings'], queryFn: () => api.holdings(getAccessToken), staleTime: 30_000 })

  const [type, setType] = useState<CampaignType>('TAP_RUSH')
  const [mint, setMint] = useState<string | null>(null)
  const [shares, setShares] = useState('')

  const wallets = me.data?.verifiedCreatorWallets ?? []
  const creatorWallet = wallets[0]
  const selected = xstocks.data?.xstocks.find((x) => x.mint === mint) ?? null
  // Raw balance of the selected stock in the creator (funding) wallet; null when unknown.
  const heldRaw = useMemo(() => {
    if (!selected || !creatorWallet || !holdings.data?.available) return null
    const b = holdings.data.wallets.find((w) => w.wallet === creatorWallet)?.balances?.[selected.mint]
    return b === undefined ? null : BigInt(b)
  }, [selected, creatorWallet, holdings.data])
  const heldDisplay =
    heldRaw !== null && selected?.multiplier != null ? rawToUiShares(heldRaw, selected.decimals, selected.multiplier) : null

  // Amount entered in shares; converted to raw base units rounding DOWN so a campaign never promises more
  // than it can pay (DECISIONS D-6). The raw value is what the API stores and the allowance will use.
  const conversion = useMemo((): Conversion | null => {
    if (!selected || !shares) return null
    if (selected.multiplier === null) return { ok: false, error: 'Live price data for this stock is unavailable right now.' }
    try {
      const raw = uiSharesToRawFloor(shares, selected.decimals, selected.multiplier)
      if (raw <= 0n) return { ok: false, error: 'Amount is too small.' }
      return { ok: true, raw, display: rawToUiShares(raw, selected.decimals, selected.multiplier) }
    } catch {
      return { ok: false, error: 'Enter a number like 0.5' }
    }
  }, [selected, shares])

  const create = useMutation({
    mutationFn: async () => {
      if (!selected || !conversion?.ok) throw new Error('Complete the form first')
      return api.createCampaign(getAccessToken, { type, mint: selected.mint, allowanceRaw: conversion.raw.toString() }, creatorWallet)
    },
    onSuccess: ({ campaign }) => {
      haptics.success()
      void queryClient.invalidateQueries({ queryKey: ['my-campaigns'] })
      router.push(`/campaign/${campaign.id}`)
    },
    onError: () => haptics.error(),
  })

  if (me.isSuccess && !creatorWallet) {
    return (
      <Screen>
        <Title kicker="Create">Start a campaign</Title>
        <Panel>
          <Text className="text-lg font-semibold text-white">Creators use their own wallet</Text>
          <Muted>
            Campaign stock comes from your Solana wallet, so sign in with it first. Recipients never need a wallet.
          </Muted>
          <PrimaryButton onPress={() => router.push('/login/wallet')}>Connect my Solana wallet</PrimaryButton>
        </Panel>
      </Screen>
    )
  }

  return (
    <Screen>
      <Title kicker="Create">Start a campaign</Title>
      {creatorWallet ? <Muted>{`Funding wallet: ${shortAddress(creatorWallet)}`}</Muted> : null}
      <ErrorNote message={me.error?.message ?? xstocks.error?.message} />

      <Panel>
        <Text className="text-lg font-semibold text-white">1. How do people earn it?</Text>
        <View className="flex-row flex-wrap gap-2">
          {CAMPAIGN_TYPES.map((t) => (
            <Chip key={t} label={CAMPAIGN_TYPE_LABEL[t]} onPress={() => { haptics.tap(); setType(t) }} selected={type === t} />
          ))}
        </View>
        <Muted>{CAMPAIGN_TYPE_BLURB[type]}</Muted>
      </Panel>

      <Panel>
        <Text className="text-lg font-semibold text-white">2. Which stock?</Text>
        <View className="flex-row flex-wrap gap-2">
          {(xstocks.data?.xstocks ?? []).map((x) => (
            <Chip key={x.mint} label={x.symbol} onPress={() => { haptics.tap(); setMint(x.mint) }} selected={mint === x.mint} />
          ))}
        </View>
        {selected ? <Muted>{selected.name}</Muted> : null}
        {selected && heldDisplay !== null ? (
          <Text className={heldRaw === 0n ? 'text-amber-200' : 'text-zinc-300'}>
            {heldRaw === 0n
              ? `Your wallet holds no ${selected.symbol} yet. You’ll need some to fund this campaign.`
              : `Your wallet holds ${heldDisplay} ${selected.symbol}.`}
          </Text>
        ) : null}
        {selected?.paused ? <ErrorNote message="The issuer has paused this stock. Pick another one." /> : null}
      </Panel>

      <Panel>
        <Text className="text-lg font-semibold text-white">3. Total to give away</Text>
        <TextInput
          className="rounded-xl border border-zinc-700 bg-zinc-950 px-4 py-3 text-lg text-white"
          inputMode="decimal"
          onChangeText={(v) => setShares(v.replace(',', '.'))}
          placeholder="Shares, e.g. 0.5"
          placeholderTextColor="#71717a"
          value={shares}
        />
        {conversion?.ok ? (
          <Muted>{`≈ ${conversion.display} ${selected?.symbol} (rounded down)`}</Muted>
        ) : null}
        {conversion && !conversion.ok ? <ErrorNote message={conversion.error} /> : null}
        {conversion?.ok && heldRaw !== null && conversion.raw > heldRaw ? (
          <Text className="text-amber-200">
            {`That’s more than your wallet holds (${heldDisplay ?? '0'} ${selected?.symbol}). You can save the draft, but you’ll need enough stock before funding.`}
          </Text>
        ) : null}
      </Panel>

      <Panel>
        <Muted>{PRODUCT_COPY.treasuryStatement}</Muted>
        <ErrorNote message={create.error instanceof ApiError || create.error instanceof Error ? create.error.message : null} />
        <PrimaryButton
          disabled={!selected || !conversion?.ok || selected.paused === true || !creatorWallet}
          loading={create.isPending}
          onPress={() => create.mutate()}
        >
          Create draft
        </PrimaryButton>
        <Text className="text-xs leading-5 text-zinc-500">
          This saves a draft. Funding it from your wallet comes next — nothing moves until you approve it in your wallet.
        </Text>
      </Panel>
    </Screen>
  )
}
