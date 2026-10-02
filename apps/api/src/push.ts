import type { createPrismaClient } from './prisma-campaign-repo.ts'

/*
 * D-24: push notifications through the Expo push service (which delivers through FCM on Android).
 * Only short, non-sensitive text is sent: no amounts tied to identities, no wallet addresses, no tokens.
 * Sending never throws into the caller; a lost notification must not break a payout or a go-live.
 */

/** Expo push tokens look like `ExponentPushToken[xxxx]` (legacy `ExpoPushToken[...]` is also valid). */
export const EXPO_PUSH_TOKEN_RE = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,200}\]$/

export interface PushTokenStore {
  save(token: string, privyUserId: string, platform: string): Promise<void>
  remove(token: string, privyUserId?: string): Promise<void>
  tokensFor(privyUserId: string): Promise<string[]>
}

export class InMemoryPushTokenStore implements PushTokenStore {
  private readonly rows = new Map<string, { privyUserId: string; platform: string }>()
  async save(token: string, privyUserId: string, platform: string) {
    this.rows.set(token, { privyUserId, platform })
  }
  async remove(token: string, privyUserId?: string) {
    const row = this.rows.get(token)
    if (row && (!privyUserId || row.privyUserId === privyUserId)) this.rows.delete(token)
  }
  async tokensFor(privyUserId: string) {
    return [...this.rows].filter(([, r]) => r.privyUserId === privyUserId).map(([t]) => t)
  }
}

export class PrismaPushTokenStore implements PushTokenStore {
  constructor(private readonly prisma: ReturnType<typeof createPrismaClient>) {}
  async save(token: string, privyUserId: string, platform: string) {
    await this.prisma.pushToken.upsert({ where: { token }, create: { token, privyUserId, platform }, update: { privyUserId, platform } })
  }
  async remove(token: string, privyUserId?: string) {
    await this.prisma.pushToken.deleteMany({ where: privyUserId ? { token, privyUserId } : { token } })
  }
  async tokensFor(privyUserId: string) {
    const rows = await this.prisma.pushToken.findMany({ where: { privyUserId }, select: { token: true }, take: 10, orderBy: { updatedAt: 'desc' } })
    return rows.map((r) => r.token)
  }
}

export interface PushMessage {
  title: string
  body: string
  /** In-app route to open when tapped, e.g. `/campaign/<id>`. */
  url?: string
}

export interface Notifier {
  notify(privyUserId: string, message: PushMessage): Promise<void>
}

export const NOOP_NOTIFIER: Notifier = { notify: async () => {} }

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

interface ExpoTicket {
  status: 'ok' | 'error'
  message?: string
  details?: { error?: string }
}

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'

export class ExpoPushNotifier implements Notifier {
  constructor(
    private readonly deps: {
      store: PushTokenStore
      /** Optional Expo access token ("enhanced push security"); server-side secret, never in the APK. */
      accessToken?: string
      fetch?: Fetch
      log?: { warn: (o: object, msg: string) => void }
    },
  ) {}

  async notify(privyUserId: string, message: PushMessage) {
    try {
      const tokens = await this.deps.store.tokensFor(privyUserId)
      if (!tokens.length) return
      const headers: Record<string, string> = { accept: 'application/json', 'content-type': 'application/json' }
      if (this.deps.accessToken) headers.authorization = `Bearer ${this.deps.accessToken}`
      const body = tokens.map((to) => ({
        to,
        title: message.title,
        body: message.body,
        sound: 'default',
        channelId: 'default',
        priority: 'high',
        data: message.url ? { url: message.url } : {},
      }))
      const doFetch: Fetch = this.deps.fetch ?? (fetch as unknown as Fetch)
      const res = await doFetch(EXPO_PUSH_URL, { method: 'POST', headers, body: JSON.stringify(body) })
      if (!res.ok) {
        this.deps.log?.warn({ status: res.status }, 'push send rejected')
        return
      }
      const tickets = ((await res.json()) as { data?: ExpoTicket[] }).data ?? []
      await Promise.all(
        tickets.map(async (t, i) => {
          if (t.status !== 'error') return
          // The app was uninstalled or the token rotated: forget it so we stop sending.
          if (t.details?.error === 'DeviceNotRegistered') await this.deps.store.remove(tokens[i]!)
          else this.deps.log?.warn({ error: t.details?.error }, 'push ticket error')
        }),
      )
    } catch (err) {
      this.deps.log?.warn({ err: err instanceof Error ? err.message : String(err) }, 'push send failed')
    }
  }
}
