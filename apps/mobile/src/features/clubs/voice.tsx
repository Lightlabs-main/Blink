import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Linking, Pressable, StyleSheet, View } from 'react-native'

import { font } from '../../design/fonts'
import { Icon } from '../../design/icons'
import { color, radius, space } from '../../design/tokens'
import { IconButton, Row, T } from '../../design/ui'
import { apiUrl } from '../../lib/api'
import { CLUB_LIMITS } from '../../shared'

/*
 * D-43: club voice notes. AAC in M4A, mono 32 kbps: a 60-second note is about 240 KB (server limit 1 MB).
 * Recording only happens while the person is on the recorder; nothing records in the background.
 */
const VOICE_OPTIONS = { ...RecordingPresets.HIGH_QUALITY, numberOfChannels: 1, bitRate: 32_000, sampleRate: 22_050 }

export function clock(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** One player for the whole chat: starting a note stops the previous one. */
export function useVoicePlayback() {
  const player = useAudioPlayer(null)
  const status = useAudioPlayerStatus(player)
  const [playingId, setPlayingId] = useState<string | null>(null)

  const toggle = useCallback(
    (id: string, path: string) => {
      if (playingId === id) {
        if (status.playing) return player.pause()
        // Finished: start again from the beginning.
        if (status.duration > 0 && status.currentTime >= status.duration - 0.1) void player.seekTo(0).then(() => player.play())
        else player.play()
        return
      }
      const uri = apiUrl(path)
      if (!uri) return
      player.replace({ uri })
      player.play()
      setPlayingId(id)
    },
    [player, playingId, status.playing, status.currentTime, status.duration],
  )

  return { toggle, playingId, playing: status.playing, currentTime: status.currentTime, duration: status.duration, loading: status.isBuffering }
}
export type VoicePlayback = ReturnType<typeof useVoicePlayback>

export function VoiceBubble({ id, url, durationMs, playback, mine }: { id: string; url: string; durationMs: number; playback: VoicePlayback; mine: boolean }) {
  const active = playback.playingId === id
  const total = active && playback.duration > 0 ? playback.duration * 1000 : durationMs
  const at = active ? playback.currentTime * 1000 : 0
  const progress = total > 0 ? Math.min(1, at / total) : 0
  return (
    <Row gap={space.sm} style={styles.bubble}>
      <Pressable accessibilityLabel={active && playback.playing ? 'Pause voice note' : 'Play voice note'} hitSlop={8} onPress={() => playback.toggle(id, url)} style={[styles.play, mine && { backgroundColor: color.marker }]}>
        {active && playback.loading ? (
          <ActivityIndicator color={mine ? color.onMarker : color.text} size="small" />
        ) : active && playback.playing ? (
          <View style={{ flexDirection: 'row', gap: 3 }}>
            <View style={[styles.bar, { backgroundColor: mine ? color.onMarker : color.text }]} />
            <View style={[styles.bar, { backgroundColor: mine ? color.onMarker : color.text }]} />
          </View>
        ) : (
          <View style={[styles.triangle, { borderLeftColor: mine ? color.onMarker : color.text }]} />
        )}
      </Pressable>
      <View style={{ flex: 1, gap: 4 }}>
        <View style={styles.track}>
          <View style={[styles.fill, { width: `${progress * 100}%` }]} />
        </View>
        <T variant="caption">{active && at > 0 ? `${clock(at)} / ${clock(total)}` : clock(durationMs)}</T>
      </View>
      <Icon name="mic" size={16} stroke={color.textMuted} />
    </Row>
  )
}

/** Base64 of a local file (React Native's fetch reads file:// URIs). */
async function fileToBase64(uri: string): Promise<string> {
  const blob = await (await fetch(uri)).blob()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Could not read the recording'))
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''))
    reader.readAsDataURL(blob)
  })
}

/**
 * Inline recorder that replaces the text box: a red dot, the time, cancel and send. Stops itself at 60 seconds.
 * `onSend` gets base64 audio and the duration in ms.
 */
export function VoiceRecorder({ onSend, onClose, sending }: { onSend: (audio: string, durationMs: number) => Promise<void>; onClose: () => void; sending: boolean }) {
  const recorder = useAudioRecorder(VOICE_OPTIONS)
  const state = useAudioRecorderState(recorder, 200)
  const [error, setError] = useState<string | null>(null)
  const started = useRef(false)
  const finishing = useRef(false)
  const finishRef = useRef<(send: boolean) => Promise<void>>(async () => {})

  useEffect(() => {
    let alive = true
    let limitTimer: ReturnType<typeof setTimeout> | undefined
    void (async () => {
      try {
        const perm = await requestRecordingPermissionsAsync()
        if (!perm.granted) {
          if (!perm.canAskAgain) void Linking.openSettings()
          throw new Error('Allow the microphone to send voice notes: Settings → Apps → Blink → Permissions → Microphone.')
        }
        await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true })
        await recorder.prepareToRecordAsync()
        if (!alive) return
        recorder.record()
        started.current = true
        // Hard stop at the limit (sends what was recorded).
        limitTimer = setTimeout(() => void finishRef.current(true), CLUB_LIMITS.voiceMaxMs)
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'Could not start recording')
      }
    })()
    return () => {
      alive = false
      clearTimeout(limitTimer)
      if (started.current && !finishing.current) void recorder.stop().catch(() => {})
      // Pass playsInSilentMode every time: on Android a missing field resets it to false, and then playback on a phone
      // set to vibrate or silent does nothing (the sender couldn't hear their own notes after recording).
      void setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {})
    }
  }, [recorder])

  const finish = useCallback(
    async (send: boolean) => {
      if (finishing.current) return
      finishing.current = true
      const durationMs = Math.min(state.durationMillis, CLUB_LIMITS.voiceMaxMs)
      try {
        if (started.current) await recorder.stop()
        if (!send) return onClose()
        if (durationMs < 700) throw new Error('Hold on — that was too short to send')
        const uri = recorder.uri
        if (!uri) throw new Error('The recording was not saved')
        await onSend(await fileToBase64(uri), durationMs)
        onClose()
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not send the voice note')
        finishing.current = false
        started.current = false
      }
    },
    [onClose, onSend, recorder, state.durationMillis],
  )

  useEffect(() => {
    finishRef.current = finish
  }, [finish])

  return (
    <View style={{ gap: space.xs }}>
      <Row gap={space.sm} style={styles.recorder}>
        <IconButton icon="trash" label="Cancel voice note" onPress={() => void finish(false)} />
        <View style={[styles.dot, { opacity: state.isRecording ? 1 : 0.3 }]} />
        <T style={{ ...font('numeric'), fontSize: 16, color: color.text, flex: 1 }}>
          {`${clock(state.durationMillis)} / ${clock(CLUB_LIMITS.voiceMaxMs)}`}
        </T>
        {sending ? <ActivityIndicator color={color.text} style={{ width: 40 }} /> : <IconButton icon="send" label="Send voice note" onPress={() => void finish(true)} tone="lime" />}
      </Row>
      {error ? (
        <Row style={{ justifyContent: 'space-between' }}>
          <T style={{ flex: 1 }} variant="caption" color={color.danger}>
            {error}
          </T>
          <Pressable hitSlop={8} onPress={onClose}>
            <T variant="caption">Close</T>
          </Pressable>
        </Row>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  bubble: { minWidth: 210, paddingVertical: 2 },
  play: { width: 34, height: 34, borderRadius: 17, backgroundColor: color.surface3, alignItems: 'center', justifyContent: 'center' },
  triangle: { width: 0, height: 0, marginLeft: 3, borderTopWidth: 7, borderBottomWidth: 7, borderLeftWidth: 11, borderTopColor: 'transparent', borderBottomColor: 'transparent' },
  bar: { width: 3.5, height: 12, borderRadius: 1 },
  track: { height: 4, borderRadius: 2, backgroundColor: color.surface3, overflow: 'hidden' },
  fill: { height: 4, backgroundColor: color.marker },
  recorder: { paddingHorizontal: space.sm, minHeight: 52, borderRadius: radius.lg, backgroundColor: color.surface, borderWidth: 1, borderColor: color.border },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: color.danger },
})
