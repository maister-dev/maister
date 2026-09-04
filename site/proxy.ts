import type { NextRequest } from "next/server";

import { NextResponse } from "next/server";

import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale } from "@/lib/locale";

function preferredLocale(request: NextRequest): string {
  const savedLocale = request.cookies.get(LOCALE_COOKIE)?.value;

  if (savedLocale && isLocale(savedLocale)) return savedLocale;

  const acceptedLanguages = request.headers.get("accept-language") ?? "";

  return acceptedLanguages.toLowerCase().includes("ru") ? "ru" : DEFAULT_LOCALE;
}

export function proxy(request: NextRequest): NextResponse {
  const destination = new URL(`/${preferredLocale(request)}`, request.url);

  return NextResponse.redirect(destination);
}

export const config = {
  matcher: "/",
};
