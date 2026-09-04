import type { NextRequest } from "next/server";

import { NextResponse } from "next/server";

import { isLocale, LOCALE_COOKIE } from "@/lib/locale";
import { absoluteUrl } from "@/lib/request-url";

export function GET(request: NextRequest): NextResponse {
  const locale = request.nextUrl.searchParams.get("locale");

  if (!locale || !isLocale(locale)) {
    return NextResponse.json(
      { error: "INVALID_LOCALE" },
      { status: 400 },
    );
  }

  // Never derive the target from `request.url`: in a standalone build that is
  // the bind address (0.0.0.0:3001), which no browser can follow.
  const response = NextResponse.redirect(absoluteUrl(request, `/${locale}`));

  response.cookies.set(LOCALE_COOKIE, locale, {
    httpOnly: true,
    maxAge: 31_536_000,
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });

  return response;
}
