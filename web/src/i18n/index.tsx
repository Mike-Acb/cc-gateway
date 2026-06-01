import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'
import type { Locale, TranslationKeys } from './types'
import zh from './zh'
import en from './en'

const translations: Record<Locale, TranslationKeys> = { zh, en }

function detectLocale(): Locale {
  const stored = localStorage.getItem('locale')
  if (stored === 'zh' || stored === 'en') return stored
  const nav = navigator.language.toLowerCase()
  return nav.startsWith('zh') ? 'zh' : 'en'
}

type I18nContextType = {
  locale: Locale
  setLocale: (l: Locale) => void
  t: (key: keyof TranslationKeys, ...args: (string | number)[]) => string
}

const I18nContext = createContext<I18nContextType>(null!)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectLocale)

  const setLocale = useCallback((l: Locale) => {
    localStorage.setItem('locale', l)
    setLocaleState(l)
  }, [])

  const t = useCallback((key: keyof TranslationKeys, ...args: (string | number)[]) => {
    let text = translations[locale][key] ?? translations['en'][key] ?? key
    args.forEach((arg, i) => {
      text = text.replace(`{${i}}`, String(arg))
    })
    return text
  }, [locale])

  return (
    <I18nContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </I18nContext.Provider>
  )
}

export function useI18n() {
  return useContext(I18nContext)
}

export function useT() {
  return useContext(I18nContext).t
}

export function LanguageSwitcher({ className }: { className?: string }) {
  const { locale, setLocale } = useI18n()
  return (
    <button
      onClick={() => setLocale(locale === 'zh' ? 'en' : 'zh')}
      className={className ?? 'text-[12px] text-[var(--color-gray-3)] hover:text-[var(--color-gray-1)] transition-colors'}
      title={locale === 'zh' ? 'Switch to English' : '切换到中文'}
    >
      {locale === 'zh' ? 'EN' : '中文'}
    </button>
  )
}
