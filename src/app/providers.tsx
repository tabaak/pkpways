'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { makeT, type I18nKey } from '@/lib/i18n'
import type { Lang, Theme } from '@/lib/types'

type AppContextValue = {
  theme: Theme
  toggleTheme: () => void
  lang: Lang
  setLang: (lang: Lang) => void
  toggleLang: () => void
  t: (key: I18nKey) => string
}

const AppContext = createContext<AppContextValue | null>(null)

const THEME_KEY = 'pkpways-theme'
const LANG_KEY = 'pkpways-lang'

export function AppProvider({ children }: { children: React.ReactNode }) {
  // Theme is applied to <html> before hydration by the inline script in
  // layout.tsx; read the initial value back from the DOM to stay in sync.
  const [theme, setTheme] = useState<Theme>('light')
  const [lang, setLangState] = useState<Lang>('en')

  useEffect(() => {
    // Intentional post-mount sync from external state (the DOM class set by the
    // pre-hydration script, plus localStorage). Rendering defaults first and
    // reconciling here is what keeps SSR and the client hydration in agreement.
    /* eslint-disable react-hooks/set-state-in-effect */
    const isDark = document.documentElement.classList.contains('dark')
    setTheme(isDark ? 'dark' : 'light')
    try {
      const storedLang = localStorage.getItem(LANG_KEY)
      if (storedLang === 'pl' || storedLang === 'en') setLangState(storedLang)
    } catch {
      /* ignore */
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [])

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark'
      const root = document.documentElement
      root.classList.toggle('dark', next === 'dark')
      try {
        localStorage.setItem(THEME_KEY, next)
      } catch {
        /* ignore */
      }
      return next
    })
  }, [])

  const setLang = useCallback((next: Lang) => {
    setLangState(next)
    try {
      localStorage.setItem(LANG_KEY, next)
    } catch {
      /* ignore */
    }
  }, [])

  const toggleLang = useCallback(() => {
    setLang(lang === 'pl' ? 'en' : 'pl')
  }, [lang, setLang])

  const value = useMemo<AppContextValue>(
    () => ({
      theme,
      toggleTheme,
      lang,
      setLang,
      toggleLang,
      t: makeT(lang),
    }),
    [theme, toggleTheme, lang, setLang, toggleLang]
  )

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used within <AppProvider>')
  return ctx
}
