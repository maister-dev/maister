import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import pino from "pino";

import en from "../messages/en.json";
import ru from "../messages/ru.json";

import {
  DEFAULT_LOCALE,
  isLocale,
  LOCALE_COOKIE,
  pickFromAcceptLanguage,
  type Locale,
} from "@/lib/i18n";

const log = pino({ name: "i18n", level: process.env.LOG_LEVEL ?? "info" });
const messagesByLocale = { en, ru } satisfies Record<Locale, unknown>;

async function resolveLocale(): Promise<{ locale: Locale; source: string }> {
  const cookieStore = await cookies();
  const fromCookie = cookieStore.get(LOCALE_COOKIE)?.value;

  if (isLocale(fromCookie)) {
    return { locale: fromCookie, source: "cookie" };
  }

  const headerStore = await headers();
  const fromHeader = pickFromAcceptLanguage(headerStore.get("accept-language"));

  if (fromHeader) {
    return { locale: fromHeader, source: "accept-language" };
  }

  return { locale: DEFAULT_LOCALE, source: "default" };
}

export default getRequestConfig(async () => {
  const { locale, source } = await resolveLocale();

  log.debug({ locale, source }, "resolved request locale");

  return { locale, messages: messagesByLocale[locale] };
});
