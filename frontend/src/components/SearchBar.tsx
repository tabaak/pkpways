'use client'

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useApp } from '@/app/providers'
import { getCarrier } from '@/lib/carriers'
import { getTrainIdentity } from '@/lib/trainIdentity'
import type { TrainLive } from '@/lib/types'
import { CloseIcon, SearchIcon } from './icons'

// Cap the dropdown so it never overruns the viewport; matches are ranked so the
// most relevant few are the ones shown.
const MAX_RESULTS = 8

/** Collapse case and whitespace so "IC3512" matches "IC 3512". */
function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '')
}

/**
 * Rank live trains against a query by number, category, or service name.
 * A prefix hit scores best; earlier substring positions rank ahead of later
 * ones. Non-matches are dropped.
 */
function rankMatches(trains: TrainLive[], query: string): TrainLive[] {
  const q = normalize(query)
  if (!q) return []

  const scored: { train: TrainLive; score: number }[] = []
  for (const train of trains) {
    const fields = [train.number, train.category ?? '', train.name ?? '']
    let best = Number.POSITIVE_INFINITY
    for (const field of fields) {
      const nf = normalize(field)
      if (!nf) continue
      const idx = nf.indexOf(q)
      if (idx === -1) continue
      best = Math.min(best, idx === 0 ? 0 : idx + 1)
    }
    if (best !== Number.POSITIVE_INFINITY) scored.push({ train, score: best })
  }

  scored.sort(
    (a, b) => a.score - b.score || a.train.number.localeCompare(b.train.number)
  )
  return scored.slice(0, MAX_RESULTS).map((s) => s.train)
}

/**
 * Expanding search overlay. Rendered inside the top bar only while open, laid
 * over the bar contents so no reflow is needed. Closes via the ✕ button,
 * Escape, an outside click, or after picking a result.
 */
export function SearchBar({
  trains,
  onSelect,
  onClose,
}: {
  trains: TrainLive[]
  onSelect: (id: string) => void
  onClose: () => void
}) {
  const { t } = useApp()
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listboxId = useId()

  const results = useMemo(() => rankMatches(trains, query), [trains, query])
  const trimmed = query.trim()
  const showDropdown = trimmed.length > 0
  // Clamp against the live result set, which can shrink as positions refresh.
  const active = results.length ? Math.min(activeIndex, results.length - 1) : 0

  // Focus the field as soon as the search expands.
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // A click outside the overlay collapses search entirely.
  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [onClose])

  function choose(train: TrainLive) {
    onSelect(train.id)
    onClose()
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex(Math.min(active + 1, results.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex(Math.max(active - 1, 0))
    } else if (event.key === 'Enter') {
      if (showDropdown && results[active]) {
        event.preventDefault()
        choose(results[active])
      }
    } else if (event.key === 'Escape') {
      event.preventDefault()
      if (trimmed) setQuery('')
      else onClose()
    }
  }

  return (
    <div ref={containerRef} className="absolute inset-0 z-10">
      <div className="glass-strong flex h-full items-center gap-2 rounded-2xl px-3 sm:px-4">
        <SearchIcon className="h-[18px] w-[18px] shrink-0 text-slate-400 dark:text-slate-500" />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-label={t('searchLabel')}
          aria-expanded={showDropdown}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={
            showDropdown && results[active]
              ? `${listboxId}-opt-${active}`
              : undefined
          }
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
          placeholder={t('searchPlaceholder')}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActiveIndex(0)
          }}
          onKeyDown={onKeyDown}
          className="min-w-0 flex-1 bg-transparent text-sm font-medium text-slate-900 placeholder:text-slate-400 focus:outline-none dark:text-white dark:placeholder:text-slate-500"
        />
        <button
          type="button"
          onClick={onClose}
          aria-label={t('clearSearch')}
          title={t('clearSearch')}
          className="grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-lg text-slate-400 transition hover:bg-slate-500/10 hover:text-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 dark:hover:text-slate-200"
        >
          <CloseIcon className="h-4 w-4" />
        </button>
      </div>

      {showDropdown && (
        <div className="glass-strong absolute inset-x-0 top-full mt-2 overflow-hidden rounded-2xl p-1.5">
          {results.length > 0 ? (
            <ul
              id={listboxId}
              role="listbox"
              aria-label={t('searchLabel')}
              className="thin-scroll max-h-[min(60vh,26rem)] overflow-y-auto"
            >
              {results.map((train, i) => (
                <ResultRow
                  key={train.id}
                  id={`${listboxId}-opt-${i}`}
                  train={train}
                  active={i === active}
                  onHover={() => setActiveIndex(i)}
                  onPick={() => choose(train)}
                />
              ))}
            </ul>
          ) : (
            <div className="px-3 py-4 text-center">
              <p className="text-sm font-medium text-slate-600 dark:text-slate-300">
                {t('noResults')}
              </p>
              <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
                {t('noResultsHint')}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ResultRow({
  id,
  train,
  active,
  onHover,
  onPick,
}: {
  id: string
  train: TrainLive
  active: boolean
  onHover: () => void
  onPick: () => void
}) {
  const carrier = getCarrier(train.carrierId)
  const identity = getTrainIdentity(train)
  const origin = train.stops[0]?.name
  const destination = train.stops[train.stops.length - 1]?.name

  return (
    <li
      id={id}
      role="option"
      aria-selected={active}
      // Use pointer-down so the pick fires before the input's blur closes it.
      onMouseDown={(e) => {
        e.preventDefault()
        onPick()
      }}
      onMouseMove={onHover}
      className={`flex cursor-pointer items-center gap-3 rounded-xl px-2.5 py-2 transition-colors ${
        active ? 'bg-slate-500/10 dark:bg-white/10' : ''
      }`}
    >
      <span
        className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[11px] font-bold text-white"
        style={{ background: carrier.color }}
      >
        {carrier.code}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-sm font-semibold text-slate-900 dark:text-white">
            {identity.primary}
          </span>
          {identity.secondary && (
            <span className="shrink-0 font-mono text-[11px] text-slate-400 dark:text-slate-500">
              {identity.secondary}
            </span>
          )}
        </div>
        {origin && destination && (
          <p className="truncate text-xs text-slate-500 dark:text-slate-400">
            {origin} <span className="text-slate-300 dark:text-slate-600">→</span>{' '}
            {destination}
          </p>
        )}
      </div>
      {train.delay > 0 && (
        <span className="shrink-0 rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-amber-600 dark:text-amber-400">
          +{train.delay}
        </span>
      )}
    </li>
  )
}
