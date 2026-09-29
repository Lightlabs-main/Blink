import '../global.css'

import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'

import { AppProviders } from '../features/core/data-access/app-providers'

export default function Layout() {
  return (
    <AppProviders>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#09090b' }, animation: 'fade' }} />
    </AppProviders>
  )
}
