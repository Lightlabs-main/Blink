/**
 * D-40: creates Blink's starter clubs (run by Blink, no owner). Idempotent: existing slugs are left alone.
 * They start with 0 members — member counts always come from real memberships, never from this script.
 * Names say "community around", never "official": none of these clubs is endorsed by the companies named.
 *
 *   npx tsx scripts/seed-clubs.ts          (uses DATABASE_URL from .env; refuses unless it is Blink's database)
 */
import { randomUUID } from 'node:crypto'

import type { ClubCategory } from '@blink/domain'

import { createPrismaClient } from '../apps/api/src/prisma-campaign-repo.ts'
import { newCode, PrismaSocialStore, SlugTakenError } from '../apps/api/src/social-store.ts'
import { assertBlinkDatabase } from './db-guard.ts'

const CLUBS: { slug: string; name: string; description: string; category: ClubCategory; tags: string[] }[] = [
  { slug: 'nvda', name: 'NVDA Club', description: 'Community around NVDAx and NVIDIA exposure: news, drops and Tap Rush competitions. Not affiliated with NVIDIA.', category: 'ASSET', tags: ['nvda', 'tech', 'tap-rush'] },
  { slug: 'seeker', name: 'Seeker Club', description: 'For Solana Seeker owners: Seeker-only drops, quests and tips.', category: 'ECOSYSTEM', tags: ['seeker', 'solana-mobile'] },
  { slug: 'skr', name: 'SKR Club', description: 'SKR holders and stakers: staking-gated drops and community campaigns.', category: 'ECOSYSTEM', tags: ['skr', 'staking'] },
  { slug: 'ore-miners', name: 'ORE Miners Club', description: 'People who mine and stake ORE: mining quests and ORE-gated drops.', category: 'ECOSYSTEM', tags: ['ore', 'mining'] },
]

try {
  process.loadEnvFile('.env')
} catch {
  // rely on process env
}
assertBlinkDatabase(process.env.DATABASE_URL, process.env.BLINK_DATABASE_NAME ?? 'blink_to_stock')
const prisma = createPrismaClient(process.env.DATABASE_URL!)
const store = new PrismaSocialStore(prisma)
for (const c of CLUBS) {
  try {
    await store.createClub({ id: randomUUID(), ...c, visibility: 'PUBLIC', inviteCode: newCode(8), ownerPrivyUserId: null, rules: [] }, null)
    console.log(`created ${c.slug}`)
  } catch (err) {
    if (err instanceof SlugTakenError) console.log(`exists  ${c.slug}`)
    else throw err
  }
}
await prisma.$disconnect()
