import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from 'react';
import { browserLocale, isLocale, localeNames, localize, translate, type Locale, type Localized, type Message } from '../i18n/messages';

const preferenceKey = 'ekn-language';
const Language = createContext<{
  locale: Locale;
  change: (locale: Locale) => void;
  t: (key: Message) => string;
  l: (text: Localized) => string;
} | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState(() => {
    try {
      const saved = localStorage.getItem(preferenceKey);
      if (isLocale(saved)) return saved;
    } catch {
      // Browser storage can be disabled.
    }
    return browserLocale(navigator.languages);
  });

  useLayoutEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
  }, [locale]);

  function change(next: Locale) {
    setLocale(next);
    try {
      localStorage.setItem(preferenceKey, next);
    } catch {
      // The current page still uses the selected language.
    }
  }

  return <Language.Provider value={{ locale, change, t: key => translate(locale, key), l: text => localize(locale, text) }}>
    {children}
  </Language.Provider>;
}

export function useLanguage() {
  const context = useContext(Language);
  if (!context) throw new Error('Missing LanguageProvider');
  return context;
}

export function LanguagePicker() {
  const { locale, change, t } = useLanguage();
  return <label className="language-picker">
    <span>{t('language')}</span>
    <select value={locale} onChange={event => {
      const next = event.currentTarget.value;
      if (isLocale(next)) change(next);
    }}>
      {Object.entries(localeNames).map(([id, name]) => <option key={id} value={id} lang={id} dir="auto">{name}</option>)}
    </select>
  </label>;
}
