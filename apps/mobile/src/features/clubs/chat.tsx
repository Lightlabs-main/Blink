import { usePrivy } from '@privy-io/expo'
import { useFocusEffect } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native'

import { font } from '../../design/fonts'
import { Icon } from '../../design/icons'
import { color, radius, space } from '../../design/tokens'
import { Avatar, Button, IconButton, Notice, Row, T } from '../../design/ui'
import { api, ApiError, apiUrl } from '../../lib/api'
import { haptics } from '../../lib/haptics'
import { type ChatMessage, CLUB_LIMITS, CLUB_REACTIONS, type ClubReaction } from '../../shared'

const POLL_MS = 3500
/** Every few polls, reload the newest page too, so reactions and deletions on recent messages catch up. */
const RESYNC_EVERY = 5

function time(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/** Plain text only: #tags and @mentions are tinted, nothing is ever parsed as HTML or turned into a link. */
function Body({ text }: { text: string }) {
  const parts = text.split(/([#@][A-Za-z0-9_-]{1,30})/g)
  return (
    <T style={{ ...font('body'), fontSize: 15, lineHeight: 21, color: color.text }}>
      {parts.map((p, i) =>
        /^[#@][A-Za-z0-9_-]+$/.test(p) ? (
          <T key={i} style={{ ...font('bodySemi'), fontSize: 15, lineHeight: 21, color: color.lime }}>
            {p}
          </T>
        ) : (
          p
        ),
      )}
    </T>
  )
}

function merge(prev: ChatMessage[], next: ChatMessage[]) {
  const byId = new Map(prev.map((m) => [m.id, m]))
  for (const m of next) byId.set(m.id, m)
  return [...byId.values()].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
}

/**
 * D-40: club chat. Polled while the screen is focused (stops when you leave). Members post; everyone signed in can
 * read a public club. Tap a message for reactions, reply or delete.
 */
export function ClubChat({ slug, canPost, canModerate, onJoin, joining }: { slug: string; canPost: boolean; canModerate: boolean; onJoin: () => void; joining: boolean }) {
  const { getAccessToken } = usePrivy()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [older, setOlder] = useState<'idle' | 'loading' | 'done'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const latest = useRef<ChatMessage[]>([])
  useEffect(() => {
    latest.current = messages
  }, [messages])

  const loadNewest = useCallback(async () => {
    const res = await api.messages(getAccessToken, slug)
    setMessages((prev) => merge(prev, res.messages))
    if (res.messages.length < CLUB_LIMITS.messagePage) setOlder('done')
  }, [getAccessToken, slug])

  // First page (the screen remounts per club, so `loading` starts true).
  useEffect(() => {
    let alive = true
    api
      .messages(getAccessToken, slug)
      .then((res) => {
        if (!alive) return
        setMessages((prev) => merge(prev, res.messages))
        if (res.messages.length < CLUB_LIMITS.messagePage) setOlder('done')
      })
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : 'Could not load the chat'))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [getAccessToken, slug])

  // Poll only while this screen is in front.
  useFocusEffect(
    useCallback(() => {
      let ticks = 0
      let busy = false
      const id = setInterval(() => {
        if (busy) return
        busy = true
        ticks += 1
        const last = latest.current.at(-1)?.id
        const work = ticks % RESYNC_EVERY === 0 || !last ? loadNewest() : api.messages(getAccessToken, slug, { after: last }).then((r) => setMessages((prev) => merge(prev, r.messages)))
        work
          .then(() => setError(null))
          .catch(() => setError('Reconnecting…'))
          .finally(() => {
            busy = false
          })
      }, POLL_MS)
      return () => clearInterval(id)
    }, [getAccessToken, slug, loadNewest]),
  )

  async function loadOlder() {
    const first = messages[0]?.id
    if (!first || older !== 'idle') return
    setOlder('loading')
    try {
      const res = await api.messages(getAccessToken, slug, { before: first })
      setMessages((prev) => merge(prev, res.messages))
      setOlder(res.messages.length < CLUB_LIMITS.messagePage ? 'done' : 'idle')
    } catch {
      setOlder('idle')
    }
  }

  async function send() {
    const body = text.trim()
    if (!body || sending) return
    setSending(true)
    try {
      const res = await api.sendMessage(getAccessToken, slug, body, replyTo?.id)
      haptics.tap()
      setText('')
      setReplyTo(null)
      setMessages((prev) => merge(prev, [res.message]))
      setError(null)
    } catch (e) {
      haptics.error()
      // Keep the text so the person can retry.
      setError(e instanceof ApiError ? e.message : 'Not sent — check your connection and try again')
    } finally {
      setSending(false)
    }
  }

  async function react(m: ChatMessage, emoji: ClubReaction) {
    setSelected(null)
    try {
      const res = await api.react(getAccessToken, slug, m.id, emoji)
      haptics.tap()
      setMessages((prev) => merge(prev, [res.message]))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not react')
    }
  }

  async function remove(m: ChatMessage) {
    setSelected(null)
    try {
      await api.deleteMessage(getAccessToken, slug, m.id)
      setMessages((prev) => merge(prev, [{ ...m, deleted: true, body: '', reactions: [] }]))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete')
    }
  }

  function report(m: ChatMessage) {
    setSelected(null)
    Alert.alert('Report this message?', 'If several members report it, Blink hides it from the club.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Report',
        style: 'destructive',
        onPress: () =>
          void api
            .reportMessage(getAccessToken, slug, m.id)
            .then((r) => {
              haptics.tap()
              if (r.hidden) setMessages((prev) => merge(prev, [{ ...m, deleted: true, body: '', reactions: [] }]))
              Alert.alert('Thanks', 'Your report was sent.')
            })
            .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not report')),
      },
    ])
  }

  const data = [...messages].reverse()

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={color.text} />
        </View>
      ) : (
        <FlatList
          contentContainerStyle={{ paddingVertical: space.md, gap: space.md }}
          data={data}
          inverted
          keyExtractor={(m) => m.id}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            <View style={[styles.center, { transform: [{ scaleY: -1 }] }]}>
              <Icon name="chat" size={28} stroke={color.textMuted} />
              <T align="center" variant="label">
                No messages yet. Say hi 👋
              </T>
            </View>
          }
          ListFooterComponent={
            older === 'loading' ? <ActivityIndicator color={color.textMuted} /> : older === 'idle' && messages.length ? (
              <Pressable onPress={() => void loadOlder()} style={{ alignSelf: 'center', padding: space.sm }}>
                <T variant="caption">Load earlier messages</T>
              </Pressable>
            ) : null
          }
          onEndReached={() => void loadOlder()}
          onEndReachedThreshold={0.2}
          renderItem={({ item: m }) => (
            <Pressable onPress={() => setSelected((s) => (s === m.id ? null : m.id))} style={[styles.msg, m.mine && styles.mine]}>
              <Row style={{ alignItems: 'flex-start' }} gap={space.sm}>
                <Avatar label={m.author.username ?? m.author.label} size={30} uri={apiUrl(m.author.avatarUrl)} />
                <View style={{ flex: 1, gap: 3 }}>
                  <Row gap={6}>
                    <T style={{ ...font('bodySemi'), fontSize: 13, color: m.mine ? color.lime : color.text }}>{m.author.label}</T>
                    <T variant="caption">{time(m.createdAt)}</T>
                  </Row>
                  {m.replyTo ? (
                    <View style={styles.quote}>
                      <T numberOfLines={2} variant="caption">
                        {`${m.replyTo.author.label}: ${m.replyTo.body || 'deleted message'}`}
                      </T>
                    </View>
                  ) : null}
                  {m.deleted ? (
                    <T style={{ ...font('body'), fontStyle: 'italic', fontSize: 14, color: color.textMuted }}>Message deleted</T>
                  ) : (
                    <Body text={m.body} />
                  )}
                  {m.reactions.length ? (
                    <Row gap={6} style={{ flexWrap: 'wrap' }}>
                      {m.reactions.map((r) => (
                        <Pressable disabled={!canPost} key={r.emoji} onPress={() => void react(m, r.emoji)} style={[styles.reaction, r.mine && styles.reactionMine]}>
                          <T style={{ fontSize: 13 }}>{`${r.emoji} ${r.count}`}</T>
                        </Pressable>
                      ))}
                    </Row>
                  ) : null}
                  {selected === m.id && !m.deleted && canPost ? (
                    <Row gap={6} style={{ flexWrap: 'wrap', marginTop: 4 }}>
                      {CLUB_REACTIONS.map((e) => (
                        <Pressable accessibilityLabel={`React ${e}`} key={e} onPress={() => void react(m, e)} style={styles.reaction}>
                          <T style={{ fontSize: 16 }}>{e}</T>
                        </Pressable>
                      ))}
                      <Pressable
                        accessibilityLabel="Reply"
                        onPress={() => {
                          setReplyTo(m)
                          setSelected(null)
                        }}
                        style={styles.reaction}
                      >
                        <Icon name="reply" size={16} stroke={color.text} />
                      </Pressable>
                      {!m.mine ? (
                        <Pressable accessibilityLabel="Report message" onPress={() => report(m)} style={styles.reaction}>
                          <T style={{ fontSize: 12, color: color.textMuted }}>Report</T>
                        </Pressable>
                      ) : null}
                      {m.mine || canModerate ? (
                        <Pressable accessibilityLabel="Delete message" onPress={() => void remove(m)} style={styles.reaction}>
                          <Icon name="trash" size={16} stroke={color.danger} />
                        </Pressable>
                      ) : null}
                    </Row>
                  ) : null}
                </View>
              </Row>
            </Pressable>
          )}
          style={{ flex: 1 }}
        />
      )}

      {error ? <Notice message={error} tone={error === 'Reconnecting…' ? 'warn' : 'danger'} /> : null}

      {canPost ? (
        <View style={{ gap: space.xs, paddingTop: space.sm }}>
          {replyTo ? (
            <Row style={styles.replyBar}>
              <Icon name="reply" size={14} stroke={color.textMuted} />
              <T numberOfLines={1} style={{ flex: 1 }} variant="caption">{`Replying to ${replyTo.author.label}: ${replyTo.body}`}</T>
              <Pressable accessibilityLabel="Cancel reply" hitSlop={8} onPress={() => setReplyTo(null)}>
                <Icon name="close" size={14} stroke={color.textMuted} />
              </Pressable>
            </Row>
          ) : null}
          <Row gap={space.sm}>
            <TextInput
              maxLength={CLUB_LIMITS.messageMax}
              multiline
              onChangeText={setText}
              placeholder="Message the club"
              placeholderTextColor={color.textMuted}
              style={styles.input}
              value={text}
            />
            {sending ? <ActivityIndicator color={color.text} style={{ width: 40 }} /> : <IconButton icon="send" label="Send" onPress={() => void send()} tone="lime" />}
          </Row>
        </View>
      ) : (
        <Button icon="users" loading={joining} onPress={onJoin} style={{ marginTop: space.sm }}>
          Join to chat
        </Button>
      )}
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.sm, paddingVertical: space.huge },
  msg: { padding: space.md, borderRadius: radius.md, backgroundColor: color.surface, borderWidth: 1, borderColor: color.border },
  mine: { backgroundColor: color.surface2 },
  quote: { borderLeftWidth: 2, borderColor: color.limeLine, paddingLeft: space.sm },
  reaction: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: radius.pill, backgroundColor: color.surface3, borderWidth: 1, borderColor: color.border },
  reactionMine: { borderColor: color.limeLine, backgroundColor: color.limeSoft },
  replyBar: { paddingHorizontal: space.md, paddingVertical: 6, borderRadius: radius.sm, backgroundColor: color.surface2 },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 120,
    paddingHorizontal: space.lg,
    paddingTop: 11,
    paddingBottom: 11,
    borderRadius: radius.lg,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.border,
    ...font('body'),
    fontSize: 15,
    color: color.text,
  },
})
