import '../global.css'

import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'

import { FontProvider } from '../design/fonts'
import { color } from '../design/tokens'
import { AppProviders } from '../features/core/data-access/app-providers'

export default function Layout() {
  return (
    <AppProviders>
      <FontProvider>
        <StatusBar style="light" />
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.bg }, animation: 'slide_from_right' }} />
      </FontProvider>
    </AppProviders>
  )
}
