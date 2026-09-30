import { useLoginWithEmail } from '@privy-io/expo'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useRef, useState } from 'react'
import { Pressable, StyleSheet, TextInput, View } from 'react-native'

import { font } from '../../design/fonts'
import { Icon } from '../../design/icons'
import { color, radius, space } from '../../design/tokens'
import { Button, NavBar, Notice, Row, Screen, T } from '../../design/ui'
import { haptics } from '../../lib/haptics'

/** Six visible boxes backed by one hidden input (paste and autofill friendly). */
function CodeInput({ value, onChange, onComplete }: { value: string; onChange: (v: string) => void; onComplete: (v: string) => void }) {
  const ref = useRef<TextInput>(null)
  return (
    <Pressable onPress={() => ref.current?.focus()}>
      <Row gap={space.sm} style={{ justifyContent: 'space-between' }}>
        {Array.from({ length: 6 }).map((_, i) => {
          const filled = i < value.length
          const active = i === value.length
          return (
            <View key={i} style={[styles.box, filled && { borderColor: color.borderStrong }, active && { borderColor: color.lime }]}>
              <T style={{ ...font('display'), fontSize: 26, color: color.text }}>{value[i] ?? ''}</T>
            </View>
          )
        })}
      </Row>
      <TextInput
        autoComplete="one-time-code"
        autoFocus
        inputMode="numeric"
        maxLength={6}
        onChangeText={(v) => {
          const digits = v.replace(/\D/g, '').slice(0, 6)
          onChange(digits)
          if (digits.length === 6) onComplete(digits)
        }}
        ref={ref}
        style={styles.hidden}
        textContentType="oneTimeCode"
        value={value}
      />
    </Pressable>
  )
}

export default function EmailLogin() {
  const router = useRouter()
  // Only in-app campaign routes are accepted as a return target (e.g. "Sign in to claim").
  const { next } = useLocalSearchParams<{ next?: string }>()
  const returnTo = typeof next === 'string' && /^\/campaign\/[0-9a-f-]{36}$/.test(next) ? next : null
  const { sendCode, loginWithCode } = useLoginWithEmail()
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [step, setStep] = useState<'email' | 'code'>('email')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const emailValid = /^\S+@\S+\.\S+$/.test(email.trim())

  async function onSend() {
    setBusy(true)
    setError(null)
    try {
      await sendCode({ email: email.trim() })
      setStep('code')
    } catch (e) {
      haptics.error()
      setError(e instanceof Error ? e.message : 'Could not send the code')
    } finally {
      setBusy(false)
    }
  }

  async function onVerify(value = code) {
    if (value.length !== 6 || busy) return
    setBusy(true)
    setError(null)
    try {
      await loginWithCode({ code: value, email: email.trim() })
      haptics.success()
      if (returnTo) {
        router.replace('/home')
        router.push(returnTo as `/campaign/${string}`)
      } else {
        router.replace('/home')
      }
    } catch (e) {
      haptics.error()
      setCode('')
      setError(e instanceof Error ? e.message : 'That code did not work')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen>
      <NavBar onBack={() => (step === 'code' ? setStep('email') : router.back())} />
      <View style={{ gap: space.md }}>
        <View style={styles.badgeIcon}>
          <Icon name="mail" size={24} stroke={color.lime} />
        </View>
        <T variant="display">{step === 'email' ? 'What’s your email?' : 'Enter your code'}</T>
        <T>
          {step === 'email'
            ? 'We’ll send a one-time code. A secure wallet is created for you automatically.'
            : `We sent a 6-digit code to ${email.trim()}. It expires in 10 minutes.`}
        </T>
      </View>

      {step === 'email' ? (
        <View style={{ gap: space.lg }}>
          <View style={styles.inputWrap}>
            <Icon name="mail" size={20} stroke={color.textMuted} />
            <TextInput
              autoCapitalize="none"
              autoComplete="email"
              autoFocus
              inputMode="email"
              onChangeText={setEmail}
              onSubmitEditing={() => emailValid && void onSend()}
              placeholder="you@example.com"
              placeholderTextColor={color.textMuted}
              selectionColor={color.lime}
              style={[styles.input, font('bodyMedium')]}
              value={email}
            />
          </View>
          <Notice message={error} />
          <Button disabled={!emailValid} iconRight="arrowRight" loading={busy} onPress={() => void onSend()}>
            Send code
          </Button>
        </View>
      ) : (
        <View style={{ gap: space.lg }}>
          <CodeInput onChange={setCode} onComplete={(v) => void onVerify(v)} value={code} />
          <Notice message={error} />
          <Button disabled={code.length !== 6} loading={busy} onPress={() => void onVerify()}>
            Verify and continue
          </Button>
          <Button onPress={() => void onSend()} size="md" variant="ghost">
            Resend code
          </Button>
        </View>
      )}
    </Screen>
  )
}

const styles = StyleSheet.create({
  badgeIcon: { width: 52, height: 52, borderRadius: 18, backgroundColor: color.limeSoft, alignItems: 'center', justifyContent: 'center' },
  inputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    height: 58,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.borderStrong,
    backgroundColor: color.surface,
  },
  input: { flex: 1, fontSize: 17, color: color.text },
  box: {
    flex: 1,
    height: 60,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: color.border,
    backgroundColor: color.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hidden: { position: 'absolute', opacity: 0, width: 1, height: 1 },
})
