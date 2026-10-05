import { StyleSheet, TextInput, View } from 'react-native'

import { font } from '../../design/fonts'
import { Icon } from '../../design/icons'
import { color, space } from '../../design/tokens'
import { Card, Chip, Row, T } from '../../design/ui'
import { parseAmountToRaw, type QuestGroup, VERIFIERS } from '../../shared'

/** Who-can-join building blocks shared by Create (drops) and Start a club (D-41). Amounts become raw bigint strings. */
export type TokenRule = 'off' | 'hold' | 'stake' | 'either' | 'total'

/** One token rule → one requirement group ("either" becomes an ANY group). */
export function tokenGroup(token: 'SKR' | 'ORE', rule: TokenRule, minRaw: string): QuestGroup | null {
  const held = token === 'SKR' ? 'SKR_BALANCE' : 'ORE_BALANCE'
  const staked = token === 'SKR' ? 'SKR_STAKED' : 'ORE_STAKED'
  if (rule === 'off') return null
  if (rule === 'hold') return { mode: 'ALL', conditions: [{ verifier: held, minRaw }] }
  if (rule === 'stake') return { mode: 'ALL', conditions: [{ verifier: staked, minRaw }] }
  if (rule === 'total' && token === 'SKR') return { mode: 'ALL', conditions: [{ verifier: 'SKR_TOTAL', minRaw }] }
  return { mode: 'ANY', conditions: [{ verifier: held, minRaw }, { verifier: staked, minRaw }] }
}

export function TokenRuleCard({ token, rule, setRule, min, setMin }: { token: 'SKR' | 'ORE'; rule: TokenRule; setRule: (r: TokenRule) => void; min: string; setMin: (v: string) => void }) {
  const rules: [TokenRule, string][] =
    token === 'SKR'
      ? [['off', 'Off'], ['hold', 'Holds'], ['stake', 'Stakes'], ['either', 'Holds or stakes'], ['total', 'Held + staked']]
      : [['off', 'Off'], ['hold', 'Holds'], ['stake', 'Stakes'], ['either', 'Holds or stakes']]
  return (
    <Card style={{ gap: space.md }}>
      <Row>
        <Icon name="layers" size={18} stroke={color.violet} />
        <T variant="heading">{`${token} holders & stakers`}</T>
      </Row>
      <Row gap={space.sm} style={{ flexWrap: 'wrap' }}>
        {rules.map(([r, label]) => (
          <Chip key={r} label={label} onPress={() => setRule(r)} selected={rule === r} />
        ))}
      </Row>
      {rule !== 'off' ? (
        <View style={styles.amountWrap}>
          <TextInput
            inputMode="decimal"
            onChangeText={(v) => setMin(v.replace(',', '.'))}
            placeholder="Minimum"
            placeholderTextColor={color.textMuted}
            selectionColor={color.lime}
            style={[styles.amountInput, font('display'), { fontSize: 30 }]}
            value={min}
          />
          <T variant="heading" color={color.textDim}>
            {token}
          </T>
        </View>
      ) : null}
    </Card>
  )
}

/** "500" SKR → raw string; throws a readable error for empty or zero minimums. */
export function tokenMin(value: string, token: 'SKR' | 'ORE'): string {
  const decimals = VERIFIERS[token === 'SKR' ? 'SKR_BALANCE' : 'ORE_BALANCE'].amount!.decimals
  const raw = parseAmountToRaw(value, decimals)
  if (raw <= 0n) throw new Error(`enter a ${token} minimum above zero`)
  return raw.toString()
}

export interface RuleState {
  seeker: boolean
  skrRule: TokenRule
  skrMin: string
  oreRule: TokenRule
  oreMin: string
}

/** Rule choices → requirement groups (every group must pass). */
export function buildRuleGroups(r: RuleState): { ok: true; groups: QuestGroup[] } | { ok: false; error: string } {
  try {
    const groups: QuestGroup[] = []
    if (r.seeker) groups.push({ mode: 'ALL', conditions: [{ verifier: 'SEEKER_SGT' }] })
    const skr = r.skrRule === 'off' ? null : tokenGroup('SKR', r.skrRule, tokenMin(r.skrMin, 'SKR'))
    const ore = r.oreRule === 'off' ? null : tokenGroup('ORE', r.oreRule, tokenMin(r.oreMin, 'ORE'))
    if (skr) groups.push(skr)
    if (ore) groups.push(ore)
    return { ok: true, groups }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Check the minimums.' }
  }
}

const styles = StyleSheet.create({
  amountWrap: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  amountInput: { flex: 1, fontSize: 48, color: color.text, padding: 0 },
})
