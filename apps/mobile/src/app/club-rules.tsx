import { usePrivy } from '@privy-io/expo'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useState } from 'react'

import { Button, Loading, NavBar, Notice, Screen, T } from '../design/ui'
import { ClubRulesEditor, ruleStateFrom } from '../features/clubs/club-rules'
import { buildRuleGroups, type RuleState } from '../features/rules/rule-builder'
import { api } from '../lib/api'
import { haptics } from '../lib/haptics'

function Editor({ slug, initial }: { slug: string; initial: RuleState }) {
  const router = useRouter()
  const { getAccessToken } = usePrivy()
  const queryClient = useQueryClient()
  const [rules, setRules] = useState(initial)
  const built = buildRuleGroups(rules)
  const save = useMutation({
    mutationFn: () => {
      if (!built.ok) throw new Error(built.error)
      return api.setClubRules(getAccessToken, slug, built.groups)
    },
    onSuccess: () => {
      haptics.success()
      void queryClient.invalidateQueries({ queryKey: ['club', slug] })
      void queryClient.invalidateQueries({ queryKey: ['clubs'] })
      router.back()
    },
    onError: () => haptics.error(),
  })
  return (
    <>
      <T variant="label">Turn on the requirements new members must meet. People already in the club stay.</T>
      <ClubRulesEditor onChange={setRules} value={rules} />
      <Notice message={!built.ok ? built.error : save.error ? save.error.message : null} />
      <Button disabled={!built.ok} icon="check" loading={save.isPending} onPress={() => save.mutate()}>
        {built.ok && built.groups.length === 0 ? 'Save · anyone can join' : 'Save requirements'}
      </Button>
    </>
  )
}

/** D-41: the club owner sets who can join (Seeker, SKR / ORE holders or stakers, custom minimums). */
export default function ClubRules() {
  const router = useRouter()
  const { slug } = useLocalSearchParams<{ slug: string }>()
  const { getAccessToken } = usePrivy()
  const club = useQuery({ queryKey: ['club', String(slug)], queryFn: () => api.club(getAccessToken, String(slug)) })
  if (club.isPending) return <Loading label="Loading club…" />
  return (
    <Screen>
      <NavBar onBack={() => router.back()} title="Who can join" />
      {club.data ? (
        club.data.club.role === 'OWNER' ? (
          <Editor initial={ruleStateFrom(club.data.club.rules)} slug={club.data.club.slug} />
        ) : (
          <Notice message="Only the club’s owner can change who can join." tone="warn" />
        )
      ) : (
        <Notice message={club.error?.message ?? 'Club not found'} />
      )}
    </Screen>
  )
}
