import type { ReactElement, ReactNode } from "react";

import { notFound } from "next/navigation";
import Script from "next/script";

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

const YANDEX_METRIKA_SCRIPT = `
  (function(m,e,t,r,i,k,a){
    m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};
    m[i].l=1*new Date();
    for (var j = 0; j < document.scripts.length; j++) {if (document.scripts[j].src === r) { return; }}
    k=e.createElement(t),a=e.getElementsByTagName(t)[0],k.async=1,k.src=r,a.parentNode.insertBefore(k,a)
  })(window, document, 'script', 'https://mc.yandex.ru/metrika/tag.js?id=112387867', 'ym');

  ym(112387867, 'init', {ssr:true, webvisor:true, clickmap:true, referrer: document.referrer, url: location.href, accurateTrackBounce:true, trackLinks:true});
`;

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
      <body>
        <Script id="yandex-metrika" strategy="afterInteractive">
          {YANDEX_METRIKA_SCRIPT}
        </Script>
        <noscript>
          <div>
            {/* eslint-disable-next-line @next/next/no-img-element -- tracking pixel must request Yandex directly */}
            <img
              alt=""
              height={1}
              src="https://mc.yandex.ru/watch/112387867"
              style={{ position: "absolute", left: "-9999px" }}
              width={1}
            />
          </div>
        </noscript>
        {children}
      </body>
    </html>
  );
}
