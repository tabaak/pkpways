'use client'

import dynamic from 'next/dynamic'
import { useEffect, useMemo, useState } from 'react'
import { useApp } from '@/app/providers'
import { tickTrains } from '@/lib/geo'
import { TRAINS } from '@/lib/trains'
import { TopBar } from './TopBar'
import { TrainDetailsPanel } from './TrainDetailsPanel'
import { TrainGlyph } from './icons'

// Leaflet only runs in the browser, so load the map with SSR disabled.
const MapView = dynamic(() => import('./MapView'), {
  ssr: false,
  loading: () => <MapLoading />,
})

function MapLoading() {
  return (
    <div className="grid h-full w-full place-items-center bg-[#dfe7ee] dark:bg-[#0b1220]">
      <div className="flex flex-col items-center gap-3 text-slate-400 dark:text-slate-500">
        <span className="grid h-12 w-12 animate-pulse place-items-center rounded-2xl bg-gradient-to-br from-sky-500 to-indigo-600 text-white">
          <TrainGlyph className="h-6 w-6" />
        </span>
        <span className="text-sm font-medium">Loading map…</span>
      </div>
    </div>
  )
}

/** Drives the animation clock at ~15fps so live markers glide smoothly.
 *  No-ops when there's nothing to animate. */
function useAnimationClock(active: boolean) {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (!active) return
    let raf = 0
    const start = performance.now()
    let last = 0
    const loop = (t: number) => {
      const e = t - start
      if (e - last >= 66) {
        last = e
        setElapsed(e)
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [active])
  return elapsed
}

export function AppShell() {
  const { theme, t } = useApp()
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const elapsed = useAnimationClock(TRAINS.length > 0)
  const trains = useMemo(() => tickTrains(TRAINS, elapsed), [elapsed])
  const selected = trains.find((tr) => tr.id === selectedId) ?? null

  return (
    <main className="relative h-dvh w-screen overflow-hidden">
      <MapView
        trains={trains}
        selectedId={selectedId}
        theme={theme}
        onSelect={setSelectedId}
      />

      <TopBar trainCount={trains.length} />

      {selected && (
        <TrainDetailsPanel train={selected} onClose={() => setSelectedId(null)} />
      )}

      {/* Bottom status pill: empty-data state takes priority over the
          select-a-train hint, since there's nothing to click yet. */}
      {!selected && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 z-[1050] flex justify-center px-4">
          <div className="glass pointer-events-auto flex items-center gap-2 rounded-full px-4 py-2 text-xs font-medium text-slate-600 shadow-lg dark:text-slate-300">
            <TrainGlyph className="h-4 w-4 opacity-60" />
            {trains.length === 0 ? t('noLiveData') : t('selectHint')}
          </div>
        </div>
      )}
    </main>
  )
}
