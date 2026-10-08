import { Linking } from 'react-native'

/** D-48: SKR is staked on Solana Mobile's official surfaces, not in Blink. */
export const SKR_OFFICIAL_STAKING_URL = 'https://stake.solanamobile.com'
export const SKR_STAKE_LABEL = 'Stake on Solana Mobile'
export const SKR_SEED_VAULT_NOTE = 'Opens stake.solanamobile.com. On a Seeker you can also stake in Seed Vault Wallet. Blink counts your stake once it’s onchain.'

/** Opens the official staking site in the phone's browser (outside Blink). */
export function openOfficialSkrStaking() {
  void Linking.openURL(SKR_OFFICIAL_STAKING_URL)
}
