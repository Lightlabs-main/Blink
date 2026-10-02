import {
  prepareSkrStakeTransaction,
  readSkrPosition,
  SKR_GUARDIAN_POOL,
  type SkrPosition,
  SkrStakeError,
  skrSharesForAmount,
  type SkrStakeInput,
  type SkrStakeAction,
} from '@blink/solana'
import {
  address,
  type GetAccountInfoApi,
  type GetGenesisHashApi,
  type GetLatestBlockhashApi,
  type Rpc,
  type SimulateTransactionApi,
} from '@solana/kit'

/** Mainnet-beta genesis hash, VERIFIED against the live cluster 2026-10-01. */
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'

export interface SkrPositionSummary {
  wallet: string
  guardianPool: string
  walletRaw: string
  stakedRaw: string
  unstakingRaw: string
  minStakeRaw: string
  cooldownSeconds: number
  /** ISO time the pending unstake can be withdrawn; null when nothing is unstaking. */
  withdrawableAt: string | null
}

export interface PreparedSkrAction {
  transaction: string
  minContextSlot: string
  lastValidBlockHeight: string
}

export interface SkrStaking {
  position(wallet: string): Promise<SkrPositionSummary>
  prepare(wallet: string, action: SkrStakeAction, amountRaw?: bigint, all?: boolean): Promise<PreparedSkrAction>
}

export function summarizePosition(p: SkrPosition): SkrPositionSummary {
  return {
    wallet: p.wallet,
    guardianPool: SKR_GUARDIAN_POOL,
    walletRaw: p.walletRaw.toString(),
    stakedRaw: p.stakedRaw.toString(),
    unstakingRaw: p.unstakingRaw.toString(),
    minStakeRaw: p.minStakeRaw.toString(),
    cooldownSeconds: Number(p.cooldownSeconds),
    withdrawableAt: p.unstakingRaw > 0n ? new Date(Number(p.unstakeTimestamp + p.cooldownSeconds) * 1000).toISOString() : null,
  }
}

/**
 * D-23: in-app SKR staking on MAINNET. The server only reads and builds; the user's own wallet is fee payer and only
 * signer, signs in their wallet app and sends it. Blink never holds, moves or sends SKR or any transaction here.
 */
export class MainnetSkrStaking implements SkrStaking {
  private ready: Promise<void> | null = null

  constructor(private readonly rpc: Rpc<GetAccountInfoApi & GetGenesisHashApi & GetLatestBlockhashApi & SimulateTransactionApi>) {}

  private check() {
    this.ready ??= (async () => {
      const genesis = await this.rpc.getGenesisHash().send()
      if (genesis !== MAINNET_GENESIS) throw new Error(`SKR RPC is not mainnet-beta (genesis ${genesis})`)
    })().catch((err: unknown) => {
      this.ready = null
      throw err
    })
    return this.ready
  }

  async position(wallet: string) {
    await this.check()
    return summarizePosition(await readSkrPosition(this.rpc, address(wallet)))
  }

  async prepare(wallet: string, action: SkrStakeAction, amountRaw?: bigint, all?: boolean) {
    await this.check()
    const user = address(wallet)
    const p = await readSkrPosition(this.rpc, user)
    let input: SkrStakeInput
    switch (action) {
      case 'stake': {
        const amount = all ? p.walletRaw : (amountRaw ?? 0n)
        if (amount <= 0n) throw new SkrStakeError('INVALID', 'Enter an amount to stake.')
        if (amount > p.walletRaw) throw new SkrStakeError('INVALID', 'That is more SKR than this wallet holds.')
        if (amount < p.minStakeRaw) throw new SkrStakeError('INVALID', 'Below the minimum stake amount.')
        input = { action, user, amountRaw: amount }
        break
      }
      case 'unstake': {
        if (p.shares === 0n) throw new SkrStakeError('INVALID', 'Nothing is staked with this wallet.')
        if (p.unstakingRaw > 0n) throw new SkrStakeError('INVALID', 'Finish or cancel the pending unstake first.')
        const shares = all ? p.shares : skrSharesForAmount(amountRaw ?? 0n, p.sharePrice, p.shares)
        if (shares <= 0n) throw new SkrStakeError('INVALID', 'Enter an amount to unstake.')
        input = { action, user, shares }
        break
      }
      case 'cancel_unstake':
      case 'withdraw':
        if (p.unstakingRaw === 0n) throw new SkrStakeError('INVALID', 'Nothing is unstaking.')
        input = { action, user }
        break
    }
    const prepared = await prepareSkrStakeTransaction(this.rpc, input)
    return {
      transaction: prepared.transaction,
      minContextSlot: prepared.minContextSlot.toString(),
      lastValidBlockHeight: prepared.lastValidBlockHeight.toString(),
    }
  }
}
