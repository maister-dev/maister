export const LOCALES = ["en", "ru"] as const;
export const DEFAULT_LOCALE = "en";
export const LOCALE_COOKIE = "MAISTER_SITE_LOCALE";

export type Locale = (typeof LOCALES)[number];

export function isLocale(value: string): value is Locale {
  return LOCALES.some((locale) => locale === value);
}
