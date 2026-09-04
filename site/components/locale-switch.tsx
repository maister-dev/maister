import type { ReactElement } from "react";

import type { Locale } from "@/lib/locale";

import { LOCALES } from "@/lib/locale";

type LocaleSwitchProps = {
  current: Locale;
  label: string;
};

export function LocaleSwitch({ current, label }: LocaleSwitchProps): ReactElement {
  return (
    <div aria-label={label} className="locale-switch" role="group">
      {LOCALES.map((locale) => (
        <a
          key={locale}
          aria-current={locale === current ? "page" : undefined}
          className={locale === current ? "is-active" : undefined}
          href={`/api/locale?locale=${locale}`}
          hrefLang={locale}
          lang={locale}
        >
          {locale.toUpperCase()}
        </a>
      ))}
    </div>
  );
}
