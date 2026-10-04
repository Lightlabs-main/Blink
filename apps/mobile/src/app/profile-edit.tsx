import { usePrivy } from '@privy-io/expo'
import { useQueryClient } from '@tanstack/react-query'
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator'
import * as ImagePicker from 'expo-image-picker'
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { Pressable, StyleSheet, TextInput, View } from 'react-native'

import { font } from '../design/fonts'
import { Icon } from '../design/icons'
import { color, radius, space } from '../design/tokens'
import { Avatar, Button, Card, NavBar, Notice, Row, Screen, T } from '../design/ui'
import { api, ApiError, apiUrl } from '../lib/api'
import { useProfile } from '../lib/data'
import { haptics } from '../lib/haptics'
import { userEmail } from '../lib/privy-user'

const USERNAME = /^[a-z0-9_]{3,20}$/

/** D-37: pick a username and a profile picture. Shown in live rooms and on receipts. */
export default function EditProfile() {
  const router = useRouter()
  const { user, getAccessToken } = usePrivy()
  const queryClient = useQueryClient()
  const profile = useProfile()
  const current = profile.data?.profile
  // null until the person types: shows their saved username until then.
  const [draft, setName] = useState<string | null>(null)
  const [busy, setBusy] = useState<'name' | 'photo' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const name = draft ?? current?.username ?? ''

  const cleaned = name.trim().toLowerCase()
  const nameError = cleaned && !USERNAME.test(cleaned) ? 'Use 3–20 letters, numbers or _ (no spaces).' : null
  const changed = cleaned !== (current?.username ?? '')

  async function refresh() {
    await Promise.all([queryClient.invalidateQueries({ queryKey: ['profile'] }), queryClient.invalidateQueries({ queryKey: ['room'] })])
  }

  async function saveName() {
    setError(null)
    setSaved(false)
    setBusy('name')
    try {
      await api.setUsername(getAccessToken, cleaned || null)
      await refresh()
      haptics.success()
      setSaved(true)
    } catch (e) {
      haptics.error()
      setError(e instanceof ApiError || e instanceof Error ? e.message : 'Could not save your username.')
    } finally {
      setBusy(null)
    }
  }

  async function pickPhoto() {
    setError(null)
    try {
      const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 1 })
      if (picked.canceled || !picked.assets[0]) return
      setBusy('photo')
      // Square 256 px JPEG keeps uploads small (the server refuses anything over 150 KB).
      const ctx = ImageManipulator.manipulate(picked.assets[0].uri)
      ctx.resize({ width: 256, height: 256 })
      const rendered = await ctx.renderAsync()
      const out = await rendered.saveAsync({ compress: 0.8, format: SaveFormat.JPEG, base64: true })
      if (!out.base64) throw new Error('Could not read that picture.')
      await api.setAvatar(getAccessToken, out.base64)
      await refresh()
      haptics.success()
    } catch (e) {
      haptics.error()
      setError(e instanceof ApiError || e instanceof Error ? e.message : 'Could not update your picture.')
    } finally {
      setBusy(null)
    }
  }

  async function removePhoto() {
    setBusy('photo')
    try {
      await api.removeAvatar(getAccessToken)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not remove your picture.')
    } finally {
      setBusy(null)
    }
  }

  const avatarUri = apiUrl(current?.avatarUrl)

  return (
    <Screen>
      <NavBar onBack={() => router.back()} title="Edit profile" />

      <View style={{ alignItems: 'center', gap: space.md }}>
        <Pressable accessibilityLabel="Change profile picture" accessibilityRole="button" disabled={busy !== null} onPress={() => void pickPhoto()}>
          <Avatar label={current?.username ?? userEmail(user) ?? 'B'} size={112} uri={avatarUri} />
          <View style={styles.cameraBadge}>
            <Icon name="plus" size={18} stroke={color.onMarker} strokeWidth={2.4} />
          </View>
        </Pressable>
        <Row gap={space.sm}>
          <Button loading={busy === 'photo'} onPress={() => void pickPhoto()} size="sm" variant="secondary">
            {avatarUri ? 'Change picture' : 'Add picture'}
          </Button>
          {avatarUri ? (
            <Button disabled={busy !== null} onPress={() => void removePhoto()} size="sm" variant="ghost">
              Remove
            </Button>
          ) : null}
        </Row>
      </View>

      <Card>
        <View style={{ gap: space.md }}>
          <T variant="heading">Username</T>
          <View style={styles.field}>
            <T variant="bodyStrong" color={color.textMuted}>
              @
            </T>
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={20}
              onChangeText={(v) => {
                setSaved(false)
                setName(v.replace(/\s/g, ''))
              }}
              placeholder="yourname"
              placeholderTextColor={color.textMuted}
              selectionColor={color.lime}
              style={[styles.input, font('bodyMedium')]}
              value={name}
            />
          </View>
          <T variant="caption">{nameError ?? 'Shown in live rooms, leaderboards and on your receipts instead of your wallet address.'}</T>
          <Button disabled={!changed || Boolean(nameError) || busy !== null} loading={busy === 'name'} onPress={() => void saveName()}>
            {cleaned ? 'Save username' : 'Remove username'}
          </Button>
          {saved ? <Notice message="Saved." tone="info" /> : null}
        </View>
      </Card>

      <Notice message={error} />
      <T variant="caption">Your email and wallet stay private. Pick a picture you’re happy for others to see.</T>
    </Screen>
  )
}

const styles = StyleSheet.create({
  cameraBadge: {
    position: 'absolute',
    right: 2,
    bottom: 2,
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: color.marker,
    borderWidth: 3,
    borderColor: color.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: space.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.surface2,
  },
  input: { flex: 1, fontSize: 17, paddingVertical: space.md, color: color.text },
})
