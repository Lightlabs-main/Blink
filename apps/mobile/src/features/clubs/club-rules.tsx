import { useRouter } from 'expo-router'
import { Pressable, StyleSheet, View } from 'react-native'

import { Icon, type IconName } from '../../design/icons'
import { color, radius, space } from '../../design/tokens'
import { Button, Card, Row, T } from '../../design/ui'
import { formatRaw, type QuestEvaluation, type QuestGroup, VERIFIERS } from '../../shared'
import { describeCondition } from '../campaign/quest-panel'
import { type RuleState, type TokenRule, TokenRuleCard } from '../rules/rule-builder'

export const EMPTY_RULES: RuleState = { seeker: false, skrRule: 'off', skrMin: '', oreRule: 'off', oreMin: '' }

/** Existing rules → editor state (the editor only produces these shapes, so they round-trip). */
export function ruleStateFrom(groups: QuestGroup[]): RuleState {
  const s: RuleState = { ...EMPTY_RULES }
  for (const g of groups) {
    const vs = g.conditions.map((c) => c.verifier)
    const min = g.conditions[0]?.minRaw
    if (vs.includes('SEEKER_SGT')) s.seeker = true
    const token = vs.some((v) => v.startsWith('SKR')) ? 'SKR' : vs.some((v) => v.startsWith('ORE')) ? 'ORE' : null
    if (!token || !min) continue
    const rule: TokenRule = g.mode === 'ANY' && vs.length > 1 ? 'either' : vs[0]!.endsWith('_TOTAL') ? 'total' : vs[0]!.endsWith('_STAKED') ? 'stake' : 'hold'
    const display = formatRaw(BigInt(min), VERIFIERS[token === 'SKR' ? 'SKR_BALANCE' : 'ORE_BALANCE'].amount!.decimals)
    if (token === 'SKR') Object.assign(s, { skrRule: rule, skrMin: display })
    else Object.assign(s, { oreRule: rule, oreMin: display })
  }
  return s
}

/** D-41: who can join a club — Seeker owners, SKR / ORE holders or stakers, each with a custom minimum. */
export function ClubRulesEditor({ value, onChange }: { value: RuleState; onChange: (v: RuleState) => void }) {
  return (
    <View style={{ gap: space.md }}>
      <Pressable
        accessibilityRole="switch"
        accessibilityState={{ checked: value.seeker }}
        onPress={() => onChange({ ...value, seeker: !value.seeker })}
        style={[styles.toggle, value.seeker && styles.toggleOn]}
      >
        <Icon name="phone" size={20} stroke={value.seeker ? color.lime : color.textDim} />
        <View style={{ flex: 1 }}>
          <T variant="bodyStrong">Solana Seeker owners only</T>
          <T variant="caption">Proven by the phone’s Seeker Genesis Token.</T>
        </View>
        <View style={[styles.box, value.seeker && styles.boxOn]}>{value.seeker ? <Icon name="check" size={14} stroke={color.onLime} strokeWidth={3} /> : null}</View>
      </Pressable>
      <TokenRuleCard min={value.skrMin} rule={value.skrRule} setMin={(skrMin) => onChange({ ...value, skrMin })} setRule={(skrRule) => onChange({ ...value, skrRule })} token="SKR" />
      <TokenRuleCard min={value.oreMin} rule={value.oreRule} setMin={(oreMin) => onChange({ ...value, oreMin })} setRule={(oreRule) => onChange({ ...value, oreRule })} token="ORE" />
      <T variant="caption">Checked on Solana mainnet against the wallets people verified in Blink when they join. Nobody’s tokens are locked.</T>
    </View>
  )
}

function ctaFor(verifier: string): { label: string; icon: IconName; route: string } | null {
  if (verifier === 'SEEKER_SGT') return { label: 'Connect my Seeker', icon: 'phone', route: '/login/wallet' }
  if (verifier === 'SKR_STAKED' || verifier === 'SKR_TOTAL') return { label: 'Stake SKR in Blink', icon: 'layers', route: '/skr' }
  return { label: 'Verify a wallet', icon: 'wallet', route: '/login/wallet' }
}

/** The rules as a checklist; with an evaluation (after a refused join) each line shows the person's result. */
export function ClubRulesList({ rules, evaluation }: { rules: QuestGroup[]; evaluation?: QuestEvaluation | null }) {
  const router = useRouter()
  if (!rules.length) return null
  const ctas = new Map<string, { label: string; icon: IconName; route: string }>()
  return (
    <Card style={{ gap: space.md }} tone={evaluation ? 'danger' : 'raised'}>
      <Row>
        <Icon name="shield" size={18} stroke={evaluation ? color.danger : color.lime} />
        <T variant="heading">{evaluation ? 'Not yet — who can join' : 'Who can join'}</T>
      </Row>
      {rules.map((g, gi) => (
        <View key={gi} style={{ gap: space.sm }}>
          {g.mode === 'ANY' && g.conditions.length > 1 ? <T variant="caption">Any one of these</T> : null}
          {g.conditions.map((c, ci) => {
            const r = evaluation?.eligibility[gi]?.results[ci]
            const passed = r?.status === 'PASSED'
            if (r && !passed) {
              const cta = ctaFor(c.verifier)
              if (cta) ctas.set(cta.label, cta)
            }
            const def = VERIFIERS[c.verifier]
            const yours = r?.actualRaw && def.amount ? ` · yours: ${formatRaw(BigInt(r.actualRaw), def.amount.decimals)} ${def.amount.symbol}` : ''
            return (
              <Row key={ci} style={{ alignItems: 'flex-start' }}>
                <Icon name={!r ? 'check' : passed ? 'check' : r.status === 'ERROR' ? 'refresh' : 'close'} size={16} stroke={!r ? color.textMuted : passed ? color.lime : color.danger} strokeWidth={2.4} />
                <T style={{ flex: 1 }} variant="label">
                  {`${describeCondition(c)}${yours}${r?.status === 'ERROR' ? ' · couldn’t check right now' : ''}`}
                </T>
              </Row>
            )
          })}
        </View>
      ))}
      {[...ctas.values()].map((c) => (
        <Button icon={c.icon} key={c.label} onPress={() => router.push(c.route as '/skr')} size="sm" style={{ alignSelf: 'flex-start' }} variant="secondary">
          {c.label}
        </Button>
      ))}
    </Card>
  )
}

const styles = StyleSheet.create({
  toggle: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.lg, borderRadius: radius.lg, backgroundColor: color.surface, borderWidth: 1, borderColor: color.border },
  toggleOn: { borderColor: color.limeLine, backgroundColor: color.limeSoft },
  box: { width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, borderColor: color.borderStrong, alignItems: 'center', justifyContent: 'center' },
  boxOn: { backgroundColor: color.lime, borderColor: color.lime },
})
