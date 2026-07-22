'use client'

import { useId, useState } from 'react'
import { useApp } from '@/app/providers'
import { getCarrier } from '@/lib/carriers'
import { getTrainIdentity } from '@/lib/trainIdentity'
import type { TrainLive } from '@/lib/types'
import { ChevronIcon, CloseIcon, TrainGlyph } from './icons'

function StatusChip({ delay }: { delay: number }) {
  const { t } = useApp()
  const onTime = delay <= 0
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${onTime
          ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
          : 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
        }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${onTime ? 'bg-emerald-500' : 'bg-amber-500'
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
  const [expanded, setExpanded] = useState(false)
  const contentId = useId()
  const carrier = getCarrier(train.carrierId)
  const identity = getTrainIdentity(train)

  const from = train.stops[train.fromIndex]
  const to = train.stops[train.toIndex]

  return (
    <aside
      key={train.id}
      className={`train-details-panel panel-in glass pointer-events-auto absolute inset-x-3 bottom-3 z-[1100] flex flex-col overflow-hidden rounded-2xl transition-[height] duration-300 ease-out sm:inset-x-auto sm:top-20 sm:right-4 sm:bottom-4 sm:h-auto sm:w-[min(24rem,calc(100vw-1.5rem))] ${expanded ? 'h-[min(72dvh,40rem)]' : 'h-[9rem]'
        }`}
    >
      {/* Accent strip in the carrier color */}
      <div className="h-1.5 w-full shrink-0" style={{ background: carrier.color }} />

      {/* Mobile sheet control. A button is more discoverable and accessible
          than making a drag gesture the only way to reveal the route. */}
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
        aria-controls={contentId}
        className="flex h-11 shrink-0 cursor-pointer items-center justify-center gap-2 text-xs font-semibold text-slate-500 transition-colors hover:bg-slate-500/5 hover:text-slate-700 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-sky-500 dark:text-slate-400 dark:hover:bg-white/5 dark:hover:text-slate-200 sm:hidden"
      >
        <span className="h-1 w-8 rounded-full bg-slate-400/60 dark:bg-slate-500/70" />
        <span>{expanded ? t('hideDetails') : t('showDetails')}</span>
        <ChevronIcon
          className={`h-4 w-4 transition-transform duration-300 ${expanded ? 'rotate-180' : ''
            }`}
        />
      </button>

      {/* Header */}
      <div className="flex shrink-0 items-start gap-3 px-4 pt-2 sm:pt-4">
        <span
          className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-white shadow-sm"
          style={{ background: carrier.color }}
        >
          <TrainGlyph className="h-6 w-6" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2">
            <h2 className="min-w-0 truncate text-lg font-semibold tracking-tight text-slate-900 dark:text-white">
              {identity.primary}
            </h2>
            {identity.secondary && (
              <span className="shrink-0 truncate font-mono text-xs text-slate-500 dark:text-slate-400">
                {identity.secondary}
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
          className="grid h-10 w-10 shrink-0 cursor-pointer place-items-center rounded-lg text-slate-400 transition hover:bg-slate-500/10 hover:text-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 dark:hover:text-slate-200 sm:h-8 sm:w-8"
        >
          <CloseIcon className="h-4 w-4" />
        </button>
      </div>

      <div
        id={contentId}
        className="flex min-h-0 flex-1 flex-col"
      >
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
            const passed = i <= train.fromIndex
            const isOrigin = i === 0
            const isDest = i === train.stops.length - 1
            const isAboveActive = i === train.toIndex
            const isBelowActive = i === train.fromIndex

            return (
              <li key={`${stop.stationId}:${i}`} className="flex gap-3">
                {/* Timeline gutter */}
                <div className="flex w-4 flex-col items-center">
                  {/* connector above the dot */}
                  {i > 0 && (
                    <span
                      className="w-0.5 flex-1"
                      style={{
                        background: isAboveActive
                          ? `linear-gradient(to bottom, ${carrier.color}77, rgba(100,116,139,0.25))`
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
                        background: isBelowActive
                          ? `linear-gradient(to bottom, ${carrier.color}, ${carrier.color}77)`
                          : i < train.fromIndex
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
                      {stop.name}
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
      </div>
    </aside>
  )
}
