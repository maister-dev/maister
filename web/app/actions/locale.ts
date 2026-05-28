"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import pino from "pino";

import { isLocale, LOCALE_COOKIE, type Locale } from "@/lib/i18n";

const log = pino({
  name: "action-locale",
  level: process.env.LOG_LEVEL ?? "info",
});

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export async function setLocale(locale: Locale): Promise<void> {
  if (!isLocale(locale)) {
    log.warn({ locale }, "rejected unsupported locale");

    return;
  }

  const cookieStore = await cookies();

  cookieStore.set(LOCALE_COOKIE, locale, {
    path: "/",
    maxAge: ONE_YEAR_SECONDS,
    sameSite: "lax",
  });

  log.info({ locale }, "locale cookie set");

  revalidatePath("/", "layout");
}
