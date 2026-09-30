import { usePrivy } from '@privy-io/expo'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { useMemo, useState } from 'react'
import { Pressable, StyleSheet, TextInput, View } from 'react-native'

import { font } from '../../design/fonts'
import { Icon } from '../../design/icons'
import { color, radius, space } from '../../design/tokens'
import { Badge, Button, Card, Chip, EmptyState, Notice, Row, Screen, Skeleton, StockAvatar, T } from '../../design/ui'
import { api, ApiError } from '../../lib/api'
import { useAssets, useHoldings, useMe } from '../../lib/data'
import { CAMPAIGN_TYPE_BLURB, CAMPAIGN_TYPE_ICON, CAMPAIGN_TYPE_LABEL, shortAddress } from '../../lib/format'
import { haptics } from '../../lib/haptics'
import { CAMPAIGN_TYPES, type CampaignType, PRODUCT_COPY, rawToUiShares, uiSharesToRawFloor } from '../../shared'

type Conversion = { ok: true; raw: bigint; display: string } | { ok: false; error: string }

const STEPS = ['Mechanic', 'Stock', 'Amount', 'Review'] as const

function StepHeader({ step }: { step: number }) {
  return (
    <View style={{ gap: space.md }}>
      <Row gap={6}>
        {STEPS.map((s, i) => (
          <View key={s} style={[styles.progress, { backgroundColor: i <= step ? color.lime : color.surface3 }]} />
        ))}
      </Row>
      <T variant="caption">{`Step ${step + 1} of ${STEPS.length} · ${STEPS[step]}`}</T>
    </View>
  )
}

export default function Create() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const { getAccessToken } = usePrivy()
  const me = useMe()
  const assets = useAssets()
  const holdings = useHoldings()

  const [step, setStep] = useState(0)
  const [type, setType] = useState<CampaignType>('TAP_RUSH')
  const [mint, setMint] = useState<string | null>(null)
  const [shares, setShares] = useState('')

  const creatorWallet = me.data?.verifiedCreatorWallets[0]
  const selected = assets.data?.xstocks.find((x) => x.mint === mint) ?? null

  const heldRaw = useMemo(() => {
    if (!selected || !creatorWallet || !holdings.data?.available) return null
    const b = holdings.data.wallets.find((w) => w.wallet === creatorWallet)?.balances?.[selected.mint]
    return b === undefined ? null : BigInt(b)
  }, [selected, creatorWallet, holdings.data])

  const heldFor = (assetMint: string) => {
    const b = holdings.data?.wallets.find((w) => w.wallet === creatorWallet)?.balances?.[assetMint]
    const a = assets.data?.xstocks.find((x) => x.mint === assetMint)
    return b && a?.multiplier != null ? rawToUiShares(BigInt(b), a.decimals, a.multiplier) : null
  }

  const conversion = useMemo((): Conversion | null => {
    if (!selected || !shares) return null
    if (selected.multiplier === null) return { ok: false, error: 'Live data for this stock is unavailable right now.' }
    try {
      const raw = uiSharesToRawFloor(shares, selected.decimals, selected.multiplier)
      if (raw <= 0n) return { ok: false, error: 'Amount is too small.' }
      return { ok: true, raw, display: rawToUiShares(raw, selected.decimals, selected.multiplier) }
    } catch {
      return { ok: false, error: 'Enter a number like 0.5' }
    }
  }, [selected, shares])

  const overHoldings = conversion?.ok && heldRaw !== null && conversion.raw > heldRaw

  const create = useMutation({
    mutationFn: async () => {
      if (!selected || !conversion?.ok) throw new Error('Complete the form first')
      return api.createCampaign(getAccessToken, { type, mint: selected.mint, allowanceRaw: conversion.raw.toString() }, creatorWallet)
    },
    onSuccess: ({ campaign }) => {
      haptics.success()
      void queryClient.invalidateQueries({ queryKey: ['my-campaigns'] })
      setStep(0)
      setShares('')
      router.push(`/campaign/${campaign.id}`)
    },
    onError: () => haptics.error(),
  })

  function fillFraction(f: number) {
    if (heldRaw === null || !selected || selected.multiplier == null) return
    const raw = (heldRaw * BigInt(Math.round(f * 100))) / 100n
    setShares(rawToUiShares(raw, selected.decimals, selected.multiplier, 8))
  }

  if (me.isPending) {
    return (
      <Screen tabBar>
        <Skeleton height={34} width={200} />
        <Skeleton height={220} radius={20} />
      </Screen>
    )
  }

  if (!creatorWallet) {
    return (
      <Screen tabBar>
        <View style={{ gap: space.sm }}>
          <T variant="overline">Create</T>
          <T variant="display">Give away stock</T>
        </View>
        <EmptyState
          action="Connect my Solana wallet"
          body="Campaign stock comes from your own wallet, so connect it first. It’s added to this account — you stay signed in."
          icon="wallet"
          onAction={() => router.push('/login/wallet')}
          title="Creators use their own wallet"
        />
      </Screen>
    )
  }

  const canNext =
    (step === 0 && Boolean(type)) || (step === 1 && Boolean(selected) && !selected?.paused) || (step === 2 && Boolean(conversion?.ok))

  return (
    <Screen tabBar>
      <View style={{ gap: space.sm }}>
        <T variant="overline">New campaign</T>
        <T variant="display">{step === 0 ? 'How do people earn it?' : step === 1 ? 'Pick a stock' : step === 2 ? 'How much in total?' : 'Review'}</T>
      </View>
      <StepHeader step={step} />

      {step === 0 ? (
        <View style={{ gap: space.md }}>
          {CAMPAIGN_TYPES.map((t) => {
            const on = type === t
            return (
              <Pressable
                key={t}
                onPress={() => {
                  haptics.tap()
                  setType(t)
                }}
                style={[styles.option, on && styles.optionOn]}
              >
                <View style={[styles.optionIcon, on && { backgroundColor: color.lime }]}>
                  <Icon name={CAMPAIGN_TYPE_ICON[t]} size={22} stroke={on ? color.onLime : color.lime} strokeWidth={2} />
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <T variant="bodyStrong">{CAMPAIGN_TYPE_LABEL[t]}</T>
                  <T variant="label">{CAMPAIGN_TYPE_BLURB[t]}</T>
                </View>
                <View style={[styles.radio, on && { borderColor: color.lime }]}>{on ? <View style={styles.radioDot} /> : null}</View>
              </Pressable>
            )
          })}
        </View>
      ) : null}

      {step === 1 ? (
        <View style={{ gap: space.md }}>
          {(assets.data?.xstocks ?? []).map((x) => {
            const on = mint === x.mint
            const held = heldFor(x.mint)
            return (
              <Pressable
                key={x.mint}
                onPress={() => {
                  haptics.tap()
                  setMint(x.mint)
                }}
                style={[styles.option, on && styles.optionOn]}
              >
                <StockAvatar isTest={x.isTest} logo={x.logo} size={44} symbol={x.symbol} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Row gap={6}>
                    <T variant="bodyStrong">{x.symbol}</T>
                    {x.paused ? <Badge label="Paused" tone="danger" /> : null}
                  </Row>
                  <T variant="label" numberOfLines={1}>
                    {x.name}
                  </T>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <T variant="caption">You hold</T>
                  <T variant="numeric" color={held && held !== '0' ? color.text : color.textMuted}>
                    {held ?? '0'}
                  </T>
                </View>
              </Pressable>
            )
          })}
        </View>
      ) : null}

      {step === 2 && selected ? (
        <Card style={{ gap: space.lg }}>
          <Row>
            <StockAvatar isTest={selected.isTest} logo={selected.logo} size={36} symbol={selected.symbol} />
            <T variant="bodyStrong">{selected.symbol}</T>
          </Row>
          <View style={styles.amountWrap}>
            <TextInput
              autoFocus
              inputMode="decimal"
              onChangeText={(v) => setShares(v.replace(',', '.'))}
              placeholder="0.00"
              placeholderTextColor={color.textMuted}
              selectionColor={color.lime}
              style={[styles.amountInput, font('display')]}
              value={shares}
            />
            <T variant="title" color={color.textDim}>
              shares
            </T>
          </View>
          {heldRaw !== null ? (
            <Row gap={space.sm}>
              <Chip label="25%" onPress={() => fillFraction(0.25)} selected={false} />
              <Chip label="50%" onPress={() => fillFraction(0.5)} selected={false} />
              <Chip label="Max" onPress={() => fillFraction(1)} selected={false} />
            </Row>
          ) : null}
          <T variant="caption">{`Wallet ${shortAddress(creatorWallet)} holds ${heldFor(selected.mint) ?? '0'} ${selected.symbol}`}</T>
          {conversion && !conversion.ok ? <Notice message={conversion.error} /> : null}
          {overHoldings ? <Notice message="That’s more than your wallet holds. You can save a draft, but you’ll need enough stock to fund it." tone="warn" /> : null}
        </Card>
      ) : null}

      {step === 3 && selected && conversion?.ok ? (
        <Card style={{ gap: space.lg }}>
          <Row>
            <StockAvatar isTest={selected.isTest} logo={selected.logo} size={48} symbol={selected.symbol} />
            <View>
              <T variant="title">{`${conversion.display} ${selected.symbol}`}</T>
              <T variant="label">{`${CAMPAIGN_TYPE_LABEL[type]} campaign`}</T>
            </View>
          </Row>
          <View style={{ gap: space.md }}>
            {[
              ['Mechanic', CAMPAIGN_TYPE_LABEL[type]],
              ['Stock', selected.name],
              ['Total pool', `${conversion.display} ${selected.symbol} (rounded down)`],
              ['Funding wallet', shortAddress(creatorWallet)],
            ].map(([k, v]) => (
              <Row key={k} style={{ justifyContent: 'space-between' }}>
                <T variant="label">{k}</T>
                <T variant="bodyStrong" style={{ flexShrink: 1, textAlign: 'right' }}>
                  {v}
                </T>
              </Row>
            ))}
          </View>
          <Notice message={PRODUCT_COPY.treasuryStatement} tone="info" />
          <T variant="caption">Saving creates a draft. Nothing leaves your wallet until you fund it and approve in your wallet app.</T>
          <Notice message={create.error instanceof ApiError || create.error instanceof Error ? create.error.message : null} />
        </Card>
      ) : null}

      <Row gap={space.md}>
        {step > 0 ? (
          <Button icon="chevronLeft" onPress={() => setStep((s) => s - 1)} style={{ flex: 1 }} variant="secondary">
            Back
          </Button>
        ) : null}
        {step < 3 ? (
          <Button disabled={!canNext} iconRight="arrowRight" onPress={() => setStep((s) => s + 1)} style={{ flex: 2 }}>
            Continue
          </Button>
        ) : (
          <Button icon="check" loading={create.isPending} onPress={() => create.mutate()} style={{ flex: 2 }}>
            Save draft
          </Button>
        )}
      </Row>
    </Screen>
  )
}

const styles = StyleSheet.create({
  progress: { flex: 1, height: 4, borderRadius: 2 },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.surface,
  },
  optionOn: { borderColor: color.limeLine, backgroundColor: 'rgba(198,255,61,0.06)' },
  optionIcon: { width: 46, height: 46, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: color.limeSoft },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: color.borderStrong, alignItems: 'center', justifyContent: 'center' },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: color.lime },
  amountWrap: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  amountInput: { flex: 1, fontSize: 48, color: color.text, padding: 0 },
})
