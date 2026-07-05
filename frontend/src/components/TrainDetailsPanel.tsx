'use client'

import { useApp } from '@/app/providers'
import { getCarrier } from '@/lib/carriers'
import { getStation } from '@/lib/stations'
import type { TrainLive } from '@/lib/types'
import { CloseIcon, TrainGlyph } from './icons'

function StatusChip({ delay }: { delay: number }) {
  const { t } = useApp()
  const onTime = delay <= 0
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${
        onTime
          ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
          : 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          onTime ? 'bg-emerald-500' : 'bg-amber-500'
        }`}
      />
      {onTime ? t('onTime') : `+${delay} ${t('min')} ${t('delayed').toLowerCase()}`}
    </span>
  )
}

export function TrainDetailsPanel({
  train,
  onClose,
}: {
  train: TrainLive
  onClose: () => void
}) {
  const { t } = useApp()
  const carrier = getCarrier(train.carrierId)

  const from = getStation(train.stops[train.fromIndex].stationId)
  const to = getStation(train.stops[train.toIndex].stationId)

  return (
    <aside
      key={train.id}
      className="panel-in glass pointer-events-auto absolute right-3 top-20 bottom-3 z-[1100] flex w-[min(24rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-2xl sm:right-4 sm:bottom-4"
    >
      {/* Accent strip in the carrier color */}
      <div className="h-1.5 w-full shrink-0" style={{ background: carrier.color }} />

      {/* Header */}
      <div className="flex items-start gap-3 px-4 pt-4">
        <span
          className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-white shadow-sm"
          style={{ background: carrier.color }}
        >
          <TrainGlyph className="h-6 w-6" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-lg font-semibold tracking-tight text-slate-900 dark:text-white">
              {train.number}
            </h2>
            {train.name && (
              <span className="truncate text-sm text-slate-400 dark:text-slate-500">
                · {train.name}
              </span>
            )}
          </div>
          <p
            className="truncate text-xs font-medium"
            style={{ color: carrier.color }}
          >
            {carrier.name}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('close')}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-slate-400 transition hover:bg-slate-500/10 hover:text-slate-700 dark:hover:text-slate-200"
        >
          <CloseIcon className="h-4 w-4" />
        </button>
      </div>

      {/* Status + current position */}
      <div className="px-4 pt-3">
        <StatusChip delay={train.delay} />
        <p className="mt-2.5 text-xs text-slate-500 dark:text-slate-400">
          {t('currentlyBetween')}{' '}
          <span className="font-medium text-slate-700 dark:text-slate-200">
            {from.name}
          </span>{' '}
          {t('and')}{' '}
          <span className="font-medium text-slate-700 dark:text-slate-200">
            {to.name}
          </span>
        </p>
      </div>

      <div className="mx-4 mt-3.5 h-px shrink-0 bg-slate-500/10" />

      {/* Route timeline */}
      <div className="flex items-center justify-between px-4 pt-3.5">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
          {t('route')}
        </h3>
        <span className="text-xs text-slate-400 dark:text-slate-500">
          {train.stops.length} {t('stops').toLowerCase()}
        </span>
      </div>

      <ol className="thin-scroll mt-2 flex-1 overflow-y-auto px-4 pb-4">
        {train.stops.map((stop, i) => {
          const station = getStation(stop.stationId)
          const passed = i <= train.fromIndex
          const isOrigin = i === 0
          const isDest = i === train.stops.length - 1
          const activeSegment = i === train.toIndex // connector above is active

          return (
            <li key={stop.stationId} className="flex gap-3">
              {/* Timeline gutter */}
              <div className="flex w-4 flex-col items-center">
                {/* connector above the dot */}
                {i > 0 && (
                  <span
                    className="w-0.5 flex-1"
                    style={{
                      background: activeSegment
                        ? `linear-gradient(${carrier.color}, ${carrier.color}55)`
                        : passed
                          ? carrier.color
                          : 'rgba(100,116,139,0.25)',
                    }}
                  />
                )}
                <span
                  className="my-0.5 grid h-3.5 w-3.5 place-items-center rounded-full border-2"
                  style={{
                    borderColor: passed ? carrier.color : 'rgba(100,116,139,0.4)',
                    background: passed ? carrier.color : 'transparent',
                  }}
                >
                  {(isOrigin || isDest) && (
                    <span className="h-1 w-1 rounded-full bg-white" />
                  )}
                </span>
                {/* connector below the dot */}
                {i < train.stops.length - 1 && (
                  <span
                    className="w-0.5 flex-1"
                    style={{
                      background:
                        i < train.fromIndex
                          ? carrier.color
                          : 'rgba(100,116,139,0.25)',
                    }}
                  />
                )}
              </div>

              {/* Stop info */}
              <div className="flex flex-1 items-start justify-between gap-3 py-1.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                    {station.name}
                  </p>
                  {isOrigin && (
                    <p className="text-[11px] text-slate-400 dark:text-slate-500">
                      {t('origin')}
                    </p>
                  )}
                  {isDest && (
                    <p className="text-[11px] text-slate-400 dark:text-slate-500">
                      {t('destination')}
                    </p>
                  )}
                </div>
                <div className="shrink-0 text-right">
                  <p className="font-mono text-sm tabular-nums text-slate-700 dark:text-slate-200">
                    {stop.arrival ?? stop.departure}
                  </p>
                  {stop.delay > 0 ? (
                    <p className="text-[11px] font-semibold text-amber-600 dark:text-amber-400">
                      +{stop.delay} {t('min')}
                    </p>
                  ) : (
                    <p className="text-[11px] text-emerald-600 dark:text-emerald-400">
                      {t('onTime')}
                    </p>
                  )}
                </div>
              </div>
            </li>
          )
        })}
      </ol>
    </aside>
  )
}
