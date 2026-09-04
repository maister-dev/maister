import type { NextRequest } from "next/server";

import { NextResponse } from "next/server";

import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale } from "@/lib/locale";
import { absoluteUrl } from "@/lib/request-url";

function preferredLocale(request: NextRequest): string {
  const savedLocale = request.cookies.get(LOCALE_COOKIE)?.value;

  if (savedLocale && isLocale(savedLocale)) return savedLocale;

  const acceptedLanguages = request.headers.get("accept-language") ?? "";

  return acceptedLanguages.toLowerCase().includes("ru") ? "ru" : DEFAULT_LOCALE;
}

export function proxy(request: NextRequest): NextResponse {
  // Never derive the target from `request.url`: in a standalone build that is
  // the bind address (0.0.0.0:3001), which no browser can follow.
  return NextResponse.redirect(absoluteUrl(request, `/${preferredLocale(request)}`));
}

export const config = {
  matcher: "/",
};
