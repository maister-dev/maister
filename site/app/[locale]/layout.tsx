import type { ReactElement, ReactNode } from "react";

import { notFound } from "next/navigation";

import { isLocale, LOCALES } from "@/lib/locale";

import "../globals.css";

const THEME_SCRIPT = `(() => {
  try {
    const saved = localStorage.getItem("maister-site-theme");
    const theme = saved === "light" || saved === "dark"
      ? saved
      : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    document.documentElement.dataset.theme = theme;
  } catch (error) {
    document.documentElement.dataset.theme = "light";
  }
})();`;

export function generateStaticParams(): Array<{ locale: string }> {
  return LOCALES.map((locale) => ({ locale }));
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}): Promise<ReactElement> {
  const { locale } = await params;

  if (!isLocale(locale)) notFound();

  return (
    <html data-scroll-behavior="smooth" suppressHydrationWarning lang={locale}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
