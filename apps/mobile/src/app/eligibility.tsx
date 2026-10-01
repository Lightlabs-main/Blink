import { usePrivy } from '@privy-io/expo'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useMemo, useState } from 'react'
import { Pressable, StyleSheet, TextInput, View } from 'react-native'

import { font } from '../design/fonts'
import { Icon } from '../design/icons'
import { color, radius, space } from '../design/tokens'
import { Button, Card, NavBar, Notice, Row, Screen, T } from '../design/ui'
import { sentence } from '../features/campaign/claim-panel'
import { api, ApiError } from '../lib/api'
import { COUNTRIES } from '../lib/countries'
import { haptics } from '../lib/haptics'
import { XSTOCK_POLICY, type XStockEligibilityReason } from '../shared'

const REASON_TEXT: Record<XStockEligibilityReason, string> = {
  ELIGIBLE: 'You can receive xStocks on Blink.',
  US_PERSON: 'xStocks are not available to U.S. persons.',
  DECLARED_COUNTRY_RESTRICTED: 'xStocks are not available in your country.',
  IP_COUNTRY_RESTRICTED: 'xStocks are not available where you are connecting from.',
  IP_COUNTRY_UNKNOWN: 'We could not confirm where you are connecting from. Try again on mobile data or another network.',
  REGION_ATTESTATION_MISSING: 'Please answer the region question.',
  INVALID_COUNTRY: 'Please choose your country.',
}

/** Return targets accepted after confirming (in-app campaign and Tap Rush routes only). */
function safeNext(next: unknown): string | null {
  return typeof next === 'string' && /^\/(campaign|tap-rush)\/[0-9a-f-]{36}(\?ref=[2-9A-HJ-NP-Z]{8})?$/.test(next) ? next : null
}

function Check({ on, label, onPress }: { on: boolean; label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: on }} onPress={onPress} style={styles.check}>
      <View style={[styles.box, on && styles.boxOn]}>{on ? <Icon name="check" size={14} stroke={color.onLime} strokeWidth={3} /> : null}</View>
      <T variant="bodyStrong" style={{ flex: 1 }}>
        {label}
      </T>
    </Pressable>
  )
}

/**
 * D-20 xStocks eligibility: the user declares their country and confirms they are not a U.S. person; the server
 * decides (cross-checking the connection's country) and keeps only the result. Never shown to anyone else.
 */
export default function Eligibility() {
  const router = useRouter()
  const { next } = useLocalSearchParams<{ next?: string }>()
  const returnTo = safeNext(next)
  const { getAccessToken, user } = usePrivy()
  const queryClient = useQueryClient()
  const current = useQuery({ queryKey: ['eligibility'], queryFn: () => api.myEligibility(getAccessToken), enabled: Boolean(user) })

  const [query, setQuery] = useState('')
  const [country, setCountry] = useState<string | null>(null)
  const [notUsPerson, setNotUsPerson] = useState(false)
  const [notOccupied, setNotOccupied] = useState(false)
  const needsRegion = country !== null && XSTOCK_POLICY.regionAttestations[country] === 'NOT_IN_OCCUPIED_REGION'

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? COUNTRIES.filter((c) => c.name.toLowerCase().includes(q) || c.code.toLowerCase() === q).slice(0, 8) : []
  }, [query])

  const declare = useMutation({
    mutationFn: () =>
      api.declareEligibility(getAccessToken, {
        country: country!,
        notUsPerson,
        attestations: needsRegion && notOccupied ? ['NOT_IN_OCCUPIED_REGION'] : [],
      }),
    onSuccess: (res) => {
      queryClient.setQueryData(['eligibility'], res)
      if (res.eligibility.eligible) haptics.success()
      else haptics.error()
    },
    onError: () => haptics.error(),
  })

  const decided = declare.data?.eligibility ?? (current.data?.eligibility?.current ? current.data.eligibility : null)
  const back = () => (router.canGoBack() ? router.back() : router.replace('/home'))
  const selectedName = COUNTRIES.find((c) => c.code === country)?.name

  return (
    <Screen>
      <NavBar onBack={back} />
      <View style={{ gap: space.md }}>
        <View style={styles.badge}>
          <Icon name="shield" size={24} stroke={color.lime} />
        </View>
        <T variant="display">Where do you live?</T>
        <T>
          xStocks are tokenized securities with legal restrictions on where they can be offered. Blink keeps only your country and
          the result — never your address, location or ID.
        </T>
      </View>

      {decided ? (
        <Card style={{ gap: space.md }} tone={decided.eligible ? 'lime' : 'danger'}>
          <Row>
            <Icon name={decided.eligible ? 'check' : 'close'} size={20} stroke={decided.eligible ? color.lime : color.danger} />
            <T variant="heading">{decided.eligible ? 'You’re eligible' : 'Not available for you'}</T>
          </Row>
          <T variant="label" color={color.text}>
            {REASON_TEXT[decided.reason]}
          </T>
          {decided.eligible && returnTo ? (
            <Button iconRight="arrowRight" onPress={() => router.replace(returnTo as `/campaign/${string}`)}>
              Continue
            </Button>
          ) : (
            <Button onPress={back} variant="secondary">
              Done
            </Button>
          )}
          <Pressable onPress={() => declare.reset()}>
            <T variant="caption" align="center">
              Answer again
            </T>
          </Pressable>
        </Card>
      ) : (
        <Card style={{ gap: space.lg }}>
          <View style={{ gap: space.sm }}>
            <T variant="heading">Country of residence</T>
            {country ? (
              <Pressable onPress={() => setCountry(null)} style={styles.selected}>
                <T variant="bodyStrong" style={{ flex: 1 }}>
                  {selectedName}
                </T>
                <T variant="caption">Change</T>
              </Pressable>
            ) : (
              <>
                <TextInput
                  autoCorrect={false}
                  onChangeText={setQuery}
                  placeholder="Search countries"
                  placeholderTextColor={color.textMuted}
                  selectionColor={color.lime}
                  style={[styles.input, font('bodyMedium')]}
                  value={query}
                />
                {matches.map((c) => (
                  <Pressable
                    key={c.code}
                    onPress={() => {
                      haptics.tap()
                      setCountry(c.code)
                      setQuery('')
                      setNotOccupied(false)
                    }}
                    style={styles.option}
                  >
                    <T variant="bodyStrong">{c.name}</T>
                  </Pressable>
                ))}
              </>
            )}
          </View>
          <Check label="I am not a U.S. person and I am not in the United States." on={notUsPerson} onPress={() => setNotUsPerson((v) => !v)} />
          {needsRegion ? <Check label="I am not in an occupied region of Ukraine." on={notOccupied} onPress={() => setNotOccupied((v) => !v)} /> : null}
          <Notice message={declare.error instanceof ApiError || declare.error instanceof Error ? sentence(declare.error.message) : null} />
          <Button disabled={!country || !notUsPerson || (needsRegion && !notOccupied)} loading={declare.isPending} onPress={() => declare.mutate()}>
            Confirm
          </Button>
          <T variant="caption">
            Your answer must be true. Blink also checks the country of your internet connection. Policy {XSTOCK_POLICY.version}.
          </T>
        </Card>
      )}
    </Screen>
  )
}

const styles = StyleSheet.create({
  badge: { width: 52, height: 52, borderRadius: 18, backgroundColor: color.limeSoft, alignItems: 'center', justifyContent: 'center' },
  input: {
    height: 50,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.borderStrong,
    backgroundColor: color.surface,
    color: color.text,
    fontSize: 16,
  },
  option: { paddingVertical: 12, paddingHorizontal: space.md, borderRadius: radius.sm, backgroundColor: color.surface2 },
  selected: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: color.limeLine },
  check: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  box: { width: 24, height: 24, borderRadius: 7, borderWidth: 2, borderColor: color.borderStrong, alignItems: 'center', justifyContent: 'center', marginTop: 2 },
  boxOn: { backgroundColor: color.lime, borderColor: color.lime },
})
