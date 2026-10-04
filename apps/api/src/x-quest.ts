import { randomInt } from 'node:crypto'

import type { createPrismaClient } from './prisma-campaign-repo.ts'

/*
 * D-39: X task verification without connecting X. Each participant gets a personal code per campaign, posts on X
 * with it (post, quote or reply), and pastes the post link. Blink reads the PUBLIC post through X's official oEmbed
 * endpoint (no login, no API key, no scraping) and checks: the post exists, its text contains the person's code
 * (and the creator's required text, if any), it was posted after the campaign was created, and that X account has
 * not already been used by someone else in the same campaign.
 */

const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
export function newXCode(): string {
  let s = 'BLINK-'
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  return s
}

/** x.com / twitter.com status links (mobile and www too); returns the canonical URL and ids. */
export function parsePostUrl(input: string): { handle: string; postId: string; url: string } | null {
  let u: URL
  try {
    u = new URL(input.trim())
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  if (!/^(www\.|mobile\.)?(x|twitter)\.com$/i.test(u.hostname)) return null
  const m = u.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{5,25})\/?$/)
  if (!m) return null
  return { handle: m[1]!.toLowerCase(), postId: m[2]!, url: `https://x.com/${m[1]}/status/${m[2]}` }
}

/** X ids are snowflakes: the top bits are milliseconds since 2010-11-04 (X's epoch). */
export function postTime(postId: string): Date {
  return new Date(Number((BigInt(postId) >> 22n) + 1288834974657n))
}

function decodeEntities(s: string) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
}

/** The post's own text from the oEmbed blockquote (its first paragraph), tags stripped. */
export function postTextFromEmbed(html: string): string {
  const p = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? ''
  return decodeEntities(p.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
}

export interface FetchedPost {
  authorHandle: string
  text: string
}

export type XFetchResult = { ok: true; post: FetchedPost } | { ok: false; reason: 'NOT_FOUND' | 'UNAVAILABLE' }

export interface XPostReader {
  read(canonicalUrl: string): Promise<XFetchResult>
}

type Fetch = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

/** X's public oEmbed endpoint (publish.x.com): the same data X gives any website that embeds a post. */
export class OEmbedXPostReader implements XPostReader {
  constructor(private readonly fetchImpl: Fetch = fetch as unknown as Fetch) {}
  async read(canonicalUrl: string): Promise<XFetchResult> {
    try {
      const res = await this.fetchImpl(`https://publish.x.com/oembed?url=${encodeURIComponent(canonicalUrl)}&omit_script=1&dnt=true`, {
        signal: AbortSignal.timeout(8000),
        headers: { accept: 'application/json' },
      })
      // Deleted, private (protected) or non-existent posts are not embeddable.
      if (res.status === 404 || res.status === 403) return { ok: false, reason: 'NOT_FOUND' }
      if (!res.ok) return { ok: false, reason: 'UNAVAILABLE' }
      const body = (await res.json()) as { html?: string; author_url?: string }
      const handle = body.author_url?.match(/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})/i)?.[1]
      if (!body.html || !handle) return { ok: false, reason: 'UNAVAILABLE' }
      return { ok: true, post: { authorHandle: handle.toLowerCase(), text: postTextFromEmbed(body.html) } }
    } catch {
      return { ok: false, reason: 'UNAVAILABLE' }
    }
  }
}

export interface StoredXTask {
  campaignId: string
  privyUserId: string
  code: string
  postId: string | null
  postUrl: string | null
  authorHandle: string | null
  verifiedAt: Date | null
}

export class XAccountUsedError extends Error {
  override name = 'XAccountUsedError'
}

export interface XTaskStore {
  getOrCreate(campaignId: string, privyUserId: string): Promise<StoredXTask>
  get(campaignId: string, privyUserId: string): Promise<StoredXTask | null>
  /** Throws XAccountUsedError when that X account or post already verified for another person in the campaign. */
  markVerified(campaignId: string, privyUserId: string, post: { postId: string; postUrl: string; authorHandle: string }): Promise<StoredXTask>
}

export class InMemoryXTaskStore implements XTaskStore {
  private readonly rows = new Map<string, StoredXTask>()
  private key(c: string, u: string) {
    return `${c}|${u}`
  }
  async getOrCreate(campaignId: string, privyUserId: string) {
    const k = this.key(campaignId, privyUserId)
    let r = this.rows.get(k)
    if (!r) {
      r = { campaignId, privyUserId, code: newXCode(), postId: null, postUrl: null, authorHandle: null, verifiedAt: null }
      this.rows.set(k, r)
    }
    return { ...r }
  }
  async get(campaignId: string, privyUserId: string) {
    const r = this.rows.get(this.key(campaignId, privyUserId))
    return r ? { ...r } : null
  }
  async markVerified(campaignId: string, privyUserId: string, post: { postId: string; postUrl: string; authorHandle: string }) {
    for (const r of this.rows.values()) {
      if (r.campaignId === campaignId && r.privyUserId !== privyUserId && r.verifiedAt && (r.authorHandle === post.authorHandle || r.postId === post.postId)) {
        throw new XAccountUsedError()
      }
    }
    const r = this.rows.get(this.key(campaignId, privyUserId))!
    Object.assign(r, { ...post, verifiedAt: new Date() })
    return { ...r }
  }
}

export class PrismaXTaskStore implements XTaskStore {
  constructor(private readonly prisma: ReturnType<typeof createPrismaClient>) {}
  async getOrCreate(campaignId: string, privyUserId: string) {
    const existing = await this.prisma.xTask.findUnique({ where: { campaignId_privyUserId: { campaignId, privyUserId } } })
    if (existing) return existing
    try {
      return await this.prisma.xTask.create({ data: { campaignId, privyUserId, code: newXCode() } })
    } catch {
      // A concurrent request created it first.
      return this.prisma.xTask.findUniqueOrThrow({ where: { campaignId_privyUserId: { campaignId, privyUserId } } })
    }
  }
  async get(campaignId: string, privyUserId: string) {
    return this.prisma.xTask.findUnique({ where: { campaignId_privyUserId: { campaignId, privyUserId } } })
  }
  async markVerified(campaignId: string, privyUserId: string, post: { postId: string; postUrl: string; authorHandle: string }) {
    try {
      return await this.prisma.xTask.update({
        where: { campaignId_privyUserId: { campaignId, privyUserId } },
        data: { ...post, verifiedAt: new Date() },
      })
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') throw new XAccountUsedError()
      throw err
    }
  }
}
