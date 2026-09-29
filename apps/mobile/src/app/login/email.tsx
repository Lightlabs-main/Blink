import { useLoginWithEmail } from '@privy-io/expo'
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { TextInput } from 'react-native'

import { haptics } from '../../lib/haptics'
import { ErrorNote, Muted, Panel, PrimaryButton, Screen, Title } from '../../ui/screen'

const inputClass = 'rounded-xl border border-zinc-700 bg-zinc-950 px-4 py-3 text-lg text-white'

export default function EmailLogin() {
  const router = useRouter()
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
      haptics.tap()
      setStep('code')
    } catch (e) {
      haptics.error()
      setError(e instanceof Error ? e.message : 'Could not send the code')
    } finally {
      setBusy(false)
    }
  }

  async function onVerify() {
    setBusy(true)
    setError(null)
    try {
      await loginWithCode({ code: code.trim(), email: email.trim() })
      haptics.success()
      router.replace('/drops')
    } catch (e) {
      haptics.error()
      setError(e instanceof Error ? e.message : 'That code did not work')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen>
      <Title kicker="Sign in">{step === 'email' ? 'Your email' : 'Check your inbox'}</Title>
      <Muted>
        {step === 'email'
          ? 'We’ll email you a one-time code. A wallet is created for you automatically — nothing to install.'
          : `Enter the code we sent to ${email.trim()}. It expires in 10 minutes.`}
      </Muted>
      <Panel>
        {step === 'email' ? (
          <TextInput
            autoCapitalize="none"
            autoComplete="email"
            autoFocus
            className={inputClass}
            inputMode="email"
            onChangeText={setEmail}
            onSubmitEditing={() => emailValid && void onSend()}
            placeholder="you@example.com"
            placeholderTextColor="#71717a"
            value={email}
          />
        ) : (
          <TextInput
            autoComplete="one-time-code"
            autoFocus
            className={`${inputClass} tracking-[8px]`}
            inputMode="numeric"
            maxLength={6}
            onChangeText={(v) => setCode(v.replace(/\D/g, ''))}
            placeholder="123456"
            placeholderTextColor="#71717a"
            value={code}
          />
        )}
        <ErrorNote message={error} />
        {step === 'email' ? (
          <PrimaryButton disabled={!emailValid} loading={busy} onPress={() => void onSend()}>
            Send code
          </PrimaryButton>
        ) : (
          <>
            <PrimaryButton disabled={code.length !== 6} loading={busy} onPress={() => void onVerify()}>
              Verify and continue
            </PrimaryButton>
            <PrimaryButton variant="secondary" onPress={() => { setStep('email'); setCode(''); setError(null) }}>
              Use a different email
            </PrimaryButton>
          </>
        )}
      </Panel>
    </Screen>
  )
}
