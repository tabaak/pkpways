'use client'

import { useEffect, useState } from 'react'
import { useApp } from '@/app/providers'
import { CloseIcon, InfoIcon } from './icons'

/**
 * Small floating control under the top bar that explains the map shows
 * schedule-derived estimates rather than real GPS positions.
 */
export function InfoButton() {
  const { t } = useApp()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open])

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t('aboutLabel')}
        title={t('aboutLabel')}
        // Sits level with the top bar once the viewport is wide enough that the
        // bar (max-w-4xl, centered) can't reach the corner; below it otherwise.
        className="map-control-button map-control-button--sm absolute top-[4.75rem] right-3 z-[1100] sm:right-4 min-[1000px]:top-7"
      >
        <InfoIcon className="h-4 w-4" />
      </button>

      {open && (
        <div
          className="info-dialog__backdrop absolute inset-0 z-[1200] grid place-items-center bg-slate-900/25 px-4 dark:bg-slate-950/45"
          onClick={() => setOpen(false)}
        >
          {/* Same shell, radii and text scale as the top bar, but on the
              near-solid glass so the map behind can't wash out the text. */}
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="info-dialog-title"
            className="info-dialog__panel glass-strong w-full max-w-sm rounded-2xl px-4 py-3.5 sm:px-5"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center gap-2.5">
              <InfoIcon className="h-[18px] w-[18px] shrink-0 text-slate-400 dark:text-slate-500" />
              <h2
                id="info-dialog-title"
                className="min-w-0 flex-1 text-[15px] leading-tight font-semibold tracking-tight text-slate-900 dark:text-white"
              >
                {t('disclaimerTitle')}
              </h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label={t('close')}
                className="-mr-1 grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-xl bg-slate-200/50 text-slate-600 transition duration-200 ease-out hover:bg-slate-200/80 hover:text-slate-900 active:scale-95 motion-reduce:transition-none dark:bg-white/5 dark:text-slate-300 dark:hover:bg-white/10 dark:hover:text-white"
              >
                <CloseIcon className="h-4 w-4" />
              </button>
            </div>

            <p className="mt-3 text-[13px] leading-relaxed text-slate-600 dark:text-slate-300">
              {t('disclaimerBody')}
            </p>
            <p className="mt-2.5 text-[12px] leading-relaxed text-slate-500 dark:text-slate-400">
              {t('disclaimerNote')}
            </p>

            {/* Dismiss action, in the same inverted slate as the active pill
                of the top bar's language toggle. */}
            <button
              type="button"
              onClick={() => setOpen(false)}
              autoFocus
              className="mt-4 w-full cursor-pointer rounded-xl bg-slate-900 py-2 text-[13px] font-semibold text-white transition duration-200 ease-out hover:bg-slate-800 active:scale-[0.99] motion-reduce:transition-none dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100"
            >
              {t('gotIt')}
            </button>
          </div>
        </div>
      )}
    </>
  )
}
