'use client'

import { useState } from 'react'
import { useApp } from '@/app/providers'
import type { TrainLive } from '@/lib/types'
import { MoonIcon, SearchIcon, SunIcon, TrainGlyph } from './icons'
import { SearchBar } from './SearchBar'

export function TopBar({
  trains,
  onSelect,
}: {
  trains: TrainLive[]
  onSelect: (id: string) => void
}) {
  const { theme, toggleTheme, lang, toggleLang, t } = useApp()
  const [searchOpen, setSearchOpen] = useState(false)
  const trainCount = trains.length

  return (
    <header className="pointer-events-none absolute inset-x-0 top-0 z-[1100] flex justify-center px-3 pt-3 sm:px-4 sm:pt-4">
      <div className="glass pointer-events-auto relative flex w-full max-w-4xl items-center gap-3 rounded-2xl px-3 py-2 sm:px-4 sm:py-2.5">
        {/* Brand */}
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-sky-500 to-indigo-600 text-white shadow-md">
            <TrainGlyph className="h-5 w-5" />
          </span>
          <div className="min-w-0 leading-tight">
            <h1 className="truncate text-[15px] font-semibold tracking-tight text-slate-900 dark:text-white">
              {t('appName')}
            </h1>
            <p className="truncate text-[11px] text-slate-500 dark:text-slate-400">
              {t('tagline')}
            </p>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {/* Live train counter — only shown once there's something to count */}
          {trainCount > 0 && (
            <div className="hidden items-center gap-2 rounded-full bg-white/50 px-3 py-1.5 text-xs font-medium text-slate-600 dark:bg-white/5 dark:text-slate-300 sm:flex">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
              <span className="tabular-nums">{trainCount}</span>
              <span className="text-slate-400 dark:text-slate-500">
                {t('trainsRunning')}
              </span>
            </div>
          )}

          {/* Search toggle — expands the search field over the bar. */}
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            aria-label={t('searchLabel')}
            title={t('searchLabel')}
            className="grid h-9 w-9 place-items-center rounded-xl bg-white/50 text-slate-600 transition hover:bg-white/80 hover:text-slate-900 dark:bg-white/5 dark:text-slate-300 dark:hover:bg-white/10 dark:hover:text-white"
          >
            <SearchIcon className="h-[18px] w-[18px]" />
          </button>

          {/* Language toggle */}
          <button
            type="button"
            onClick={toggleLang}
            aria-label="Toggle language"
            className="flex h-9 items-center rounded-xl bg-white/50 px-1 text-xs font-semibold text-slate-500 transition hover:bg-white/80 dark:bg-white/5 dark:text-slate-400 dark:hover:bg-white/10"
          >
            <span
              className={`rounded-lg px-2 py-1 transition ${
                lang === 'pl'
                  ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900'
                  : ''
              }`}
            >
              PL
            </span>
            <span
              className={`rounded-lg px-2 py-1 transition ${
                lang === 'en'
                  ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900'
                  : ''
              }`}
            >
              EN
            </span>
          </button>

          {/* Theme toggle */}
          <button
            type="button"
            onClick={toggleTheme}
            aria-label={theme === 'dark' ? t('lightMode') : t('darkMode')}
            title={theme === 'dark' ? t('lightMode') : t('darkMode')}
            className="grid h-9 w-9 place-items-center rounded-xl bg-white/50 text-slate-600 transition hover:bg-white/80 hover:text-slate-900 dark:bg-white/5 dark:text-slate-300 dark:hover:bg-white/10 dark:hover:text-white"
          >
            {theme === 'dark' ? (
              <SunIcon className="h-[18px] w-[18px]" />
            ) : (
              <MoonIcon className="h-[18px] w-[18px]" />
            )}
          </button>
        </div>

        {/* Search by train number — expands over the bar on demand. */}
        {searchOpen && (
          <SearchBar
            trains={trains}
            onSelect={onSelect}
            onClose={() => setSearchOpen(false)}
          />
        )}
      </div>
    </header>
  )
}
