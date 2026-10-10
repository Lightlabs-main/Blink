import { usePrivy } from '@privy-io/expo'
import { useState } from 'react'
import { Pressable, StyleSheet, TextInput, View } from 'react-native'

import { font } from '../../design/fonts'
import { Icon } from '../../design/icons'
import { PersonName } from '../../design/og'
import { color, radius, space } from '../../design/tokens'
import { Avatar, Button, Notice, Row, T } from '../../design/ui'
import { api, apiUrl, type FoundPerson } from '../../lib/api'
import { haptics } from '../../lib/haptics'

/**
 * Find people on Blink by username or .skr name (paste several at once in `multiple` mode). Found people are shown
 * with their picture and can be removed; names that aren't on Blink, aren't valid names, or are you are flagged.
 */
export function PeoplePicker({ multiple, value, onChange }: { multiple: boolean; value: FoundPerson[]; onChange: (people: FoundPerson[]) => void }) {
  const { getAccessToken } = usePrivy()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [flags, setFlags] = useState<{ missing: string[]; invalid: string[]; you: boolean }>({ missing: [], invalid: [], you: false })
  const [error, setError] = useState<string | null>(null)

  async function onFind() {
    const names = text.trim()
    if (!names) return
    setBusy(true)
    setError(null)
    try {
      const { results } = await api.resolvePeople(getAccessToken, [names])
      const found = results.flatMap((r) => (r.found && !r.isYou ? [r.person] : []))
      setFlags({
        missing: results.flatMap((r) => (!r.found && r.reason === 'NOT_FOUND' ? [r.input] : [])),
        invalid: results.flatMap((r) => (!r.found && r.reason === 'INVALID' ? [r.input] : [])),
        you: results.some((r) => r.found && r.isYou),
      })
      if (found.length) haptics.success()
      else haptics.error()
      const merged = multiple ? [...value, ...found.filter((f) => !value.some((v) => v.handle === f.handle))] : found.slice(0, 1)
      onChange(merged)
      // Keep only what still needs fixing in the box.
      setText(results.flatMap((r) => (!r.found ? [r.input] : [])).join(multiple ? '\n' : ''))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not search right now')
    } finally {
      setBusy(false)
    }
  }

  return (
    <View style={{ gap: space.md }}>
      <View style={styles.inputWrap}>
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          multiline={multiple}
          onChangeText={setText}
          placeholder={multiple ? '@alice, @bob, maris.skr…\nPaste as many names as you like (up to 50)' : '@username or name.skr'}
          placeholderTextColor={color.textMuted}
          selectionColor={color.lime}
          style={[styles.input, font('body'), multiple && { minHeight: 96, textAlignVertical: 'top' }]}
          value={text}
        />
      </View>
      <Button disabled={!text.trim()} icon="search" loading={busy} onPress={() => void onFind()} size="sm" variant="secondary">
        {multiple ? 'Check names' : 'Find'}
      </Button>
      {flags.missing.length ? <Notice message={`Not on Blink: ${flags.missing.join(', ')}`} /> : null}
      {flags.invalid.length ? <Notice message={`Not a Blink name: ${flags.invalid.join(', ')}`} tone="warn" /> : null}
      {flags.you ? <Notice message="You can’t gift yourself, so you were left out." tone="warn" /> : null}
      <Notice message={error} />
      {value.length ? (
        <View style={{ gap: space.sm }}>
          <T variant="overline">{multiple ? `${value.length} ${value.length === 1 ? 'person' : 'people'}` : 'Sending to'}</T>
          {value.map((p) => (
            <Row key={p.handle} style={styles.person}>
              <Avatar label={p.username ?? p.label} size={36} uri={apiUrl(p.avatarUrl)} />
              <View style={{ flex: 1 }}>
                <PersonName style={{ ...font('bodySemi'), fontSize: 15, color: color.text }} who={p} />
                {p.skrName && p.username ? <T variant="caption">{`@${p.username}`}</T> : null}
              </View>
              <Icon name="check" size={16} stroke={color.success} strokeWidth={2.4} />
              <Pressable accessibilityLabel={`Remove ${p.handle}`} hitSlop={10} onPress={() => onChange(value.filter((v) => v.handle !== p.handle))}>
                <Icon name="close" size={16} stroke={color.textMuted} />
              </Pressable>
            </Row>
          ))}
        </View>
      ) : null}
    </View>
  )
}

/** Overlapping profile pictures for a list of people (review steps). */
export function AvatarStack({ people, size = 32 }: { people: FoundPerson[]; size?: number }) {
  const shown = people.slice(0, 8)
  return (
    <Row gap={0}>
      {shown.map((p, i) => (
        <View key={p.handle} style={{ marginLeft: i ? -size / 3 : 0, borderRadius: size, borderWidth: 2, borderColor: color.surface }}>
          <Avatar label={p.username ?? p.label} size={size} uri={apiUrl(p.avatarUrl)} />
        </View>
      ))}
      {people.length > shown.length ? <T style={{ marginLeft: space.sm }} variant="label">{`+${people.length - shown.length}`}</T> : null}
    </Row>
  )
}

const styles = StyleSheet.create({
  inputWrap: { borderRadius: radius.lg, borderWidth: 1, borderColor: color.border, backgroundColor: color.surface, paddingHorizontal: space.lg, paddingVertical: space.sm },
  input: { fontSize: 16, color: color.text, paddingVertical: space.sm },
  person: { paddingVertical: space.xs, alignItems: 'center' },
})
