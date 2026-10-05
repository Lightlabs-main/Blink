import { randomBytes } from 'node:crypto'

import { OG_TYPES, type OgType } from '@blink/domain'

import type { createPrismaClient } from './prisma-campaign-repo.ts'

/*
 * D-37: public profiles — an optional unique username and a small profile picture. Pictures are served by a random
 * public id (never the Privy user id) and carry a version so caches refresh when they change.
 */

export const USERNAME_RE = /^[a-z0-9_]{3,20}$/
/** Names that could pass for Blink, an issuer or staff. */
const RESERVED = new Set(['blink', 'blinksol', 'blinktostock', 'admin', 'administrator', 'support', 'help', 'official', 'team', 'staff', 'mod', 'moderator', 'solana', 'solanamobile', 'seeker', 'xstocks', 'backed', 'privy', 'phantom', 'root', 'system', 'null', 'undefined'])

export function usernameProblem(name: string): string | null {
  if (!USERNAME_RE.test(name)) return 'use 3–20 letters, numbers or _'
  if (RESERVED.has(name) || name.startsWith('blink_') || name.endsWith('_official')) return 'that username is reserved'
  return null
}

export const AVATAR_MAX_BYTES = 150 * 1024

/** JPEG (FF D8 FF) or PNG (89 50 4E 47) by magic bytes; the declared type is never trusted. */
export function sniffImage(bytes: Uint8Array): 'image/jpeg' | 'image/png' | null {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  return null
}

export interface StoredProfile {
  privyUserId: string
  publicId: string
  username: string | null
  avatarVersion: number
  hasAvatar: boolean
  /** D-45: OG marks from the last check, and when it ran. */
  og: OgType[]
  ogCheckedAt: Date | null
}

export class UsernameTakenError extends Error {
  override name = 'UsernameTakenError'
}

export interface ProfileStore {
  get(privyUserId: string): Promise<StoredProfile | null>
  getMany(privyUserIds: string[]): Promise<Map<string, StoredProfile>>
  setUsername(privyUserId: string, username: string | null): Promise<StoredProfile>
  setAvatar(privyUserId: string, image: { bytes: Uint8Array; type: string } | null): Promise<StoredProfile>
  avatar(publicId: string): Promise<{ bytes: Uint8Array; type: string } | null>
  setOg(privyUserId: string, og: OgType[]): Promise<StoredProfile>
}

/** The participant fields every public view shares: username, picture and OG marks. */
export function profileExtras(p: StoredProfile | null | undefined): { avatarUrl: string | null; og?: OgType[] } {
  return p?.og.length ? { avatarUrl: avatarPath(p), og: p.og } : { avatarUrl: avatarPath(p) }
}

const newPublicId = () => randomBytes(9).toString('base64url')

/** `/v1/avatars/<publicId>?v=<version>` — relative to the API origin. */
export function avatarPath(p: StoredProfile | null | undefined): string | null {
  return p?.hasAvatar ? `/v1/avatars/${p.publicId}?v=${p.avatarVersion}` : null
}

export class InMemoryProfileStore implements ProfileStore {
  private readonly rows = new Map<string, StoredProfile & { avatar: { bytes: Uint8Array; type: string } | null }>()
  /** username → the account that first used it (kept after it is changed or removed). */
  private readonly claimed = new Map<string, string>()

  private row(privyUserId: string) {
    let r = this.rows.get(privyUserId)
    if (!r) {
      r = { privyUserId, publicId: newPublicId(), username: null, avatarVersion: 0, hasAvatar: false, og: [], ogCheckedAt: null, avatar: null }
      this.rows.set(privyUserId, r)
    }
    return r
  }
  private view(r: StoredProfile): StoredProfile {
    return { privyUserId: r.privyUserId, publicId: r.publicId, username: r.username, avatarVersion: r.avatarVersion, hasAvatar: r.hasAvatar, og: [...r.og], ogCheckedAt: r.ogCheckedAt }
  }
  async get(privyUserId: string) {
    const r = this.rows.get(privyUserId)
    return r ? this.view(r) : null
  }
  async getMany(ids: string[]) {
    const out = new Map<string, StoredProfile>()
    for (const id of ids) {
      const r = this.rows.get(id)
      if (r) out.set(id, this.view(r))
    }
    return out
  }
  async setUsername(privyUserId: string, username: string | null) {
    if (username) {
      const owner = this.claimed.get(username)
      if (owner && owner !== privyUserId) throw new UsernameTakenError()
      this.claimed.set(username, privyUserId)
    }
    const r = this.row(privyUserId)
    r.username = username
    return this.view(r)
  }
  async setAvatar(privyUserId: string, image: { bytes: Uint8Array; type: string } | null) {
    const r = this.row(privyUserId)
    r.avatar = image
    r.hasAvatar = Boolean(image)
    r.avatarVersion += 1
    return this.view(r)
  }
  async avatar(publicId: string) {
    return [...this.rows.values()].find((r) => r.publicId === publicId)?.avatar ?? null
  }
  async setOg(privyUserId: string, og: OgType[]) {
    const r = this.row(privyUserId)
    r.og = og
    r.ogCheckedAt = new Date()
    return this.view(r)
  }
}

type Row = { privyUserId: string; publicId: string; username: string | null; avatarVersion: number; avatarType: string | null; og: string[]; ogCheckedAt: Date | null }
const toOg = (v: string[]) => OG_TYPES.filter((t) => v.includes(t))

export class PrismaProfileStore implements ProfileStore {
  constructor(private readonly prisma: ReturnType<typeof createPrismaClient>) {}

  private view(r: Row): StoredProfile {
    return { privyUserId: r.privyUserId, publicId: r.publicId, username: r.username, avatarVersion: r.avatarVersion, hasAvatar: Boolean(r.avatarType), og: toOg(r.og), ogCheckedAt: r.ogCheckedAt }
  }
  private readonly select = { privyUserId: true, publicId: true, username: true, avatarVersion: true, avatarType: true, og: true, ogCheckedAt: true } as const

  async get(privyUserId: string) {
    const r = await this.prisma.profile.findUnique({ where: { privyUserId }, select: this.select })
    return r ? this.view(r) : null
  }
  async getMany(ids: string[]) {
    const rows = ids.length ? await this.prisma.profile.findMany({ where: { privyUserId: { in: ids } }, select: this.select }) : []
    return new Map(rows.map((r) => [r.privyUserId, this.view(r)]))
  }
  async setUsername(privyUserId: string, username: string | null) {
    try {
      const r = await this.prisma.$transaction(async (tx) => {
        if (username) {
          // A name stays with the account that first used it, even after it is changed or removed.
          const claim = await tx.usernameClaim.findUnique({ where: { username } })
          if (claim && claim.privyUserId !== privyUserId) throw new UsernameTakenError()
          if (!claim) await tx.usernameClaim.create({ data: { username, privyUserId } })
        }
        return tx.profile.upsert({
          where: { privyUserId },
          create: { privyUserId, publicId: newPublicId(), username },
          update: { username },
          select: this.select,
        })
      })
      return this.view(r)
    } catch (err) {
      if (err instanceof UsernameTakenError) throw err
      if ((err as { code?: string }).code === 'P2002') throw new UsernameTakenError()
      throw err
    }
  }
  async setAvatar(privyUserId: string, image: { bytes: Uint8Array; type: string } | null) {
    const data = image ? { avatar: Buffer.from(image.bytes), avatarType: image.type } : { avatar: null, avatarType: null }
    const r = await this.prisma.profile.upsert({
      where: { privyUserId },
      create: { privyUserId, publicId: newPublicId(), ...data, avatarVersion: 1 },
      update: { ...data, avatarVersion: { increment: 1 } },
      select: this.select,
    })
    return this.view(r)
  }
  async avatar(publicId: string) {
    const r = await this.prisma.profile.findUnique({ where: { publicId }, select: { avatar: true, avatarType: true } })
    return r?.avatar && r.avatarType ? { bytes: Uint8Array.from(r.avatar), type: r.avatarType } : null
  }
  async setOg(privyUserId: string, og: OgType[]) {
    const r = await this.prisma.profile.upsert({
      where: { privyUserId },
      create: { privyUserId, publicId: newPublicId(), og, ogCheckedAt: new Date() },
      update: { og, ogCheckedAt: new Date() },
      select: this.select,
    })
    return this.view(r)
  }
}
