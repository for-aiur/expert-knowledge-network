import en from './en.json';
import de from './de.json';
import tr from './tr.json';
import pl from './pl.json';
import ru from './ru.json';
import ar from './ar.json';

export const dictionaries = { en, de, tr, pl, ru, ar };
export type Locale = keyof typeof dictionaries;
export type Message = keyof typeof en;
export type Localized = { en: string } & Partial<Record<Locale, string>>;
export const localeNames: Record<Locale, string> = {
  en: 'English', de: 'Deutsch', tr: 'Türkçe', pl: 'Polski', ru: 'Русский', ar: 'العربية',
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && Object.hasOwn(dictionaries, value);
}

export function browserLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    const base = language.toLowerCase().split('-')[0];
    if (isLocale(base)) return base;
  }
  return 'en';
}

export function translate(locale: Locale, key: Message) {
  return dictionaries[locale][key] ?? en[key];
}

export function isMessage(key: unknown): key is Message {
  return typeof key === 'string' && Object.hasOwn(en, key);
}

export function localize(locale: Locale, text: Localized) {
  return text[locale] ?? text.en;
}
