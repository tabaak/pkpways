import { AppShell } from '@/components/AppShell'
import { AppProvider } from './providers'

export default function Home() {
  return (
    <AppProvider>
      <AppShell />
    </AppProvider>
  )
}
