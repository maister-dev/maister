export const LOCALES = ["en", "ru"] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

export const LOCALE_COOKIE = "NEXT_LOCALE";

export function isLocale(value: string | null | undefined): value is Locale {
  return !!value && (LOCALES as readonly string[]).includes(value);
}

/**
 * Pick the best supported locale from an `Accept-Language` header value.
 * Returns undefined when nothing matches so the caller can fall back.
 */
export function pickFromAcceptLanguage(
  header: string | null | undefined,
): Locale | undefined {
  if (!header) return undefined;

  const ranked = header
    .split(",")
    .map((part) => {
      const [tag, q] = part.trim().split(";q=");
      const base = tag.trim().toLowerCase().split("-")[0];
      const weight = q ? Number.parseFloat(q) : 1;

      return { base, weight: Number.isFinite(weight) ? weight : 1 };
    })
    .filter((entry) => entry.base.length > 0)
    .sort((a, b) => b.weight - a.weight);

  for (const entry of ranked) {
    if (isLocale(entry.base)) return entry.base;
  }

  return undefined;
}
