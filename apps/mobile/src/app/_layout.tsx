import '../global.css'

import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'

import { FontProvider } from '../design/fonts'
import { color, isNight } from '../design/tokens'
import { AppProviders } from '../features/core/data-access/app-providers'

export default function Layout() {
  return (
    <AppProviders>
      <FontProvider>
        <StatusBar style={isNight ? 'light' : 'dark'} />
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.bg }, animation: 'slide_from_right' }} />
      </FontProvider>
    </AppProviders>
  )
}
