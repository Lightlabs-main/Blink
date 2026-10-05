import { usePrivy } from '@privy-io/expo'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { StyleSheet, TextInput, View } from 'react-native'

import { font } from '../design/fonts'
import { color, radius, space } from '../design/tokens'
import { Button, Chip, NavBar, Notice, Row, Screen, T } from '../design/ui'
import { api } from '../lib/api'
import { haptics } from '../lib/haptics'
import { CLUB_CATEGORIES, CLUB_CATEGORY_LABEL, CLUB_LIMITS, type ClubCategory } from '../shared'

const CATEGORY_HINT: Record<ClubCategory, string> = {
  ASSET: 'Around one stock, e.g. NVDAx',
  ECOSYSTEM: 'Seeker, SKR, ORE…',
  COMMUNITY: 'A creator, builders, an event',
  THEME: 'AI stocks, chips, the Mag 7',
}

/** D-40: start a club. Free and offchain; at most a few per person per day. */
export default function NewClub() {
  const router = useRouter()
  const { getAccessToken } = usePrivy()
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState<ClubCategory>('ASSET')
  const [tags, setTags] = useState('')
  const [priv, setPriv] = useState(false)
  const tagList = [...new Set(tags.toLowerCase().split(/[\s,#]+/).map((t) => t.replace(/[^a-z0-9-]/g, '')).filter((t) => t.length >= 2))].slice(0, CLUB_LIMITS.maxTags)

  const create = useMutation({
    mutationFn: () => api.createClub(getAccessToken, { name: name.trim(), description: description.trim(), category, tags: tagList, visibility: priv ? 'PRIVATE' : 'PUBLIC' }),
    onSuccess: (res) => {
      haptics.success()
      void queryClient.invalidateQueries({ queryKey: ['clubs'] })
      router.replace({ pathname: '/club/[slug]', params: { slug: res.club.slug } })
    },
    onError: () => haptics.error(),
  })
  const ready = name.trim().length >= 3 && description.trim().length >= 10

  return (
    <Screen>
      <NavBar onBack={() => router.back()} title="Start a club" />
      <View style={{ gap: space.sm }}>
        <T variant="overline">Name</T>
        <TextInput maxLength={CLUB_LIMITS.nameMax} onChangeText={setName} placeholder="e.g. AI Stocks Club" placeholderTextColor={color.textMuted} style={styles.input} value={name} />
        <T variant="caption">Don’t use a company’s name as if it were official.</T>
      </View>
      <View style={{ gap: space.sm }}>
        <T variant="overline">What is it about?</T>
        <TextInput
          maxLength={CLUB_LIMITS.descriptionMax}
          multiline
          onChangeText={setDescription}
          placeholder="Who it’s for and what happens here"
          placeholderTextColor={color.textMuted}
          style={[styles.input, { height: 110, textAlignVertical: 'top', paddingTop: 14 }]}
          value={description}
        />
      </View>
      <View style={{ gap: space.sm }}>
        <T variant="overline">Type</T>
        <Row gap={space.sm} style={{ flexWrap: 'wrap' }}>
          {CLUB_CATEGORIES.map((c) => (
            <Chip key={c} label={CLUB_CATEGORY_LABEL[c]} onPress={() => setCategory(c)} selected={category === c} />
          ))}
        </Row>
        <T variant="caption">{CATEGORY_HINT[category]}</T>
      </View>
      <View style={{ gap: space.sm }}>
        <T variant="overline">Tags (optional)</T>
        <TextInput autoCapitalize="none" onChangeText={setTags} placeholder="nvda, tap-rush" placeholderTextColor={color.textMuted} style={styles.input} value={tags} />
        {tagList.length ? <T variant="label" color={color.lime}>{tagList.map((t) => `#${t}`).join('  ')}</T> : null}
      </View>
      <View style={{ gap: space.sm }}>
        <T variant="overline">Who can join</T>
        <Row gap={space.sm}>
          <Chip label="Anyone" onPress={() => setPriv(false)} selected={!priv} />
          <Chip label="Invite only" onPress={() => setPriv(true)} selected={priv} />
        </Row>
        <T variant="caption">{priv ? 'Hidden from Discover. People join with your invite link.' : 'Anyone can find and join it.'}</T>
      </View>
      <Notice message={create.error ? create.error.message : null} />
      <Button disabled={!ready} icon="users" loading={create.isPending} onPress={() => create.mutate()}>
        Start club
      </Button>
    </Screen>
  )
}

const styles = StyleSheet.create({
  input: {
    minHeight: 50,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.border,
    ...font('body'),
    fontSize: 15.5,
    color: color.text,
  },
})
