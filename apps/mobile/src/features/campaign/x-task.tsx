import { usePrivy } from '@privy-io/expo'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Linking, Share, StyleSheet, TextInput, View } from 'react-native'

import { font } from '../../design/fonts'
import { color, radius, space } from '../../design/tokens'
import { Button, Notice, Row, Skeleton, T } from '../../design/ui'
import { api, ApiError } from '../../lib/api'
import { haptics } from '../../lib/haptics'

/**
 * D-39: the X task, without connecting X. 1) Post on X with your personal code (the composer opens pre-filled);
 * 2) paste the post link; Blink checks the public post and the requirement turns green.
 */
export function XTaskPanel({ campaignId, onVerified }: { campaignId: string; onVerified: () => void }) {
  const { getAccessToken } = usePrivy()
  const queryClient = useQueryClient()
  const task = useQuery({ queryKey: ['x-task', campaignId], queryFn: () => api.xTask(getAccessToken, campaignId) })
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const t = task.data?.task

  if (task.isLoading) return <Skeleton height={120} />
  if (!t?.code) return <Notice message={task.error instanceof Error ? task.error.message : 'X tasks are not available right now.'} tone="warn" />
  const postText = t.suggestedText ?? t.code
  if (t.verified) {
    return (
      <T variant="caption" color={color.lime}>
        {`Verified post by @${t.authorHandle ?? ''}`}
      </T>
    )
  }

  async function verify() {
    setError(null)
    setBusy(true)
    try {
      await api.submitXTask(getAccessToken, campaignId, url.trim())
      haptics.success()
      await queryClient.invalidateQueries({ queryKey: ['x-task', campaignId] })
      onVerified()
    } catch (e) {
      haptics.error()
      setError(e instanceof ApiError || e instanceof Error ? e.message : 'Could not check that post.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <View style={styles.box}>
      <Row style={{ justifyContent: 'space-between' }}>
        <T variant="label">Your code</T>
        <T variant="numeric" style={{ fontSize: 16 }}>
          {t.code}
        </T>
      </Row>
      <T variant="caption">
        {`1. Post on X with your code${t.mustInclude ? ` and “${t.mustInclude}”` : ''}. A quote or reply works too.`}
      </T>
      <Row gap={space.sm}>
        <Button icon="arrowUpRight" onPress={() => void Linking.openURL(`https://x.com/intent/post?text=${encodeURIComponent(postText)}`)} size="sm" style={{ flex: 1 }}>
          Post on X
        </Button>
        <Button icon="share" onPress={() => void Share.share({ message: postText })} size="sm" style={{ flex: 1 }} variant="secondary">
          Copy text
        </Button>
      </Row>
      <T variant="caption">2. Paste the link to your post (Share → Copy link in X).</T>
      <View style={styles.field}>
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          inputMode="url"
          onChangeText={setUrl}
          placeholder="https://x.com/you/status/…"
          placeholderTextColor={color.textMuted}
          selectionColor={color.lime}
          style={[styles.input, font('body')]}
          value={url}
        />
      </View>
      <Button disabled={!url.trim() || busy} loading={busy} onPress={() => void verify()} size="sm">
        Verify my post
      </Button>
      <Notice message={error} />
      <T variant="caption">Blink reads the public post only. Your X account isn’t connected and Blink never posts for you.</T>
    </View>
  )
}

const styles = StyleSheet.create({
  box: { gap: space.sm, padding: space.md, borderRadius: radius.lg, backgroundColor: color.surface2, borderWidth: 1, borderColor: color.border },
  field: { borderRadius: radius.md, borderWidth: 1, borderColor: color.border, backgroundColor: color.surface, paddingHorizontal: space.md },
  input: { fontSize: 14.5, paddingVertical: space.md, color: color.text },
})
