'use client'

import dynamic from 'next/dynamic'
import { useCallback, useEffect, useState } from 'react'
import { useApp } from '@/app/providers'
import type { TrainLive } from '@/lib/types'
import { InfoButton } from './InfoButton'
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

// How often to refresh live positions. The worker itself polls PKP on a similar
// cadence, so faster than this just re-fetches identical data.
const POLL_INTERVAL_MS = 15_000

/** Fetches live trains from the API on an interval. */
function useLiveTrains() {
  const [snapshot, setSnapshot] = useState<{
    trains: TrainLive[]
    sampledAt: number
    receivedAt: number
    parseDurationMs: number | null
    loading: boolean
  }>({
    trains: [],
    sampledAt: 0,
    receivedAt: 0,
    parseDurationMs: null,
    loading: true,
  })

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()

    async function load() {
      try {
        const res = await fetch('/api/trains', { signal: controller.signal })
        if (!res.ok) return
        let data: { trains: TrainLive[]; at: string }
        let parseDurationMs: number | null = null
        const debug = new URLSearchParams(window.location.search).get('debug') === '1'
        if (debug) {
          const body = await res.text()
          const parseStartedAt = performance.now()
          data = JSON.parse(body) as { trains: TrainLive[]; at: string }
          parseDurationMs = performance.now() - parseStartedAt
        } else {
          data = (await res.json()) as { trains: TrainLive[]; at: string }
        }
        const sampledAt = Date.parse(data.at)
        if (!cancelled) {
          setSnapshot({
            trains: data.trains,
            sampledAt: Number.isFinite(sampledAt) ? sampledAt : Date.now(),
            receivedAt: Date.now(),
            parseDurationMs,
            loading: false,
          })
        }
      } catch {
        /* transient fetch/abort error — keep the last good set */
      }
    }

    load()
    const id = setInterval(load, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      controller.abort()
      clearInterval(id)
    }
  }, [])

  return snapshot
}

export function AppShell() {
  const { theme, t } = useApp()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Bumped each time a train is picked from search, so the map re-centers on it
  // even if it's already the selected train (a plain id change wouldn't fire).
  const [focusNonce, setFocusNonce] = useState(0)

  const { trains, sampledAt, receivedAt, parseDurationMs, loading } = useLiveTrains()
  const selected = trains.find((tr) => tr.id === selectedId) ?? null

  const focusTrain = useCallback((id: string) => {
    setSelectedId(id)
    setFocusNonce((n) => n + 1)
  }, [])

  return (
    <main className="relative h-dvh w-screen overflow-hidden">
      <MapView
        trains={trains}
        sampledAt={sampledAt}
        receivedAt={receivedAt}
        parseDurationMs={parseDurationMs}
        selectedId={selectedId}
        focusNonce={focusNonce}
        theme={theme}
        onSelect={setSelectedId}
      />

      <TopBar trains={trains} onSelect={focusTrain} />

      {/* Data disclaimer. Hidden while a train is picked, since the details
          panel takes over that corner on desktop. */}
      {!selected && <InfoButton />}

      {selected && (
        <TrainDetailsPanel
          key={selected.id}
          train={selected}
          onClose={() => setSelectedId(null)}
        />
      )}

      {/* Bottom status pill: empty-data state takes priority over the
          select-a-train hint, since there's nothing to click yet. */}
      {!selected && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 z-[1050] flex justify-center px-4">
          <div className="glass pointer-events-auto flex items-center gap-2 rounded-full px-4 py-2 text-xs font-medium text-slate-600 shadow-lg dark:text-slate-300">
            {loading ? (
              <span
                role="status"
                aria-label={t('loadingTrains')}
                className="flex h-4 items-center gap-1.5"
              >
                <span aria-hidden="true" className="loading-dot h-1.5 w-1.5 rounded-full bg-current" />
                <span aria-hidden="true" className="loading-dot h-1.5 w-1.5 rounded-full bg-current" />
                <span aria-hidden="true" className="loading-dot h-1.5 w-1.5 rounded-full bg-current" />
              </span>
            ) : (
              <>
                <TrainGlyph className="h-4 w-4 opacity-60" />
                {trains.length === 0 ? t('noLiveData') : t('selectHint')}
              </>
            )}
          </div>
        </div>
      )}
    </main>
  )
}
